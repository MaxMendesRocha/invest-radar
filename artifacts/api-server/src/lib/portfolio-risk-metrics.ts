import type { OhlcPoint } from "./market-data";

/**
 * Risco da COMPOSIÇÃO atual — quão oscilante é a carteira que a pessoa tem hoje,
 * medida aplicando as quantidades de hoje aos preços reais do último ano.
 *
 * ISTO NÃO É O HISTÓRICO DA PESSOA, e a distinção não é detalhe. As posições mudaram
 * ao longo do ano; aqui elas são mantidas fixas de propósito, o que responde "quão
 * volátil é o que eu tenho" e não "como foi o meu histórico". Track record real sai
 * dos snapshots (time-weighted-return.ts) e exige ~12 meses de uso do app — quem
 * cadastrou a carteira semana passada não tem. Esta métrica funciona desde o primeiro
 * dia porque o dado é do mercado, não do usuário. As duas nunca devem ser somadas
 * nem exibidas sem dizer qual é qual.
 *
 * ## Decisões que definem se o número presta
 *
 * - **`adjustedClose`, nunca `close`.** Medido em MXRF11: 7,5% ajustado contra 9,0%
 *   cru. FII distribui todo mês, e no fechamento cru cada provento vira uma queda que
 *   não existiu — 1,5pp de volatilidade inventada num único papel.
 * - **Só datas comuns a todos os ativos cobertos.** Se um papel não negociou num dia,
 *   usar o resto viraria uma variação de carteira que nunca aconteceu.
 * - **Renda fixa não entra, e isso é reportado.** Tesouro e CDB não têm série diária
 *   de bolsa. Silenciar isso subestimaria a volatilidade de quem tem metade da
 *   carteira em renda fixa, então `coveragePercent` diz quanto do valor foi medido.
 * - **Piso de observações.** Desvio-padrão de meia dúzia de retornos parece medido e
 *   não é. Abaixo do piso a função devolve null e quem chama mostra a ausência.
 */

/** Abaixo disso o desvio-padrão é ruído, e anualizar ruído dá um número convincente e falso. */
const MIN_TRADING_DAYS = 60;

/** Pregões por ano na B3, o fator usual para anualizar volatilidade diária. */
const TRADING_DAYS_PER_YEAR = 252;

export interface RiskPosition {
  ticker: string;
  /** Valor de mercado da posição hoje — peso na carteira e base da cobertura. */
  value: number;
  quantity: number;
}

export interface MonthlyReturn {
  /** "YYYY-MM" */
  month: string;
  percent: number;
  benchmarkPercent: number | null;
}

export interface CompositionRisk {
  /** Volatilidade anualizada da carteira, em %. */
  volatility: number;
  /** A do benchmark no MESMO intervalo de dias, para a comparação ser honesta. */
  benchmarkVolatility: number | null;
  tradingDays: number;
  fromDate: string;
  toDate: string;
  monthlyReturns: MonthlyReturn[];
  positiveMonths: number;
  monthsAboveBenchmark: number | null;
  /** Quanto do valor da carteira a medição cobre, em %. */
  coveragePercent: number;
  /** Posições fora da medição — renda fixa, ou cotado sem série disponível. */
  uncovered: string[];
}

function dailyReturns(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0) out.push(values[i] / values[i - 1] - 1);
  }
  return out;
}

function annualizedVolatility(returns: number[]): number | null {
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  // Divisor n−1: é uma amostra do comportamento do ativo, não a população inteira.
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
}

/** Último fechamento de cada mês, que é o que encadeia retorno mensal sem buraco. */
function monthEndValues(points: { date: string; value: number }[]): Map<string, number> {
  const byMonth = new Map<string, number>();
  for (const p of points) byMonth.set(p.date.slice(0, 7), p.value);
  return byMonth;
}

/**
 * Retorno mês a mês encadeando fechamentos de fim de mês. O primeiro mês da série
 * fica de fora: sem o fechamento do mês anterior não há de onde medir variação, e
 * medir do primeiro ao último dia DENTRO do mês perderia o salto entre meses.
 */
function monthlyReturnsFrom(monthEnds: Map<string, number>): { month: string; percent: number }[] {
  const months = [...monthEnds.keys()].sort();
  const out: { month: string; percent: number }[] = [];
  for (let i = 1; i < months.length; i++) {
    const previous = monthEnds.get(months[i - 1])!;
    const current = monthEnds.get(months[i])!;
    if (previous > 0) out.push({ month: months[i], percent: (current / previous - 1) * 100 });
  }
  return out;
}

export function computeCompositionRisk(
  positions: RiskPosition[],
  seriesByTicker: Map<string, OhlcPoint[]>,
  benchmarkSeries: OhlcPoint[] | null,
  /** Valor total da carteira, incluindo o que não tem série — base da cobertura. */
  totalPortfolioValue: number,
): CompositionRisk | null {
  const covered = positions.filter((p) => (seriesByTicker.get(p.ticker)?.length ?? 0) > 0);
  const uncovered = positions.filter((p) => !covered.includes(p)).map((p) => p.ticker);
  if (covered.length === 0) return null;

  // Interseção das datas: um papel que não negociou num dia tira o dia inteiro da
  // conta, em vez de deixar a carteira "variar" por ausência de negócio.
  const dateSets = covered.map((p) => new Set(seriesByTicker.get(p.ticker)!.map((d) => d.date)));
  const commonDates = seriesByTicker
    .get(covered[0].ticker)!
    .map((d) => d.date)
    .filter((date) => dateSets.every((s) => s.has(date)))
    .sort();

  if (commonDates.length < MIN_TRADING_DAYS) return null;

  const closeByTicker = new Map<string, Map<string, number>>();
  for (const p of covered) {
    closeByTicker.set(p.ticker, new Map(seriesByTicker.get(p.ticker)!.map((d) => [d.date, d.adjustedClose])));
  }

  const portfolioPoints = commonDates.map((date) => ({
    date,
    value: covered.reduce((sum, p) => sum + p.quantity * (closeByTicker.get(p.ticker)!.get(date) ?? 0), 0),
  }));

  const volatility = annualizedVolatility(dailyReturns(portfolioPoints.map((p) => p.value)));
  if (volatility == null) return null;

  // O benchmark é recortado nas MESMAS datas: volatilidades medidas em intervalos
  // diferentes não se comparam, mesmo com as duas séries reais.
  const commonDateSet = new Set(commonDates);
  const benchmarkPoints = (benchmarkSeries ?? [])
    .filter((d) => commonDateSet.has(d.date))
    .map((d) => ({ date: d.date, value: d.adjustedClose }));
  const benchmarkUsable = benchmarkPoints.length >= MIN_TRADING_DAYS;
  const benchmarkVolatility = benchmarkUsable
    ? annualizedVolatility(dailyReturns(benchmarkPoints.map((p) => p.value)))
    : null;

  const portfolioMonthly = monthlyReturnsFrom(monthEndValues(portfolioPoints));
  const benchmarkMonthly = benchmarkUsable
    ? new Map(monthlyReturnsFrom(monthEndValues(benchmarkPoints)).map((m) => [m.month, m.percent]))
    : null;

  const monthlyReturns: MonthlyReturn[] = portfolioMonthly.map((m) => ({
    month: m.month,
    percent: Math.round(m.percent * 100) / 100,
    benchmarkPercent: benchmarkMonthly?.has(m.month)
      ? Math.round(benchmarkMonthly.get(m.month)! * 100) / 100
      : null,
  }));

  const comparable = monthlyReturns.filter((m) => m.benchmarkPercent != null);

  return {
    volatility: Math.round(volatility * 10) / 10,
    benchmarkVolatility: benchmarkVolatility != null ? Math.round(benchmarkVolatility * 10) / 10 : null,
    tradingDays: commonDates.length,
    fromDate: commonDates[0],
    toDate: commonDates[commonDates.length - 1],
    monthlyReturns,
    positiveMonths: monthlyReturns.filter((m) => m.percent > 0).length,
    monthsAboveBenchmark: comparable.length > 0
      ? comparable.filter((m) => m.percent > m.benchmarkPercent!).length
      : null,
    coveragePercent:
      totalPortfolioValue > 0
        ? Math.round((covered.reduce((s, p) => s + p.value, 0) / totalPortfolioValue) * 1000) / 10
        : 0,
    uncovered,
  };
}
