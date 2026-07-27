import { logger } from "./logger";

const BCB_BASE_URL = "https://api.bcb.gov.br/dados/serie/bcdata.sgs";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // macro indicators move slowly — 6h is plenty

// Série Selic-meta (432), IPCA acumulado 12 meses (13522), dólar PTAX venda (1).
// All confirmed live against the real BCB SGS API before wiring in — see replit.md.
const SERIES = {
  selic: "432",
  ipca12m: "13522",
  usdBrl: "1",
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

  const [selicPoints, ipcaPoints, usdPoints] = await Promise.all([
    fetchSeriesRange(SERIES.selic, 180), // ~6 months, enough to span a COPOM cycle
    fetchSeries(SERIES.ipca12m, 1),
    fetchSeries(SERIES.usdBrl, 1),
  ]);

  const snapshot: MacroSnapshot = {
    selic: selicPoints.length > 0 ? parseFloat(selicPoints[selicPoints.length - 1].valor) : null,
    selicTrend: trendFrom(selicPoints),
    ipca12m: ipcaPoints.length > 0 ? parseFloat(ipcaPoints[0].valor) : null,
    usdBrl: usdPoints.length > 0 ? parseFloat(usdPoints[0].valor) : null,
    updatedAt: new Date().toISOString(),
  };

  cache = { snapshot, fetchedAt: now };
  return snapshot;
}
