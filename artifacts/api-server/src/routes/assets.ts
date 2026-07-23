import { Router, type IRouter } from "express";
import { db, assetsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { CreateAssetBody, UpdateAssetBody, GetAssetParams, UpdateAssetParams, DeleteAssetParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

// Simulated market prices (in a real app, would call an external API)
const MOCK_PRICES: Record<string, number> = {
  PETR4: 38.50, VALE3: 62.10, ITUB4: 32.80, BBDC4: 15.20, ABEV3: 12.90,
  WEGE3: 52.40, RENT3: 68.30, MGLU3: 6.80, LREN3: 18.40, EGIE3: 43.20,
  HGLG11: 165.20, MXRF11: 10.45, XPML11: 102.30, KNRI11: 145.60, HSRE11: 10.80,
  BOVA11: 118.50, SMAL11: 85.40, IVVB11: 310.20, HASH11: 45.60,
  AAPL34: 58.90, AMZO34: 65.40, MSFT34: 112.30,
};

function getCurrentPrice(ticker: string): number | null {
  return MOCK_PRICES[ticker.toUpperCase()] ?? null;
}

function enrichAsset(asset: {
  id: number; userId: number; ticker: string; quantity: string;
  averagePrice: string; purchaseDate: string | null; category: string;
  sector: string | null; notes: string | null;
  createdAt: Date; updatedAt: Date;
}) {
  const qty = parseFloat(asset.quantity);
  const avgPrice = parseFloat(asset.averagePrice);
  const currentPrice = getCurrentPrice(asset.ticker);
  const totalCost = qty * avgPrice;
  const totalValue = currentPrice ? qty * currentPrice : null;
  const profitLoss = totalValue != null ? totalValue - totalCost : null;
  const profitLossPercent = profitLoss != null && totalCost > 0 ? (profitLoss / totalCost) * 100 : null;

  return {
    id: asset.id,
    userId: asset.userId,
    ticker: asset.ticker,
    quantity: qty,
    averagePrice: avgPrice,
    purchaseDate: asset.purchaseDate,
    category: asset.category,
    sector: asset.sector,
    notes: asset.notes,
    currentPrice,
    totalValue,
    profitLoss,
    profitLossPercent,
    createdAt: asset.createdAt.toISOString(),
  };
}

router.get("/assets", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));
  res.json(assets.map(enrichAsset));
});

router.post("/assets", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateAssetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { ticker, quantity, averagePrice, purchaseDate, category, sector, notes } = parsed.data;
  const [asset] = await db.insert(assetsTable).values({
    userId: req.session.userId!,
    ticker: ticker.toUpperCase(),
    quantity: String(quantity),
    averagePrice: String(averagePrice),
    purchaseDate: typeof purchaseDate === "string" ? purchaseDate : null,
    category,
    sector: sector ?? null,
    notes: notes ?? null,
  }).returning();
  res.status(201).json(enrichAsset(asset));
});

router.get("/assets/:id", requireAuth, async (req, res): Promise<void> => {
  const params = GetAssetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [asset] = await db.select().from(assetsTable).where(
    and(eq(assetsTable.id, params.data.id), eq(assetsTable.userId, req.session.userId!))
  );
  if (!asset) {
    res.status(404).json({ error: "Asset não encontrado" });
    return;
  }
  res.json(enrichAsset(asset));
});

router.patch("/assets/:id", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateAssetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateAssetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const updates: Record<string, unknown> = {};
  if (parsed.data.ticker != null) updates.ticker = parsed.data.ticker.toUpperCase();
  if (parsed.data.quantity != null) updates.quantity = String(parsed.data.quantity);
  if (parsed.data.averagePrice != null) updates.averagePrice = String(parsed.data.averagePrice);
  if (parsed.data.purchaseDate !== undefined) updates.purchaseDate = parsed.data.purchaseDate;
  if (parsed.data.category != null) updates.category = parsed.data.category;
  if (parsed.data.sector !== undefined) updates.sector = parsed.data.sector;
  if (parsed.data.notes !== undefined) updates.notes = parsed.data.notes;

  const [asset] = await db.update(assetsTable)
    .set(updates)
    .where(and(eq(assetsTable.id, params.data.id), eq(assetsTable.userId, req.session.userId!)))
    .returning();

  if (!asset) {
    res.status(404).json({ error: "Asset não encontrado" });
    return;
  }
  res.json(enrichAsset(asset));
});

router.delete("/assets/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteAssetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await db.delete(assetsTable).where(
    and(eq(assetsTable.id, params.data.id), eq(assetsTable.userId, req.session.userId!))
  );
  res.sendStatus(204);
});

export default router;
