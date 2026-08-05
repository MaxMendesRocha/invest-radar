import { logger } from "./logger";

const BCB_BASE_URL = "https://api.bcb.gov.br/dados/serie/bcdata.sgs";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // macro indicators move slowly — 6h is plenty

// Série Selic-meta (432), IPCA acumulado 12 meses (13522), dólar PTAX venda (1),
// IGP-M variação mensal (189).
// All confirmed live against the real BCB SGS API before wiring in — see replit.md.
//
// O IGP-M não tem série "acumulado 12 meses" publicada como a do IPCA (13522), então
// é composto aqui a partir da variação mensal — mesma técnica já usada para o CDI em
// benchmark-data.ts. Continua sendo dado real: só muda a agregação.
const SERIES = {
  selic: "432",
  ipca12m: "13522",
  usdBrl: "1",
  igpmMonthly: "189",
} as const;

export interface SgsPoint {
  data: string;
  valor: string;
}

export interface MacroSnapshot {
  selic: number | null;
  selicTrend: "alta" | "queda" | "estavel" | null;
  ipca12m: number | null;
  usdBrl: number | null;
  igpm12m: number | null;
  realInterestRate: number | null;
  updatedAt: string;
}

async function fetchSeries(code: string, count: number): Promise<SgsPoint[]> {
  // /dados/ultimos/N caps N at 20 — fine for a single latest reading, but not
  // enough history for a trend. Use a date range instead when more is needed.
  const url = `${BCB_BASE_URL}.${code}/dados/ultimos/${count}?formato=json`;
  const response = await fetch(url);
  if (!response.ok) {
    logger.warn({ status: response.status, code }, "BCB SGS request failed");
    return [];
  }
  return (await response.json()) as SgsPoint[];
}

function formatBcbDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/** Exported for benchmark-data.ts (CDI monthly returns) — same BCB SGS API, different series. */
export async function fetchSeriesRange(code: string, daysBack: number): Promise<SgsPoint[]> {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - daysBack);
  const url = `${BCB_BASE_URL}.${code}/dados?dataInicial=${formatBcbDate(start)}&dataFinal=${formatBcbDate(end)}&formato=json`;
  const response = await fetch(url);
  if (!response.ok) {
    logger.warn({ status: response.status, code }, "BCB SGS range request failed");
    return [];
  }
  return (await response.json()) as SgsPoint[];
}

function trendFrom(points: SgsPoint[]): "alta" | "queda" | "estavel" | null {
  if (points.length < 2) return null;
  const first = parseFloat(points[0].valor);
  const last = parseFloat(points[points.length - 1].valor);
  if (Number.isNaN(first) || Number.isNaN(last)) return null;
  if (last - first > 0.1) return "alta";
  if (last - first < -0.1) return "queda";
  return "estavel";
}

/**
 * Compõe as variações mensais em um acumulado de 12 meses. Exige os 12 meses
 * completos — com menos que isso o número não seria "12 meses", e um acumulado
 * parcial apresentado como anual seria dado inventado.
 */
function compoundLast12Months(points: SgsPoint[]): number | null {
  const monthly = points
    .map((p) => parseFloat(p.valor))
    .filter((v) => !Number.isNaN(v))
    .slice(-12);
  if (monthly.length < 12) return null;

  let acc = 1;
  for (const variation of monthly) acc *= 1 + variation / 100;
  return (acc - 1) * 100;
}

/**
 * Juro real ex-post pela fórmula de Fisher — (1+i)/(1+π)-1, não a subtração
 * simples. Com Selic em 14,25% e IPCA em 4,64% a diferença entre os dois métodos
 * já passa de 0,4 p.p., o bastante para enganar na comparação com renda fixa.
 */
function realInterestFrom(selic: number | null, ipca12m: number | null): number | null {
  if (selic == null || ipca12m == null) return null;
  return ((1 + selic / 100) / (1 + ipca12m / 100) - 1) * 100;
}

let cache: { snapshot: MacroSnapshot; fetchedAt: number } | null = null;

/**
 * Real macroeconomic indicators from the Banco Central's public SGS API — free,
 * no key required. Selic trend compares against ~6 months back (roughly one
 * COPOM cycle) to say whether the rate is rising, falling, or holding.
 */
export async function getMacroSnapshot(): Promise<MacroSnapshot> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.snapshot;
  }

  const [selicPoints, ipcaPoints, usdPoints, igpmPoints] = await Promise.all([
    fetchSeriesRange(SERIES.selic, 180), // ~6 months, enough to span a COPOM cycle
    fetchSeries(SERIES.ipca12m, 1),
    fetchSeries(SERIES.usdBrl, 1),
    fetchSeries(SERIES.igpmMonthly, 12),
  ]);

  const selic = selicPoints.length > 0 ? parseFloat(selicPoints[selicPoints.length - 1].valor) : null;
  const ipca12m = ipcaPoints.length > 0 ? parseFloat(ipcaPoints[0].valor) : null;

  const snapshot: MacroSnapshot = {
    selic,
    selicTrend: trendFrom(selicPoints),
    ipca12m,
    usdBrl: usdPoints.length > 0 ? parseFloat(usdPoints[0].valor) : null,
    igpm12m: compoundLast12Months(igpmPoints),
    realInterestRate: realInterestFrom(selic, ipca12m),
    updatedAt: new Date().toISOString(),
  };

  cache = { snapshot, fetchedAt: now };
  return snapshot;
}
