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
  name: string | null;
  sector: string | null; // setor real (summaryProfile), em português — null se a brapi.dev não tiver perfil pro ticker
  priceEarnings: number | null; // P/L
  priceToBook: number | null; // P/VP
  dividendYield: number | null; // decimal, e.g. 0.05 = 5%
  returnOnEquity: number | null; // ROE, decimal — netIncome / shareholdersEquity (ver fetchV2Statements)
  debtToEquity: number | null; // dívida/patrimônio — (loansAndFinancing + longTermLoansAndFinancing) / shareholdersEquity
  profitMargins: number | null; // margem líquida, decimal
  revenueGrowth: number | null; // decimal — receita do ano mais recente vs ano anterior
  fiftyTwoWeekChange: number | null; // decimal
  beta: number | null;
  updatedAt: string;
}

interface FundamentalsCacheEntry {
  fundamentals: Fundamentals | null;
  fetchedAt: number;
}

interface BrapiKeyStatsResult extends BrapiResult {
  defaultKeyStatistics?: {
    priceToBook?: number | null;
    dividendYield?: number | null;
    "52WeekChange"?: number | null;
    beta?: number | null;
    profitMargins?: number | null;
  };
  summaryProfile?: {
    sector?: string | null;
  };
}

interface KeyStats {
  price: number;
  name: string | null;
  sector: string | null;
  priceEarnings: number | null;
  priceToBook: number | null;
  dividendYield: number | null;
  profitMargins: number | null;
  fiftyTwoWeekChange: number | null;
  beta: number | null;
  updatedAt: string;
}

// O módulo financialData da brapi.dev (que traria ROE/dívida-patrimônio/crescimento
// prontos) exige um plano acima do atual — testado: pedir financialData junto de
// outro módulo na mesma chamada derruba a chamada INTEIRA com 403 MODULES_NOT_AVAILABLE,
// não só o campo que falta. Por isso aqui só pedimos defaultKeyStatistics (P/L, P/VP,
// DY, beta, margem líquida — todos no plano atual) e calculamos ROE/dívida-patrimônio/
// crescimento a partir do balanço e DRE reais via fetchV2Statements abaixo. summaryProfile
// (setor/indústria reais, em português) vem de graça na mesma chamada — confirmado que
// combinar os dois não derruba a requisição, ao contrário de financialData.
async function fetchKeyStatistics(ticker: string): Promise<KeyStats | null> {
  const token = process.env.BRAPI_TOKEN;
  const url = `${BRAPI_BASE_URL}/${encodeURIComponent(ticker)}?modules=defaultKeyStatistics,summaryProfile`;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const response = await fetch(url, { headers });
  if (!response.ok) {
    logger.warn({ status: response.status, ticker }, "brapi.dev key statistics request failed");
    return null;
  }

  const body = (await response.json()) as { results?: BrapiKeyStatsResult[] };
  const item = body.results?.[0];
  if (!item || typeof item.regularMarketPrice !== "number") return null;

  const stats = item.defaultKeyStatistics ?? {};
  return {
    price: item.regularMarketPrice,
    name: item.longName ?? item.shortName ?? null,
    sector: item.summaryProfile?.sector ?? null,
    priceEarnings: item.priceEarnings ?? null,
    priceToBook: stats.priceToBook ?? null,
    dividendYield: stats.dividendYield ?? null,
    profitMargins: stats.profitMargins ?? null,
    fiftyTwoWeekChange: stats["52WeekChange"] ?? null,
    beta: stats.beta ?? null,
    updatedAt: item.regularMarketTime ?? new Date().toISOString(),
  };
}

const BRAPI_V2_BASE_URL = "https://brapi.dev/api/v2/stocks";

interface BrapiV2Period {
  endDate: string;
  shareholdersEquity?: number | null;
  loansAndFinancing?: number | null;
  longTermLoansAndFinancing?: number | null;
  totalRevenue?: number | null;
  netIncome?: number | null;
}

interface BrapiV2Result {
  symbol: string;
  data?: BrapiV2Period[];
}

// Plano atual da brapi.dev limita os endpoints v2 a 10 tickers por chamada —
// pedir mais devolve erro QUOTES_PER_REQUEST_EXCEEDED (sem `results`), o que sem
// esse chunking faria a lista inteira ficar sem dado nenhum silenciosamente pra
// carteiras/telas com mais de 10 ativos cotados.
const V2_BATCH_SIZE = 10;

async function fetchV2StatementsBatch(
  tickers: string[],
  path: "balance-sheet" | "income-statement",
): Promise<Map<string, BrapiV2Period[]>> {
  const result = new Map<string, BrapiV2Period[]>();
  if (tickers.length === 0) return result;

  const token = process.env.BRAPI_TOKEN;
  const url = `${BRAPI_V2_BASE_URL}/${path}?symbols=${tickers.map(encodeURIComponent).join(",")}`;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const response = await fetch(url, { headers });
  if (!response.ok) {
    logger.warn({ status: response.status, path, tickers }, "brapi.dev v2 statement request failed");
    return result;
  }

  const body = (await response.json()) as { results?: BrapiV2Result[] };
  for (const item of body.results ?? []) {
    if (item.data && item.data.length > 0) result.set(item.symbol.toUpperCase(), item.data);
  }
  return result;
}

// Endpoints v2 (diferentes do /api/quote v1) — trazem o balanço patrimonial e a DRE
// reportados de verdade (padrão CVM), com o ano mais recente primeiro em `data[]`.
// Ao contrário do v1, aceitam vários tickers numa única chamada, até o limite de
// V2_BATCH_SIZE do plano atual — daí o chunking em lotes, em paralelo.
async function fetchV2Statements(
  tickers: string[],
  path: "balance-sheet" | "income-statement",
): Promise<Map<string, BrapiV2Period[]>> {
  const result = new Map<string, BrapiV2Period[]>();
  const batches: string[][] = [];
  for (let i = 0; i < tickers.length; i += V2_BATCH_SIZE) {
    batches.push(tickers.slice(i, i + V2_BATCH_SIZE));
  }

  // allSettled, não all — um erro de rede (não só um HTTP não-2xx, já tratado dentro
  // de fetchV2StatementsBatch) num lote não pode derrubar os outros lotes.
  const batchResults = await Promise.allSettled(batches.map((batch) => fetchV2StatementsBatch(batch, path)));
  for (const outcome of batchResults) {
    if (outcome.status === "rejected") {
      logger.warn({ err: outcome.reason, path }, "brapi.dev v2 statement batch errored");
      continue;
    }
    for (const [ticker, periods] of outcome.value) result.set(ticker, periods);
  }
  return result;
}

const fundamentalsCache = new Map<string, FundamentalsCacheEntry>();

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
    const [keyStatsSettled, balanceSheets, incomeStatements] = await Promise.all([
      Promise.allSettled(stale.map((ticker) => fetchKeyStatistics(ticker))),
      fetchV2Statements(stale, "balance-sheet"),
      fetchV2Statements(stale, "income-statement"),
    ]);

    stale.forEach((ticker, i) => {
      const outcome = keyStatsSettled[i];
      const keyStats = outcome.status === "fulfilled" ? outcome.value : null;
      if (outcome.status === "rejected") {
        logger.warn({ err: outcome.reason, ticker }, "brapi.dev key statistics request errored");
      }

      let fundamentals: Fundamentals | null = null;
      if (keyStats) {
        const balanceSheet = balanceSheets.get(ticker)?.[0]; // mais recente primeiro
        const [latestIncome, previousIncome] = incomeStatements.get(ticker) ?? [];

        const equity = balanceSheet?.shareholdersEquity ?? null;
        const debt =
          balanceSheet?.loansAndFinancing != null && balanceSheet?.longTermLoansAndFinancing != null
            ? balanceSheet.loansAndFinancing + balanceSheet.longTermLoansAndFinancing
            : null;

        fundamentals = {
          price: keyStats.price,
          name: keyStats.name,
          sector: keyStats.sector,
          priceEarnings: keyStats.priceEarnings,
          priceToBook: keyStats.priceToBook,
          dividendYield: keyStats.dividendYield,
          profitMargins: keyStats.profitMargins,
          fiftyTwoWeekChange: keyStats.fiftyTwoWeekChange,
          beta: keyStats.beta,
          returnOnEquity: equity && latestIncome?.netIncome != null ? latestIncome.netIncome / equity : null,
          debtToEquity: equity ? (debt != null ? debt / equity : null) : null,
          revenueGrowth:
            latestIncome?.totalRevenue != null && previousIncome?.totalRevenue
              ? (latestIncome.totalRevenue - previousIncome.totalRevenue) / previousIncome.totalRevenue
              : null,
          updatedAt: keyStats.updatedAt,
        };
      }

      fundamentalsCache.set(ticker, { fundamentals, fetchedAt: now });
      if (fundamentals) fresh.set(ticker, fundamentals);
    });
  }

  return fresh;
}

// Categories traded on B3 and covered by brapi.dev quotes; renda_fixa/fundos have no ticker quote.
export const QUOTED_CATEGORIES = new Set(["acoes", "fiis", "etfs", "bdrs"]);

// Fallback pra quando não há setor real disponível (renda_fixa/fundos sem ticker
// de bolsa, ou falha pontual do provider) — usado por portfolio.ts (distribution,
// health) e analysis.ts (concentration alerts), kept here so all three stay in sync.
const SECTOR_MAP: Record<string, string> = {
  PETR4: "Petróleo & Gás", VALE3: "Mineração", ITUB4: "Bancos", BBDC4: "Bancos",
  ABEV3: "Bebidas", WEGE3: "Indústria", RENT3: "Locação", MGLU3: "Varejo",
  LREN3: "Varejo", EGIE3: "Energia", HGLG11: "Logística", MXRF11: "Papel",
  XPML11: "Shopping", KNRI11: "Lajes Comerciais", HSRE11: "Shopping",
  BOVA11: "ETF", SMAL11: "ETF", IVVB11: "ETF", HASH11: "ETF",
  AAPL34: "Tecnologia", AMZO34: "Tecnologia", MSFT34: "Tecnologia",
};

// Prioridade: setor definido manualmente pelo usuário no ativo > setor real da
// brapi.dev (summaryProfile, via Fundamentals.sector — passar o resultado de
// getFundamentals() como segundo argumento) > mapa curado de fallback > genérico.
export function sectorFor(asset: { ticker: string; sector: string | null }, realSector?: string | null): string {
  return asset.sector ?? realSector ?? SECTOR_MAP[asset.ticker.toUpperCase()] ?? "Outros";
}

export interface DividendEvent {
  paymentDate: string; // ISO
  rate: number; // valor por cota/ação, em R$
}

const DIVIDEND_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // anúncio de provento não muda de hora em hora
const dividendCache = new Map<string, { events: DividendEvent[]; fetchedAt: number }>();

interface BrapiStockDividendsResult {
  symbol: string;
  data?: { cashDividends?: { paymentDate: string; rate: number }[] };
}

async function fetchStockDividendsBatch(tickers: string[]): Promise<Map<string, DividendEvent[]>> {
  const result = new Map<string, DividendEvent[]>();
  if (tickers.length === 0) return result;

  const token = process.env.BRAPI_TOKEN;
  const url = `https://brapi.dev/api/v2/stocks/dividends?symbols=${tickers.map(encodeURIComponent).join(",")}`;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const response = await fetch(url, { headers });
  if (!response.ok) {
    logger.warn({ status: response.status, tickers }, "brapi.dev stock dividends request failed");
    return result;
  }

  const body = (await response.json()) as { results?: BrapiStockDividendsResult[] };
  for (const item of body.results ?? []) {
    const events = (item.data?.cashDividends ?? []).map((d) => ({ paymentDate: d.paymentDate, rate: d.rate }));
    result.set(item.symbol.toUpperCase(), events);
  }
  return result;
}

// O endpoint de dividendos de FII (/api/v2/fii/dividends) é um recurso separado do
// resto da v2 — testado e confirmado que retorna FEATURE_NOT_AVAILABLE (não
// MODULES_NOT_AVAILABLE) pra maioria dos FIIs no plano atual, funcionando só pra
// alguns poucos (ex: HGLG11, MXRF11). Por isso é best-effort por ticker, sem log de
// warning quando falha (esperado, não é um erro de fato) — o FII que falhar
// simplesmente não contribui pro total de dividendos, nunca com valor inventado.
async function fetchFiiDividends(ticker: string): Promise<DividendEvent[]> {
  const token = process.env.BRAPI_TOKEN;
  const url = `https://brapi.dev/api/v2/fii/dividends?symbols=${encodeURIComponent(ticker)}`;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const response = await fetch(url, { headers });
  if (!response.ok) return [];

  const body = (await response.json()) as { dividends?: { paymentDate: string; rate: number }[] };
  return (body.dividends ?? []).map((d) => ({ paymentDate: d.paymentDate, rate: d.rate }));
}

/**
 * Histórico real de proventos (dividendos, JCP) por ticker — ações/ETFs/BDRs via o
 * endpoint em lote (até V2_BATCH_SIZE por chamada), FIIs por ticker individual e
 * best-effort (ver fetchFiiDividends). Cache de 6h — usado por
 * POST /analysis/generate pra calcular totalDividends/portfolioYield reais.
 */
export async function getDividendEvents(
  items: { ticker: string; category: string }[],
): Promise<Map<string, DividendEvent[]>> {
  const now = Date.now();
  const fresh = new Map<string, DividendEvent[]>();
  const staleStocks: string[] = [];
  const staleFiis: string[] = [];

  const seen = new Set<string>();
  for (const item of items) {
    const ticker = item.ticker.toUpperCase();
    if (seen.has(ticker) || !QUOTED_CATEGORIES.has(item.category)) continue;
    seen.add(ticker);

    const cached = dividendCache.get(ticker);
    if (cached && now - cached.fetchedAt < DIVIDEND_CACHE_TTL_MS) {
      fresh.set(ticker, cached.events);
      continue;
    }

    if (item.category === "fiis") staleFiis.push(ticker);
    else staleStocks.push(ticker);
  }

  const stockBatches: string[][] = [];
  for (let i = 0; i < staleStocks.length; i += V2_BATCH_SIZE) stockBatches.push(staleStocks.slice(i, i + V2_BATCH_SIZE));

  const [stockBatchResults, fiiResults] = await Promise.all([
    Promise.allSettled(stockBatches.map((batch) => fetchStockDividendsBatch(batch))),
    Promise.allSettled(staleFiis.map((ticker) => fetchFiiDividends(ticker))),
  ]);

  for (const outcome of stockBatchResults) {
    if (outcome.status === "rejected") {
      logger.warn({ err: outcome.reason }, "brapi.dev stock dividends batch errored");
      continue;
    }
    for (const [ticker, events] of outcome.value) {
      dividendCache.set(ticker, { events, fetchedAt: now });
      fresh.set(ticker, events);
    }
  }

  staleFiis.forEach((ticker, i) => {
    const outcome = fiiResults[i];
    const events = outcome.status === "fulfilled" ? outcome.value : [];
    dividendCache.set(ticker, { events, fetchedAt: now });
    fresh.set(ticker, events);
  });

  return fresh;
}

export interface PriceHistory {
  price: number;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  fiveDayChangePercent: number | null; // % vs close ~5 trading days ago
  updatedAt: string;
}

interface PriceHistoryCacheEntry {
  history: PriceHistory | null;
  fetchedAt: number;
}

interface BrapiHistoricalPoint {
  date: number; // unix seconds
  close: number;
}

interface BrapiHistoryResult extends BrapiResult {
  fiftyTwoWeekHigh?: number | null;
  fiftyTwoWeekLow?: number | null;
  historicalDataPrice?: BrapiHistoricalPoint[];
}

const priceHistoryCache = new Map<string, PriceHistoryCacheEntry>();

// `?range=3mo&interval=1d` (daily closes + 52-week range) works for any quotable
// ticker on the free plan — confirmed against a non-whitelisted ação (WEGE3) and a
// FII (HGLG11), not just the paid `modules` used by getFundamentals. Used for the
// Alerta de Preço (variação forte, rompimento de máxima/mínima), which needs none
// of the paid fundamentals data.
async function fetchPriceHistory(ticker: string): Promise<PriceHistory | null> {
  const token = process.env.BRAPI_TOKEN;
  const url = `${BRAPI_BASE_URL}/${encodeURIComponent(ticker)}?range=3mo&interval=1d`;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const response = await fetch(url, { headers });
  if (!response.ok) {
    logger.warn({ status: response.status, ticker }, "brapi.dev price history request failed");
    return null;
  }

  const body = (await response.json()) as { results?: BrapiHistoryResult[] };
  const item = body.results?.[0];
  if (!item || typeof item.regularMarketPrice !== "number") return null;

  const history = item.historicalDataPrice ?? [];
  // 5 pregões atrás relative to the latest close on file — needs at least 6 points.
  const fiveDaysAgoClose = history.length >= 6 ? history[history.length - 6].close : null;
  const fiveDayChangePercent = fiveDaysAgoClose && fiveDaysAgoClose > 0
    ? ((item.regularMarketPrice - fiveDaysAgoClose) / fiveDaysAgoClose) * 100
    : null;

  return {
    price: item.regularMarketPrice,
    fiftyTwoWeekHigh: item.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow: item.fiftyTwoWeekLow ?? null,
    fiveDayChangePercent,
    updatedAt: item.regularMarketTime ?? new Date().toISOString(),
  };
}

/**
 * Cached lookup of price history (52-week high/low, 5-trading-day change) used by
 * the Alerta de Preço. Separate from getQuotes because it's a heavier payload
 * (historical series) that most callers don't need on every price lookup.
 */
export async function getPriceHistories(tickers: string[]): Promise<Map<string, PriceHistory>> {
  const uniqueTickers = Array.from(new Set(tickers.map((t) => t.toUpperCase())));
  if (uniqueTickers.length === 0) return new Map();

  const now = Date.now();
  const fresh = new Map<string, PriceHistory>();
  const stale: string[] = [];

  for (const ticker of uniqueTickers) {
    const cached = priceHistoryCache.get(ticker);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      if (cached.history) fresh.set(ticker, cached.history);
    } else {
      stale.push(ticker);
    }
  }

  if (stale.length > 0) {
    const settled = await Promise.allSettled(stale.map((ticker) => fetchPriceHistory(ticker)));
    stale.forEach((ticker, i) => {
      const outcome = settled[i];
      const history = outcome.status === "fulfilled" ? outcome.value : null;
      if (outcome.status === "rejected") {
        logger.warn({ err: outcome.reason, ticker }, "brapi.dev price history request errored");
      }
      priceHistoryCache.set(ticker, { history, fetchedAt: now });
      if (history) fresh.set(ticker, history);
    });
  }

  return fresh;
}

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
