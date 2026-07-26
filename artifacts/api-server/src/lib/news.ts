import { XMLParser } from "fast-xml-parser";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";

const SEARCH_FEED_BASE_URL = "https://www.infomoney.com.br/?feed=rss2&s=";
const FEED_CACHE_TTL_MS = 15 * 60 * 1000; // news moves faster than macro/fundamentals
const CLASSIFICATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // a headline's impact doesn't change

export const NEWS_IMPACTS = ["Muito Positivo", "Positivo", "Neutro", "Negativo", "Muito Negativo"] as const;
export type NewsImpact = (typeof NEWS_IMPACTS)[number];

// News headlines use the company's popular/trade name ("Vale", "Petrobras"), not the
// registered legal name brapi.dev returns ("Vale S.A.", "Petroleo Brasileiro SA") — for
// several well-known tickers those are unrelated words, so a search on the legal name
// would miss everything. Curated for the most-traded B3 tickers; anything else falls
// back to the first word of the legal name, which works for names like "WEG SA" or
// "Ambev SA" but not for cases like Petrobras — a known gap until we find a fuller
// ticker->nome-popular source.
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

/** Best-effort colloquial search term for a ticker — see COMPANY_ALIASES comment above. */
export function resolveSearchTerm(ticker: string, legalName: string | null): string {
  const alias = COMPANY_ALIASES[ticker.toUpperCase()];
  if (alias) return alias;
  if (legalName) return legalName.split(" ")[0];
  return ticker;
}

export interface NewsHeadline {
  title: string;
  link: string;
  publishedAt: string;
  impact: NewsImpact | null; // null when no ANTHROPIC_API_KEY is configured yet
}

interface RawFeedItem {
  title: string;
  link: string;
  pubDate: string;
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
    }))
  );
}
