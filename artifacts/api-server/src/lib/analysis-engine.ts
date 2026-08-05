import type { Fundamentals } from "./market-data";

export type AnalysisStatus = "MANTER" | "ATENCAO" | "REAVALIAR" | "POSSIVEL_SAIDA";
export type ScoreClassification = "Excelente" | "Forte" | "Estavel" | "Atencao" | "Critico";

export interface AnalysisResult {
  available: boolean;
  score: number;
  scoreClassification: ScoreClassification;
  status: AnalysisStatus;
  positives: string[];
  risks: string[];
  monitoringRecommendation: string;
}

interface MetricEval {
  score: number;
  positive?: string;
  risk?: string;
}

function evalPE(pe: number | null): MetricEval | null {
  if (pe == null) return null;
  if (pe <= 0) return { score: 20, risk: "Empresa reportou prejuízo no período (P/L negativo)" };
  if (pe <= 15) return { score: 90, positive: "P/L atrativo frente à média histórica do mercado" };
  if (pe <= 25) return { score: 65 };
  return { score: 35, risk: "P/L elevado — valuation esticado frente aos fundamentos" };
}

function evalPriceToBook(pb: number | null): MetricEval | null {
  if (pb == null) return null;
  if (pb <= 1) return { score: 90, positive: "Negociado abaixo do valor patrimonial (P/VP ≤ 1)" };
  if (pb <= 2.5) return { score: 65 };
  return { score: 40, risk: "P/VP elevado frente ao valor patrimonial" };
}

function evalROE(roe: number | null): MetricEval | null {
  if (roe == null) return null;
  if (roe < 0) return { score: 20, risk: "Retorno sobre patrimônio (ROE) negativo" };
  if (roe >= 0.15) return { score: 90, positive: "ROE elevado — boa geração de retorno sobre o patrimônio" };
  if (roe >= 0.08) return { score: 65 };
  return { score: 45 };
}

export interface DuPontBreakdown {
  taxBurden: number; // netIncome / incomeBeforeTax — quanto do lucro antes de impostos sobra depois deles
  interestBurden: number; // incomeBeforeTax / ebit — quanto do EBIT sobra depois das despesas financeiras
  ebitMargin: number; // ebit / totalRevenue
  assetTurnover: number; // totalRevenue / totalAssets — eficiência de uso dos ativos
  leverage: number; // totalAssets / shareholdersEquity — multiplicador de alavancagem
}

// Precisa vir de fora — analysis-engine.ts não importa nada de market-data.ts além
// de Fundamentals, e revenueGrowth já é derivado ali a partir de totalRevenue (que
// não é exposto cru). Aqui recebemos totalRevenue explicitamente porque a
// decomposição DuPont precisa dele — os outros 5 insumos já estão em Fundamentals.
interface DuPontInput {
  totalRevenue: number | null;
  netIncome: number | null;
  incomeBeforeTax: number | null;
  ebit: number | null;
  totalAssets: number | null;
  shareholdersEquity: number | null;
}

// Decomposição de 5 fatores do ROE (padrão CFA/DuPont estendido) — interpretativa,
// não entra na pontuação (o ROE bruto já é avaliado por evalROE acima; decompor de
// novo aqui contaria o mesmo fundamento duas vezes no score). Só calcula quando os 6
// insumos reais estão disponíveis — nunca uma decomposição parcial ou estimada.
export function computeDuPontBreakdown(input: DuPontInput): DuPontBreakdown | null {
  const { totalRevenue, netIncome, incomeBeforeTax, ebit, totalAssets, shareholdersEquity } = input;
  if (
    totalRevenue == null || totalRevenue === 0 ||
    netIncome == null ||
    incomeBeforeTax == null || incomeBeforeTax === 0 ||
    ebit == null || ebit === 0 ||
    totalAssets == null || totalAssets === 0 ||
    shareholdersEquity == null || shareholdersEquity === 0
  ) {
    return null;
  }

  return {
    taxBurden: netIncome / incomeBeforeTax,
    interestBurden: incomeBeforeTax / ebit,
    ebitMargin: ebit / totalRevenue,
    assetTurnover: totalRevenue / totalAssets,
    leverage: totalAssets / shareholdersEquity,
  };
}

// Identifica o fator que mais se distancia de um "neutro" de referência (giro de
// ativos ~1x é o único que não tem teto natural — os outros 4 têm faixa 0-1 ou perto
// disso) e usa isso pra apontar qual alavanca domina o ROE, em vez de só listar os 5
// números — é a leitura que a decomposição DuPont existe pra habilitar.
export function describeDuPontBreakdown(d: DuPontBreakdown | null): string {
  if (!d) return "Decomposição de ROE não disponível (DRE/balanço incompletos para este ativo).";

  const roeCheck = d.taxBurden * d.interestBurden * d.ebitMargin * d.assetTurnover * d.leverage;
  const parts = [
    `carga tributária ${(d.taxBurden * 100).toFixed(0)}%`,
    `carga de juros ${(d.interestBurden * 100).toFixed(0)}%`,
    `margem EBIT ${(d.ebitMargin * 100).toFixed(1)}%`,
    `giro de ativos ${d.assetTurnover.toFixed(2)}x`,
    `alavancagem ${d.leverage.toFixed(2)}x`,
  ];

  const driver =
    d.leverage >= 2.5
      ? " — alavancagem elevada é o fator que mais se destaca nesse ROE, não a operação em si"
      : d.ebitMargin >= 0.25
        ? " — margem operacional forte é o fator que mais se destaca nesse ROE"
        : d.assetTurnover >= 1.5
          ? " — giro de ativos elevado (eficiência operacional) é o fator que mais se destaca nesse ROE"
          : "";

  return `ROE de ${(roeCheck * 100).toFixed(1)}% decomposto em: ${parts.join(", ")}${driver}.`;
}

function evalDebtToEquity(de: number | null): MetricEval | null {
  if (de == null) return null;
  if (de <= 0.5) return { score: 90, positive: "Baixo endividamento em relação ao patrimônio" };
  if (de <= 1.5) return { score: 65 };
  return { score: 40, risk: "Endividamento elevado em relação ao patrimônio" };
}

function evalMargin(margin: number | null): MetricEval | null {
  if (margin == null) return null;
  if (margin < 0) return { score: 25, risk: "Margem líquida negativa no período" };
  if (margin >= 0.15) return { score: 85, positive: "Margens líquidas saudáveis" };
  if (margin >= 0.05) return { score: 60 };
  return { score: 35, risk: "Margens líquidas reduzidas" };
}

export function evalDividendYield(dy: number | null): MetricEval | null {
  if (dy == null) return null;
  if (dy >= 0.06) return { score: 85, positive: "Dividend yield acima da média do mercado" };
  if (dy >= 0.03) return { score: 60 };
  return { score: 45 };
}

// Payout ratio real = DPS dos últimos 12 meses (soma real de proventos pagos, ver
// sumLast12Months em market-data.ts — usa só a janela de 12 meses, não os 24 exigidos
// por computeDividendTrend, pra não descartar dado real disponível quando o provider
// não cobre os 12 meses anteriores) dividido pelo EPS (price/priceEarnings — não há
// campo de EPS direto no plano atual, mas dá pra derivar do P/L, que já é real). Só
// avalia quando há prova de que o ativo de fato pagou provento no período
// (dps12m != null) — sem isso, não dá pra saber payout nenhum, não vira 0. P/L
// negativo com provento pago no período é o pior caso: empresa distribuindo mesmo
// reportando prejuízo — sinal de alerta explícito, não descartado como null.
function evalPayoutRatio(priceEarnings: number | null, price: number, dps12m: number | null): MetricEval | null {
  if (dps12m == null || dps12m <= 0) return null;
  if (priceEarnings == null) return null;
  if (priceEarnings <= 0) {
    return { score: 15, risk: "Distribuiu proventos mesmo reportando prejuízo no período — sustentabilidade do pagamento em risco" };
  }
  const eps = price / priceEarnings;
  if (eps <= 0) return null;
  const payoutRatio = dps12m / eps;
  if (payoutRatio <= 0.6) return { score: 85, positive: "Distribuição bem coberta pelo lucro (payout ratio saudável)" };
  if (payoutRatio <= 1.0) return { score: 55 };
  return { score: 20, risk: "Distribuição acima do lucro do período (payout ratio acima de 100%) — sustentabilidade em risco" };
}

export function evalRevenueGrowth(growth: number | null): MetricEval | null {
  if (growth == null) return null;
  if (growth >= 0.05) return { score: 80, positive: "Crescimento de receita consistente" };
  if (growth >= -0.05) return { score: 55 };
  return { score: 30, risk: "Queda de receita no período" };
}

function evalTrend(change52w: number | null): MetricEval | null {
  if (change52w == null) return null;
  if (change52w >= 0.2) return { score: 90, positive: "Forte valorização nos últimos 12 meses" };
  if (change52w >= 0) return { score: 65 };
  if (change52w >= -0.15) return { score: 45 };
  return { score: 25, risk: "Forte desvalorização nos últimos 12 meses" };
}

export function evalVolatility(beta: number | null): MetricEval | null {
  if (beta == null) return null;
  if (beta <= 0.7) return { score: 85, positive: "Baixa volatilidade frente ao mercado (beta baixo)" };
  if (beta <= 1.2) return { score: 65 };
  return { score: 40, risk: "Alta volatilidade frente ao mercado (beta elevado)" };
}

function scoreClassification(score: number): ScoreClassification {
  if (score >= 90) return "Excelente";
  if (score >= 75) return "Forte";
  if (score >= 60) return "Estavel";
  if (score >= 40) return "Atencao";
  return "Critico";
}

function statusFromScore(score: number): AnalysisStatus {
  if (score >= 75) return "MANTER";
  if (score >= 60) return "ATENCAO";
  if (score >= 40) return "REAVALIAR";
  return "POSSIVEL_SAIDA";
}

function buildRecommendation(risks: string[]): string {
  if (risks.length === 0) {
    return "Fundamentos sólidos no momento. Acompanhar os próximos resultados trimestrais e eventuais mudanças no cenário macroeconômico.";
  }
  return `Principal ponto de atenção: ${risks[0].toLowerCase()}. Acompanhar os próximos resultados trimestrais para confirmar se a tendência se mantém.`;
}

const NO_FUNDAMENTALS_RESULT: AnalysisResult = {
  available: false,
  score: 0,
  scoreClassification: "Estavel",
  status: "MANTER",
  positives: [],
  risks: [],
  monitoringRecommendation: "Dados fundamentalistas não disponíveis para este ativo no momento.",
};

const NOT_QUOTED_RESULT: AnalysisResult = {
  available: true,
  score: 60,
  scoreClassification: "Estavel",
  status: "MANTER",
  positives: [],
  risks: [],
  monitoringRecommendation: "Ativo de renda fixa ou fundo sem ticker de bolsa — fora do escopo da análise fundamentalista automatizada.",
};

// Fallback pra quando getFundamentals() não devolve dado real pra um ticker
// específico (falha pontual do provider, ticker sem cobertura) — "Em breve" em vez
// de fingir um score completo. Ver `computeAnalysis` em routes/analysis.ts.
const PENDING_RESULT: AnalysisResult = {
  available: false,
  score: 0,
  scoreClassification: "Estavel",
  status: "MANTER",
  positives: [],
  risks: [],
  monitoringRecommendation: "Não foi possível obter os fundamentos deste ativo agora — tente gerar a análise novamente em alguns minutos.",
};

export function analysisForUnquotedAsset(): AnalysisResult {
  return NOT_QUOTED_RESULT;
}

export function pendingAnalysis(): AnalysisResult {
  return PENDING_RESULT;
}

// Exportado pra GET /analysis/opinion/:ticker (routes/analysis.ts) reaproveitar o mesmo
// fallback quando um ticker tem cotação mas nenhum fundamento aproveitável — em vez de
// duplicar a mensagem.
export function noFundamentalsAnalysis(): AnalysisResult {
  return NO_FUNDAMENTALS_RESULT;
}

/**
 * Deterministic, rules-based analysis over real fundamentals (brapi.dev) — no AI/LLM
 * involved. Weights mirror the "Score do Radar" formula from the product spec:
 * Fundamentos 40%, Notícias 20%, Macro 20%, Tendência histórica 10%, Volatilidade 10%.
 * Notícias/Macro don't have a real data source yet (Fase 3), so they score neutral (60)
 * instead of being faked — Tendência (variação 12m) and Volatilidade (beta) are real.
 *
 * Called from routes/analysis.ts via computeAnalysis(), fed by market-data.ts's
 * getFundamentals() (brapi.dev — ver o comentário lá sobre como ROE/dívida-patrimônio/
 * crescimento são calculados a partir do balanço e DRE reais, não do módulo pago).
 *
 * dps12m (DPS real dos últimos 12 meses, ver sumLast12Months em market-data.ts) é
 * opcional (default null) — nem toda chamada tem o histórico de proventos já buscado;
 * sem ele, o payout ratio simplesmente não entra na média, igual a qualquer outro
 * fundamento indisponível, nunca vira um valor chutado.
 */
export function analyzeFundamentals(f: Fundamentals, dps12m: number | null = null): AnalysisResult {
  const fundamentalMetrics = [
    evalPE(f.priceEarnings),
    evalPriceToBook(f.priceToBook),
    evalROE(f.returnOnEquity),
    evalDebtToEquity(f.debtToEquity),
    evalMargin(f.profitMargins),
    evalDividendYield(f.dividendYield),
    evalRevenueGrowth(f.revenueGrowth),
    evalPayoutRatio(f.priceEarnings, f.price, dps12m),
  ].filter((m): m is MetricEval => m != null);

  if (fundamentalMetrics.length === 0) return NO_FUNDAMENTALS_RESULT;

  const fundamentosScore = fundamentalMetrics.reduce((sum, m) => sum + m.score, 0) / fundamentalMetrics.length;

  const trend = evalTrend(f.fiftyTwoWeekChange);
  const volatility = evalVolatility(f.beta);
  const trendScore = trend?.score ?? 60;
  const volatilityScore = volatility?.score ?? 60;

  // Notícias e cenário macro ainda não têm fonte de dados real (Fase 3) — neutro.
  const newsScore = 60;
  const macroScore = 60;

  const score = Math.round(
    fundamentosScore * 0.4 + newsScore * 0.2 + macroScore * 0.2 + trendScore * 0.1 + volatilityScore * 0.1
  );

  const allMetrics = [...fundamentalMetrics, trend, volatility].filter((m): m is MetricEval => m != null);
  const positives = allMetrics.filter((m) => m.positive).map((m) => m.positive!);
  const risks = allMetrics.filter((m) => m.risk).map((m) => m.risk!);

  if (positives.length === 0 && risks.length === 0) {
    positives.push("Fundamentos dentro de padrões medianos, sem sinais de alerta relevantes");
  }

  return {
    available: true,
    score,
    scoreClassification: scoreClassification(score),
    status: statusFromScore(score),
    positives,
    risks,
    monitoringRecommendation: buildRecommendation(risks),
  };
}
