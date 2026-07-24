import { logger } from "./logger";

const BRAPI_BASE_URL = "https://brapi.dev/api/quote";
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface Quote {
  price: number;
  priceEarnings: number | null;
  updatedAt: string;
}

interface CacheEntry {
  quote: Quote | null;
  fetchedAt: number;
}

interface BrapiResult {
  symbol: string;
  regularMarketPrice?: number;
  priceEarnings?: number | null;
  regularMarketTime?: string;
}

const cache = new Map<string, CacheEntry>();

async function fetchQuotes(tickers: string[]): Promise<Map<string, Quote>> {
  const token = process.env.BRAPI_TOKEN;
  const url = `${BRAPI_BASE_URL}/${tickers.map(encodeURIComponent).join(",")}`;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const response = await fetch(url, { headers });
  if (!response.ok) {
    logger.warn({ status: response.status, tickers }, "brapi.dev quote request failed");
    return new Map();
  }

  const body = (await response.json()) as { results?: BrapiResult[] };
  const result = new Map<string, Quote>();
  for (const item of body.results ?? []) {
    if (typeof item.regularMarketPrice !== "number") continue;
    result.set(item.symbol.toUpperCase(), {
      price: item.regularMarketPrice,
      priceEarnings: item.priceEarnings ?? null,
      updatedAt: item.regularMarketTime ?? new Date().toISOString(),
    });
  }
  return result;
}

/**
 * Batched, cached lookup of real-time B3 quotes (ações, FIIs, ETFs, BDRs) via brapi.dev.
 * Tickers with no quote available (delisted, wrong category, provider error) are simply
 * absent from the returned map — callers fall back to average purchase price.
 */
export async function getQuotes(tickers: string[]): Promise<Map<string, Quote>> {
  const uniqueTickers = Array.from(new Set(tickers.map((t) => t.toUpperCase())));
  if (uniqueTickers.length === 0) return new Map();

  const now = Date.now();
  const fresh = new Map<string, Quote>();
  const stale: string[] = [];

  for (const ticker of uniqueTickers) {
    const cached = cache.get(ticker);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      if (cached.quote) fresh.set(ticker, cached.quote);
    } else {
      stale.push(ticker);
    }
  }

  if (stale.length > 0) {
    let fetched = new Map<string, Quote>();
    try {
      fetched = await fetchQuotes(stale);
    } catch (err) {
      logger.warn({ err, tickers: stale }, "brapi.dev quote request errored");
    }
    for (const ticker of stale) {
      const quote = fetched.get(ticker) ?? null;
      cache.set(ticker, { quote, fetchedAt: now });
      if (quote) fresh.set(ticker, quote);
    }
  }

  return fresh;
}
