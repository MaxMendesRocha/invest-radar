import { Router, type IRouter } from "express";
import { db, assetsTable, transactionsTable } from "@workspace/db";
import { eq, sum } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

const MOCK_PRICES: Record<string, number> = {
  PETR4: 38.50, VALE3: 62.10, ITUB4: 32.80, BBDC4: 15.20, ABEV3: 12.90,
  WEGE3: 52.40, RENT3: 68.30, MGLU3: 6.80, LREN3: 18.40, EGIE3: 43.20,
  HGLG11: 165.20, MXRF11: 10.45, XPML11: 102.30, KNRI11: 145.60, HSRE11: 10.80,
  BOVA11: 118.50, SMAL11: 85.40, IVVB11: 310.20, HASH11: 45.60,
  AAPL34: 58.90, AMZO34: 65.40, MSFT34: 112.30,
};

const SECTOR_MAP: Record<string, string> = {
  PETR4: "Petróleo & Gás", VALE3: "Mineração", ITUB4: "Bancos", BBDC4: "Bancos",
  ABEV3: "Bebidas", WEGE3: "Indústria", RENT3: "Locação", MGLU3: "Varejo",
  LREN3: "Varejo", EGIE3: "Energia", HGLG11: "Logística", MXRF11: "Papel",
  XPML11: "Shopping", KNRI11: "Lajes Comerciais", HSRE11: "Shopping",
  BOVA11: "ETF", SMAL11: "ETF", IVVB11: "ETF", HASH11: "ETF",
  AAPL34: "Tecnologia", AMZO34: "Tecnologia", MSFT34: "Tecnologia",
};

function getPrice(ticker: string): number | null {
  return MOCK_PRICES[ticker.toUpperCase()] ?? null;
}

router.get("/portfolio/summary", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));
  const txRows = await db.select({ total: sum(transactionsTable.amount) }).from(transactionsTable).where(eq(transactionsTable.userId, req.session.userId!));

  let totalPatrimony = 0;
  let totalCost = 0;

  for (const a of assets) {
    const qty = parseFloat(a.quantity);
    const avgPrice = parseFloat(a.averagePrice);
    const price = getPrice(a.ticker) ?? avgPrice;
    totalPatrimony += qty * price;
    totalCost += qty * avgPrice;
  }

  const totalProfitLoss = totalPatrimony - totalCost;
  const totalProfitLossPercent = totalCost > 0 ? (totalProfitLoss / totalCost) * 100 : 0;
  const totalDividends = parseFloat(String(txRows[0]?.total ?? "0")) || 0;
  const portfolioYield = totalCost > 0 ? (totalDividends / totalCost) * 100 : 0;

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

  const byCategoryMap: Record<string, number> = {};
  const bySectorMap: Record<string, number> = {};
  const byRiskMap: Record<string, number> = { Baixo: 0, Médio: 0, Alto: 0 };

  let total = 0;

  for (const a of assets) {
    const qty = parseFloat(a.quantity);
    const price = getPrice(a.ticker) ?? parseFloat(a.averagePrice);
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

  let currentValue = 0;
  for (const a of assets) {
    const qty = parseFloat(a.quantity);
    const price = getPrice(a.ticker) ?? parseFloat(a.averagePrice);
    currentValue += qty * price;
  }

  const points = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const label = d.toLocaleDateString("pt-BR", { month: "short", year: "2-digit" });
    const factor = 1 - i * 0.015 + Math.random() * 0.02 - 0.01;
    const value = Math.round(currentValue * factor * 100) / 100;
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
  const points = [];
  const now = new Date();

  let portfolioAcc = 100, cdiAcc = 100, ibovAcc = 100, ifixAcc = 100;

  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const label = d.toLocaleDateString("pt-BR", { month: "short", year: "2-digit" });

    portfolioAcc *= 1 + (0.012 + Math.random() * 0.01 - 0.005);
    cdiAcc *= 1.0087;
    ibovAcc *= 1 + (0.008 + Math.random() * 0.03 - 0.015);
    ifixAcc *= 1 + (0.007 + Math.random() * 0.015 - 0.007);

    points.push({
      label,
      portfolio: Math.round((portfolioAcc - 100) * 100) / 100,
      cdi: Math.round((cdiAcc - 100) * 100) / 100,
      ibov: Math.round((ibovAcc - 100) * 100) / 100,
      ifix: Math.round((ifixAcc - 100) * 100) / 100,
    });
  }

  res.json({
    points,
    portfolioTotal: Math.round((portfolioAcc - 100) * 100) / 100,
    cdiTotal: Math.round((cdiAcc - 100) * 100) / 100,
    ibovTotal: Math.round((ibovAcc - 100) * 100) / 100,
    ifixTotal: Math.round((ifixAcc - 100) * 100) / 100,
  });
});

export default router;
