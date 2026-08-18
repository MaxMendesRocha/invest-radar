import { XMLParser } from "fast-xml-parser";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";

const SEARCH_FEED_BASE_URL = "https://www.infomoney.com.br/?feed=rss2&s=";
const FEED_CACHE_TTL_MS = 15 * 60 * 1000; // news moves faster than macro/fundamentals
const CLASSIFICATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // a headline's impact doesn't change

export const NEWS_IMPACTS = ["Muito Positivo", "Positivo", "Neutro", "Negativo", "Muito Negativo"] as const;
export type NewsImpact = (typeof NEWS_IMPACTS)[number];

// For the most-traded ações, the company's popular/trade name ("Vale", "Petrobras")
// finds more relevant headlines than the ticker itself. Curated by hand and verified
// against real InfoMoney search results — every entry here is a distinctive brand
// name with no collision risk.
//
// Everything else falls back to the raw ticker symbol (see resolveSearchTerm below),
// NOT the first word of brapi.dev's legal name — that used to be the fallback, and it
// broke in ways that shipped a real false positive to a user: MXRF11's legal name is
// "Maxi Renda Fundo de Investimento Imobiliario", so the fallback searched "Maxi" and
// surfaced a baby-stroller sale ad ("Carrinho de bebê Maxi Baby..."). Checking a batch
// of FII/ETF tickers the same way found more of the same class of bug — HSRE11's
// legal name starts with "HSI", which pulled in unrelated news (US immigration,
// organized crime) that has nothing to do with the fund. The raw ticker, by contrast,
// is exactly what InfoMoney's own headlines use for FIIs/lesser-covered tickers
// ("FII MXRF11 divulga...", "XPML11 anuncia..."), so it's both safer and, in testing,
// at least as precise — confirmed across MXRF11, XPML11, HSRE11, and re-verified it
// doesn't regress the well-covered ações either (PETR4, VALE3, MGLU3, WEGE3 all still
// returned clean, on-topic results searched by ticker alone).
const COMPANY_ALIASES: Record<string, string> = {
  PETR3: "Petrobras", PETR4: "Petrobras",
  ITUB3: "Itaú", ITUB4: "Itaú",
  BBDC3: "Bradesco", BBDC4: "Bradesco",
  BBAS3: "Banco do Brasil",
  ABEV3: "Ambev",
  MGLU3: "Magazine Luiza",
  LREN3: "Renner",
  RENT3: "Localiza",
  B3SA3: "B3",
  JBSS3: "JBS",
  SUZB3: "Suzano",
  GGBR4: "Gerdau",
  CSNA3: "CSN",
};

/** Best-effort search term for a ticker — see COMPANY_ALIASES comment above. */
export function resolveSearchTerm(ticker: string): string {
  return COMPANY_ALIASES[ticker.toUpperCase()] ?? ticker.toUpperCase();
}

export interface NewsHeadline {
  title: string;
  link: string;
  publishedAt: string;
  impact: NewsImpact | null; // null when no ANTHROPIC_API_KEY is configured yet
  summary: string | null; // real excerpt from the publisher's own RSS <description>, cleaned — null when the feed didn't include one
}

interface RawFeedItem {
  title: string;
  link: string;
  pubDate: string;
  /** HTML bruto do <description> do RSS — resumo curto que o próprio InfoMoney publica pra syndication, não a matéria inteira. */
  description?: string;
}

/**
 * `<description>` do RSS do InfoMoney vem em HTML, com uma imagem embutida, o resumo
 * de fato, e um rodapé fixo que o WordPress cola em toda entrada ("The post
 * <título> appeared first on InfoMoney."). Corta no início desse rodapé em vez de por
 * regex no texto inteiro — mais robusto, porque o título dentro do rodapé pode ter
 * qualquer pontuação.
 *
 * `null` quando não sobra nada de real depois da limpeza — nunca um resumo vazio
 * fingindo ser conteúdo.
 */
function cleanSummary(raw: string | undefined): string | null {
  if (!raw) return null;
  const withoutTags = raw.replace(/<[^>]*>/g, " ");
  const boilerplateStart = withoutTags.indexOf("The post ");
  const withoutBoilerplate = boilerplateStart >= 0 ? withoutTags.slice(0, boilerplateStart) : withoutTags;
  const collapsed = withoutBoilerplate.replace(/\s+/g, " ").trim();
  return collapsed.length > 0 ? collapsed : null;
}

const searchCache = new Map<string, { items: RawFeedItem[]; fetchedAt: number }>();

// Uses InfoMoney's own WordPress search (?s=...&feed=rss2) instead of filtering the
// generic firehose feed client-side — the general feed only holds ~10 recent items
// across all of InfoMoney, so a specific company rarely shows up in it at any given
// moment. Searching gets company-specific results directly.
async function fetchSearchFeed(term: string): Promise<RawFeedItem[]> {
  const now = Date.now();
  const cached = searchCache.get(term);
  if (cached && now - cached.fetchedAt < FEED_CACHE_TTL_MS) return cached.items;

  try {
    const url = `${SEARCH_FEED_BASE_URL}${encodeURIComponent(term)}`;
    const response = await fetch(url);
    if (!response.ok) {
      logger.warn({ status: response.status, term }, "InfoMoney search RSS fetch failed");
      return cached?.items ?? [];
    }
    const xml = await response.text();
    const parsed = new XMLParser({ htmlEntities: true }).parse(xml);
    const rawItems = parsed?.rss?.channel?.item ?? [];
    const list = Array.isArray(rawItems) ? rawItems : [rawItems];

    const items: RawFeedItem[] = list
      .filter((item): item is Record<string, unknown> => !!item?.title && !!item?.link)
      .map((item) => ({
        title: String(item.title),
        link: String(item.link),
        pubDate: String(item.pubDate ?? ""),
        description: item.description != null ? String(item.description) : undefined,
      }));

    searchCache.set(term, { items, fetchedAt: now });
    return items;
  } catch (err) {
    logger.warn({ err, term }, "InfoMoney search RSS fetch errored");
    return cached?.items ?? [];
  }
}

export async function findRelevantHeadlines(term: string, limit = 3): Promise<RawFeedItem[]> {
  if (!term) return [];
  const items = await fetchSearchFeed(term);
  return items.slice(0, limit);
}

let anthropicClient: Anthropic | null | undefined;

function getClient(): Anthropic | null {
  if (anthropicClient !== undefined) return anthropicClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  anthropicClient = apiKey ? new Anthropic({ apiKey }) : null;
  return anthropicClient;
}

const classificationCache = new Map<string, { impact: NewsImpact; fetchedAt: number }>();

/**
 * Classifies a headline's investor impact using Claude (Haiku — cheap, fast, this is
 * a simple 5-way classification). Returns null when ANTHROPIC_API_KEY isn't set, so
 * callers can show the real headline without a fake/guessed impact label.
 */
export async function classifyImpact(headline: string): Promise<NewsImpact | null> {
  const client = getClient();
  if (!client) return null;

  const cached = classificationCache.get(headline);
  if (cached && Date.now() - cached.fetchedAt < CLASSIFICATION_CACHE_TTL_MS) return cached.impact;

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 12,
      messages: [
        {
          role: "user",
          content:
            `Classifique o impacto da manchete abaixo para um investidor, em exatamente uma destas categorias: ` +
            `${NEWS_IMPACTS.join(", ")}. Responda só com a categoria, sem mais nada.\n\nManchete: "${headline}"`,
        },
      ],
    });

    const text = message.content.find((block) => block.type === "text")?.text?.trim() ?? "";
    const impact = NEWS_IMPACTS.find((candidate) => text.includes(candidate)) ?? null;
    if (impact) classificationCache.set(headline, { impact, fetchedAt: Date.now() });
    return impact;
  } catch (err) {
    logger.warn({ err }, "Anthropic news classification failed");
    return null;
  }
}

/** Relevant, real headlines for a company, each classified if ANTHROPIC_API_KEY is set. */
export async function getNewsFor(term: string, limit = 3): Promise<NewsHeadline[]> {
  const relevant = await findRelevantHeadlines(term, limit);
  return Promise.all(
    relevant.map(async (item) => ({
      title: item.title,
      link: item.link,
      publishedAt: item.pubDate,
      impact: await classifyImpact(item.title),
      summary: cleanSummary(item.description),
    }))
  );
}
