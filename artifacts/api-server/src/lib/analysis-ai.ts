import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import type { TaxEstimate } from "./tax-engine";
import type { DividendTrend } from "./market-data";

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
  tax: TaxEstimate | null; // null pra renda_fixa/fundos (regras de IR diferentes, fora do escopo daqui)
  positionPercent: number; // % do patrimônio total da carteira que esse ativo representa
  dividendTrend: DividendTrend | null; // null quando não há histórico real dos dois períodos (ver computeDividendTrend em market-data.ts) — nunca estimado
}

let anthropicClient: Anthropic | null | undefined;

function getClient(): Anthropic | null {
  if (anthropicClient !== undefined) return anthropicClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  anthropicClient = apiKey ? new Anthropic({ apiKey }) : null;
  return anthropicClient;
}

const recommendationCache = new Map<string, { text: string; fetchedAt: number }>();

// Mesmos limiares de computeConcentrationAlerts (routes/analysis.ts) — mantém a
// leitura qualitativa da IA alinhada com o alerta determinístico que a carteira já
// dispara, em vez de inventar um segundo critério de concentração.
const CONCENTRATION_HIGH = 25;
const CONCENTRATION_CRITICAL = 40;

function buildPrompt(input: AssetRecommendationInput): string {
  const { ticker, score, scoreClassification, status, positives, risks, newsItems, macro, tax, positionPercent, dividendTrend } = input;

  const taxLine = tax
    ? tax.exempt
      ? `Custo de IR estimado se vender agora: ISENTO (venda dentro da faixa de isenção de R$20 mil/mês pra ações). Ganho bruto estimado: R$${tax.grossGain.toFixed(2)}.`
      : `Custo de IR estimado se vender agora: R$${tax.taxOwed.toFixed(2)} (alíquota ${(tax.taxRate * 100).toFixed(0)}%, sobre ganho bruto de R$${tax.grossGain.toFixed(2)}), ganho líquido depois do IR: R$${tax.netGain.toFixed(2)}. Isso é uma ESTIMATIVA ISOLADA (assume ser a única venda de renda variável do usuário no mês — não sabemos se ele já usou a faixa de isenção de ações em outra venda, nem se tem prejuízo acumulado pra compensar).`
    : "Custo de IR: não calculado para esta categoria de ativo.";

  const concentrationLine =
    positionPercent >= CONCENTRATION_CRITICAL
      ? `Este ativo representa ${positionPercent.toFixed(1)}% do patrimônio total da carteira — concentração CRÍTICA (acima de ${CONCENTRATION_CRITICAL}%). Mesmo com fundamentos bons, risco de posição único desse tamanho merece menção explícita.`
      : positionPercent >= CONCENTRATION_HIGH
        ? `Este ativo representa ${positionPercent.toFixed(1)}% do patrimônio total da carteira — concentração ALTA (acima de ${CONCENTRATION_HIGH}%, faixa que profissionais costumam evitar fora de posições de altíssima convicção).`
        : `Este ativo representa ${positionPercent.toFixed(1)}% do patrimônio total da carteira — dentro de uma faixa de concentração razoável.`;

  const dividendTrendLine = dividendTrend
    ? `Proventos pagos nos últimos 12 meses: R$${dividendTrend.last12mTotal.toFixed(2)}/unidade, vs. R$${dividendTrend.prior12mTotal.toFixed(2)}/unidade nos 12 meses anteriores (variação de ${dividendTrend.growthPercent >= 0 ? "+" : ""}${dividendTrend.growthPercent.toFixed(1)}%). Provento crescendo de forma consistente é, historicamente, um sinal de qualidade mais forte que só o yield atual estar alto.`
    : "Histórico de provento nos últimos 24 meses insuficiente para avaliar tendência de crescimento (não avalie isso, apenas não mencione).";

  return (
    `Você é um analista financeiro sênior atuando como consultor pessoal do dono desta carteira — ` +
    `não é um produto vendido a terceiros, é uma ferramenta de uso individual, então pode e deve ser ` +
    `direto nas suas leituras, como um analista de verdade seria numa conversa privada com o cliente. ` +
    `Escreva em português do Brasil, de forma objetiva.\n\n` +
    `Ativo: ${ticker}\n` +
    `Score do Radar: ${score}/100 (${scoreClassification}), status: ${status}\n` +
    `Pontos positivos (fundamentos reais): ${positives.join("; ") || "nenhum"}\n` +
    `Pontos de atenção (fundamentos reais): ${risks.join("; ") || "nenhum"}\n` +
    `Notícias recentes classificadas: ${newsItems.join(" | ") || "nenhuma"}\n` +
    `Cenário macro: Selic ${macro.selic ?? "?"}% (tendência ${macro.selicTrend ?? "?"}), IPCA 12m ${macro.ipca12m ?? "?"}%\n` +
    `${taxLine}\n` +
    `${concentrationLine}\n` +
    `${dividendTrendLine}\n\n` +
    `Escreva um parágrafo curto (2-6 frases) cruzando TODOS os fatores acima. Quando os fundamentos ` +
    `justificarem (status REAVALIAR ou POSSIVEL_SAIDA, ou risco relevante nos pontos de atenção), pode ` +
    `dizer explicitamente que faz sentido considerar reduzir ou encerrar a posição — não fique só em ` +
    `"observe" quando o caso pedir mais que isso. Quando os pontos de atenção envolverem piora de ROE, ` +
    `dívida subindo ou desaceleração de crescimento, pode enquadrar isso como enfraquecimento da vantagem ` +
    `competitiva do negócio (moat) quando fizer sentido, e não só citar os números soltos. Mas pese o ` +
    `custo de IR: se o imposto estimado comer boa parte do ganho (ou a posição estiver isenta e for ` +
    `barato sair), diga isso explicitamente como parte do raciocínio — às vezes o correto é "os ` +
    `fundamentos pioraram, mas o IR torna a saída agora pouco vantajosa, vale reavaliar perto de ` +
    `[condição]" em vez de uma saída imediata. Se a concentração estiver alta ou crítica, pondere isso ` +
    `mesmo quando os fundamentos estiverem bons — risco de posição é risco de carteira, não só de ativo. ` +
    `NÃO invente nenhum dado que não esteja listado acima. NÃO proponha um score ou status diferente do ` +
    `informado — a decisão de score é sempre do motor determinístico, você só interpreta. NÃO trate o ` +
    `valor de IR como exato — é uma estimativa isolada, deixe isso implícito no texto sem precisar repetir ` +
    `a ressalva inteira.\n\n` +
    `Formato de saída: texto plano, sem markdown, 2-6 frases.`
  );
}

/**
 * Síntese qualitativa via Claude por cima do score/positivos/riscos já calculados
 * deterministicamente — a IA nunca recalcula o score, só escreve o texto de
 * acompanhamento cruzando fundamentos + notícias + macro + custo de IR estimado
 * (tax-engine.ts), podendo recomendar explicitamente considerar reduzir/encerrar
 * a posição quando os fatores apontarem nessa direção. Retorna null sem
 * ANTHROPIC_API_KEY ou em caso de erro, pra o chamador cair no texto determinístico
 * de sempre (buildRecommendation em analysis-engine.ts) em vez de quebrar a geração.
 */
export async function synthesizeAssetRecommendation(input: AssetRecommendationInput): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  // Inclui IR, % de concentração (bucket de 5 em 5) e tendência de dividendo
  // (arredondados) na chave — mudam com o preço/patrimônio todo dia, mesmo quando
  // score/status ficam parados dentro do TTL de 24h.
  const taxKeyPart = input.tax ? Math.round(input.tax.taxOwed) : "na";
  const positionKeyPart = Math.round(input.positionPercent / 5) * 5;
  const dividendKeyPart = input.dividendTrend ? Math.round(input.dividendTrend.growthPercent) : "na";
  const cacheKey = `${input.ticker}:${input.score}:${input.status}:${taxKeyPart}:${positionKeyPart}:${dividendKeyPart}`;
  const cached = recommendationCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < RECOMMENDATION_CACHE_TTL_MS) return cached.text;

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 650, // 2-6 frases cruzando fundamentos+notícias+macro+IR+concentração+dividendo passam de 500 com o prompt maior — mesma lição da truncagem anterior
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
