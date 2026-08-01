import { Router, type IRouter } from "express";
import { db, assetsTable, alertsTable, analysesTable, opportunitiesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { GetAssetAnalysisParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import {
  getPricesFor,
  getPriceHistories,
  getFundamentals,
  getDividendEvents,
  sectorFor,
  QUOTED_CATEGORIES,
  type PriceHistory,
  type Fundamentals,
} from "../lib/market-data";
import { analysisForUnquotedAsset, pendingAnalysis, analyzeFundamentals, type AnalysisResult } from "../lib/analysis-engine";
import { getNewsFor, resolveSearchTerm, type NewsHeadline } from "../lib/news";
import { getMacroSnapshot } from "../lib/macro-data";
import { synthesizeAssetRecommendation, type DividendTrend } from "../lib/analysis-ai";
import { estimateCapitalGainsTax, type TaxEstimate } from "../lib/tax-engine";
import type { DividendEvent } from "../lib/market-data";

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
function computeAnalysis(ticker: string, category: string, fundamentalsByTicker: Map<string, Fundamentals>): AnalysisResult {
  if (!QUOTED_CATEGORIES.has(category)) return analysisForUnquotedAsset();
  const fundamentals = fundamentalsByTicker.get(ticker.toUpperCase());
  return fundamentals ? analyzeFundamentals(fundamentals) : pendingAnalysis();
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

function serializePersisted(row: typeof analysesTable.$inferSelect) {
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
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toApiShape(ticker: string, result: AnalysisResult, newsItems: string[]) {
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
    updatedAt: new Date().toISOString(),
  };
}

router.get("/analysis/assets", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));

  const existingAnalyses = await db.select().from(analysesTable).where(eq(analysesTable.userId, req.session.userId!));
  const analysisMap = new Map(existingAnalyses.map((a) => [a.ticker, a]));

  const pendingAssets = assets.filter((a) => !analysisMap.has(a.ticker) && QUOTED_CATEGORIES.has(a.category));
  const fundamentalsByTicker = await getFundamentals(pendingAssets.map((a) => a.ticker));

  const result = await Promise.all(
    assets.map(async (asset) => {
      const existing = analysisMap.get(asset.ticker);
      if (existing) return serializePersisted(existing);
      const newsItems = await getNewsItemsFor(asset.ticker, asset.category);
      return toApiShape(asset.ticker, computeAnalysis(asset.ticker, asset.category, fundamentalsByTicker), newsItems);
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
    res.json(serializePersisted(existing));
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
  const fundamentalsByTicker = QUOTED_CATEGORIES.has(asset.category)
    ? await getFundamentals([asset.ticker])
    : new Map<string, Fundamentals>();
  res.json(toApiShape(asset.ticker, computeAnalysis(asset.ticker, asset.category, fundamentalsByTicker), newsItems));
});

// Compara a soma de proventos pagos nos últimos 12 meses com os 12 meses anteriores
// a esses, a partir do histórico real já buscado (getDividendEvents) — nunca projeta
// nem estima nada, só retorna null quando não há pelo menos um evento real em cada
// uma das duas janelas (histórico curto demais pra dizer se está crescendo ou não).
function computeDividendTrend(events: DividendEvent[], now: number): DividendTrend | null {
  const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
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

  const analyses = assets.map((a) => ({
    ticker: a.ticker.toUpperCase(),
    ...computeAnalysis(a.ticker, a.category, fundamentalsByTicker),
    taxEstimate: null as TaxEstimate | null,
  }));

  // Only persist (and alert on) results that are actually available — pending
  // ones have nothing real to save yet and shouldn't spam the Radar.
  const available = analyses.filter((a) => a.available);

  // Buscado aqui (não só lá embaixo pros macroAlerts) porque a síntese via IA de cada
  // ativo também usa o cenário macro como parte do contexto real que ela recebe.
  const macro = await getMacroSnapshot();

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
  const dividendEventsByTicker = await getDividendEvents(assets.map((a) => ({ ticker: a.ticker, category: a.category })));

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
      const dividendTrend = computeDividendTrend(dividendEventsByTicker.get(analysis.ticker) ?? [], Date.now());

      const aiRecommendation = await synthesizeAssetRecommendation({
        ticker: analysis.ticker,
        score: analysis.score,
        scoreClassification: analysis.scoreClassification,
        status: analysis.status,
        positives: analysis.positives,
        risks: analysis.risks,
        newsItems,
        macro: { selic: macro.selic, selicTrend: macro.selicTrend, ipca12m: macro.ipca12m },
        tax,
        positionPercent,
        dividendTrend,
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
