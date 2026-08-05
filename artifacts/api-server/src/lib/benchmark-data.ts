import { db, indexSnapshotsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { fetchSeriesRange } from "./macro-data";

const BRAPI_BASE_URL = "https://brapi.dev/api/quote";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // same cadence as macro-data.ts

// CDI acumulado no mês (série 4390 do SGS/BCB) — each point IS already the month's
// return in %, so unlike IBOV/IFIX there's no "close value" math needed and, since
// BCB publishes years of history for free, no snapshot table or simulated fallback
// is needed either: it's real for the full 12-month window on every request.
const CDI_SERIES = "4390";

function monthKeyFromBcbDate(ddmmyyyy: string): string {
  const [, mm, yyyy] = ddmmyyyy.split("/");
  return `${yyyy}-${mm}`;
}

let cdiCache: { returns: Map<string, number>; fetchedAt: number } | null = null;

/** Map "YYYY-MM" -> CDI accumulated return (%) for that month, real BCB data. */
export async function getCdiMonthlyReturns(): Promise<Map<string, number>> {
  const now = Date.now();
  if (cdiCache && now - cdiCache.fetchedAt < CACHE_TTL_MS) return cdiCache.returns;

  const returns = new Map<string, number>();
  try {
    const points = await fetchSeriesRange(CDI_SERIES, 400); // >12 months of buffer
    for (const p of points) {
      const value = parseFloat(p.valor);
      if (!Number.isNaN(value)) returns.set(monthKeyFromBcbDate(p.data), value);
    }
  } catch (err) {
    logger.warn({ err }, "BCB CDI (série 4390) request errored");
  }

  cdiCache = { returns, fetchedAt: now };
  return returns;
}

/**
 * CDI acumulado real dos últimos 12 meses em carteira (composto mês a mês, não uma
 * média simples) — usado como taxa livre de risco em risk-metrics-engine.ts. Real
 * pros 12 meses sempre (mesma garantia documentada em getCdiMonthlyReturns: BCB
 * publica anos de histórico de graça) — retorna null só se a série vier vazia
 * (BCB fora do ar), nunca uma taxa chutada.
 */
export async function getCdiTrailingAnnual(): Promise<number | null> {
  const monthlyReturns = await getCdiMonthlyReturns();
  if (monthlyReturns.size === 0) return null;

  const months = Array.from(monthlyReturns.keys()).sort().slice(-12);
  if (months.length === 0) return null;

  let acc = 1;
  for (const month of months) {
    acc *= 1 + (monthlyReturns.get(month) ?? 0) / 100;
  }
  return acc - 1;
}

interface BrapiHistoricalPoint {
  date: number; // unix seconds
  close: number;
}

async function fetchIndexHistory(ticker: string): Promise<{ current: number | null; history: BrapiHistoricalPoint[] }> {
  const token = process.env.BRAPI_TOKEN;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const url = `${BRAPI_BASE_URL}/${encodeURIComponent(ticker)}?range=3mo&interval=1d`;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    logger.warn({ status: response.status, ticker }, "brapi.dev index history request failed");
    return { current: null, history: [] };
  }

  const body = (await response.json()) as {
    results?: { regularMarketPrice?: number; historicalDataPrice?: BrapiHistoricalPoint[] }[];
  };
  const item = body.results?.[0];
  return {
    current: item?.regularMarketPrice ?? null,
    // IBOV's free tier returns ~3 months of daily closes; IFIX's returns only today's
    // point (no historical data available on the free plan) — both are handled the
    // same way here, IFIX just backfills one day at a time on each real request.
    history: item?.historicalDataPrice ?? [],
  };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoFromUnixSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

async function upsertCloses(indexName: string, closesByDate: Map<string, number>): Promise<void> {
  for (const [date, closeValue] of closesByDate) {
    await db
      .insert(indexSnapshotsTable)
      .values({ indexName, date, closeValue: String(closeValue) })
      .onConflictDoUpdate({
        target: [indexSnapshotsTable.indexName, indexSnapshotsTable.date],
        set: { closeValue: String(closeValue) },
      });
  }
}

/**
 * Fetches whatever real daily closes brapi.dev will give us for `ticker` right now,
 * persists them into index_snapshots (so they survive after aging out of brapi's
 * 3-month free window), then returns the full accumulated history we have on file —
 * which can span further back than what brapi returned today.
 */
export async function syncAndGetIndexCloses(ticker: string, indexName: string): Promise<Map<string, number>> {
  try {
    const { current, history } = await fetchIndexHistory(ticker);
    const closesByDate = new Map<string, number>();
    for (const point of history) {
      closesByDate.set(isoFromUnixSeconds(point.date), point.close);
    }
    if (closesByDate.size === 0 && current != null) {
      closesByDate.set(todayIso(), current);
    }
    if (closesByDate.size > 0) await upsertCloses(indexName, closesByDate);
  } catch (err) {
    logger.warn({ err, ticker }, "index history sync errored");
  }

  const rows = await db.select().from(indexSnapshotsTable).where(eq(indexSnapshotsTable.indexName, indexName)).orderBy(indexSnapshotsTable.date);

  const monthlyCloses = new Map<string, number>();
  for (const row of rows) {
    // Rows come back sorted by date ascending — the last one written per month wins,
    // which is exactly "closing value for that month" (or month-to-date if ongoing).
    monthlyCloses.set(row.date.slice(0, 7), parseFloat(row.closeValue));
  }
  return monthlyCloses;
}
