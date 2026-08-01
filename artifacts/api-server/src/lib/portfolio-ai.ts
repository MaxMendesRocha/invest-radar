import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";

const DIAGNOSIS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface PortfolioDiagnosisInput {
  score: number;
  classification: string;
  diversification: number;
  concentration: number;
  risk: number;
  dividends: number;
  growth: number;
  composition: { ticker: string; category: string; percent: number }[];
  macro: { selic: number | null; selicTrend: string | null; ipca12m: number | null };
}

let anthropicClient: Anthropic | null | undefined;

function getClient(): Anthropic | null {
  if (anthropicClient !== undefined) return anthropicClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  anthropicClient = apiKey ? new Anthropic({ apiKey }) : null;
  return anthropicClient;
}

const diagnosisCache = new Map<string, { text: string; fetchedAt: number }>();

function buildPrompt(input: PortfolioDiagnosisInput): string {
  const { score, classification, diversification, concentration, risk, dividends, growth, composition, macro } = input;
  const compositionText = composition.map((c) => `${c.ticker} (${c.category}): ${c.percent.toFixed(1)}%`).join(", ");
  return (
    `Você é um consultor de carteira de investimentos pessoal explicando, de forma acessível e em ` +
    `português do Brasil, o resultado de um score de saúde de carteira JÁ CALCULADO. Você não deve ` +
    `recalcular nem propor um score diferente.\n\n` +
    `Score geral: ${score}/100 (${classification})\n` +
    `Diversificação: ${diversification}/100\n` +
    `Concentração: ${concentration}/100\n` +
    `Risco: ${risk}/100\n` +
    `Dividendos: ${dividends}/100\n` +
    `Crescimento: ${growth}/100\n` +
    `Composição: ${compositionText || "carteira vazia"}\n` +
    `Cenário macro: Selic ${macro.selic ?? "?"}% (tendência ${macro.selicTrend ?? "?"}), IPCA 12m ${macro.ipca12m ?? "?"}%\n\n` +
    `Escreva um diagnóstico qualitativo (3-5 frases) explicando os pontos fortes e fracos desta ` +
    `carteira com base SOMENTE nos números acima — interprete, não repita os números literalmente. ` +
    `Não invente nenhum dado novo.\n\n` +
    `Formato de saída: texto plano, sem markdown, 3-5 frases.`
  );
}

/**
 * Diagnóstico qualitativo via Claude por cima do score de saúde já calculado
 * deterministicamente em routes/portfolio.ts — a IA nunca recalcula o score, só
 * interpreta os números em texto. Retorna null sem ANTHROPIC_API_KEY ou em caso de
 * erro; o campo `aiDiagnosis` da resposta simplesmente fica null nesse caso.
 */
export async function synthesizePortfolioDiagnosis(input: PortfolioDiagnosisInput): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  const cacheKey = JSON.stringify({
    score: input.score,
    diversification: input.diversification,
    concentration: input.concentration,
    risk: input.risk,
    dividends: input.dividends,
    growth: input.growth,
  });
  const cached = diagnosisCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < DIAGNOSIS_CACHE_TTL_MS) return cached.text;

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{ role: "user", content: buildPrompt(input) }],
    });

    const text = message.content.find((block) => block.type === "text")?.text?.trim() ?? "";
    if (!text) return null;

    diagnosisCache.set(cacheKey, { text, fetchedAt: Date.now() });
    return text;
  } catch (err) {
    logger.warn({ err }, "Anthropic portfolio diagnosis synthesis failed");
    return null;
  }
}
