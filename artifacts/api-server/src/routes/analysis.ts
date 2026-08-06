import { Router, type IRouter } from "express";
import { db, assetsTable, alertsTable, analysesTable, opportunitiesTable, investorProfilesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { GetAssetAnalysisParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import {
  getPricesFor,
  getPriceHistories,
  getFundamentals,
  getDividendEvents,
  getDividendEventsForTicker,
  getTechnicalSeries,
  computeDividendTrend,
  sumLast12Months,
  classifyDividendFrequency,
  getFiiProfiles,
  sectorFor,
  QUOTED_CATEGORIES,
  type PriceHistory,
  type Fundamentals,
  type DividendFrequencyLabel,
  type FiiProfile,
} from "../lib/market-data";
import { analysisForUnquotedAsset, pendingAnalysis, noFundamentalsAnalysis, analyzeFundamentals, computeDuPontBreakdown, type AnalysisResult, concentrationLimitsFor, type ConcentrationLimits } from "../lib/analysis-engine";
import { getNewsFor, resolveSearchTerm, type NewsHeadline } from "../lib/news";
import { getMacroSnapshot } from "../lib/macro-data";
import { getCdiTrailingAnnual } from "../lib/benchmark-data";
import { synthesizeAssetRecommendation } from "../lib/analysis-ai";
import { synthesizePrePurchaseOpinion } from "../lib/opinion-ai";
import { estimateCapitalGainsTax, type TaxEstimate } from "../lib/tax-engine";
import { computeTechnicalIndicators, type TechnicalIndicators } from "../lib/technical-engine";
import { computeRiskAdjustedMetrics, type RiskAdjustedMetrics } from "../lib/risk-metrics-engine";
import { getSectorBenchmark, describeSectorComparison } from "../lib/sector-benchmarks";
import { computeFinancialHealth } from "../lib/financial-health-engine";

const router: IRouter = Router();

type AlertToInsert = {
  userId: number; type: string; severity: string; title: string; message: string;
  ticker: string | null; isRead: boolean;
};

const CONCENTRATION_ASSET_CRITICAL = 40; // % of patrimony in a single ticker
const CONCENTRATION_ASSET_HIGH = 25;
const CONCENTRATION_SECTOR_HIGH = 50; // % of patrimony in a single sector
const MIN_DISTINCT_ASSETS = 3;

/**
 * Alerta de Concentração from the product spec — no external data needed, just the
 * holdings already in the DB plus current prices. Deliberately conservative
 * thresholds; tune once we have real user feedback on what feels noisy vs useful.
 */
function computeConcentrationAlerts(
  assets: { ticker: string; quantity: string; averagePrice: string; sector: string | null }[],
  prices: Map<string, number>,
  fundamentalsByTicker: Map<string, Fundamentals>,
  userId: number,
): AlertToInsert[] {
  const byTicker = new Map<string, number>();
  const bySector = new Map<string, number>();
  let totalValue = 0;

  for (const a of assets) {
    const qty = parseFloat(a.quantity);
    const price = prices.get(a.ticker.toUpperCase()) ?? parseFloat(a.averagePrice);
    const value = qty * price;
    totalValue += value;

    const ticker = a.ticker.toUpperCase();
    byTicker.set(ticker, (byTicker.get(ticker) ?? 0) + value);

    const sector = sectorFor(a, fundamentalsByTicker.get(ticker)?.sector);
    bySector.set(sector, (bySector.get(sector) ?? 0) + value);
  }

  if (totalValue <= 0) return [];

  const alerts: AlertToInsert[] = [];

  for (const [ticker, value] of byTicker) {
    const pct = (value / totalValue) * 100;
    if (pct >= CONCENTRATION_ASSET_CRITICAL) {
      alerts.push({
        userId, type: "concentracao", severity: "Critico", ticker,
        title: `${ticker} concentra ${pct.toFixed(0)}% da carteira`,
        message: `${ticker} representa ${pct.toFixed(1)}% do patrimônio total — concentração elevada em um único ativo.`,
        isRead: false,
      });
    } else if (pct >= CONCENTRATION_ASSET_HIGH) {
      alerts.push({
        userId, type: "concentracao", severity: "Alto", ticker,
        title: `${ticker} concentra ${pct.toFixed(0)}% da carteira`,
        message: `${ticker} representa ${pct.toFixed(1)}% do patrimônio total — considere diversificar.`,
        isRead: false,
      });
    }
  }

  for (const [sector, value] of bySector) {
    const pct = (value / totalValue) * 100;
    if (pct >= CONCENTRATION_SECTOR_HIGH) {
      alerts.push({
        userId, type: "concentracao", severity: "Alto", ticker: null,
        title: `Setor ${sector} concentra ${pct.toFixed(0)}% da carteira`,
        message: `O setor "${sector}" representa ${pct.toFixed(1)}% do patrimônio total — risco de concentração setorial.`,
        isRead: false,
      });
    }
  }

  if (byTicker.size > 0 && byTicker.size < MIN_DISTINCT_ASSETS) {
    alerts.push({
      userId, type: "concentracao", severity: "Medio", ticker: null,
      title: "Baixa diversificação",
      message: `Sua carteira tem apenas ${byTicker.size} ativo${byTicker.size > 1 ? "s" : ""} diferente${byTicker.size > 1 ? "s" : ""} — baixa diversificação aumenta o risco em caso de queda de um deles.`,
      isRead: false,
    });
  }

  return alerts;
}

const PRICE_STRONG_MOVE_PERCENT = 8; // % em 5 dias úteis, direto da especificação

/**
 * Alerta de Preço from the product spec — also needs no fundamentals/paid data,
 * just brapi.dev's free `?range=3mo&interval=1d` (52-week high/low + daily closes,
 * confirmed to work for any quotable ticker, not only the 4 whitelisted for the
 * paid modules). "Máximas históricas"/"mínimas relevantes" from the spec are
 * approximated as 52-week high/low — the only window brapi.dev exposes for free.
 */
function computePriceAlerts(
  assets: { ticker: string; category: string }[],
  histories: Map<string, PriceHistory>,
  userId: number,
): AlertToInsert[] {
  const alerts: AlertToInsert[] = [];

  for (const a of assets) {
    if (!QUOTED_CATEGORIES.has(a.category)) continue;
    const ticker = a.ticker.toUpperCase();
    const h = histories.get(ticker);
    if (!h) continue;

    if (h.fiveDayChangePercent != null && Math.abs(h.fiveDayChangePercent) >= PRICE_STRONG_MOVE_PERCENT) {
      const up = h.fiveDayChangePercent > 0;
      alerts.push({
        userId, type: "preco", severity: "Alto", ticker,
        title: `${ticker} ${up ? "subiu" : "caiu"} ${Math.abs(h.fiveDayChangePercent).toFixed(1)}% em 5 dias`,
        message: `${ticker} ${up ? "valorizou" : "desvalorizou"} ${Math.abs(h.fiveDayChangePercent).toFixed(1)}% nos últimos 5 dias úteis — variação forte, vale entender o motivo.`,
        isRead: false,
      });
    }

    if (h.fiftyTwoWeekHigh != null && h.price >= h.fiftyTwoWeekHigh) {
      alerts.push({
        userId, type: "preco", severity: "Medio", ticker,
        title: `${ticker} rompeu a máxima de 52 semanas`,
        message: `${ticker} está cotado a R$ ${h.price.toFixed(2)}, novo topo em 52 semanas.`,
        isRead: false,
      });
    } else if (h.fiftyTwoWeekLow != null && h.price <= h.fiftyTwoWeekLow) {
      alerts.push({
        userId, type: "preco", severity: "Alto", ticker,
        title: `${ticker} rompeu a mínima de 52 semanas`,
        message: `${ticker} está cotado a R$ ${h.price.toFixed(2)}, nova mínima em 52 semanas — atenção redobrada.`,
        isRead: false,
      });
    }
  }

  return alerts;
}

// Real fundamentals via getFundamentals() (brapi.dev, ver market-data.ts). Se o
// provider não devolver dado pra um ticker específico (falha pontual, ticker sem
// cobertura), cai em pendingAnalysis() — "Em breve" nunca virou score inventado.
function computeAnalysis(
  ticker: string,
  category: string,
  fundamentalsByTicker: Map<string, Fundamentals>,
  dps12mByTicker: Map<string, number | null>,
  positionPercentByTicker: Map<string, number>,
  limits: ConcentrationLimits,
): AnalysisResult {
  if (!QUOTED_CATEGORIES.has(category)) return analysisForUnquotedAsset();
  const upper = ticker.toUpperCase();
  const fundamentals = fundamentalsByTicker.get(upper);
  return fundamentals
    ? analyzeFundamentals(fundamentals, dps12mByTicker.get(upper) ?? null, positionPercentByTicker.get(upper) ?? 0, limits)
    : pendingAnalysis();
}

/**
 * % do patrimônio em cada ativo. Calculado nos três handlers que chamam
 * computeAnalysis (não só no generate) porque o status agora depende da
 * concentração — sem isso o mesmo ativo mostraria status diferente antes e depois
 * de gerar a análise.
 */
/**
 * Limiares de concentração do usuário. Sem perfil definido cai na régua do
 * Moderado — ver concentrationLimitsFor.
 */
async function concentrationLimitsForUser(userId: number): Promise<ConcentrationLimits> {
  const [profile] = await db.select().from(investorProfilesTable).where(eq(investorProfilesTable.userId, userId));
  return concentrationLimitsFor(profile?.classification ?? null);
}

async function buildPositionPercents(
  assets: { ticker: string; category: string; quantity: string; averagePrice: string }[],
): Promise<Map<string, number>> {
  const prices = await getPricesFor(assets);
  const values = new Map<string, number>();
  let total = 0;
  for (const asset of assets) {
    // Renda fixa não tem cotação: cai no preço médio, que é o valor da posição.
    const price = prices.get(asset.ticker.toUpperCase()) ?? parseFloat(asset.averagePrice);
    const value = parseFloat(asset.quantity) * price;
    values.set(asset.ticker.toUpperCase(), value);
    total += value;
  }
  const percents = new Map<string, number>();
  for (const [ticker, value] of values) percents.set(ticker, total > 0 ? (value / total) * 100 : 0);
  return percents;
}

interface DividendDerivedMaps {
  dps12mByTicker: Map<string, number | null>;
  dividendFrequencyByTicker: Map<string, DividendFrequencyLabel | null>;
}

// Reaproveitado pelos 3 pontos que chamam computeAnalysis — busca o histórico real de
// proventos UMA vez e já devolve os dois Maps derivados dele prontos pra passar
// direto (payout ratio e periodicidade de pagamento), em vez de cada call site
// recalcular ou refazer a busca na mão. sumLast12Months, não computeDividendTrend —
// payout ratio só precisa do total de 12 meses, não da comparação com o ano anterior.
async function buildDividendDerivedMaps(
  items: { ticker: string; category: string }[],
): Promise<DividendDerivedMaps> {
  const eventsByTicker = await getDividendEvents(items);
  const now = Date.now();
  const dps12mByTicker = new Map<string, number | null>();
  const dividendFrequencyByTicker = new Map<string, DividendFrequencyLabel | null>();
  for (const [ticker, events] of eventsByTicker) {
    dps12mByTicker.set(ticker, sumLast12Months(events, now));
    dividendFrequencyByTicker.set(ticker, classifyDividendFrequency(events, now)?.label ?? null);
  }
  return { dps12mByTicker, dividendFrequencyByTicker };
}

function formatHeadline(item: NewsHeadline): string {
  return item.impact ? `[${item.impact}] ${item.title}` : item.title;
}

// Real, relevant headlines for a ticker — see resolveSearchTerm's comment for how the
// search term is picked. Renda fixa/fundos have no company to search for, so they
// never get news.
async function getNewsItemsFor(ticker: string, category: string): Promise<string[]> {
  if (!QUOTED_CATEGORIES.has(category)) return [];
  const headlines = await getNewsFor(resolveSearchTerm(ticker), 3);
  return headlines.map(formatHeadline);
}

function serializePersisted(row: typeof analysesTable.$inferSelect, dividendFrequency: DividendFrequencyLabel | null) {
  return {
    ticker: row.ticker,
    available: true,
    status: row.status,
    score: parseFloat(row.score),
    scoreClassification: row.scoreClassification,
    positives: JSON.parse(row.positives) as string[],
    risks: JSON.parse(row.risks) as string[],
    newsItems: JSON.parse(row.newsItems) as string[],
    alerts: JSON.parse(row.alerts) as string[],
    monitoringRecommendation: row.monitoringRecommendation,
    // Persistido no momento do POST /analysis/generate (preço daquele instante) —
    // fica parado até a próxima geração, igual ao resto da análise (score,
    // positivos, riscos). Não recalculado a cada leitura.
    taxEstimate: row.taxEstimate ? (JSON.parse(row.taxEstimate) as TaxEstimate) : null,
    technical: row.technical ? (JSON.parse(row.technical) as TechnicalIndicators) : null,
    // Diferente de taxEstimate/technical, sempre recalculado ao vivo (não persistido)
    // — é barato (mesmo histórico de dividendos já cacheado por 6h) e não faz
    // sentido ficar parado até a próxima geração manual.
    dividendFrequency,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toApiShape(ticker: string, result: AnalysisResult, newsItems: string[], dividendFrequency: DividendFrequencyLabel | null) {
  return {
    ticker: ticker.toUpperCase(),
    available: result.available,
    status: result.status,
    score: result.score,
    scoreClassification: result.scoreClassification,
    positives: result.positives,
    risks: result.risks,
    newsItems,
    alerts: result.available && result.risks.length > 0 ? [result.risks[0]] : [],
    monitoringRecommendation: result.monitoringRecommendation,
    // Só calculado em POST /analysis/generate (precisa do preço atual, que essas
    // rotas GET não buscam pra ficarem leves) — sempre presente no shape, mesmo
    // que null, pra quem consome a API não precisar tratar campo ausente.
    taxEstimate: null as TaxEstimate | null,
    technical: null as TechnicalIndicators | null,
    dividendFrequency,
    updatedAt: new Date().toISOString(),
  };
}

router.get("/analysis/assets", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));

  const existingAnalyses = await db.select().from(analysesTable).where(eq(analysesTable.userId, req.session.userId!));
  const analysisMap = new Map(existingAnalyses.map((a) => [a.ticker, a]));

  const pendingAssets = assets.filter((a) => !analysisMap.has(a.ticker) && QUOTED_CATEGORIES.has(a.category));
  // dividendFrequency não é persistido (sempre recalculado ao vivo, ver serializePersisted),
  // então busca pra TODOS os ativos (não só os pendentes) — o dps12mByTicker resultante
  // cobre os pendentes de qualquer forma, então não precisa de uma segunda busca.
  const [fundamentalsByTicker, { dps12mByTicker, dividendFrequencyByTicker }, positionPercentByTicker, concentrationLimits] = await Promise.all([
    getFundamentals(pendingAssets.map((a) => a.ticker)),
    buildDividendDerivedMaps(assets.map((a) => ({ ticker: a.ticker, category: a.category }))),
    buildPositionPercents(assets),
    concentrationLimitsForUser(req.session.userId!),
  ]);

  const result = await Promise.all(
    assets.map(async (asset) => {
      const dividendFrequency = dividendFrequencyByTicker.get(asset.ticker.toUpperCase()) ?? null;
      const existing = analysisMap.get(asset.ticker);
      if (existing) return serializePersisted(existing, dividendFrequency);
      const newsItems = await getNewsItemsFor(asset.ticker, asset.category);
      return toApiShape(asset.ticker, computeAnalysis(asset.ticker, asset.category, fundamentalsByTicker, dps12mByTicker, positionPercentByTicker, concentrationLimits), newsItems, dividendFrequency);
    })
  );

  res.json(result);
});

router.get("/analysis/assets/:ticker", requireAuth, async (req, res): Promise<void> => {
  const params = GetAssetAnalysisParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await db.select().from(analysesTable).where(
    and(eq(analysesTable.ticker, params.data.ticker.toUpperCase()), eq(analysesTable.userId, req.session.userId!))
  );

  if (existing) {
    // analysesTable não guarda category — getDividendEventsForTicker não precisa dela
    // (tenta o endpoint de ações/ETFs/BDRs, cai pro de FII se vier vazio), então serve
    // bem aqui sem precisar buscar o asset só por causa disso.
    const events = await getDividendEventsForTicker(existing.ticker);
    const dividendFrequency = classifyDividendFrequency(events, Date.now())?.label ?? null;
    res.json(serializePersisted(existing, dividendFrequency));
    return;
  }

  const [asset] = await db.select().from(assetsTable).where(
    and(eq(assetsTable.ticker, params.data.ticker.toUpperCase()), eq(assetsTable.userId, req.session.userId!))
  );

  if (!asset) {
    res.status(404).json({ error: "Ativo não encontrado na carteira" });
    return;
  }

  const newsItems = await getNewsItemsFor(asset.ticker, asset.category);
  // A carteira inteira, não só este ativo: a concentração que decide o status é a
  // fração do patrimônio total, então o denominador exige todas as posições.
  const allAssets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));
  const positionPercentByTicker = await buildPositionPercents(allAssets);
  const concentrationLimits = await concentrationLimitsForUser(req.session.userId!);
  const [fundamentalsByTicker, { dps12mByTicker, dividendFrequencyByTicker }] = QUOTED_CATEGORIES.has(asset.category)
    ? await Promise.all([
        getFundamentals([asset.ticker]),
        buildDividendDerivedMaps([{ ticker: asset.ticker, category: asset.category }]),
      ])
    : [new Map<string, Fundamentals>(), { dps12mByTicker: new Map<string, number | null>(), dividendFrequencyByTicker: new Map<string, DividendFrequencyLabel | null>() }];
  const dividendFrequency = dividendFrequencyByTicker.get(asset.ticker.toUpperCase()) ?? null;
  res.json(toApiShape(asset.ticker, computeAnalysis(asset.ticker, asset.category, fundamentalsByTicker, dps12mByTicker, positionPercentByTicker, concentrationLimits), newsItems, dividendFrequency));
});

// Cacheado por ticker (não por usuário nem por carteira) — o parecer não depende de
// posição/quantidade, então a resposta é a mesma pra qualquer usuário perguntando
// sobre o mesmo ticker no mesmo período. TTL de 12h controla tanto chamadas repetidas
// à brapi.dev quanto o custo de IA em buscas populares.
const OPINION_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const opinionResponseCache = new Map<string, { response: object; fetchedAt: number }>();

router.get("/analysis/opinion/:ticker", requireAuth, async (req, res): Promise<void> => {
  const params = GetAssetAnalysisParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const ticker = params.data.ticker.toUpperCase();

  const cached = opinionResponseCache.get(ticker);
  if (cached && Date.now() - cached.fetchedAt < OPINION_CACHE_TTL_MS) {
    res.json(cached.response);
    return;
  }

  const [fundamentalsByTicker, priceHistories, dividendEvents, technicalSeries, newsHeadlines, macro, cdiAnnual] = await Promise.all([
    getFundamentals([ticker]),
    getPriceHistories([ticker]),
    getDividendEventsForTicker(ticker),
    getTechnicalSeries([ticker]),
    getNewsFor(resolveSearchTerm(ticker), 3),
    getMacroSnapshot(),
    getCdiTrailingAnnual(),
  ]);

  const fundamentals = fundamentalsByTicker.get(ticker);
  const priceHistory = priceHistories.get(ticker);
  const price = priceHistory?.price ?? fundamentals?.price ?? null;

  // Nem fetchPriceHistory (endpoint gratuito, funciona pra qualquer ticker cotável) nem
  // getFundamentals encontraram cotação — ticker inválido, delistado ou fora de B3.
  if (price == null) {
    res.status(404).json({ error: "Ticker não encontrado ou sem cotação disponível" });
    return;
  }

  const opinionNow = Date.now();
  const dividendTrend = computeDividendTrend(dividendEvents, opinionNow);
  const dps12m = sumLast12Months(dividendEvents, opinionNow);
  const dividendFrequency = classifyDividendFrequency(dividendEvents, opinionNow)?.label ?? null;
  const analysis = fundamentals ? analyzeFundamentals(fundamentals, dps12m) : noFundamentalsAnalysis();
  const technicalPoints = technicalSeries.get(ticker) ?? [];
  const technical = technicalPoints.length > 0 ? computeTechnicalIndicators(technicalPoints) : null;
  const riskAdjusted = cdiAnnual != null ? computeRiskAdjustedMetrics(technicalPoints, fundamentals?.beta ?? null, cdiAnnual) : null;
  const duPont = fundamentals ? computeDuPontBreakdown(fundamentals) : null;
  const financialHealth = fundamentals ? computeFinancialHealth(fundamentals, dps12m) : null;
  const fiiProfile = (await getFiiProfiles([ticker])).get(ticker) ?? null;
  const sectorBenchmark = await getSectorBenchmark(fundamentals?.sector ?? null);
  const sectorComparison = fundamentals
    ? describeSectorComparison(fundamentals, sectorBenchmark)
    : "Comparação com o setor não disponível (fundamentos não encontrados para este ativo).";
  const newsItems = newsHeadlines.map(formatHeadline);
  const name = fundamentals?.name ?? null;

  const aiOpinion = await synthesizePrePurchaseOpinion({
    ticker,
    name,
    available: analysis.available,
    score: analysis.score,
    scoreClassification: analysis.scoreClassification,
    positives: analysis.positives,
    risks: analysis.risks,
    price,
    fiftyTwoWeekHigh: priceHistory?.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow: priceHistory?.fiftyTwoWeekLow ?? null,
    fiveDayChangePercent: priceHistory?.fiveDayChangePercent ?? null,
    dividendTrend,
    technical,
    riskAdjusted,
    duPont,
    financialHealth,
    sector: fundamentals?.sector ?? null,
    fiiProfile,
    sectorComparison,
    newsItems,
    macro,
  });

  const response = {
    ticker,
    name,
    available: analysis.available,
    score: analysis.score,
    scoreClassification: analysis.scoreClassification,
    positives: analysis.positives,
    risks: analysis.risks,
    price,
    fiftyTwoWeekHigh: priceHistory?.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow: priceHistory?.fiftyTwoWeekLow ?? null,
    fiveDayChangePercent: priceHistory?.fiveDayChangePercent ?? null,
    dividendTrend,
    technical,
    dividendFrequency,
    newsItems,
    opinion: aiOpinion ?? analysis.monitoringRecommendation,
    updatedAt: new Date().toISOString(),
  };

  opinionResponseCache.set(ticker, { response, fetchedAt: Date.now() });
  res.json(response);
});

router.post("/analysis/generate", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));

  await db.delete(analysesTable).where(eq(analysesTable.userId, req.session.userId!));
  await db.delete(alertsTable).where(eq(alertsTable.userId, req.session.userId!));

  // Real news per ticker, fetched once and reused for both the analysis payload
  // and the "noticias" alerts below.
  const newsByTicker = new Map<string, NewsHeadline[]>();
  await Promise.all(
    assets
      .filter((a) => QUOTED_CATEGORIES.has(a.category))
      .map(async (a) => {
        const headlines = await getNewsFor(resolveSearchTerm(a.ticker), 3);
        newsByTicker.set(a.ticker.toUpperCase(), headlines);
      })
  );

  const fundamentalsByTicker = await getFundamentals(
    assets.filter((a) => QUOTED_CATEGORIES.has(a.category)).map((a) => a.ticker)
  );

  // Buscado aqui (antes de computeAnalysis) porque o payout ratio — um dos fundamentos
  // avaliados por analyzeFundamentals — precisa do histórico real de proventos pra
  // calcular DPS 12m. Reaproveitado mais embaixo pro dividendTrend passado pra IA e
  // pro cálculo de totalDividends, sem buscar duas vezes. dps12mByTicker (payout
  // ratio) e dividendTrendByTicker (contexto de tendência pra IA) vêm do mesmo
  // histórico, mas dps12m só exige a janela de 12 meses — ver sumLast12Months.
  const dividendEventsByTicker = await getDividendEvents(assets.map((a) => ({ ticker: a.ticker, category: a.category })));
  const dividendTrendNow = Date.now();
  const dps12mByTicker = new Map(
    Array.from(dividendEventsByTicker.entries()).map(([ticker, events]) => [ticker, sumLast12Months(events, dividendTrendNow)])
  );
  const dividendTrendByTicker = new Map(
    Array.from(dividendEventsByTicker.entries()).map(([ticker, events]) => [ticker, computeDividendTrend(events, dividendTrendNow)])
  );
  const dividendFrequencyByTicker = new Map(
    Array.from(dividendEventsByTicker.entries()).map(([ticker, events]) => [ticker, classifyDividendFrequency(events, dividendTrendNow)?.label ?? null])
  );

  // Antes do map porque o status de cada ativo depende da concentração. O
  // getPricesFor daqui a pouco reaproveita o cache por ticker de getQuotes, então
  // isso não custa uma segunda ida à rede.
  const positionPercentByTicker = await buildPositionPercents(assets);
  const concentrationLimits = await concentrationLimitsForUser(req.session.userId!);

  const analyses = assets.map((a) => ({
    ticker: a.ticker.toUpperCase(),
    ...computeAnalysis(a.ticker, a.category, fundamentalsByTicker, dps12mByTicker, positionPercentByTicker, concentrationLimits),
    taxEstimate: null as TaxEstimate | null,
    technical: null as TechnicalIndicators | null,
    dividendFrequency: dividendFrequencyByTicker.get(a.ticker.toUpperCase()) ?? null,
  }));

  // Only persist (and alert on) results that are actually available — pending
  // ones have nothing real to save yet and shouldn't spam the Radar.
  const available = analyses.filter((a) => a.available);

  // Buscado aqui (não só lá embaixo pros macroAlerts) porque a síntese via IA de cada
  // ativo também usa o cenário macro como parte do contexto real que ela recebe.
  const macro = await getMacroSnapshot();
  const cdiAnnual = await getCdiTrailingAnnual();

  // Movido pra antes do loop de IA (o resto do handler só precisava dele mais
  // embaixo) porque o cálculo de IR e de % de concentração precisam do preço atual
  // de cada ativo.
  const prices = await getPricesFor(assets);
  const assetsByTicker = new Map(assets.map((a) => [a.ticker.toUpperCase(), a]));

  // Patrimônio total (reaproveitado lá embaixo pro summary da resposta) e histórico de
  // proventos (pra tendência de dividendo) — os dois movidos pra antes do loop de IA
  // pelo mesmo motivo dos preços acima.
  let totalPatrimony = 0;
  for (const a of assets) {
    const price = prices.get(a.ticker.toUpperCase()) ?? parseFloat(a.averagePrice);
    totalPatrimony += parseFloat(a.quantity) * price;
  }
  const technicalSeriesByTicker = await getTechnicalSeries(available.map((a) => a.ticker));
  // Só os FIIs da carteira — perfil (papel/tijolo/FoF) não existe pras outras categorias.
  const fiiProfileByTicker = await getFiiProfiles(
    assets.filter((a) => a.category === "fiis").map((a) => a.ticker)
  );

  // Em paralelo — sequencial levava ~4s por ativo (chamada real à Anthropic), o que
  // deixava uma carteira de 5 ativos demorando ~20s pra gerar.
  await Promise.all(
    available.map(async (analysis) => {
      const newsItems = (newsByTicker.get(analysis.ticker) ?? []).map(formatHeadline);

      const asset = assetsByTicker.get(analysis.ticker);
      const currentPrice = asset ? (prices.get(analysis.ticker) ?? parseFloat(asset.averagePrice)) : null;
      const tax = asset && currentPrice != null
        ? estimateCapitalGainsTax(asset.category, parseFloat(asset.quantity), parseFloat(asset.averagePrice), currentPrice)
        : null;
      analysis.taxEstimate = tax; // mesma mutação intencional de monitoringRecommendation logo abaixo — flui pra resposta HTTP

      const positionPercent =
        asset && currentPrice != null && totalPatrimony > 0
          ? ((parseFloat(asset.quantity) * currentPrice) / totalPatrimony) * 100
          : 0;
      const dividendTrend = dividendTrendByTicker.get(analysis.ticker) ?? null;
      const technicalPoints = technicalSeriesByTicker.get(analysis.ticker) ?? [];
      const technical = technicalPoints.length > 0 ? computeTechnicalIndicators(technicalPoints) : null;
      analysis.technical = technical;
      const assetFundamentals = fundamentalsByTicker.get(analysis.ticker) ?? null;
      const riskAdjusted = cdiAnnual != null ? computeRiskAdjustedMetrics(technicalPoints, assetFundamentals?.beta ?? null, cdiAnnual) : null;
      const duPont = assetFundamentals ? computeDuPontBreakdown(assetFundamentals) : null;
      const financialHealth = assetFundamentals
        ? computeFinancialHealth(assetFundamentals, dps12mByTicker.get(analysis.ticker) ?? null)
        : null;
      const sectorBenchmark = await getSectorBenchmark(assetFundamentals?.sector ?? null);
      const sectorComparison = assetFundamentals
        ? describeSectorComparison(assetFundamentals, sectorBenchmark)
        : "Comparação com o setor não disponível (fundamentos não encontrados para este ativo).";

      const aiRecommendation = await synthesizeAssetRecommendation({
        ticker: analysis.ticker,
        score: analysis.score,
        scoreClassification: analysis.scoreClassification,
        status: analysis.status,
        positives: analysis.positives,
        risks: analysis.risks,
        newsItems,
        macro,
        tax,
        positionPercent,
        concentrationLimits,
        dividendTrend,
        technical,
        riskAdjusted,
        duPont,
        financialHealth,
        sector: assetFundamentals?.sector ?? null,
        fiiProfile: fiiProfileByTicker.get(analysis.ticker) ?? null,
        sectorComparison,
      });

      // Mutação intencional: `analysis` é a mesma referência presente em `analyses`
      // (available é só um filter, não uma cópia), então isso também atualiza o texto
      // que vai na resposta HTTP construída a partir de `analyses` lá embaixo.
      analysis.monitoringRecommendation = aiRecommendation ?? analysis.monitoringRecommendation;

      await db.insert(analysesTable).values({
        userId: req.session.userId!,
        ticker: analysis.ticker,
        status: analysis.status,
        score: String(analysis.score),
        scoreClassification: analysis.scoreClassification,
        positives: JSON.stringify(analysis.positives),
        risks: JSON.stringify(analysis.risks),
        newsItems: JSON.stringify(newsItems),
        alerts: JSON.stringify(analysis.risks.length > 0 ? [analysis.risks[0]] : []),
        monitoringRecommendation: analysis.monitoringRecommendation,
        taxEstimate: tax ? JSON.stringify(tax) : null,
        technical: technical ? JSON.stringify(technical) : null,
      });
    })
  );

  const priceHistories = await getPriceHistories(assets.filter((a) => QUOTED_CATEGORIES.has(a.category)).map((a) => a.ticker));

  const fundamentalAlerts: AlertToInsert[] = available
    .filter((a) => a.score < 60)
    .map((a) => ({
      userId: req.session.userId!,
      type: "fundamentos",
      severity: a.score < 40 ? "Critico" : "Alto",
      title: `${a.ticker} — ${a.status.replace("_", " ")}`,
      message: a.risks[0] ?? "Monitorar fundamentos",
      ticker: a.ticker,
      isRead: false,
    }));

  const newsAlerts: AlertToInsert[] = Array.from(newsByTicker.entries()).flatMap(([ticker, headlines]) =>
    headlines
      .filter((h) => h.impact === "Negativo" || h.impact === "Muito Negativo")
      .map((h) => ({
        userId: req.session.userId!,
        type: "noticias",
        severity: h.impact === "Muito Negativo" ? "Critico" : "Alto",
        title: `${ticker} — notícia ${h.impact!.toLowerCase()}`,
        message: h.title,
        ticker,
        isRead: false,
      }))
  );

  const macroAlerts: AlertToInsert[] = [];
  if (macro.ipca12m != null && macro.ipca12m > 4.5) {
    macroAlerts.push({
      userId: req.session.userId!,
      type: "macroeconomico",
      severity: "Medio",
      title: "IPCA acima do teto da meta",
      message: `IPCA acumulado em 12 meses em ${macro.ipca12m.toFixed(2)}% — acima do teto histórico de meta de inflação.`,
      ticker: null,
      isRead: false,
    });
  }
  if (macro.selicTrend === "alta") {
    macroAlerts.push({
      userId: req.session.userId!,
      type: "macroeconomico",
      severity: "Baixo",
      title: "Selic em trajetória de alta",
      message: `Selic em ${macro.selic?.toFixed(2)}%, em alta nos últimos meses — pode pressionar ativos de maior risco e crescimento.`,
      ticker: null,
      isRead: false,
    });
  }

  const concentrationAlerts = computeConcentrationAlerts(assets, prices, fundamentalsByTicker, req.session.userId!);
  const priceAlerts = computePriceAlerts(assets, priceHistories, req.session.userId!);

  const alertsToInsert = [...fundamentalAlerts, ...newsAlerts, ...macroAlerts, ...concentrationAlerts, ...priceAlerts];
  if (alertsToInsert.length > 0) {
    await db.insert(alertsTable).values(alertsToInsert);
  }

  const alertRows = await db.select().from(alertsTable).where(eq(alertsTable.userId, req.session.userId!));

  let totalCost = 0;
  for (const a of assets) {
    const qty = parseFloat(a.quantity);
    const avgPrice = parseFloat(a.averagePrice);
    totalCost += qty * avgPrice;
  }
  const totalProfitLoss = totalPatrimony - totalCost;
  const totalProfitLossPercent = totalCost > 0 ? (totalProfitLoss / totalCost) * 100 : 0;

  // Dividendos/JCP reais pagos nos últimos 12 meses, aplicados à quantidade ATUAL de
  // cada ativo (aproximação — não reconstrói o histórico de compras/vendas pra saber
  // quanto era detido em cada data de pagamento). FIIs sem cobertura no plano atual
  // (ver getDividendEvents) simplesmente não contribuem, nunca com valor inventado.
  // dividendEventsByTicker já buscado antes do loop de IA — reaproveitado aqui.
  const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let totalDividends = 0;
  for (const a of assets) {
    const qty = parseFloat(a.quantity);
    const events = dividendEventsByTicker.get(a.ticker.toUpperCase()) ?? [];
    for (const event of events) {
      const paidAt = new Date(event.paymentDate).getTime();
      if (paidAt <= now && now - paidAt <= TWELVE_MONTHS_MS) totalDividends += event.rate * qty;
    }
  }
  const portfolioYield = totalPatrimony > 0 ? (totalDividends / totalPatrimony) * 100 : 0;

  const opportunities = await db.select().from(opportunitiesTable);

  res.json({
    generatedAt: new Date().toISOString(),
    summary: {
      totalPatrimony,
      totalProfitLoss,
      totalProfitLossPercent,
      totalDividends,
      portfolioYield,
      assetCount: assets.length,
    },
    analyses: analyses.map((a) => ({
      ...a,
      newsItems: (newsByTicker.get(a.ticker) ?? []).map(formatHeadline),
      alerts: a.available && a.risks.length > 0 ? [a.risks[0]] : [],
    })),
    topAlerts: alertRows.slice(0, 5).map((a) => ({
      id: a.id, userId: a.userId, type: a.type, severity: a.severity,
      title: a.title, message: a.message, ticker: a.ticker,
      isRead: a.isRead, createdAt: a.createdAt.toISOString(),
    })),
    opportunities: opportunities.slice(0, 10).map((o) => ({
      id: o.id, ticker: o.ticker, name: o.name, category: o.category,
      score: parseFloat(o.score), potentialReturn: parseFloat(o.potentialReturn),
      dividendYield: parseFloat(o.dividendYield), riskLevel: o.riskLevel,
      reason: o.reason, positives: JSON.parse(o.positives) as string[],
      risks: JSON.parse(o.risks) as string[], horizon: o.horizon,
    })),
  });
});

export default router;
