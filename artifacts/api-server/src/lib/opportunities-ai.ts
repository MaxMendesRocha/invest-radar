import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import type { Fundamentals } from "./market-data";
import type { AnalysisResult } from "./analysis-engine";
import type { UniverseEntry } from "./ticker-universe";

const HORIZONS = ["Curto prazo", "Médio prazo", "Longo prazo"] as const;
type Horizon = (typeof HORIZONS)[number];

export interface OpportunityDescription {
  reason: string;
  positives: string[];
  risks: string[];
  horizon: Horizon;
}

let anthropicClient: Anthropic | null | undefined;

function getClient(): Anthropic | null {
  if (anthropicClient !== undefined) return anthropicClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  anthropicClient = apiKey ? new Anthropic({ apiKey }) : null;
  return anthropicClient;
}

function buildPrompt(entry: UniverseEntry, name: string, f: Fundamentals, analysis: AnalysisResult): string {
  return (
    `Você é um analista que escreve resumos curtos e objetivos de oportunidades de investimento em ` +
    `ações/FIIs/ETFs/BDRs da B3, para um app de carteira pessoal. NUNCA invente números — use somente ` +
    `os fornecidos abaixo.\n\n` +
    `Ticker: ${entry.ticker} — ${name} (${entry.category})\n` +
    `Score do Radar: ${analysis.score}/100 (${analysis.scoreClassification})\n` +
    `Fundamentos: P/L ${f.priceEarnings ?? "?"}, P/VP ${f.priceToBook ?? "?"}, ROE ${f.returnOnEquity != null ? (f.returnOnEquity * 100).toFixed(1) : "?"}%, ` +
    `Dívida/Patrimônio ${f.debtToEquity ?? "?"}, Margem líquida ${f.profitMargins != null ? (f.profitMargins * 100).toFixed(1) : "?"}%, ` +
    `Dividend Yield ${f.dividendYield != null ? (f.dividendYield * 100).toFixed(1) : "?"}%, ` +
    `Crescimento de receita ${f.revenueGrowth != null ? (f.revenueGrowth * 100).toFixed(1) : "?"}%, ` +
    `Variação 12m ${f.fiftyTwoWeekChange != null ? (f.fiftyTwoWeekChange * 100).toFixed(1) : "?"}%, Beta ${f.beta ?? "?"}\n` +
    `Pontos positivos calculados: ${analysis.positives.join("; ") || "nenhum"}\n` +
    `Pontos de atenção calculados: ${analysis.risks.join("; ") || "nenhum"}\n\n` +
    `Retorne SOMENTE um JSON válido, sem texto fora dele, no formato:\n` +
    `{"reason": "1-2 frases explicando por que este ativo é uma oportunidade, cruzando os fundamentos", ` +
    `"positives": ["até 3 frases curtas reescrevendo os pontos positivos de forma mais natural"], ` +
    `"risks": ["até 3 frases curtas reescrevendo os pontos de atenção de forma mais natural"], ` +
    `"horizon": "Curto prazo" | "Médio prazo" | "Longo prazo"}`
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

// O modelo às vezes envolve o JSON num bloco de código markdown (```json ... ```)
// apesar do prompt pedir "SOMENTE o JSON" — extrai o primeiro objeto `{...}` do
// texto em vez de confiar que a resposta é JSON puro.
function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

function parseResponse(text: string): OpportunityDescription | null {
  const jsonText = extractJson(text);
  if (!jsonText) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;

  if (typeof candidate.reason !== "string" || !candidate.reason.trim()) return null;
  if (!isStringArray(candidate.positives) || !isStringArray(candidate.risks)) return null;
  const horizon = HORIZONS.includes(candidate.horizon as Horizon) ? (candidate.horizon as Horizon) : "Médio prazo";

  return { reason: candidate.reason, positives: candidate.positives, risks: candidate.risks, horizon };
}

/**
 * Reescreve reason/positives/risks/horizon em texto mais natural via Claude, a
 * partir de números e classificações já calculados deterministicamente — a IA
 * nunca decide score, riskLevel ou quais ativos entram na lista. Pede JSON
 * estruturado mas NÃO confia cegamente: valida forma e conteúdo antes de usar;
 * qualquer falha (sem API key, erro de rede, JSON malformado, campo faltando) faz
 * o chamador (opportunities-engine.ts) cair no fallback determinístico usando os
 * positives/risks já calculados pelo analysis-engine.
 */
export async function describeOpportunity(
  entry: UniverseEntry,
  name: string,
  fundamentals: Fundamentals,
  analysis: AnalysisResult,
): Promise<OpportunityDescription | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [{ role: "user", content: buildPrompt(entry, name, fundamentals, analysis) }],
    });

    const text = message.content.find((block) => block.type === "text")?.text?.trim() ?? "";
    const parsed = parseResponse(text);
    if (!parsed) {
      logger.warn({ ticker: entry.ticker, text }, "Anthropic opportunity description returned invalid JSON");
    }
    return parsed;
  } catch (err) {
    logger.warn({ err, ticker: entry.ticker }, "Anthropic opportunity description failed");
    return null;
  }
}
