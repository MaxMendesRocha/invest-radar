import type { OhlcPoint } from "./market-data";

export interface MacdResult {
  line: number;
  signal: number;
  histogram: number;
}

export interface BollingerResult {
  upper: number;
  middle: number;
  lower: number;
  pricePosition: number; // 0-100%, posição do preço atual dentro da banda
}

export type CrossSignal = "golden_cross_recente" | "death_cross_recente" | "acima_sma200" | "abaixo_sma200";

export interface TechnicalIndicators {
  sma20: number | null;
  sma50: number | null;
  sma200: number | null; // null com menos de 200 candles (ticker novo/pouco líquido) — nunca estimado
  rsi14: number | null;
  macd: MacdResult | null;
  bollinger: BollingerResult | null;
  crossSignal: CrossSignal | null;
}

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

function smaSeries(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    result[i] = sum / period;
  }
  return result;
}

// EMA clássica: seed com a SMA do primeiro período, depois rolagem recursiva
// (multiplicador 2/(period+1)) até o valor mais recente da série.
function emaSeries(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return result;
  const k = 2 / (period + 1);
  const seed = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  result[period - 1] = seed;
  let prevEma = seed;
  for (let i = period; i < values.length; i++) {
    const ema = values[i] * k + prevEma * (1 - k);
    result[i] = ema;
    prevEma = ema;
  }
  return result;
}

// RSI(14) pelo método de suavização de Wilder — padrão da indústria, diferente de
// uma média móvel simples de ganhos/perdas.
function rsi14(values: number[]): number | null {
  const period = 14;
  if (values.length < period + 1) return null;

  const changes: number[] = [];
  for (let i = 1; i < values.length; i++) changes.push(values[i] - values[i - 1]);

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    const c = changes[i];
    if (c > 0) avgGain += c;
    else avgLoss += -c;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period; i < changes.length; i++) {
    const c = changes[i];
    const gain = c > 0 ? c : 0;
    const loss = c < 0 ? -c : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// MACD(12,26,9): linha = EMA12 - EMA26; sinal = EMA9 da própria linha do MACD.
function macd(values: number[]): MacdResult | null {
  if (values.length < 26 + 9) return null;

  const ema12 = emaSeries(values, 12);
  const ema26 = emaSeries(values, 26);
  const macdLineSeries: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (ema12[i] != null && ema26[i] != null) macdLineSeries.push(ema12[i]! - ema26[i]!);
  }
  if (macdLineSeries.length < 9) return null;

  const signalSeries = emaSeries(macdLineSeries, 9);
  const line = macdLineSeries[macdLineSeries.length - 1];
  const signal = signalSeries[signalSeries.length - 1];
  if (signal == null) return null;

  return { line, signal, histogram: line - signal };
}

// Bandas de Bollinger(20, 2 desvios-padrão) — banda expande/contrai com a
// volatilidade real dos últimos 20 candles.
function bollinger(values: number[]): BollingerResult | null {
  const period = 20;
  if (values.length < period) return null;

  const slice = values.slice(values.length - period);
  const middle = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - middle) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);
  const upper = middle + 2 * stdDev;
  const lower = middle - 2 * stdDev;
  const current = values[values.length - 1];
  const pricePosition = upper > lower ? Math.min(100, Math.max(0, ((current - lower) / (upper - lower)) * 100)) : 50;

  return { upper, middle, lower, pricePosition };
}

// Não é o momento exato do cruzamento — compara o sinal de (SMA50 - SMA200) hoje
// contra o mesmo cálculo há CROSS_LOOKBACK_DAYS pregões. Se o sinal mudou nesse
// intervalo, um cruzamento aconteceu em algum ponto da janela (sem apontar o dia
// exato); honesto sobre a limitação, nunca finge precisão que não tem.
const CROSS_LOOKBACK_DAYS = 10;

function detectCrossSignal(values: number[]): CrossSignal | null {
  const sma50s = smaSeries(values, 50);
  const sma200s = smaSeries(values, 200);
  const n = values.length;
  const currentSma50 = sma50s[n - 1];
  const currentSma200 = sma200s[n - 1];
  if (currentSma50 == null || currentSma200 == null) return null;

  const currentDiff = currentSma50 - currentSma200;
  const lookbackIndex = n - 1 - CROSS_LOOKBACK_DAYS;
  const priorSma50 = lookbackIndex >= 0 ? sma50s[lookbackIndex] : null;
  const priorSma200 = lookbackIndex >= 0 ? sma200s[lookbackIndex] : null;
  const priorDiff = priorSma50 != null && priorSma200 != null ? priorSma50 - priorSma200 : null;

  if (priorDiff != null && Math.sign(priorDiff) !== Math.sign(currentDiff) && currentDiff !== 0) {
    return currentDiff > 0 ? "golden_cross_recente" : "death_cross_recente";
  }
  return currentDiff > 0 ? "acima_sma200" : "abaixo_sma200";
}

/**
 * Indicadores técnicos determinísticos (médias móveis, RSI, MACD, Bollinger) a
 * partir de candles diários reais (getTechnicalSeries em market-data.ts) — matemática
 * pura sobre `adjustedClose`, sem nenhuma IA envolvida e sem nenhum campo estimado:
 * cada indicador vira null quando não há candles suficientes pra calculá-lo (nunca
 * um valor chutado). Reconhecimento de padrão de candlestick e suporte/resistência
 * ficam de fora deliberadamente — são interpretativos, não dá pra calcular de forma
 * inequívoca em código.
 */
export function computeTechnicalIndicators(points: OhlcPoint[]): TechnicalIndicators {
  const values = points.map((p) => p.adjustedClose);
  return {
    sma20: sma(values, 20),
    sma50: sma(values, 50),
    sma200: sma(values, 200),
    rsi14: rsi14(values),
    macd: macd(values),
    bollinger: bollinger(values),
    crossSignal: detectCrossSignal(values),
  };
}

const CROSS_SIGNAL_LABELS: Record<CrossSignal, string> = {
  golden_cross_recente: "cruzamento dourado recente (SMA50 cruzou acima da SMA200 — sinal técnico de alta)",
  death_cross_recente: "cruzamento da morte recente (SMA50 cruzou abaixo da SMA200 — sinal técnico de baixa)",
  acima_sma200: "tendência de alta no longo prazo (SMA50 acima da SMA200)",
  abaixo_sma200: "tendência de baixa no longo prazo (SMA50 abaixo da SMA200)",
};

/**
 * Traduz os indicadores em linhas de prompt prontas — usado tanto por
 * analysis-ai.ts (ativo já possuído) quanto opinion-ai.ts (parecer pré-compra), pra
 * não duplicar a mesma lógica de formatação/interpretação em dois lugares.
 */
export function describeTechnicalIndicators(t: TechnicalIndicators | null): string {
  if (!t) return "Indicadores técnicos não disponíveis (histórico de preço insuficiente).";

  const lines: string[] = [];

  if (t.sma20 != null && t.sma50 != null) {
    const crossLabel = t.crossSignal ? CROSS_SIGNAL_LABELS[t.crossSignal] : null;
    lines.push(
      `Médias móveis: SMA20 R$${t.sma20.toFixed(2)}, SMA50 R$${t.sma50.toFixed(2)}` +
      `${t.sma200 != null ? `, SMA200 R$${t.sma200.toFixed(2)}` : " (SMA200 indisponível, histórico curto demais)"}.` +
      `${crossLabel ? ` ${crossLabel}.` : ""}`
    );
  }

  if (t.rsi14 != null) {
    const rsiLabel = t.rsi14 >= 70 ? "sobrecomprado" : t.rsi14 <= 30 ? "sobrevendido" : "neutro";
    lines.push(`RSI(14): ${t.rsi14.toFixed(0)} (${rsiLabel} — acima de 70 é sobrecompra, abaixo de 30 é sobrevenda).`);
  }

  if (t.macd) {
    const momentum = t.macd.histogram > 0 ? "momentum positivo (linha acima do sinal)" : "momentum negativo (linha abaixo do sinal)";
    lines.push(`MACD: ${momentum}.`);
  }

  if (t.bollinger) {
    lines.push(`Bandas de Bollinger: preço está a ${t.bollinger.pricePosition.toFixed(0)}% da banda (0% = banda inferior, 100% = banda superior).`);
  }

  return lines.length > 0 ? lines.join(" ") : "Indicadores técnicos não disponíveis (histórico de preço insuficiente).";
}
