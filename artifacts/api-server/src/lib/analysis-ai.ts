import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import { describeMacroContext, type MacroContext } from "./macro-data";
import type { TaxEstimate } from "./tax-engine";
import type { DividendTrend } from "./market-data";
import { describeTechnicalIndicators, type TechnicalIndicators } from "./technical-engine";
import { describeRiskAdjustedMetrics, type RiskAdjustedMetrics } from "./risk-metrics-engine";
import { describeDuPontBreakdown, DEFAULT_CONCENTRATION_LIMITS, type ConcentrationLimits, type DuPontBreakdown } from "./analysis-engine";
import { describeFinancialHealth, type FinancialHealth } from "./financial-health-engine";
import { describeFiiProfile } from "./fii-engine";
import type { FiiProfile } from "./market-data";

const RECOMMENDATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // score/status não mudam mais de uma vez por dia

export interface AssetRecommendationInput {
  ticker: string;
  score: number;
  scoreClassification: string;
  status: string;
  positives: string[];
  risks: string[];
  newsItems: string[]; // já formatadas com "[Impacto] título" (formatHeadline)
  macro: MacroContext;
  tax: TaxEstimate | null; // null pra renda_fixa/fundos (regras de IR diferentes, fora do escopo daqui)
  positionPercent: number; // % do patrimônio total da carteira que esse ativo representa
  concentrationLimits?: ConcentrationLimits; // varia por perfil de investidor; sem perfil definido usa a régua do Moderado
  dividendTrend: DividendTrend | null; // null quando não há histórico real dos dois períodos (ver computeDividendTrend em market-data.ts) — nunca estimado
  technical: TechnicalIndicators | null; // null quando não há candles suficientes (technical-engine.ts)
  riskAdjusted: RiskAdjustedMetrics | null; // null quando não há candles suficientes (risk-metrics-engine.ts)
  duPont: DuPontBreakdown | null; // null quando DRE/balanço estão incompletos (computeDuPontBreakdown, analysis-engine.ts)
  financialHealth: FinancialHealth | null; // métricas de caixa/liquidez (financial-health-engine.ts) — null se o provider não trouxer nada
  sector: string | null; // usado só pra ressalva de comparabilidade em setor financeiro (ver describeFinancialHealth)
  fiiProfile: FiiProfile | null; // só pra FIIs — null pra qualquer outra categoria (ver getFiiProfiles)
  sectorComparison: string; // já formatado pelo chamador via describeSectorComparison (sector-benchmarks.ts) — precisa do Fundamentals bruto, que esse módulo não importa só por isso
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
  const { ticker, score, scoreClassification, status, positives, risks, newsItems, macro, tax, positionPercent, concentrationLimits, dividendTrend, technical, riskAdjusted, duPont, financialHealth, sector, fiiProfile, sectorComparison } = input;

  const taxLine = tax
    ? tax.exempt
      ? `Custo de IR estimado se vender agora: ISENTO (venda dentro da faixa de isenção de R$20 mil/mês pra ações). Ganho bruto estimado: R$${tax.grossGain.toFixed(2)}.`
      : `Custo de IR estimado se vender agora: R$${tax.taxOwed.toFixed(2)} (alíquota ${(tax.taxRate * 100).toFixed(0)}%, sobre ganho bruto de R$${tax.grossGain.toFixed(2)}), ganho líquido depois do IR: R$${tax.netGain.toFixed(2)}. Isso é uma ESTIMATIVA ISOLADA (assume ser a única venda de renda variável do usuário no mês — não sabemos se ele já usou a faixa de isenção de ações em outra venda, nem se tem prejuízo acumulado pra compensar).`
    : "Custo de IR: não calculado para esta categoria de ativo.";

  const limits = concentrationLimits ?? DEFAULT_CONCENTRATION_LIMITS;
  const concentrationLine =
    positionPercent >= limits.critical
      ? `Este ativo representa ${positionPercent.toFixed(1)}% do patrimônio total da carteira — concentração CRÍTICA para o perfil do investidor (acima de ${limits.critical}%). Mesmo com fundamentos bons, risco de posição único desse tamanho merece menção explícita.`
      : positionPercent >= limits.high
        ? `Este ativo representa ${positionPercent.toFixed(1)}% do patrimônio total da carteira — concentração ALTA para o perfil do investidor (acima de ${limits.high}%, faixa que profissionais costumam evitar fora de posições de altíssima convicção).`
        : `Este ativo representa ${positionPercent.toFixed(1)}% do patrimônio total da carteira — dentro de uma faixa de concentração razoável.`;

  const dividendTrendLine = dividendTrend
    ? `Proventos pagos nos últimos 12 meses: R$${dividendTrend.last12mTotal.toFixed(2)}/unidade, vs. R$${dividendTrend.prior12mTotal.toFixed(2)}/unidade nos 12 meses anteriores (variação de ${dividendTrend.growthPercent >= 0 ? "+" : ""}${dividendTrend.growthPercent.toFixed(1)}%). Provento crescendo de forma consistente é, historicamente, um sinal de qualidade mais forte que só o yield atual estar alto.`
    : "Histórico de provento nos últimos 24 meses insuficiente para avaliar tendência de crescimento (não avalie isso, apenas não mencione).";

  const technicalLine = describeTechnicalIndicators(technical);
  const riskAdjustedLine = describeRiskAdjustedMetrics(riskAdjusted);
  const duPontLine = describeDuPontBreakdown(duPont);
  const financialHealthLine = financialHealth ? describeFinancialHealth(financialHealth, sector) : "Métricas de caixa e liquidez não disponíveis para este ativo.";
  const fiiProfileLine = describeFiiProfile(fiiProfile);

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
    `${describeMacroContext(macro)}\n` +
    `${taxLine}\n` +
    `${concentrationLine}\n` +
    `${dividendTrendLine}\n` +
    `Indicadores técnicos (candles reais, 1 ano): ${technicalLine}\n` +
    `Retorno ajustado ao risco (1 ano, CDI como taxa livre de risco): ${riskAdjustedLine}\n` +
    `Decomposição DuPont do ROE: ${duPontLine}\n` +
    `Saúde financeira (caixa, liquidez, alavancagem): ${financialHealthLine}\n` +
    (fiiProfileLine ? `Perfil do FII: ${fiiProfileLine}\n` : "") +
    `Comparação com pares do setor: ${sectorComparison}\n\n` +
    `Escreva um parágrafo curto (2-6 frases) cruzando TODOS os fatores acima. Quando os fundamentos ` +
    `justificarem (status VENDER, ou risco relevante nos pontos de atenção), pode ` +
    `dizer explicitamente que faz sentido considerar reduzir ou encerrar a posição — não fique só em ` +
    `"observe" quando o caso pedir mais que isso. Quando os pontos de atenção envolverem piora de ROE, ` +
    `dívida subindo ou desaceleração de crescimento, pode enquadrar isso como enfraquecimento da vantagem ` +
    `competitiva do negócio (moat) quando fizer sentido, e não só citar os números soltos. Use a ` +
    `decomposição DuPont pra qualificar o ROE, não só repeti-lo — um ROE alto puxado majoritariamente por ` +
    `alavancagem é um sinal de qualidade bem diferente de um ROE alto puxado por margem operacional forte, ` +
    `mesmo com o mesmo número final. Use a saúde financeira como o teste mais duro de sustentabilidade de dividendo: cobertura por fluxo de caixa livre abaixo de 1x significa que a empresa distribuiu mais caixa do que gerou no período — isso pesa MAIS que um payout ratio contábil confortável, porque payout usa lucro e lucro não paga dividendo, caixa paga. Dívida líquida alta sobre EBITDA agrava esse quadro (empresa alavancada corta dividendo antes de deixar de pagar credor). Respeite a ressalva de comparabilidade quando ela aparecer. Se houver linha de perfil de FII, use o segmento pra qualificar o yield em vez de tratá-lo como número solto: yield alto em fundo de papel costuma refletir juro alto e encolhe no ciclo de queda, enquanto em fundo de tijolo reflete aluguel contratado; FoF carrega taxa em duas camadas. Use a comparação com o setor como contexto, nunca como sinal ` +
    `automático — um múltiplo mais barato que a média do setor pode ser uma oportunidade real ou um ` +
    `desconto justificado por fundamentos piores; interprete à luz dos outros dados, não trate ` +
    `"mais barato que o setor" como sinônimo de "melhor". Mas pese o ` +
    `custo de IR: se o imposto estimado comer boa parte do ganho (ou a posição estiver isenta e for ` +
    `barato sair), diga isso explicitamente como parte do raciocínio — às vezes o correto é "os ` +
    `fundamentos pioraram, mas o IR torna a saída agora pouco vantajosa, vale reavaliar perto de ` +
    `[condição]" em vez de uma saída imediata. Se a concentração estiver alta ou crítica, pondere isso ` +
    `mesmo quando os fundamentos estiverem bons — risco de posição é risco de carteira, não só de ativo. ` +
    `Use o indicador técnico como contexto de TIMING, nunca como fator decisório principal — os ` +
    `fundamentos sempre vêm primeiro; mencione o técnico só quando ele reforçar ou contradizer de forma ` +
    `relevante a leitura fundamentalista (ex.: "fundamentos deterioraram e o RSI já mostra sobrevenda, ` +
    `pouco espaço pra piorar mais no curto prazo" ou "fundamentos sólidos, mas tecnicamente esticado pelo ` +
    `RSI, talvez valha esperar uma correção pra reforçar"). Use o Sharpe/Sortino/Treynor como contexto de ` +
    `qualidade do retorno passado (retorno alto com Sharpe baixo indica que o retorno veio à custa de ` +
    `volatilidade desproporcional, não de qualidade) — mencione só quando destoar claramente do que os ` +
    `fundamentos sozinhos sugeririam. NÃO invente nenhum dado que não esteja listado acima. NÃO proponha um score ou status diferente do ` +
    `informado — a decisão de score é sempre do motor determinístico, você só interpreta. NÃO trate o ` +
    `valor de IR como exato — é uma estimativa isolada, deixe isso implícito no texto sem precisar repetir ` +
    `a ressalva inteira. Evite muletas vagas como "observe", "acompanhe" ou "fique atento" — só recorra a ` +
    `esse tipo de linguagem quando genuinamente não houver dado suficiente pra uma conclusão mais forte. A ` +
    `última frase do parágrafo deve indicar claramente a implicação prática (manter, aumentar, reduzir, ` +
    `vender ou reavaliar a posição), coerente com o status informado.\n\n` +
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

  // Inclui IR, % de concentração, tendência de dividendo e sinal técnico (arredondados/
  // bucketizados) na chave — mudam com o preço/patrimônio todo dia, mesmo quando
  // score/status ficam parados dentro do TTL de 24h.
  const taxKeyPart = input.tax ? Math.round(input.tax.taxOwed) : "na";
  const positionKeyPart = Math.round(input.positionPercent / 5) * 5;
  const dividendKeyPart = input.dividendTrend ? Math.round(input.dividendTrend.growthPercent) : "na";
  const technicalKeyPart = input.technical
    ? `${input.technical.crossSignal ?? "na"}:${input.technical.rsi14 != null ? Math.round(input.technical.rsi14 / 5) * 5 : "na"}`
    : "na";
  const riskAdjustedKeyPart = input.riskAdjusted ? Math.round(input.riskAdjusted.sharpeRatio * 10) : "na";
  const cacheKey = `${input.ticker}:${input.score}:${input.status}:${taxKeyPart}:${positionKeyPart}:${dividendKeyPart}:${technicalKeyPart}:${riskAdjustedKeyPart}`;
  const cached = recommendationCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < RECOMMENDATION_CACHE_TTL_MS) return cached.text;

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 750, // 2-6 frases cruzando fundamentos+notícias+macro+IR+concentração+dividendo+técnico passam de 650 com o prompt maior — mesma lição da truncagem anterior
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
