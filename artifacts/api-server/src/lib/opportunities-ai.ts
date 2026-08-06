import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import type { Fundamentals, FiiSegment } from "./market-data";
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

// Números em pt-BR ANTES de entrar no prompt. O modelo copia literalmente o formato
// que recebe, então `toFixed()` fazia o card exibir "P/VP 0.62" e "21.0%" com ponto,
// no meio de uma interface que usa vírgula em todo o resto.
const N2 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const N1 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const num2 = (v: number | null | undefined) => (v != null ? N2.format(v) : "?");
const pct1 = (v: number | null | undefined) => (v != null ? N1.format(v * 100) : "?");

/**
 * Como ler desconto sobre valor patrimonial, por segmento de FII. Sem isso o modelo
 * trata qualquer P/VP abaixo de 1 como "potencial de recuperação de preço" — foi o
 * que escreveu sobre um FoF negociando 38% abaixo do patrimônio, quando nesse caso o
 * desconto é justamente o sinal a questionar.
 */
const NAV_DISCOUNT_CONTEXT: Record<FiiSegment, string> = {
  fof: "Este é um FII de fundos: o patrimônio dele são cotas de outros FIIs, líquidas e marcadas a mercado diariamente. Desconto grande sobre o valor patrimonial aqui NÃO é defasagem de laudo — é o mercado discordando da carteira ou precificando a segunda camada de taxa. Trate desconto profundo como pergunta, não como oportunidade.",
  papel: "Este é um FII de papel (CRI/LCI): o patrimônio é uma carteira de crédito. Desconto sobre valor patrimonial costuma refletir risco de inadimplência dos devedores que o laudo ainda não reconheceu, e yield alto costuma vir de CDI/IPCA elevados — que encolhem quando o juro cai.",
  tijolo: "Este é um FII de tijolo: o valor patrimonial vem de laudo de avaliação dos imóveis, que é periódico e pode estar defasado em relação ao mercado. Aqui desconto sobre patrimônio tem mais chance de ser oportunidade real, mas confira vacância e qualidade dos contratos antes de concluir.",
  hibrido: "Este é um FII híbrido: combina carteira de crédito e imóveis, então o desconto sobre patrimônio pode vir de qualquer um dos dois lados e não permite uma leitura única.",
};

function buildPrompt(
  entry: UniverseEntry,
  name: string,
  f: Fundamentals,
  analysis: AnalysisResult,
  fiiSegment: FiiSegment | null,
): string {
  return (
    `Você é um analista que escreve resumos curtos e objetivos de oportunidades de investimento em ` +
    `ações/FIIs/ETFs/BDRs da B3, para um app de carteira pessoal. NUNCA invente números — use somente ` +
    `os fornecidos abaixo, e escreva os números exatamente no formato em que aparecem (decimal com vírgula).\n\n` +
    `Ticker: ${entry.ticker} — ${name} (${entry.category})\n` +
    `Score do Radar: ${analysis.score}/100 (${analysis.scoreClassification})\n` +
    // Múltiplos arredondados ANTES de entrar no prompt: sem isso o modelo copia o
    // número cru na resposta e o card exibe coisas como "P/L 7.8125 e P/VP 0.8572569".
    // Os percentuais já vinham com toFixed; P/L, P/VP, dívida/patrimônio e beta não.
    `Fundamentos: P/L ${num2(f.priceEarnings)}, P/VP ${num2(f.priceToBook)}, ROE ${pct1(f.returnOnEquity)}%, ` +
    `Dívida/Patrimônio ${num2(f.debtToEquity)}, Margem líquida ${pct1(f.profitMargins)}%, ` +
    `Dividend Yield ${pct1(f.dividendYield)}%, ` +
    `Crescimento de receita ${pct1(f.revenueGrowth)}%, ` +
    `Variação 12m ${pct1(f.fiftyTwoWeekChange)}%, Beta ${num2(f.beta)}\n` +
    (fiiSegment ? `${NAV_DISCOUNT_CONTEXT[fiiSegment]}\n` : "") +
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
  fiiSegment: FiiSegment | null,
): Promise<OpportunityDescription | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [{ role: "user", content: buildPrompt(entry, name, fundamentals, analysis, fiiSegment) }],
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
