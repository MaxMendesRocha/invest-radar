import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import type { DividendTrend } from "./market-data";

const OPINION_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // preço/notícias mudam ao longo do dia, mas não a ponto de justificar cache mais curto pra um parecer sob demanda

export interface PrePurchaseOpinionInput {
  ticker: string;
  name: string | null;
  available: boolean; // fundamentos disponíveis (analyzeFundamentals)
  score: number;
  scoreClassification: string;
  positives: string[];
  risks: string[];
  price: number;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  fiveDayChangePercent: number | null;
  dividendTrend: DividendTrend | null;
  newsItems: string[]; // já formatadas com "[Impacto] título"
  macro: { selic: number | null; selicTrend: string | null; ipca12m: number | null };
}

let anthropicClient: Anthropic | null | undefined;

function getClient(): Anthropic | null {
  if (anthropicClient !== undefined) return anthropicClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  anthropicClient = apiKey ? new Anthropic({ apiKey }) : null;
  return anthropicClient;
}

const opinionCache = new Map<string, { text: string; fetchedAt: number }>();

function buildPrompt(input: PrePurchaseOpinionInput): string {
  const { ticker, name, available, score, scoreClassification, positives, risks, price, fiftyTwoWeekHigh, fiftyTwoWeekLow, fiveDayChangePercent, dividendTrend, newsItems, macro } = input;

  const fundamentalsLine = available
    ? `Score do Radar: ${score}/100 (${scoreClassification})\nPontos positivos (fundamentos reais): ${positives.join("; ") || "nenhum"}\nPontos de atenção (fundamentos reais): ${risks.join("; ") || "nenhum"}`
    : "Fundamentos detalhados não disponíveis pra este ativo no momento — baseie a leitura só em preço, notícias e macro, e deixe claro essa limitação.";

  const rangeLine =
    fiftyTwoWeekHigh != null && fiftyTwoWeekLow != null
      ? `Preço atual: R$${price.toFixed(2)}. Range de 52 semanas: R$${fiftyTwoWeekLow.toFixed(2)} - R$${fiftyTwoWeekHigh.toFixed(2)} (preço atual está a ${(((price - fiftyTwoWeekLow) / (fiftyTwoWeekHigh - fiftyTwoWeekLow)) * 100).toFixed(0)}% do range, onde 0% é a mínima e 100% é a máxima de 52 semanas).${fiveDayChangePercent != null ? ` Variação nos últimos 5 pregões: ${fiveDayChangePercent >= 0 ? "+" : ""}${fiveDayChangePercent.toFixed(1)}%.` : ""}`
      : `Preço atual: R$${price.toFixed(2)}. Range de 52 semanas indisponível.`;

  const dividendLine = dividendTrend
    ? `Proventos pagos nos últimos 12 meses: R$${dividendTrend.last12mTotal.toFixed(2)}/unidade, vs. R$${dividendTrend.prior12mTotal.toFixed(2)}/unidade nos 12 meses anteriores (variação de ${dividendTrend.growthPercent >= 0 ? "+" : ""}${dividendTrend.growthPercent.toFixed(1)}%).`
    : "Histórico de provento insuficiente pra avaliar tendência (não avalie isso, apenas não mencione).";

  return (
    `Você é um analista financeiro sênior dando uma PRIMEIRA LEITURA sobre um ativo pra alguém que ` +
    `está avaliando comprar — a pessoa ainda não tem posição nesse ativo, então isso não é sobre segurar ` +
    `ou vender nada, é sobre se o momento parece razoável pra começar ou reforçar uma posição. Não é uma ` +
    `recomendação formal de investimento, é uma ferramenta de uso pessoal — pode e deve ser direto, como ` +
    `um analista de verdade seria numa conversa privada. Escreva em português do Brasil, de forma objetiva.\n\n` +
    `Ativo: ${ticker}${name ? ` (${name})` : ""}\n` +
    `${fundamentalsLine}\n` +
    `${rangeLine}\n` +
    `${dividendLine}\n` +
    `Notícias recentes classificadas: ${newsItems.join(" | ") || "nenhuma"}\n` +
    `Cenário macro: Selic ${macro.selic ?? "?"}% (tendência ${macro.selicTrend ?? "?"}), IPCA 12m ${macro.ipca12m ?? "?"}%\n\n` +
    `Escreva um parecer curto (2-6 frases) cruzando TODOS os fatores acima. Pode dizer diretamente se o ` +
    `momento parece bom pra entrada ou se vale esperar — cruze a posição do preço no range de 52 semanas ` +
    `com os fundamentos (quando disponíveis): comprar perto da máxima de 52 semanas com fundamentos ` +
    `fracos pede mais cautela do que comprar perto da mínima com fundamentos sólidos, por exemplo. Quando ` +
    `os pontos de atenção envolverem piora de ROE, dívida subindo ou desaceleração de crescimento, pode ` +
    `enquadrar isso como enfraquecimento da vantagem competitiva do negócio (moat). NÃO invente nenhum ` +
    `dado que não esteja listado acima. NÃO proponha um score diferente do informado quando os ` +
    `fundamentos estiverem disponíveis — a decisão de score é sempre do motor determinístico, você só ` +
    `interpreta.\n\n` +
    `Formato de saída: texto plano, sem markdown, 2-6 frases.`
  );
}

/**
 * Parecer qualitativo via Claude sobre um ativo AINDA NÃO possuído, pra apoiar decisão
 * de compra — mesmo padrão de synthesizeAssetRecommendation (analysis-ai.ts), mas sem
 * contexto de posição/IR/concentração, que não existem antes da compra. Cacheado por
 * ticker (não por usuário — o dado de entrada é o mesmo pra qualquer um perguntando
 * sobre o mesmo ticker no mesmo dia). Retorna null sem ANTHROPIC_API_KEY ou em caso de
 * erro, pra o chamador cair num texto determinístico em vez de quebrar a rota.
 */
export async function synthesizePrePurchaseOpinion(input: PrePurchaseOpinionInput): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  const dividendKeyPart = input.dividendTrend ? Math.round(input.dividendTrend.growthPercent) : "na";
  const cacheKey = `${input.ticker}:${input.score}:${Math.round(input.price)}:${dividendKeyPart}`;
  const cached = opinionCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < OPINION_CACHE_TTL_MS) return cached.text;

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 650,
      messages: [{ role: "user", content: buildPrompt(input) }],
    });

    const text = message.content.find((block) => block.type === "text")?.text?.trim() ?? "";
    if (!text) return null;

    opinionCache.set(cacheKey, { text, fetchedAt: Date.now() });
    return text;
  } catch (err) {
    logger.warn({ err, ticker: input.ticker }, "Anthropic pre-purchase opinion synthesis failed");
    return null;
  }
}
