import type { OhlcPoint } from "./market-data";

export interface RiskAdjustedMetrics {
  annualizedReturn: number; // decimal, ex. 0.22 = 22% a.a.
  annualizedVolatility: number; // decimal, desvio-padrão anualizado dos retornos diários
  downsideDeviation: number | null; // decimal anualizado, só considera retornos negativos — null se não houve nenhum retorno negativo no período (raro, mas honesto)
  sharpeRatio: number;
  sortinoRatio: number | null; // null quando downsideDeviation é null
  treynorRatio: number | null; // null quando beta não está disponível
  riskFreeRate: number; // CDI acumulado real do mesmo período (decimal)
}

const TRADING_DAYS_PER_YEAR = 252;
// Abaixo disso, desvio-padrão e retorno anualizado ficam estatisticamente pouco
// confiáveis (poucos pontos amplificam ruído) — mesmo espírito de SMA200 exigir 200
// candles: sem dado suficiente, null em vez de um número instável.
const MIN_TRADING_DAYS = 60;

function dailyReturns(points: OhlcPoint[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].adjustedClose;
    const curr = points[i].adjustedClose;
    if (prev > 0) returns.push(curr / prev - 1);
  }
  return returns;
}

function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Sharpe/Sortino/Treynor a partir da mesma série de candles diários já buscada pra
 * calcular os indicadores técnicos (technical-engine.ts) — nenhuma chamada nova à
 * API. cdiAnnualReal é o CDI acumulado real do mesmo período (getCdiTrailingAnnual,
 * benchmark-data.ts), usado como taxa livre de risco — nunca uma constante chutada.
 * Retorna null quando não há candles suficientes (MIN_TRADING_DAYS) pra uma
 * estimativa minimamente estável, nunca um número forçado a partir de pouco dado.
 */
export function computeRiskAdjustedMetrics(
  points: OhlcPoint[],
  beta: number | null,
  cdiAnnualReal: number,
): RiskAdjustedMetrics | null {
  const returns = dailyReturns(points);
  if (returns.length < MIN_TRADING_DAYS) return null;

  const first = points[0].adjustedClose;
  const last = points[points.length - 1].adjustedClose;
  if (first <= 0) return null;

  const totalReturn = last / first - 1;
  const annualizedReturn = Math.pow(1 + totalReturn, TRADING_DAYS_PER_YEAR / returns.length) - 1;
  const annualizedVolatility = stdDev(returns) * Math.sqrt(TRADING_DAYS_PER_YEAR);

  const negativeReturns = returns.filter((r) => r < 0);
  const downsideDeviation = negativeReturns.length > 0
    ? Math.sqrt(negativeReturns.reduce((s, r) => s + r * r, 0) / returns.length) * Math.sqrt(TRADING_DAYS_PER_YEAR)
    : null;

  const excessReturn = annualizedReturn - cdiAnnualReal;

  return {
    annualizedReturn,
    annualizedVolatility,
    downsideDeviation,
    sharpeRatio: annualizedVolatility > 0 ? excessReturn / annualizedVolatility : 0,
    sortinoRatio: downsideDeviation != null && downsideDeviation > 0 ? excessReturn / downsideDeviation : null,
    treynorRatio: beta != null && beta !== 0 ? excessReturn / beta : null,
    riskFreeRate: cdiAnnualReal,
  };
}

/**
 * Traduz as métricas em uma linha de prompt pronta — mesmo padrão de
 * describeTechnicalIndicators (technical-engine.ts), usado tanto por analysis-ai.ts
 * quanto opinion-ai.ts.
 */
export function describeRiskAdjustedMetrics(m: RiskAdjustedMetrics | null): string {
  if (!m) return "Métricas de retorno ajustado ao risco não disponíveis (histórico de preço insuficiente).";

  const parts = [
    `retorno anualizado de ${(m.annualizedReturn * 100).toFixed(1)}% vs. CDI real de ${(m.riskFreeRate * 100).toFixed(1)}% no mesmo período`,
    `volatilidade anualizada de ${(m.annualizedVolatility * 100).toFixed(1)}%`,
    `Sharpe de ${m.sharpeRatio.toFixed(2)}`,
  ];
  if (m.sortinoRatio != null) parts.push(`Sortino de ${m.sortinoRatio.toFixed(2)}`);
  if (m.treynorRatio != null) parts.push(`Treynor de ${m.treynorRatio.toFixed(2)}`);

  return parts.join(", ") + ".";
}
