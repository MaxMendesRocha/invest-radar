import type { OhlcPoint } from "./market-data";

/**
 * Correlação real entre pares de ativos da carteira.
 *
 * A diversificação em `/portfolio/health` é medida por dispersão de VALOR entre
 * setores (`spreadScore`, em routes/portfolio.ts) — e setor é um PROXY de
 * correlação, não a correlação em si. Duas ações de setores diferentes que na
 * prática se movem quase juntas (duas exportadoras de commodity seguindo o mesmo
 * ciclo global, por exemplo) contam como bem diversificadas pelo proxy; a
 * correlação real diria outra coisa.
 *
 * Isto é ADITIVO, não substitui a nota de diversificação. Trocar o que já está
 * calibrado por este número exigiria a mesma medição que decidiu NÃO dobrar saúde
 * financeira no score do Radar (ver o histórico de PRs de análise-engine) — medição
 * que não foi feita aqui. Até que seja, o número é informativo: aparece ao lado do
 * que já existe, não decide nada.
 *
 * Mesmas regras de série que portfolio-risk-metrics.ts, pelo mesmo motivo — E É A
 * MESMA SÉRIE já buscada para aquele cálculo, reaproveitada aqui sem custo de rede
 * extra: `adjustedClose`, interseção de datas comuns entre TODOS os ativos
 * cobertos, piso de observações abaixo do qual o número é ruído disfarçado de
 * medição.
 */

/** Mesmo piso de portfolio-risk-metrics.ts — abaixo disso, correlação é ruído. */
const MIN_TRADING_DAYS = 60;

/** Acima disto (em módulo, mas só o lado positivo importa aqui — ver nota abaixo). */
const HIGH_CORRELATION_THRESHOLD = 0.7;

/** Quantos pares aparecem na tela — o resto seria lista longa que ninguém lê. */
const MAX_PAIRS_SHOWN = 5;

export interface CorrelationPosition {
  ticker: string;
  value: number;
}

export interface AssetCorrelationPair {
  tickerA: string;
  tickerB: string;
  /** Pearson sobre RETORNOS diários, não sobre preço bruto — preço bruto dá
   * correlação espúria de tendência (dois ativos em alta "correlacionam" mesmo
   * sem relação real de movimento). -1 a 1. */
  correlation: number;
  /** % do valor COBERTO (não do total da carteira) que as duas posições somam. */
  combinedWeightPercent: number;
}

export interface CorrelationSummary {
  /** Os MAX_PAIRS_SHOWN mais correlacionados, do mais positivo pro menos — ver nota
   * na função de ordenação sobre por que não é por valor absoluto. */
  pairs: AssetCorrelationPair[];
  /** Média entre TODOS os pares medidos, não só os exibidos em `pairs`. */
  averageCorrelation: number;
  /** Quantos pares (de todos) passam do limiar positivo — não conta anti-correlação. */
  highlyCorrelatedCount: number;
  totalPairs: number;
  tradingDays: number;
  fromDate: string;
  toDate: string;
  /** % do valor da carteira coberto pela medição — o resto está em `uncovered`. */
  coveragePercent: number;
  uncovered: string[];
}

function dailyReturns(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0) out.push(values[i] / values[i - 1] - 1);
  }
  return out;
}

/**
 * Pearson entre duas séries de retorno já alinhadas por data (mesmo tamanho,
 * mesma ordem). Null quando um dos dois ativos não variou NADA no período —
 * variância zero deixa a correlação indefinida (divisão por zero), e indefinido
 * não é o mesmo que zero.
 */
function pearsonCorrelation(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 2) return null;
  const n = a.length;
  const meanA = a.reduce((sum, v) => sum + v, 0) / n;
  const meanB = b.reduce((sum, v) => sum + v, 0) / n;

  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < n; i++) {
    const deviationA = a[i] - meanA;
    const deviationB = b[i] - meanB;
    covariance += deviationA * deviationB;
    varianceA += deviationA * deviationA;
    varianceB += deviationB * deviationB;
  }
  if (varianceA === 0 || varianceB === 0) return null;
  return covariance / Math.sqrt(varianceA * varianceB);
}

export function computeAssetCorrelations(
  positions: CorrelationPosition[],
  seriesByTicker: Map<string, OhlcPoint[]>,
  totalPortfolioValue: number,
): CorrelationSummary | null {
  const covered = positions.filter((p) => (seriesByTicker.get(p.ticker)?.length ?? 0) > 0);
  const uncovered = positions.filter((p) => !covered.includes(p)).map((p) => p.ticker);
  // Correlação exige PAR — carteira de zero ou um ativo cotado não tem o que medir.
  if (covered.length < 2) return null;

  const dateSets = covered.map((p) => new Set(seriesByTicker.get(p.ticker)!.map((d) => d.date)));
  const commonDates = seriesByTicker
    .get(covered[0].ticker)!
    .map((d) => d.date)
    .filter((date) => dateSets.every((s) => s.has(date)))
    .sort();

  if (commonDates.length < MIN_TRADING_DAYS) return null;

  const returnsByTicker = new Map<string, number[]>();
  for (const p of covered) {
    const closeByDate = new Map(seriesByTicker.get(p.ticker)!.map((d) => [d.date, d.adjustedClose]));
    returnsByTicker.set(p.ticker, dailyReturns(commonDates.map((date) => closeByDate.get(date)!)));
  }

  const totalCoveredValue = covered.reduce((sum, p) => sum + p.value, 0);

  // Correlação bruta primeiro, arredondamento só na saída — arredondar por par e
  // tirar a média DOS ARREDONDADOS acumula erro sistemático pequeno mas evitável.
  const rawPairs: { tickerA: string; tickerB: string; correlation: number; combinedWeightPercent: number }[] = [];
  for (let i = 0; i < covered.length; i++) {
    for (let j = i + 1; j < covered.length; j++) {
      const correlation = pearsonCorrelation(returnsByTicker.get(covered[i].ticker)!, returnsByTicker.get(covered[j].ticker)!);
      if (correlation == null) continue;
      rawPairs.push({
        tickerA: covered[i].ticker,
        tickerB: covered[j].ticker,
        correlation,
        combinedWeightPercent: totalCoveredValue > 0 ? ((covered[i].value + covered[j].value) / totalCoveredValue) * 100 : 0,
      });
    }
  }
  if (rawPairs.length === 0) return null;

  const averageCorrelation = rawPairs.reduce((sum, p) => sum + p.correlation, 0) / rawPairs.length;
  const highlyCorrelatedCount = rawPairs.filter((p) => p.correlation >= HIGH_CORRELATION_THRESHOLD).length;

  // Do mais positivo pro menos, não por módulo: o que interessa aqui é achar
  // concentração ESCONDIDA (dois ativos que sobem e descem juntos apesar de
  // parecerem diversificados por setor). Correlação bem NEGATIVA é o oposto de um
  // problema — é um par que se protege mutuamente — então não faz sentido misturar
  // as duas pontas numa mesma lista "mais notável".
  const pairs = [...rawPairs]
    .sort((a, b) => b.correlation - a.correlation)
    .slice(0, MAX_PAIRS_SHOWN)
    .map((p) => ({
      tickerA: p.tickerA,
      tickerB: p.tickerB,
      correlation: Math.round(p.correlation * 100) / 100,
      combinedWeightPercent: Math.round(p.combinedWeightPercent * 10) / 10,
    }));

  return {
    pairs,
    averageCorrelation: Math.round(averageCorrelation * 100) / 100,
    highlyCorrelatedCount,
    totalPairs: rawPairs.length,
    tradingDays: commonDates.length,
    fromDate: commonDates[0],
    toDate: commonDates[commonDates.length - 1],
    coveragePercent: totalPortfolioValue > 0 ? Math.round((totalCoveredValue / totalPortfolioValue) * 1000) / 10 : 0,
    uncovered,
  };
}
