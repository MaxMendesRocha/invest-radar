import { Router, type IRouter } from "express";
import { db, assetsTable, transactionsTable } from "@workspace/db";
import { eq, sum } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { getPricesFor } from "../lib/market-data";
import { recordSnapshot, getSnapshotsForUser, findSnapshotForMonth } from "../lib/portfolio-history";

const router: IRouter = Router();

const SECTOR_MAP: Record<string, string> = {
  PETR4: "Petróleo & Gás", VALE3: "Mineração", ITUB4: "Bancos", BBDC4: "Bancos",
  ABEV3: "Bebidas", WEGE3: "Indústria", RENT3: "Locação", MGLU3: "Varejo",
  LREN3: "Varejo", EGIE3: "Energia", HGLG11: "Logística", MXRF11: "Papel",
  XPML11: "Shopping", KNRI11: "Lajes Comerciais", HSRE11: "Shopping",
  BOVA11: "ETF", SMAL11: "ETF", IVVB11: "ETF", HASH11: "ETF",
  AAPL34: "Tecnologia", AMZO34: "Tecnologia", MSFT34: "Tecnologia",
};

router.get("/portfolio/summary", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));
  const txRows = await db.select({ total: sum(transactionsTable.amount) }).from(transactionsTable).where(eq(transactionsTable.userId, req.session.userId!));
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
  const totalDividends = parseFloat(String(txRows[0]?.total ?? "0")) || 0;
  const portfolioYield = totalCost > 0 ? (totalDividends / totalCost) * 100 : 0;

  // Upserts today's row in portfolio_snapshots — this is the only place real history
  // gets recorded, from ordinary use of the app, no scheduled job involved.
  await recordSnapshot(req.session.userId!, totalPatrimony, totalCost);

  res.json({
    totalPatrimony,
    totalProfitLoss,
    totalProfitLossPercent,
    totalDividends,
    portfolioYield,
    assetCount: assets.length,
  });
});

router.get("/portfolio/distribution", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));
  const prices = await getPricesFor(assets);

  const byCategoryMap: Record<string, number> = {};
  const bySectorMap: Record<string, number> = {};
  const byRiskMap: Record<string, number> = { Baixo: 0, Médio: 0, Alto: 0 };

  let total = 0;

  for (const a of assets) {
    const qty = parseFloat(a.quantity);
    const price = prices.get(a.ticker.toUpperCase()) ?? parseFloat(a.averagePrice);
    const value = qty * price;
    total += value;

    byCategoryMap[a.category] = (byCategoryMap[a.category] ?? 0) + value;
    const sector = a.sector ?? SECTOR_MAP[a.ticker.toUpperCase()] ?? "Outros";
    bySectorMap[sector] = (bySectorMap[sector] ?? 0) + value;

    const risk = a.category === "acoes" ? "Alto" : a.category === "renda_fixa" ? "Baixo" : "Médio";
    byRiskMap[risk] = (byRiskMap[risk] ?? 0) + value;
  }

  const toItems = (map: Record<string, number>) =>
    Object.entries(map).map(([label, value]) => ({
      label,
      value: Math.round(value * 100) / 100,
      percent: total > 0 ? Math.round((value / total) * 10000) / 100 : 0,
    })).sort((a, b) => b.value - a.value);

  res.json({
    byCategory: toItems(byCategoryMap),
    bySector: toItems(bySectorMap),
    byRisk: toItems(byRiskMap),
  });
});

router.get("/portfolio/evolution", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));
  const prices = await getPricesFor(assets);

  let currentValue = 0;
  for (const a of assets) {
    const qty = parseFloat(a.quantity);
    const price = prices.get(a.ticker.toUpperCase()) ?? parseFloat(a.averagePrice);
    currentValue += qty * price;
  }

  // Months with a real snapshot (portfolio_snapshots) use it; months without one still
  // fall back to a simulated approximation around the current value. The real portion
  // grows on its own as portfolio_snapshots accumulates one row per day of app usage.
  const snapshots = await getSnapshotsForUser(req.session.userId!);

  const points = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const label = d.toLocaleDateString("pt-BR", { month: "short", year: "2-digit" });
    const snapshot = findSnapshotForMonth(snapshots, d.getFullYear(), d.getMonth());

    let value: number;
    if (snapshot) {
      value = parseFloat(snapshot.totalValue);
    } else {
      const factor = 1 - i * 0.015 + Math.random() * 0.02 - 0.01;
      value = Math.round(currentValue * factor * 100) / 100;
    }
    points.push({ date: label, value, cdi: null, ibov: null });
  }

  res.json(points);
});

router.get("/portfolio/health", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));

  const categories = new Set(assets.map(a => a.category));
  const sectors = new Set(assets.map(a => a.sector ?? SECTOR_MAP[a.ticker.toUpperCase()] ?? "Outros"));

  const diversification = Math.min(100, categories.size * 15 + sectors.size * 8);
  const concentration = assets.length > 0 ? Math.max(0, 100 - (100 / assets.length) * 2) : 0;
  const risk = assets.some(a => a.category === "acoes") ? 60 : 80;
  const dividends = assets.some(a => a.category === "fiis" || a.category === "acoes") ? 72 : 50;
  const growth = 68;

  const score = Math.round((diversification * 0.25 + concentration * 0.25 + risk * 0.2 + dividends * 0.15 + growth * 0.15));

  let classification: string;
  if (score >= 80) classification = "Excelente";
  else if (score >= 65) classification = "Boa";
  else if (score >= 45) classification = "Regular";
  else classification = "Ruim";

  res.json({ score, classification, diversification, risk, dividends, growth, concentration });
});

router.get("/portfolio/benchmarks", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));
  const prices = await getPricesFor(assets);

  let totalCost = 0;
  let totalValue = 0;
  for (const a of assets) {
    const qty = parseFloat(a.quantity);
    const avgPrice = parseFloat(a.averagePrice);
    const price = prices.get(a.ticker.toUpperCase()) ?? avgPrice;
    totalCost += qty * avgPrice;
    totalValue += qty * price;
  }
  // Fallback for months without a real snapshot: current return held flat, since we
  // have no other honest estimate for the past. A portfolio with 0 assets correctly
  // shows 0%, not a fabricated gain.
  const portfolioReturn = totalCost > 0 ? Math.round(((totalValue - totalCost) / totalCost) * 10000) / 100 : 0;
  const snapshots = await getSnapshotsForUser(req.session.userId!);

  const points = [];
  const now = new Date();

  // CDI/IBOV/IFIX are still simulated (Math.random) — no real data source wired up yet.
  let cdiAcc = 100, ibovAcc = 100, ifixAcc = 100;

  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const label = d.toLocaleDateString("pt-BR", { month: "short", year: "2-digit" });
    const snapshot = findSnapshotForMonth(snapshots, d.getFullYear(), d.getMonth());

    let portfolioForMonth = portfolioReturn;
    if (snapshot) {
      const snapCost = parseFloat(snapshot.totalCost);
      const snapValue = parseFloat(snapshot.totalValue);
      portfolioForMonth = snapCost > 0 ? Math.round(((snapValue - snapCost) / snapCost) * 10000) / 100 : 0;
    }

    cdiAcc *= 1.0087;
    ibovAcc *= 1 + (0.008 + Math.random() * 0.03 - 0.015);
    ifixAcc *= 1 + (0.007 + Math.random() * 0.015 - 0.007);

    points.push({
      label,
      portfolio: portfolioForMonth,
      cdi: Math.round((cdiAcc - 100) * 100) / 100,
      ibov: Math.round((ibovAcc - 100) * 100) / 100,
      ifix: Math.round((ifixAcc - 100) * 100) / 100,
    });
  }

  res.json({
    points,
    portfolioTotal: portfolioReturn,
    cdiTotal: Math.round((cdiAcc - 100) * 100) / 100,
    ibovTotal: Math.round((ibovAcc - 100) * 100) / 100,
    ifixTotal: Math.round((ifixAcc - 100) * 100) / 100,
  });
});

export default router;
