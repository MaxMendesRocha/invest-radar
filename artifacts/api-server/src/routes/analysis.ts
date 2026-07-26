import { Router, type IRouter } from "express";
import { db, assetsTable, alertsTable, analysesTable, opportunitiesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { GetAssetAnalysisParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import { getPricesFor, QUOTED_CATEGORIES } from "../lib/market-data";
import { analysisForUnquotedAsset, pendingAnalysis, type AnalysisResult } from "../lib/analysis-engine";

const router: IRouter = Router();

// Full fundamentalist analysis (analyzeFundamentals in analysis-engine.ts) needs the
// paid brapi.dev plan — see pendingAnalysis()'s comment. "Pending" results are never
// persisted to analysesTable, so there's nothing stale to invalidate once a data
// source is picked; only genuinely-computed results (today: the unquoted-asset case)
// get saved.
function computeAnalysis(category: string): AnalysisResult {
  return QUOTED_CATEGORIES.has(category) ? pendingAnalysis() : analysisForUnquotedAsset();
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
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toApiShape(ticker: string, result: AnalysisResult) {
  return {
    ticker: ticker.toUpperCase(),
    available: result.available,
    status: result.status,
    score: result.score,
    scoreClassification: result.scoreClassification,
    positives: result.positives,
    risks: result.risks,
    // Notícias reais ainda não implementadas (Fase 3) — nunca inventar manchetes aqui.
    newsItems: [] as string[],
    alerts: result.available && result.risks.length > 0 ? [result.risks[0]] : [],
    monitoringRecommendation: result.monitoringRecommendation,
    updatedAt: new Date().toISOString(),
  };
}

router.get("/analysis/assets", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));

  const existingAnalyses = await db.select().from(analysesTable).where(eq(analysesTable.userId, req.session.userId!));
  const analysisMap = new Map(existingAnalyses.map((a) => [a.ticker, a]));

  const result = assets.map((asset) => {
    const existing = analysisMap.get(asset.ticker);
    if (existing) return serializePersisted(existing);
    return toApiShape(asset.ticker, computeAnalysis(asset.category));
  });

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

  res.json(toApiShape(asset.ticker, computeAnalysis(asset.category)));
});

router.post("/analysis/generate", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));

  await db.delete(analysesTable).where(eq(analysesTable.userId, req.session.userId!));
  await db.delete(alertsTable).where(eq(alertsTable.userId, req.session.userId!));

  const analyses = assets.map((a) => ({
    ticker: a.ticker.toUpperCase(),
    ...computeAnalysis(a.category),
  }));

  // Only persist (and alert on) results that are actually available — pending
  // ones have nothing real to save yet and shouldn't spam the Radar.
  const available = analyses.filter((a) => a.available);

  for (const analysis of available) {
    await db.insert(analysesTable).values({
      userId: req.session.userId!,
      ticker: analysis.ticker,
      status: analysis.status,
      score: String(analysis.score),
      scoreClassification: analysis.scoreClassification,
      positives: JSON.stringify(analysis.positives),
      risks: JSON.stringify(analysis.risks),
      newsItems: JSON.stringify([]),
      alerts: JSON.stringify(analysis.risks.length > 0 ? [analysis.risks[0]] : []),
      monitoringRecommendation: analysis.monitoringRecommendation,
    });
  }

  const alertsToInsert = available
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

  if (alertsToInsert.length > 0) {
    await db.insert(alertsTable).values(alertsToInsert);
  }

  const alertRows = await db.select().from(alertsTable).where(eq(alertsTable.userId, req.session.userId!));

  const prices = await getPricesFor(assets);
  let totalPatrimony = 0;
  let totalCost = 0;
  for (const a of assets) {
    const qty = parseFloat(a.quantity);
    const avgPrice = parseFloat(a.averagePrice);
    const price = prices.get(a.ticker.toUpperCase()) ?? avgPrice;
    totalPatrimony += qty * price;
    totalCost += qty * avgPrice;
  }
  const totalProfitLoss = totalPatrimony - totalCost;
  const totalProfitLossPercent = totalCost > 0 ? (totalProfitLoss / totalCost) * 100 : 0;

  const opportunities = await db.select().from(opportunitiesTable);

  res.json({
    generatedAt: new Date().toISOString(),
    summary: {
      totalPatrimony,
      totalProfitLoss,
      totalProfitLossPercent,
      totalDividends: 0,
      portfolioYield: 0,
      assetCount: assets.length,
    },
    analyses: analyses.map((a) => ({
      ...a,
      newsItems: [] as string[],
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
