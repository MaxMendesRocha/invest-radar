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

function evalDividendYield(dy: number | null): MetricEval | null {
  if (dy == null) return null;
  if (dy >= 0.06) return { score: 85, positive: "Dividend yield acima da média do mercado" };
  if (dy >= 0.03) return { score: 60 };
  return { score: 45 };
}

function evalRevenueGrowth(growth: number | null): MetricEval | null {
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

function evalVolatility(beta: number | null): MetricEval | null {
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
 */
export function analyzeFundamentals(f: Fundamentals): AnalysisResult {
  const fundamentalMetrics = [
    evalPE(f.priceEarnings),
    evalPriceToBook(f.priceToBook),
    evalROE(f.returnOnEquity),
    evalDebtToEquity(f.debtToEquity),
    evalMargin(f.profitMargins),
    evalDividendYield(f.dividendYield),
    evalRevenueGrowth(f.revenueGrowth),
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
