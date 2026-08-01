import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";

const RECOMMENDATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // score/status não mudam mais de uma vez por dia

export interface AssetRecommendationInput {
  ticker: string;
  score: number;
  scoreClassification: string;
  status: string;
  positives: string[];
  risks: string[];
  newsItems: string[]; // já formatadas com "[Impacto] título" (formatHeadline)
  macro: { selic: number | null; selicTrend: string | null; ipca12m: number | null };
}

let anthropicClient: Anthropic | null | undefined;

function getClient(): Anthropic | null {
  if (anthropicClient !== undefined) return anthropicClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  anthropicClient = apiKey ? new Anthropic({ apiKey }) : null;
  return anthropicClient;
}

const recommendationCache = new Map<string, { text: string; fetchedAt: number }>();

function buildPrompt(input: AssetRecommendationInput): string {
  const { ticker, score, scoreClassification, status, positives, risks, newsItems, macro } = input;
  return (
    `Você é um analista financeiro assistente de um app pessoal de acompanhamento de carteira ` +
    `(não é recomendação formal de investimento). Escreva em português do Brasil, de forma objetiva.\n\n` +
    `Ativo: ${ticker}\n` +
    `Score do Radar: ${score}/100 (${scoreClassification}), status: ${status}\n` +
    `Pontos positivos (fundamentos reais): ${positives.join("; ") || "nenhum"}\n` +
    `Pontos de atenção (fundamentos reais): ${risks.join("; ") || "nenhum"}\n` +
    `Notícias recentes classificadas: ${newsItems.join(" | ") || "nenhuma"}\n` +
    `Cenário macro: Selic ${macro.selic ?? "?"}% (tendência ${macro.selicTrend ?? "?"}), IPCA 12m ${macro.ipca12m ?? "?"}%\n\n` +
    `Escreva um parágrafo curto (2-4 frases) de recomendação de monitoramento, cruzando fundamentos, ` +
    `notícias e macro acima. NÃO invente nenhum dado que não esteja listado. NÃO proponha um score ` +
    `diferente do informado. Não dê conselho categórico de compra/venda — foque em "o que observar".\n\n` +
    `Formato de saída: texto plano, sem markdown, 2-4 frases.`
  );
}

/**
 * Síntese qualitativa via Claude por cima do score/positivos/riscos já calculados
 * deterministicamente — a IA nunca recalcula o score, só escreve o texto de
 * acompanhamento cruzando fundamentos + notícias + macro. Retorna null sem
 * ANTHROPIC_API_KEY ou em caso de erro, pra o chamador cair no texto determinístico
 * de sempre (buildRecommendation em analysis-engine.ts) em vez de quebrar a geração.
 */
export async function synthesizeAssetRecommendation(input: AssetRecommendationInput): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  const cacheKey = `${input.ticker}:${input.score}:${input.status}`;
  const cached = recommendationCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < RECOMMENDATION_CACHE_TTL_MS) return cached.text;

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{ role: "user", content: buildPrompt(input) }],
    });

    const text = message.content.find((block) => block.type === "text")?.text?.trim() ?? "";
    if (!text) return null;

    recommendationCache.set(cacheKey, { text, fetchedAt: Date.now() });
    return text;
  } catch (err) {
    logger.warn({ err, ticker: input.ticker }, "Anthropic asset recommendation synthesis failed");
    return null;
  }
}
