import { logger } from "./logger";

const BRAPI_BASE_URL = "https://brapi.dev/api/quote";
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface Quote {
  price: number;
  priceEarnings: number | null;
  name: string | null;
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
  longName?: string;
  shortName?: string;
}

const cache = new Map<string, CacheEntry>();

// brapi.dev's free/free-token plans cap requests at 1 ticker each — a batched,
// comma-separated request gets rejected for the whole list (QUOTES_PER_REQUEST_EXCEEDED),
// even if only one ticker in it would be invalid. Fetch one ticker per request instead.
async function fetchQuote(ticker: string): Promise<Quote | null> {
  const token = process.env.BRAPI_TOKEN;
  const url = `${BRAPI_BASE_URL}/${encodeURIComponent(ticker)}`;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const response = await fetch(url, { headers });
  if (!response.ok) {
    logger.warn({ status: response.status, ticker }, "brapi.dev quote request failed");
    return null;
  }

  const body = (await response.json()) as { results?: BrapiResult[] };
  const item = body.results?.[0];
  if (!item || typeof item.regularMarketPrice !== "number") return null;

  return {
    price: item.regularMarketPrice,
    priceEarnings: item.priceEarnings ?? null,
    name: item.longName ?? item.shortName ?? null,
    updatedAt: item.regularMarketTime ?? new Date().toISOString(),
  };
}

async function fetchQuotes(tickers: string[]): Promise<Map<string, Quote>> {
  const result = new Map<string, Quote>();
  const settled = await Promise.allSettled(tickers.map((ticker) => fetchQuote(ticker)));
  tickers.forEach((ticker, i) => {
    const outcome = settled[i];
    if (outcome.status === "fulfilled" && outcome.value) {
      result.set(ticker.toUpperCase(), outcome.value);
    } else if (outcome.status === "rejected") {
      logger.warn({ err: outcome.reason, ticker }, "brapi.dev quote request errored");
    }
  });
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

export interface Fundamentals {
  price: number;
  priceEarnings: number | null; // P/L
  priceToBook: number | null; // P/VP
  dividendYield: number | null; // decimal, e.g. 0.05 = 5%
  returnOnEquity: number | null; // ROE, decimal
  debtToEquity: number | null; // dívida/patrimônio, ratio (1.5 = 150%)
  profitMargins: number | null; // margem líquida, decimal
  revenueGrowth: number | null; // decimal
  fiftyTwoWeekChange: number | null; // decimal
  beta: number | null;
  updatedAt: string;
}

interface FundamentalsCacheEntry {
  fundamentals: Fundamentals | null;
  fetchedAt: number;
}

interface BrapiFundamentalsResult extends BrapiResult {
  defaultKeyStatistics?: {
    priceToBook?: number | null;
    dividendYield?: number | null;
    "52WeekChange"?: number | null;
    beta?: number | null;
  };
  financialData?: {
    returnOnEquity?: number | null;
    debtToEquity?: number | null;
    profitMargins?: number | null;
    revenueGrowth?: number | null;
  };
}

const fundamentalsCache = new Map<string, FundamentalsCacheEntry>();

async function fetchFundamentals(ticker: string): Promise<Fundamentals | null> {
  const token = process.env.BRAPI_TOKEN;
  const url = `${BRAPI_BASE_URL}/${encodeURIComponent(ticker)}?modules=defaultKeyStatistics,financialData`;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const response = await fetch(url, { headers });
  if (!response.ok) {
    logger.warn({ status: response.status, ticker }, "brapi.dev fundamentals request failed");
    return null;
  }

  const body = (await response.json()) as { results?: BrapiFundamentalsResult[] };
  const item = body.results?.[0];
  if (!item || typeof item.regularMarketPrice !== "number") return null;

  const stats = item.defaultKeyStatistics ?? {};
  const financials = item.financialData ?? {};

  return {
    price: item.regularMarketPrice,
    priceEarnings: item.priceEarnings ?? null,
    priceToBook: stats.priceToBook ?? null,
    dividendYield: stats.dividendYield ?? null,
    returnOnEquity: financials.returnOnEquity ?? null,
    debtToEquity: financials.debtToEquity ?? null,
    profitMargins: financials.profitMargins ?? null,
    revenueGrowth: financials.revenueGrowth ?? null,
    fiftyTwoWeekChange: stats["52WeekChange"] ?? null,
    beta: stats.beta ?? null,
    updatedAt: item.regularMarketTime ?? new Date().toISOString(),
  };
}

/**
 * Cached lookup of fundamentals (P/L, P/VP, ROE, endividamento, margens, crescimento,
 * beta, variação 12m) for tickers, used by the analysis engine — heavier payload than
 * getQuotes, so kept separate rather than folded into every price lookup.
 */
export async function getFundamentals(tickers: string[]): Promise<Map<string, Fundamentals>> {
  const uniqueTickers = Array.from(new Set(tickers.map((t) => t.toUpperCase())));
  if (uniqueTickers.length === 0) return new Map();

  const now = Date.now();
  const fresh = new Map<string, Fundamentals>();
  const stale: string[] = [];

  for (const ticker of uniqueTickers) {
    const cached = fundamentalsCache.get(ticker);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      if (cached.fundamentals) fresh.set(ticker, cached.fundamentals);
    } else {
      stale.push(ticker);
    }
  }

  if (stale.length > 0) {
    const settled = await Promise.allSettled(stale.map((ticker) => fetchFundamentals(ticker)));
    stale.forEach((ticker, i) => {
      const outcome = settled[i];
      const fundamentals = outcome.status === "fulfilled" ? outcome.value : null;
      if (outcome.status === "rejected") {
        logger.warn({ err: outcome.reason, ticker }, "brapi.dev fundamentals request errored");
      }
      fundamentalsCache.set(ticker, { fundamentals, fetchedAt: now });
      if (fundamentals) fresh.set(ticker, fundamentals);
    });
  }

  return fresh;
}

// Categories traded on B3 and covered by brapi.dev quotes; renda_fixa/fundos have no ticker quote.
export const QUOTED_CATEGORIES = new Set(["acoes", "fiis", "etfs", "bdrs"]);

/**
 * Convenience wrapper around getQuotes for a list of { ticker, category } records
 * (assets, opportunities, ...): filters to quotable categories and returns a
 * ticker -> price map. Missing entries mean no quote was available — callers
 * fall back to whatever price they already have on hand.
 */
export async function getPricesFor(items: { ticker: string; category: string }[]): Promise<Map<string, number>> {
  const tickers = items.filter((i) => QUOTED_CATEGORIES.has(i.category)).map((i) => i.ticker);
  const prices = new Map<string, number>();
  if (tickers.length === 0) return prices;
  const quotes = await getQuotes(tickers);
  for (const [ticker, quote] of quotes) prices.set(ticker, quote.price);
  return prices;
}
