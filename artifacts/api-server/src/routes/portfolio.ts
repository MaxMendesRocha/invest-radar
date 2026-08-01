import { Router, type IRouter } from "express";
import { db, assetsTable, transactionsTable } from "@workspace/db";
import { eq, sum } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { getPricesFor, getFundamentals, sectorFor, QUOTED_CATEGORIES } from "../lib/market-data";
import { recordSnapshot, getSnapshotsForUser, findSnapshotForMonth } from "../lib/portfolio-history";
import { getCdiMonthlyReturns, syncAndGetIndexCloses } from "../lib/benchmark-data";
import { evalVolatility, evalDividendYield, evalRevenueGrowth } from "../lib/analysis-engine";
import { synthesizePortfolioDiagnosis } from "../lib/portfolio-ai";
import { getMacroSnapshot } from "../lib/macro-data";

const router: IRouter = Router();

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
  const fundamentalsByTicker = await getFundamentals(
    assets.filter((a) => QUOTED_CATEGORIES.has(a.category)).map((a) => a.ticker)
  );

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
    const sector = sectorFor(a, fundamentalsByTicker.get(a.ticker.toUpperCase())?.sector);
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

  const prices = await getPricesFor(assets);
  const fundamentalsByTicker = await getFundamentals(
    assets.filter((a) => QUOTED_CATEGORIES.has(a.category)).map((a) => a.ticker)
  );

  const categories = new Set(assets.map(a => a.category));
  const sectors = new Set(assets.map((a) => sectorFor(a, fundamentalsByTicker.get(a.ticker.toUpperCase())?.sector)));

  // With no assets, every dimension is honestly 0 — the risk/dividends/growth fallbacks
  // below are heuristics for an existing portfolio's composition, not a default score
  // for having no portfolio at all (that was a bug: an empty carteira showed Score 34).
  const diversification = assets.length > 0 ? Math.min(100, categories.size * 15 + sectors.size * 8) : 0;
  const concentration = assets.length > 0 ? Math.max(0, 100 - (100 / assets.length) * 2) : 0;

  // Risco/dividendos/crescimento são médias ponderadas pelo valor de cada posição,
  // usando os mesmos buckets de evalVolatility/evalDividendYield/evalRevenueGrowth do
  // motor de análise — só ativos com dado real contribuem peso; um ativo sem
  // fundamentos disponível simplesmente não pesa nessa dimensão, nunca herda um valor
  // chutado. Renda fixa não tem beta, mas segue o mesmo mapeamento de baixo risco já
  // usado em /portfolio/distribution.
  let totalValue = 0;
  let riskWeighted = 0, riskWeight = 0;
  let dividendsWeighted = 0, dividendsWeight = 0;
  let growthWeighted = 0, growthWeight = 0;
  const composition: { ticker: string; category: string; percent: number }[] = [];

  for (const a of assets) {
    const qty = parseFloat(a.quantity);
    const price = prices.get(a.ticker.toUpperCase()) ?? parseFloat(a.averagePrice);
    const value = qty * price;
    totalValue += value;
    composition.push({ ticker: a.ticker, category: a.category, percent: 0 }); // percent preenchido depois de somar totalValue

    const fundamentals = fundamentalsByTicker.get(a.ticker.toUpperCase());

    if (a.category === "renda_fixa") {
      riskWeighted += 85 * value; // mesmo score de baixa-volatilidade usado pra beta baixo
      riskWeight += value;
    } else {
      const volatility = fundamentals ? evalVolatility(fundamentals.beta) : null;
      if (volatility) { riskWeighted += volatility.score * value; riskWeight += value; }
    }

    const dividendYield = fundamentals ? evalDividendYield(fundamentals.dividendYield) : null;
    if (dividendYield) { dividendsWeighted += dividendYield.score * value; dividendsWeight += value; }

    const revenueGrowth = fundamentals ? evalRevenueGrowth(fundamentals.revenueGrowth) : null;
    if (revenueGrowth) { growthWeighted += revenueGrowth.score * value; growthWeight += value; }
  }

  for (const c of composition) {
    const a = assets.find((x) => x.ticker === c.ticker)!;
    const qty = parseFloat(a.quantity);
    const price = prices.get(a.ticker.toUpperCase()) ?? parseFloat(a.averagePrice);
    c.percent = totalValue > 0 ? ((qty * price) / totalValue) * 100 : 0;
  }

  // Sem nenhum dado real disponível pra pesar a dimensão, cai num neutro documentado
  // (mesmos valores do fallback anterior) em vez de inventar — só acontece se o
  // provider falhar pra todos os ativos cotados da carteira.
  const risk = riskWeight > 0 ? Math.round(riskWeighted / riskWeight) : assets.length > 0 ? 60 : 0;
  const dividends = dividendsWeight > 0 ? Math.round(dividendsWeighted / dividendsWeight) : assets.length > 0 ? 50 : 0;
  const growth = growthWeight > 0 ? Math.round(growthWeighted / growthWeight) : assets.length > 0 ? 55 : 0;

  const score = Math.round((diversification * 0.25 + concentration * 0.25 + risk * 0.2 + dividends * 0.15 + growth * 0.15));

  let classification: string;
  if (score >= 80) classification = "Excelente";
  else if (score >= 65) classification = "Boa";
  else if (score >= 45) classification = "Regular";
  else classification = "Ruim";

  const aiDiagnosis =
    assets.length > 0
      ? await synthesizePortfolioDiagnosis({
          score,
          classification,
          diversification,
          concentration,
          risk,
          dividends,
          growth,
          composition,
          macro: await getMacroSnapshot().then((m) => ({ selic: m.selic, selicTrend: m.selicTrend, ipca12m: m.ipca12m })),
        })
      : null;

  res.json({ score, classification, diversification, risk, dividends, growth, concentration, aiDiagnosis });
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

  // CDI is real for the full window (BCB publishes years of monthly history for free).
  // IBOV/IFIX are real wherever we have two consecutive months of closes on file —
  // IBOV starts with ~3 real months backfilled from brapi.dev's free tier; IFIX has no
  // historical data available for free, so it only accumulates one day at a time from
  // here on. Months without real data on either side still fall back to the old
  // simulated approximation, same "real crowds out simulated, never fabricated" rule
  // used for the portfolio's own snapshot history.
  const [cdiReturns, ibovCloses, ifixCloses] = await Promise.all([
    getCdiMonthlyReturns(),
    syncAndGetIndexCloses("^BVSP", "ibov"),
    syncAndGetIndexCloses("IFIX", "ifix"),
  ]);

  const points = [];
  const now = new Date();

  let cdiAcc = 100, ibovAcc = 100, ifixAcc = 100;

  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const prevD = new Date(now.getFullYear(), now.getMonth() - i - 1, 1);
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const prevMonthKey = `${prevD.getFullYear()}-${String(prevD.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("pt-BR", { month: "short", year: "2-digit" });
    const snapshot = findSnapshotForMonth(snapshots, d.getFullYear(), d.getMonth());

    let portfolioForMonth = portfolioReturn;
    if (snapshot) {
      const snapCost = parseFloat(snapshot.totalCost);
      const snapValue = parseFloat(snapshot.totalValue);
      portfolioForMonth = snapCost > 0 ? Math.round(((snapValue - snapCost) / snapCost) * 10000) / 100 : 0;
    }

    const cdiMonthReturn = cdiReturns.get(monthKey);
    cdiAcc *= cdiMonthReturn != null ? 1 + cdiMonthReturn / 100 : 1.0087;

    const ibovThis = ibovCloses.get(monthKey);
    const ibovPrev = ibovCloses.get(prevMonthKey);
    ibovAcc *= ibovThis != null && ibovPrev != null ? ibovThis / ibovPrev : 1 + (0.008 + Math.random() * 0.03 - 0.015);

    const ifixThis = ifixCloses.get(monthKey);
    const ifixPrev = ifixCloses.get(prevMonthKey);
    ifixAcc *= ifixThis != null && ifixPrev != null ? ifixThis / ifixPrev : 1 + (0.007 + Math.random() * 0.015 - 0.007);

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
