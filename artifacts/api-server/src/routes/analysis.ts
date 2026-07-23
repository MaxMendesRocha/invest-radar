import { Router, type IRouter } from "express";
import { db, assetsTable, alertsTable, analysesTable, opportunitiesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { GetAssetAnalysisParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

function scoreClassification(score: number): string {
  if (score >= 90) return "Excelente";
  if (score >= 75) return "Forte";
  if (score >= 60) return "Estavel";
  if (score >= 40) return "Atencao";
  return "Critico";
}

function statusFromScore(score: number): string {
  if (score >= 75) return "MANTER";
  if (score >= 60) return "ATENCAO";
  if (score >= 40) return "REAVALIAR";
  return "POSSIVEL_SAIDA";
}

function generateAnalysisForTicker(ticker: string, category: string) {
  const t = ticker.toUpperCase();
  const score = 50 + Math.floor(Math.random() * 45);
  const status = statusFromScore(score);
  const classification = scoreClassification(score);

  const categoryPositives: Record<string, string[]> = {
    acoes: ["Crescimento consistente de receita", "Gestão eficiente do capital", "Posição competitiva sólida"],
    fiis: ["Dividend yield acima da média", "Portfólio diversificado de imóveis", "Contratos de longo prazo"],
    etfs: ["Diversificação instantânea", "Baixo custo de gestão", "Liquidez elevada"],
    bdrs: ["Exposição cambial diversificada", "Empresa líder em seu segmento"],
    fundos: ["Gestão ativa profissional", "Diversificação setorial"],
    renda_fixa: ["Proteção do capital", "Rentabilidade previsível", "Baixo risco de crédito"],
  };

  const positives = categoryPositives[category] ?? ["Fundamentos sólidos", "Boa liquidez"];

  return {
    ticker: t,
    status,
    score,
    scoreClassification: classification,
    positives,
    risks: ["Exposição à volatilidade macroeconômica", "Dependência de cenário de juros"],
    newsItems: [`Resultados do ${t} em linha com expectativas`, "Cenário macroeconômico em observação"],
    alerts: score < 60 ? ["Monitorar próximos resultados trimestrais"] : [],
    monitoringRecommendation: `Acompanhar os resultados do próximo trimestre e eventuais mudanças regulatórias que possam impactar o setor.`,
    updatedAt: new Date().toISOString(),
  };
}

router.get("/analysis/assets", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));

  // Check if analyses exist in DB, if not generate on the fly
  const existingAnalyses = await db.select().from(analysesTable).where(eq(analysesTable.userId, req.session.userId!));
  const analysisMap = new Map(existingAnalyses.map(a => [a.ticker, a]));

  const result = assets.map(asset => {
    const existing = analysisMap.get(asset.ticker);
    if (existing) {
      return {
        ticker: existing.ticker,
        status: existing.status,
        score: parseFloat(existing.score),
        scoreClassification: existing.scoreClassification,
        positives: JSON.parse(existing.positives) as string[],
        risks: JSON.parse(existing.risks) as string[],
        newsItems: JSON.parse(existing.newsItems) as string[],
        alerts: JSON.parse(existing.alerts) as string[],
        monitoringRecommendation: existing.monitoringRecommendation,
        updatedAt: existing.updatedAt.toISOString(),
      };
    }
    return generateAnalysisForTicker(asset.ticker, asset.category);
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
    res.json({
      ticker: existing.ticker, status: existing.status, score: parseFloat(existing.score),
      scoreClassification: existing.scoreClassification,
      positives: JSON.parse(existing.positives) as string[],
      risks: JSON.parse(existing.risks) as string[],
      newsItems: JSON.parse(existing.newsItems) as string[],
      alerts: JSON.parse(existing.alerts) as string[],
      monitoringRecommendation: existing.monitoringRecommendation,
      updatedAt: existing.updatedAt.toISOString(),
    });
    return;
  }

  // Check if asset exists in portfolio
  const [asset] = await db.select().from(assetsTable).where(
    and(eq(assetsTable.ticker, params.data.ticker.toUpperCase()), eq(assetsTable.userId, req.session.userId!))
  );

  if (!asset) {
    res.status(404).json({ error: "Ativo não encontrado na carteira" });
    return;
  }

  res.json(generateAnalysisForTicker(asset.ticker, asset.category));
});

router.post("/analysis/generate", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));

  // Delete old analyses for this user and regenerate
  await db.delete(analysesTable).where(eq(analysesTable.userId, req.session.userId!));

  const analyses = assets.map(a => generateAnalysisForTicker(a.ticker, a.category));

  for (const analysis of analyses) {
    await db.insert(analysesTable).values({
      userId: req.session.userId!,
      ticker: analysis.ticker,
      status: analysis.status,
      score: String(analysis.score),
      scoreClassification: analysis.scoreClassification,
      positives: JSON.stringify(analysis.positives),
      risks: JSON.stringify(analysis.risks),
      newsItems: JSON.stringify(analysis.newsItems),
      alerts: JSON.stringify(analysis.alerts),
      monitoringRecommendation: analysis.monitoringRecommendation,
    });
  }

  // Also generate alerts based on analyses
  await db.delete(alertsTable).where(eq(alertsTable.userId, req.session.userId!));

  const alertsToInsert = analyses
    .filter(a => a.score < 60)
    .map(a => ({
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

  const txRows = await db.select().from(alertsTable).where(eq(alertsTable.userId, req.session.userId!));

  const opportunities = await db.select().from(opportunitiesTable);

  res.json({
    generatedAt: new Date().toISOString(),
    summary: {
      totalPatrimony: 0,
      totalProfitLoss: 0,
      totalProfitLossPercent: 0,
      totalDividends: 0,
      portfolioYield: 0,
      assetCount: assets.length,
    },
    analyses,
    topAlerts: txRows.slice(0, 5).map(a => ({
      id: a.id, userId: a.userId, type: a.type, severity: a.severity,
      title: a.title, message: a.message, ticker: a.ticker,
      isRead: a.isRead, createdAt: a.createdAt.toISOString(),
    })),
    opportunities: opportunities.slice(0, 10).map(o => ({
      id: o.id, ticker: o.ticker, name: o.name, category: o.category,
      score: parseFloat(o.score), potentialReturn: parseFloat(o.potentialReturn),
      dividendYield: parseFloat(o.dividendYield), riskLevel: o.riskLevel,
      reason: o.reason, positives: JSON.parse(o.positives) as string[],
      risks: JSON.parse(o.risks) as string[], horizon: o.horizon,
    })),
  });
});

export default router;
