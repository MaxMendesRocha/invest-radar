import { db, priceSnapshotsTable } from "@workspace/db";
import { latestTreasuryBonds } from "./treasury-identity";
import { inArray, sql } from "drizzle-orm";
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
 * Grava em price_snapshots as cotações que a brapi.dev acabou de devolver de verdade,
 * para servirem de último preço conhecido quando ela cair (ver getLastKnownPrices).
 *
 * Só é chamada no ramo que foi de fato à rede, então o volume é de no máximo uma
 * escrita por ticker a cada CACHE_TTL_MS. Falha de banco aqui é registrada e
 * engolida de propósito: gravar o histórico é acessório, e derrubar a cotação ao vivo
 * por causa disso trocaria um problema pequeno por um grande.
 */
async function recordPriceSnapshots(quotes: Map<string, Quote>): Promise<void> {
  if (quotes.size === 0) return;
  const rows = Array.from(quotes, ([ticker, quote]) => ({
    ticker,
    price: String(quote.price),
    capturedAt: new Date(),
  }));
  try {
    await db
      .insert(priceSnapshotsTable)
      .values(rows)
      .onConflictDoUpdate({
        target: priceSnapshotsTable.ticker,
        set: {
          price: sql`excluded.price`,
          capturedAt: sql`excluded.captured_at`,
        },
      });
  } catch (err) {
    logger.warn({ err, tickers: Array.from(quotes.keys()) }, "price snapshot upsert failed");
  }
}

/**
 * A partir de quanto tempo um preço parado deixa de ser "a última cotação" e vira um
 * número órfão. Dentro da janela, o cenário provável é o provedor fora do ar e o
 * preço continua descrevendo o ativo; muito além dela, o cenário provável é o ticker
 * ter saído de negociação — e aí congelar o último preço para sempre esconderia o
 * fato em vez de informá-lo. Passado o prazo, volta a valer o aviso de "sem cotação".
 */
const MAX_SNAPSHOT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Último preço real conhecido por ticker, dentro da janela de MAX_SNAPSHOT_AGE_MS. */
export async function getLastKnownPrices(tickers: string[]): Promise<Map<string, { price: number; capturedAt: Date }>> {
  const result = new Map<string, { price: number; capturedAt: Date }>();
  if (tickers.length === 0) return result;

  let rows: { ticker: string; price: string; capturedAt: Date }[] = [];
  try {
    rows = await db.select().from(priceSnapshotsTable).where(inArray(priceSnapshotsTable.ticker, tickers));
  } catch (err) {
    logger.warn({ err, tickers }, "price snapshot lookup failed");
    return result;
  }

  const now = Date.now();
  for (const row of rows) {
    const price = parseFloat(row.price);
    if (Number.isNaN(price) || price <= 0) continue;
    if (now - row.capturedAt.getTime() > MAX_SNAPSHOT_AGE_MS) continue;
    result.set(row.ticker.toUpperCase(), { price, capturedAt: row.capturedAt });
  }
  return result;
}

/**
 * Batched, cached lookup of real-time B3 quotes (ações, FIIs, ETFs, BDRs) via brapi.dev.
 * Tickers with no quote available (delisted, wrong category, provider error) are simply
 * absent from the returned map.
 *
 * Devolve SÓ cotação ao vivo, de propósito — o fallback de último preço conhecido mora
 * em getPricesFor, uma camada acima. Quem chama aqui (fundamentos, alerta de preço)
 * precisa saber que o dado é de agora: um alerta de preço disparado a partir de uma
 * cotação de ontem avisaria sobre um patamar que o ativo pode nem ter tocado.
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
    await recordPriceSnapshots(fetched);
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
  totalAssets: number | null; // ativo total (balanço), usado na decomposição DuPont do ROE
  ebit: number | null; // lucro antes de juros e impostos (DRE), idem
  incomeBeforeTax: number | null; // lucro antes de impostos (DRE), idem
  netIncome: number | null; // lucro líquido (DRE), idem — já usado internamente pro ROE, agora exposto pra decomposição
  shareholdersEquity: number | null; // patrimônio líquido (balanço), idem — já usado internamente pro ROE/dívida-patrimônio
  totalRevenue: number | null; // receita total (DRE), idem — já usado internamente pro crescimento de receita
  sharesOutstanding: number | null; // nº de cotas/ações em circulação (defaultKeyStatistics) — usado pra converter DPS por ação em dividendos totais pagos
  // Campos do módulo financialData — liberados só a partir do plano Pro da brapi.dev
  // (antes retornavam 403 MODULES_NOT_AVAILABLE). Todos null quando o plano não cobre
  // ou o provider não tem o dado pro ticker, nunca estimados.
  freeCashflow: number | null; // fluxo de caixa livre
  operatingCashflow: number | null; // fluxo de caixa operacional
  currentRatio: number | null; // liquidez corrente
  ebitda: number | null; // null pra bancos — não reportam EBITDA de forma significativa
  returnOnAssets: number | null; // ROA
  totalDebt: number | null; // dívida bruta total
  totalCash: number | null; // caixa e equivalentes
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
    sharesOutstanding?: number | null;
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
  sharesOutstanding: number | null;
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
    sharesOutstanding: stats.sharesOutstanding ?? null,
    updatedAt: item.regularMarketTime ?? new Date().toISOString(),
  };
}

interface BrapiFinancialData {
  freeCashflow?: number | null;
  operatingCashflow?: number | null;
  currentRatio?: number | null;
  ebitda?: number | null;
  returnOnAssets?: number | null;
  totalDebt?: number | null;
  totalCash?: number | null;
}

interface BrapiFinancialDataResult {
  symbol: string;
  data?: BrapiFinancialData | null;
}

// Módulo financialData via o endpoint v2 dedicado (aceita vários símbolos por chamada,
// diferente do v1 `?modules=financialData`, que segue derrubando a requisição inteira
// quando combinado com outros módulos). Exige plano Pro — sem ele responde 403
// MODULES_NOT_AVAILABLE e todos os campos ficam null, sem quebrar o resto da análise.
// Traz EBITDA, fluxo de caixa livre/operacional, liquidez corrente e ROA reais.
// `targetMeanPrice` existe no payload mas vem null mesmo no Pro (confirmado em toda a
// amostra testada) — por isso computePotentialReturn segue na heurística documentada.
async function fetchFinancialDataBatch(tickers: string[]): Promise<Map<string, BrapiFinancialData>> {
  const result = new Map<string, BrapiFinancialData>();
  if (tickers.length === 0) return result;

  const token = process.env.BRAPI_TOKEN;
  const url = `${BRAPI_V2_BASE_URL}/financial-data?symbols=${tickers.map(encodeURIComponent).join(",")}`;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const response = await fetch(url, { headers });
  if (!response.ok) {
    logger.warn({ status: response.status, tickers }, "brapi.dev financial-data request failed");
    return result;
  }

  const body = (await response.json()) as { results?: BrapiFinancialDataResult[] };
  for (const item of body.results ?? []) {
    if (item.data) result.set(item.symbol.toUpperCase(), item.data);
  }
  return result;
}

// Mesmo chunking de fetchV2Statements — o endpoint aceitou 12 símbolos numa chamada no
// teste, mas mantemos o lote de V2_BATCH_SIZE por consistência com os outros endpoints
// v2 e pra não depender de um limite não documentado.
async function fetchFinancialData(tickers: string[]): Promise<Map<string, BrapiFinancialData>> {
  const result = new Map<string, BrapiFinancialData>();
  const batches: string[][] = [];
  for (let i = 0; i < tickers.length; i += V2_BATCH_SIZE) {
    batches.push(tickers.slice(i, i + V2_BATCH_SIZE));
  }

  const outcomes = await Promise.allSettled(batches.map((batch) => fetchFinancialDataBatch(batch)));
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      logger.warn({ err: outcome.reason }, "brapi.dev financial-data batch errored");
      continue;
    }
    for (const [ticker, data] of outcome.value) result.set(ticker, data);
  }
  return result;
}

const BRAPI_V2_BASE_URL = "https://brapi.dev/api/v2/stocks";

interface BrapiV2Period {
  endDate: string;
  shareholdersEquity?: number | null;
  loansAndFinancing?: number | null;
  longTermLoansAndFinancing?: number | null;
  totalRevenue?: number | null;
  netIncome?: number | null;
  totalAssets?: number | null; // só vem no payload de balance-sheet
  ebit?: number | null; // só vem no payload de income-statement
  incomeBeforeTax?: number | null; // idem
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
    const [keyStatsSettled, balanceSheets, incomeStatements, financialData] = await Promise.all([
      Promise.allSettled(stale.map((ticker) => fetchKeyStatistics(ticker))),
      fetchV2Statements(stale, "balance-sheet"),
      fetchV2Statements(stale, "income-statement"),
      fetchFinancialData(stale),
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
        const finData = financialData.get(ticker);

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
          totalAssets: balanceSheet?.totalAssets ?? null,
          ebit: latestIncome?.ebit ?? null,
          incomeBeforeTax: latestIncome?.incomeBeforeTax ?? null,
          netIncome: latestIncome?.netIncome ?? null,
          shareholdersEquity: equity,
          totalRevenue: latestIncome?.totalRevenue ?? null,
          sharesOutstanding: keyStats.sharesOutstanding,
          freeCashflow: finData?.freeCashflow ?? null,
          operatingCashflow: finData?.operatingCashflow ?? null,
          currentRatio: finData?.currentRatio ?? null,
          ebitda: finData?.ebitda ?? null,
          returnOnAssets: finData?.returnOnAssets ?? null,
          totalDebt: finData?.totalDebt ?? null,
          totalCash: finData?.totalCash ?? null,
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
  label: string; // "DIVIDENDO" | "JCP" | "RENDIMENTO" etc., como vem da brapi.dev
  approvedOn: string | null; // ISO da aprovação em ata; null = ainda não formalizado (ou fora do que a brapi rastreia, caso dos FIIs)
  /**
   * DATA-COM: último pregão em que o ativo negocia COM direito ao provento. Quem
   * comprou até esta data recebe; quem comprou depois, não.
   *
   * Vem da brapi como `lastDatePrior`, nos dois endpoints (ações e FII), com cobertura
   * de 100% na amostra medida — 1.100 eventos de PETR4/VALE3/ITUB4/TAEE11/BBAS3 e os
   * 12 de HGLG11. O campo existia desde sempre e este mapeamento simplesmente o
   * descartava, o que levou a documentar por engano que "o provider não entrega
   * data-com" e a inferir o direito ao provento pela data de compra com uma folga
   * fixa de 45 dias. A folga era errada: PETR4 paga até 112 dias depois da data-com,
   * então quem comprasse no meio do caminho era marcado como tendo direito sem ter.
   */
  lastDatePrior: string | null;
}

const DIVIDEND_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // anúncio de provento não muda de hora em hora

export type FiiSegment = "tijolo" | "papel" | "hibrido" | "fof";

export interface FiiProfile {
  segmentType: FiiSegment | null; // classificação patrimonial — o campo que mais muda a leitura de risco de um FII
  segmentoAtuacao: string | null; // setor imobiliário (Logística, Shoppings, Lajes Corporativas...)
  tipoGestao: string | null; // "Ativa" | "Definida" (passiva)
  priceToNav: number | null; // P/VP do endpoint dedicado
  dividendYield12m: number | null; // decimal
}

interface BrapiFiiIndicator {
  symbol: string;
  segmentType?: string | null;
  segmentoAtuacao?: string | null;
  tipoGestao?: string | null;
  priceToNav?: number | null;
  dividendYield12m?: number | null;
}

// Empírico: 45 tickers numa chamada só falha, 10 passa.
const FII_PROFILE_BATCH_SIZE = 15;

const FII_SEGMENTS = new Set<FiiSegment>(["tijolo", "papel", "hibrido", "fof"]);
const FII_PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // indicadores de FII são atualizados 1x/dia após o fechamento (doc da brapi)
const fiiProfileCache = new Map<string, { profile: FiiProfile | null; fetchedAt: number }>();

/**
 * Perfil de FII via o endpoint dedicado /api/v2/fii/indicators (exige plano Pro —
 * sem ele responde FEATURE_NOT_AVAILABLE e todo mundo fica null, sem quebrar nada).
 *
 * O campo que realmente importa aqui é `segmentType`: FII de papel (CRI/LCI) e de
 * tijolo (imóvel físico) têm riscos estruturalmente diferentes — papel carrega risco
 * de crédito e costuma acompanhar CDI/IPCA, tijolo carrega risco de vacância mas tem
 * aluguel indexado à inflação. Ler o mesmo dividend yield sem saber qual dos dois é
 * leva a conclusão errada.
 *
 * Ticker que não é FII devolve NOT_FOUND (testado) — tratado como perfil ausente, não
 * como erro. Lote misto com ações não contamina a resposta (também testado): o
 * provider simplesmente ignora quem não é FII, diferente do endpoint de dividendos.
 * `mandate` existe no payload mas vem null em toda a amostra testada, então não é
 * capturado. Vacância (endpoint /properties) ficou de fora de propósito: a qualidade
 * do dado é inconsistente — há fundos em que todos os imóveis vêm com vacância 100%
 * (ex. XPML11), o que tornaria a informação enganosa sem um filtro de sanidade.
 */
export async function getFiiProfiles(tickers: string[]): Promise<Map<string, FiiProfile>> {
  const unique = Array.from(new Set(tickers.map((t) => t.toUpperCase())));
  if (unique.length === 0) return new Map();

  const now = Date.now();
  const fresh = new Map<string, FiiProfile>();
  const stale: string[] = [];

  for (const ticker of unique) {
    const cached = fiiProfileCache.get(ticker);
    if (cached && now - cached.fetchedAt < FII_PROFILE_CACHE_TTL_MS) {
      if (cached.profile) fresh.set(ticker, cached.profile);
    } else {
      stale.push(ticker);
    }
  }

  if (stale.length === 0) return fresh;

  const token = process.env.BRAPI_TOKEN;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  // Em lotes, não numa URL só. Pedir os 45 FIIs do universo de uma vez derruba a
  // chamada inteira; com 10 funciona. Como a falha é silenciosa (cai no catch e
  // devolve o mapa vazio), o efeito era o agrupamento por segmento simplesmente não
  // acontecer na varredura, sem nada quebrar de forma visível.
  for (let start = 0; start < stale.length; start += FII_PROFILE_BATCH_SIZE) {
    const batch = stale.slice(start, start + FII_PROFILE_BATCH_SIZE);
    const url = `https://brapi.dev/api/v2/fii/indicators?symbols=${batch.map(encodeURIComponent).join(",")}`;

    try {
      const response = await fetch(url, { headers });
      // NOT_FOUND é o caso normal de "não é FII", não uma falha — por isso não logamos
      // warning aqui, ao contrário dos outros fetchers.
      const body = (await response.json()) as { fiis?: BrapiFiiIndicator[]; error?: boolean };
      const found = new Set<string>();

      for (const item of body.fiis ?? []) {
        const ticker = item.symbol.toUpperCase();
        const segment = item.segmentType?.toLowerCase();
        const profile: FiiProfile = {
          segmentType: segment && FII_SEGMENTS.has(segment as FiiSegment) ? (segment as FiiSegment) : null,
          segmentoAtuacao: item.segmentoAtuacao ?? null,
          tipoGestao: item.tipoGestao ?? null,
          priceToNav: item.priceToNav ?? null,
          dividendYield12m: item.dividendYield12m ?? null,
        };
        fiiProfileCache.set(ticker, { profile, fetchedAt: now });
        fresh.set(ticker, profile);
        found.add(ticker);
      }

      // Quem foi pedido e não voltou (não é FII, ou o plano não cobre) entra no cache
      // como ausente pra não repetir a chamada a cada request.
      for (const ticker of batch) {
        if (!found.has(ticker)) fiiProfileCache.set(ticker, { profile: null, fetchedAt: now });
      }
    } catch (err) {
      // Só este lote se perde; os demais seguem. Não cacheia como ausente aqui —
      // falha de rede não é "não é FII", e marcar assim esconderia o segmento por
      // 24h inteiras.
      logger.warn({ err, tickers: batch }, "brapi.dev FII indicators batch errored");
    }
  }

  return fresh;
}
const dividendCache = new Map<string, { events: DividendEvent[]; fetchedAt: number }>();

interface BrapiStockDividendsResult {
  symbol: string;
  data?: { cashDividends?: { paymentDate: string; rate: number; label: string; approvedOn: string | null; lastDatePrior: string | null }[] };
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
    const events = (item.data?.cashDividends ?? []).map((d) => ({
      paymentDate: d.paymentDate, rate: d.rate, label: d.label, approvedOn: d.approvedOn ?? null,
      lastDatePrior: d.lastDatePrior ?? null,
    }));
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

  const body = (await response.json()) as { dividends?: { paymentDate: string; rate: number; label: string; approvedOn: string | null; lastDatePrior: string | null }[] };
  // approvedOn vem sempre null nesse endpoint (dado importado de CSV, ver comentário
  // acima) — mesmo pra pagamentos já ocorridos no passado, então não serve pra
  // distinguir "confirmado" de "previsto" em FIIs como serve pra ações.
  return (body.dividends ?? []).map((d) => ({
    paymentDate: d.paymentDate, rate: d.rate, label: d.label,
    approvedOn: d.approvedOn ?? null, lastDatePrior: d.lastDatePrior ?? null,
  }));
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

    // ETFs entram no mesmo caminho best-effort dos FIIs, não no lote de ações — testado
    // e confirmado que a brapi.dev rejeita o lote INTEIRO de /v2/stocks/dividends
    // (FII_DIVIDENDS_MISUSE) quando qualquer ticker de sufixo "11" (todo ETF B3, ex.
    // BOVA11) entra na mesma chamada, derrubando silenciosamente o dado real de ações
    // que estariam no mesmo lote de até V2_BATCH_SIZE. Isolando por ticker aqui, o pior
    // caso vira o próprio ETF sem histórico (nenhum módulo real disponível pra ETF no
    // plano atual — confirmado, FEATURE_NOT_AVAILABLE também no endpoint de FII), nunca
    // mais contamina o resto do lote.
    if (item.category === "fiis" || item.category === "etfs") staleFiis.push(ticker);
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

/**
 * Histórico de proventos pra UM ticker sem saber a categoria antecipadamente — caso do
 * parecer pré-compra, onde o usuário busca um ticker que não está na carteira (logo
 * sem `category` cadastrado). Tenta o endpoint de ações/ETFs/BDRs; se vier vazio,
 * tenta o de FII. Não usa o dividendCache de getDividendEvents (chave por categoria
 * conhecida) — o chamador é responsável por cachear a resposta inteira do parecer.
 */
export async function getDividendEventsForTicker(ticker: string): Promise<DividendEvent[]> {
  const upper = ticker.toUpperCase();
  const [stockResult, fiiEvents] = await Promise.all([
    fetchStockDividendsBatch([upper]),
    fetchFiiDividends(upper),
  ]);
  const stockEvents = stockResult.get(upper) ?? [];
  return stockEvents.length > 0 ? stockEvents : fiiEvents;
}

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// DPS real dos últimos 12 meses, sem exigir os 12 meses anteriores (diferente de
// computeDividendTrend, que precisa das duas janelas pra calcular tendência de
// crescimento). Usado por payout ratio (analysis-engine.ts) e projeção de renda
// passiva (/portfolio/dividends/projection) — nenhum dos dois precisa de comparação
// ano a ano, só do total real recebido, então exigir 24 meses descartaria dado real
// disponível (ex. FIIs cujo provider só cobre os últimos ~12 meses) sem necessidade.
export function sumLast12Months(events: DividendEvent[], now: number): number | null {
  let total = 0;
  let hasAny = false;

  for (const event of events) {
    const paidAt = new Date(event.paymentDate).getTime();
    if (paidAt > now) continue;
    if (now - paidAt <= ONE_YEAR_MS) {
      total += event.rate;
      hasAny = true;
    }
  }

  return hasAny ? total : null;
}

export type DividendFrequencyLabel = "Mensal" | "Trimestral" | "Semestral" | "Anual" | "Irregular";

export interface DividendFrequency {
  label: DividendFrequencyLabel;
  paymentsLast12m: number;
}

/** Datas DISTINTAS de pagamento dentro de uma janela, em ordem cronológica. */
function distinctPaymentTimes(events: DividendEvent[], now: number, windowMs: number): number[] {
  // Agrupa por DATA (não por evento) — é comum um ativo pagar dividendo + JCP na
  // mesma data em linhas separadas do provider; contar cada linha como um pagamento
  // distinto criaria gaps de 0 dias artificiais e classificaria como "Irregular" um
  // ativo que na prática paga num calendário perfeitamente regular (ex. TAEE11,
  // trimestral de verdade, mas com 2-3 linhas na mesma data a cada trimestre).
  const distinctDates = new Set(
    events
      .map((e) => new Date(e.paymentDate).getTime())
      .filter((t) => t <= now && now - t <= windowMs)
      .map((t) => new Date(t).toISOString().slice(0, 10))
  );
  return Array.from(distinctDates)
    .map((d) => new Date(d).getTime())
    .sort((a, b) => a - b);
}

function gapsInDays(paymentTimes: number[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < paymentTimes.length; i++) {
    gaps.push((paymentTimes[i] - paymentTimes[i - 1]) / (24 * 60 * 60 * 1000));
  }
  return gaps;
}

/** Desvio máximo de até 50% do intervalo médio. */
function isRegularCadence(gapsDays: number[]): boolean {
  if (gapsDays.length === 0) return false;
  const avgGap = gapsDays.reduce((sum, g) => sum + g, 0) / gapsDays.length;
  return Math.max(...gapsDays.map((g) => Math.abs(g - avgGap))) <= avgGap * 0.5;
}

// Periodicidade real de pagamento, a partir do espaçamento entre DATAS distintas de
// pagamento — nunca declarada como "Mensal"/"Trimestral"/etc. quando os pagamentos
// não forem regulares o suficiente; nesse caso vira "Irregular" em vez de uma
// rotulagem falsamente precisa. null quando não há nenhum pagamento real no período
// (não paga, ou histórico insuficiente).
//
// A CADÊNCIA vem dos últimos 12 meses — descreve o ritmo atual, que é o que
// interessa a quem olha o card hoje. Mas ela só é declarada se TIVER SE SUSTENTADO
// ao longo de 24 meses: o rótulo é uma promessa sobre quando esperar o próximo
// pagamento, e doze meses é janela curta demais para distinguir uma pagadora
// trimestral de verdade de uma que distribui em blocos.
//
// O EQPA3 pagou em nov e dez/2024, passou 2025 inteiro sem pagar, e voltou com três
// pagamentos entre dez/2025 e jul/2026. Nos últimos 12 meses os intervalos ficam em
// 124 e 70 dias e ele passa por "Trimestral" — que é, aliás, exatamente o que
// portais de mercado exibem para esse papel.
//
// O teste é o VAZIO MÁXIMO em 24 meses contra o teto da cadência declarada, e não a
// dispersão dos intervalos: medidos por dispersão, EQPA3 (2,9x a mediana) e PETR4
// (2,8x) são indistinguíveis, mas o maior vazio do primeiro é de 361 dias — um ano
// sem pagar — contra 92 dias do segundo, que é só o trimestre normal de quem paga em
// parcelas. Pagadoras que fatiam o provento em várias datas por período continuam
// classificadas corretamente, porque nenhum vazio delas passa do teto.
// Vazio máximo tolerado por cadência: o teto do intervalo de cada rótulo mais 60
// dias de folga, para não punir atraso pontual de calendário societário.
const MAX_DROUGHT_DAYS: Record<Exclude<DividendFrequencyLabel, "Irregular">, number> = {
  Mensal: 100,
  Trimestral: 160,
  Semestral: 260,
  Anual: 425,
};

function cadenceFromAverageGap(avgGap: number): Exclude<DividendFrequencyLabel, "Irregular"> {
  if (avgGap <= 40) return "Mensal";
  if (avgGap <= 100) return "Trimestral";
  if (avgGap <= 200) return "Semestral";
  return "Anual";
}

export function classifyDividendFrequency(events: DividendEvent[], now: number): DividendFrequency | null {
  const last12m = distinctPaymentTimes(events, now, ONE_YEAR_MS);
  if (last12m.length === 0) return null;

  const paymentsLast12m = last12m.length;
  const gapsDays = gapsInDays(last12m);

  let label: Exclude<DividendFrequencyLabel, "Irregular">;
  if (paymentsLast12m === 1) {
    label = "Anual";
  } else {
    if (!isRegularCadence(gapsDays)) return { label: "Irregular", paymentsLast12m };
    label = cadenceFromAverageGap(gapsDays.reduce((sum, g) => sum + g, 0) / gapsDays.length);
  }

  // Um único vazio acima do teto derruba o rótulo: significa que a cadência não se
  // sustentou, mesmo que os pagamentos recentes pareçam espaçados de forma regular.
  const gaps24m = gapsInDays(distinctPaymentTimes(events, now, ONE_YEAR_MS * 2));
  if (gaps24m.length > 0 && Math.max(...gaps24m) > MAX_DROUGHT_DAYS[label]) {
    return { label: "Irregular", paymentsLast12m };
  }

  return { label, paymentsLast12m };
}

export interface DividendTrend {
  last12mTotal: number; // R$ por unidade, soma dos proventos pagos nos últimos 12 meses
  prior12mTotal: number; // R$ por unidade, soma dos 12 meses anteriores a esses
  growthPercent: number; // (last12m - prior12m) / prior12m * 100
}

// Compara a soma de proventos pagos nos últimos 12 meses com os 12 meses anteriores a
// esses, a partir do histórico real (getDividendEvents/getDividendEventsForTicker) —
// nunca projeta nem estima nada, só retorna null quando não há pelo menos um evento
// real em cada uma das duas janelas (histórico curto demais pra dizer se está
// crescendo ou não).
export function computeDividendTrend(events: DividendEvent[], now: number): DividendTrend | null {
  let last12mTotal = 0;
  let prior12mTotal = 0;
  let hasLast12m = false;
  let hasPrior12m = false;

  for (const event of events) {
    const paidAt = new Date(event.paymentDate).getTime();
    if (paidAt > now) continue; // eventos futuros (ver /portfolio/dividends/upcoming) não contam pra tendência histórica
    const ageMs = now - paidAt;
    if (ageMs <= ONE_YEAR_MS) {
      last12mTotal += event.rate;
      hasLast12m = true;
    } else if (ageMs <= ONE_YEAR_MS * 2) {
      prior12mTotal += event.rate;
      hasPrior12m = true;
    }
  }

  if (!hasLast12m || !hasPrior12m || prior12mTotal === 0) return null;

  return {
    last12mTotal,
    prior12mTotal,
    growthPercent: ((last12mTotal - prior12mTotal) / prior12mTotal) * 100,
  };
}

const SIX_MONTHS_MS = ONE_YEAR_MS / 2;

export interface DistributionMomentum {
  last6mTotal: number; // R$ por cota, soma dos 6 meses mais recentes
  prior6mTotal: number; // R$ por cota, soma dos 6 meses anteriores a esses
  ratio: number; // last6 / prior6 — 1.0 = distribuição estável
}

/**
 * Compara os proventos dos últimos 6 meses com os 6 meses anteriores.
 *
 * Existe em paralelo a computeDividendTrend (12m vs 12m anteriores) por uma razão
 * medida, não por gosto: o provider cobre ~12 meses de histórico para FII, então a
 * janela dos "12 meses anteriores" existe para apenas 5 dos 45 FIIs do universo —
 * computeDividendTrend devolveria null para os outros 40. Com a janela de 6 meses,
 * os 45 têm resposta. Para FII, que distribui todo mês, 6 meses já são 6 pagamentos
 * reais: é amostra suficiente para dizer se a distribuição está caindo, e é
 * exatamente o sinal que separa um yield alto sustentável de um yield alto que é só
 * o preço despencando.
 *
 * Devolve null quando falta evento real em qualquer das duas janelas — sem base de
 * comparação não se inventa tendência.
 */
export function computeDistributionMomentum(events: DividendEvent[], now: number): DistributionMomentum | null {
  let last6mTotal = 0;
  let prior6mTotal = 0;
  let hasLast = false;
  let hasPrior = false;

  for (const event of events) {
    const paidAt = new Date(event.paymentDate).getTime();
    if (paidAt > now) continue;
    const ageMs = now - paidAt;
    if (ageMs <= SIX_MONTHS_MS) {
      last6mTotal += event.rate;
      hasLast = true;
    } else if (ageMs <= ONE_YEAR_MS) {
      prior6mTotal += event.rate;
      hasPrior = true;
    }
  }

  if (!hasLast || !hasPrior || prior6mTotal === 0) return null;
  return { last6mTotal, prior6mTotal, ratio: last6mTotal / prior6mTotal };
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

export interface OhlcPoint {
  date: string; // ISO
  close: number;
  adjustedClose: number; // usado em todo cálculo técnico (technical-engine.ts), nunca `close` puro — evita que desdobramento/provento vire um "gap" falso no gráfico
  volume: number;
}

interface BrapiOhlcPoint {
  date: number; // unix seconds
  close: number;
  adjustedClose?: number;
  volume?: number;
}

interface BrapiExtendedHistoryResult extends BrapiResult {
  historicalDataPrice?: BrapiOhlcPoint[];
}

const TECHNICAL_SERIES_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // indicador é de fechamento diário, não precisa ser mais fresco que isso
const technicalSeriesCache = new Map<string, { points: OhlcPoint[]; fetchedAt: number }>();

async function fetchTechnicalSeries(ticker: string): Promise<OhlcPoint[]> {
  const token = process.env.BRAPI_TOKEN;
  // 1 ano de candles diários (~249 pontos reais, testado) — suficiente pra SMA200,
  // o indicador que exige mais histórico entre os que technical-engine.ts calcula.
  const url = `${BRAPI_BASE_URL}/${encodeURIComponent(ticker)}?range=1y&interval=1d`;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const response = await fetch(url, { headers });
  if (!response.ok) {
    logger.warn({ status: response.status, ticker }, "brapi.dev technical series request failed");
    return [];
  }

  const body = (await response.json()) as { results?: BrapiExtendedHistoryResult[] };
  const item = body.results?.[0];
  const history = item?.historicalDataPrice ?? [];

  return history
    .filter((p): p is Required<BrapiOhlcPoint> => typeof p.close === "number" && typeof p.adjustedClose === "number")
    .map((p) => ({
      date: new Date(p.date * 1000).toISOString().slice(0, 10),
      close: p.close,
      adjustedClose: p.adjustedClose,
      volume: p.volume ?? 0,
    }));
}

/**
 * Série diária de 1 ano (fechamento ajustado) por ticker, usada por
 * technical-engine.ts pra calcular indicadores técnicos reais (médias móveis, RSI,
 * MACD, Bollinger). Cache de 24h — separado de getPriceHistories porque é um payload
 * bem mais pesado (a série inteira, não só min/max/variação) que só quem calcula
 * indicador técnico precisa buscar.
 */
export async function getTechnicalSeries(tickers: string[]): Promise<Map<string, OhlcPoint[]>> {
  const uniqueTickers = Array.from(new Set(tickers.map((t) => t.toUpperCase())));
  if (uniqueTickers.length === 0) return new Map();

  const now = Date.now();
  const fresh = new Map<string, OhlcPoint[]>();
  const stale: string[] = [];

  for (const ticker of uniqueTickers) {
    const cached = technicalSeriesCache.get(ticker);
    if (cached && now - cached.fetchedAt < TECHNICAL_SERIES_CACHE_TTL_MS) {
      fresh.set(ticker, cached.points);
    } else {
      stale.push(ticker);
    }
  }

  if (stale.length > 0) {
    const settled = await Promise.allSettled(stale.map((ticker) => fetchTechnicalSeries(ticker)));
    stale.forEach((ticker, i) => {
      const outcome = settled[i];
      const points = outcome.status === "fulfilled" ? outcome.value : [];
      if (outcome.status === "rejected") {
        logger.warn({ err: outcome.reason, ticker }, "brapi.dev technical series request errored");
      }
      technicalSeriesCache.set(ticker, { points, fetchedAt: now });
      fresh.set(ticker, points);
    });
  }

  return fresh;
}

export interface PricePoint {
  price: number;
  /**
   * null quando o preço é a cotação ao vivo. Preenchido com o instante da captura
   * quando é o último preço conhecido, servido porque o provedor não respondeu — ou
   * seja, `asOf != null` É a marca de defasagem, não existe um booleano paralelo que
   * possa discordar dela. Quem exibe o valor ao usuário tem obrigação de dizer a
   * data; quem só agrega (percentual de concentração, distribuição por setor) pode
   * ignorar o campo, e nesses casos um preço datado ainda descreve a carteira muito
   * melhor do que o preço médio de compra.
   */
  asOf: Date | null;
}

export interface PriceableItem {
  ticker: string;
  category: string;
  /** Preenchidos só em posição de Tesouro Direto — ver o schema de assets. */
  treasuryBondType?: string | null;
  treasuryMaturityDate?: string | null;
}

/**
 * Marca a mercado as posições de Tesouro Direto, pelo PU de RECOMPRA da data-base mais
 * recente sincronizada (treasury_bonds).
 *
 * Recompra e não compra: a posição vale o que se consegue ao vendê-la, e o spread entre
 * os dois lados chega a 2,66% nos IPCA+ longos — usar o preço de compra infla o
 * patrimônio justamente nos títulos de maior prazo. Se o arquivo não trouxer o lado da
 * recompra, o título não é marcado, em vez de cair no preço de compra: melhor a posição
 * seguir no preço médio, com o motivo visível, do que exibir um valor otimista.
 *
 * `asOf` recebe a data-base do arquivo porque o PU é sempre de um ou dois dias úteis
 * atrás — é dado real e datado, exatamente a semântica do campo.
 */
async function getTreasuryPrices(items: PriceableItem[]): Promise<Map<string, PricePoint>> {
  const prices = new Map<string, PricePoint>();
  const treasuryItems = items.filter((i) => i.treasuryBondType && i.treasuryMaturityDate);
  if (treasuryItems.length === 0) return prices;

  let rows: { bondType: string; maturityDate: string; baseDate: string; sellUnitPrice: string | null }[] = [];
  try {
    // latestTreasuryBonds e não a tabela inteira: ela guarda o histórico desde 2002, e
    // sem o filtro cada marcação a mercado varreria duas décadas de preços.
    rows = await latestTreasuryBonds();
  } catch (err) {
    logger.warn({ err }, "consulta de títulos do Tesouro falhou");
    return prices;
  }

  const byKey = new Map(rows.map((r) => [`${r.bondType}|${r.maturityDate}`, r]));
  for (const item of treasuryItems) {
    const bond = byKey.get(`${item.treasuryBondType}|${item.treasuryMaturityDate}`);
    if (!bond?.sellUnitPrice) continue;
    const price = parseFloat(bond.sellUnitPrice);
    if (!Number.isFinite(price) || price <= 0) continue;
    prices.set(item.ticker.toUpperCase(), { price, asOf: new Date(`${bond.baseDate}T00:00:00Z`) });
  }

  return prices;
}

/**
 * Convenience wrapper around getQuotes for a list of { ticker, category } records
 * (assets, opportunities, ...): filters to quotable categories and returns a
 * ticker -> PricePoint map.
 *
 * Ticker ausente do mapa significa que não há preço nenhum — nem ao vivo, nem
 * guardado dentro da janela, nem PU de título público — e o chamador cai no preço que
 * já tem em mãos (o médio de compra). Esse era o único comportamento antes; hoje ele é
 * o último degrau.
 *
 * Renda fixa entra por aqui mesmo estando fora de QUOTED_CATEGORIES: título público não
 * tem cotação de bolsa, mas tem PU diário publicado, e é este helper que todas as telas
 * usam para valorizar posição. Ligar a marcação aqui, em vez de em cada rota, é o que
 * faz patrimônio, distribuição, saúde, concentração e meta de renda passarem a contar o
 * Tesouro corretamente de uma vez.
 */
export async function getPricesFor(items: PriceableItem[]): Promise<Map<string, PricePoint>> {
  const prices = new Map<string, PricePoint>();

  const tickers = items.filter((i) => QUOTED_CATEGORIES.has(i.category)).map((i) => i.ticker.toUpperCase());
  if (tickers.length > 0) {
    const quotes = await getQuotes(tickers);
    for (const [ticker, quote] of quotes) prices.set(ticker, { price: quote.price, asOf: null });

    const missing = Array.from(new Set(tickers)).filter((ticker) => !prices.has(ticker));
    if (missing.length > 0) {
      for (const [ticker, snapshot] of await getLastKnownPrices(missing)) {
        prices.set(ticker, { price: snapshot.price, asOf: snapshot.capturedAt });
      }
    }
  }

  for (const [ticker, point] of await getTreasuryPrices(items)) prices.set(ticker, point);

  return prices;
}
