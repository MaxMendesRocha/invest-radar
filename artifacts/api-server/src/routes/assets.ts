import { Router, type IRouter } from "express";
import { db, assetsTable, salesTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { CreateAssetBody, UpdateAssetBody, GetAssetParams, UpdateAssetParams, DeleteAssetParams, SellAssetParams, SellAssetBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import { getPricesFor, getDividendEvents, getDividendEventsForTicker, classifyDividendFrequency, type DividendFrequency } from "../lib/market-data";
import { estimateCapitalGainsTax } from "../lib/tax-engine";
import { computeMonthlyTaxSummary } from "../lib/monthly-tax-engine";

const router: IRouter = Router();

function enrichAsset(asset: {
  id: number; userId: number; ticker: string; quantity: string;
  averagePrice: string; purchaseDate: string | null; category: string;
  sector: string | null; notes: string | null;
  createdAt: Date; updatedAt: Date;
}, currentPrice: number | null, dividendFrequency: DividendFrequency | null) {
  const qty = parseFloat(asset.quantity);
  const avgPrice = parseFloat(asset.averagePrice);
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
    dividendFrequency: dividendFrequency?.label ?? null,
    createdAt: asset.createdAt.toISOString(),
  };
}

// Usado pelas rotas de mutação/leitura de um único ativo (criar/editar/buscar), onde
// não vale a pena buscar o histórico em lote — só um ticker por vez.
async function dividendFrequencyFor(ticker: string): Promise<DividendFrequency | null> {
  const events = await getDividendEventsForTicker(ticker);
  return classifyDividendFrequency(events, Date.now());
}

router.get("/assets", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));
  const prices = await getPricesFor(assets);
  // Reaproveita o mesmo histórico real de proventos já usado em /portfolio/dividends/*
  // (getDividendEvents, cache de 6h) — periodicidade classificada a partir da mesma
  // fonte, sem chamada nova à API além da já feita hoje pra outras telas.
  const dividendEventsByTicker = await getDividendEvents(assets.map((a) => ({ ticker: a.ticker, category: a.category })));
  const now = Date.now();
  res.json(assets.map((a) => enrichAsset(
    a,
    prices.get(a.ticker.toUpperCase()) ?? null,
    classifyDividendFrequency(dividendEventsByTicker.get(a.ticker.toUpperCase()) ?? [], now),
  )));
});

router.post("/assets", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateAssetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { ticker, quantity, averagePrice, purchaseDate, category, sector, notes } = parsed.data;
  const tickerUpper = ticker.toUpperCase();

  // Comprar mais de um ticker que já está na carteira consolida na mesma linha em vez
  // de criar uma segunda posição — soma a quantidade e recalcula o preço médio
  // ponderado, igual a qualquer corretora faria. Só considera a mesma categoria (o
  // preço médio de "acoes" e "bdrs" do mesmo ticker, por exemplo, nunca deveriam se
  // misturar, embora isso praticamente não aconteça na prática).
  const [existing] = await db.select().from(assetsTable).where(
    and(eq(assetsTable.userId, req.session.userId!), eq(assetsTable.ticker, tickerUpper), eq(assetsTable.category, category))
  );

  if (existing) {
    const existingQty = parseFloat(existing.quantity);
    const existingAvg = parseFloat(existing.averagePrice);
    const newQty = existingQty + quantity;
    const newAvg = (existingQty * existingAvg + quantity * averagePrice) / newQty;

    const [updated] = await db.update(assetsTable)
      .set({ quantity: String(newQty), averagePrice: String(newAvg) })
      .where(eq(assetsTable.id, existing.id))
      .returning();
    const prices = await getPricesFor([updated]);
    const dividendFrequency = await dividendFrequencyFor(updated.ticker);
    res.status(200).json(enrichAsset(updated, prices.get(updated.ticker.toUpperCase()) ?? null, dividendFrequency));
    return;
  }

  const [asset] = await db.insert(assetsTable).values({
    userId: req.session.userId!,
    ticker: tickerUpper,
    quantity: String(quantity),
    averagePrice: String(averagePrice),
    purchaseDate: typeof purchaseDate === "string" ? purchaseDate : null,
    category,
    sector: sector ?? null,
    notes: notes ?? null,
  }).returning();
  const prices = await getPricesFor([asset]);
  const dividendFrequency = await dividendFrequencyFor(asset.ticker);
  res.status(201).json(enrichAsset(asset, prices.get(asset.ticker.toUpperCase()) ?? null, dividendFrequency));
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
  const prices = await getPricesFor([asset]);
  const dividendFrequency = await dividendFrequencyFor(asset.ticker);
  res.json(enrichAsset(asset, prices.get(asset.ticker.toUpperCase()) ?? null, dividendFrequency));
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
  const prices = await getPricesFor([asset]);
  const dividendFrequency = await dividendFrequencyFor(asset.ticker);
  res.json(enrichAsset(asset, prices.get(asset.ticker.toUpperCase()) ?? null, dividendFrequency));
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

function serializeSale(sale: typeof salesTable.$inferSelect) {
  return {
    id: sale.id,
    userId: sale.userId,
    ticker: sale.ticker,
    category: sale.category,
    quantity: parseFloat(sale.quantity),
    averagePrice: parseFloat(sale.averagePrice),
    salePrice: parseFloat(sale.salePrice),
    saleDate: sale.saleDate,
    grossGain: parseFloat(sale.grossGain),
    taxOwed: sale.taxOwed != null ? parseFloat(sale.taxOwed) : null,
    notes: sale.notes,
    createdAt: sale.createdAt.toISOString(),
  };
}

// Tolerância pra erro de arredondamento de ponto flutuante ao comparar a quantidade
// vendida com a quantidade restante da posição — sem isso, vender "a posição toda"
// podia deixar um resíduo tipo 0.000000003 e nunca encerrar o asset de verdade.
const QUANTITY_EPSILON = 1e-6;

router.post("/assets/:id/sell", requireAuth, async (req, res): Promise<void> => {
  const params = SellAssetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = SellAssetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [asset] = await db.select().from(assetsTable).where(
    and(eq(assetsTable.id, params.data.id), eq(assetsTable.userId, req.session.userId!))
  );
  if (!asset) {
    res.status(404).json({ error: "Asset não encontrado" });
    return;
  }

  const existingQty = parseFloat(asset.quantity);
  const { salePrice, saleDate, quantity } = parsed.data;
  const soldQty = quantity ?? existingQty;

  if (soldQty <= 0 || soldQty > existingQty + QUANTITY_EPSILON) {
    res.status(400).json({ error: "Quantidade vendida inválida — deve ser maior que zero e não pode superar a posição atual." });
    return;
  }

  // Reaproveita o mesmo motor de IR usado no parecer de ativos (tax-engine.ts), mas
  // agora com o preço de venda REAL, não mais uma estimativa de "e se eu vendesse
  // hoje" — esta venda já aconteceu de verdade. null pra renda_fixa/fundos, categorias
  // fora do escopo de ganho de capital em renda variável.
  const averagePrice = parseFloat(asset.averagePrice);
  const tax = estimateCapitalGainsTax(asset.category, soldQty, averagePrice, salePrice);
  const grossGain = tax ? tax.grossGain : (salePrice - averagePrice) * soldQty;

  const [sale] = await db.insert(salesTable).values({
    userId: req.session.userId!,
    ticker: asset.ticker,
    category: asset.category,
    quantity: String(soldQty),
    averagePrice: String(averagePrice),
    salePrice: String(salePrice),
    saleDate: saleDate.toISOString().slice(0, 10),
    grossGain: String(grossGain),
    taxOwed: tax ? String(tax.taxOwed) : null,
  }).returning();

  const remainingQty = existingQty - soldQty;
  if (remainingQty > QUANTITY_EPSILON) {
    // Venda parcial: reduz a quantidade, preço médio de compra não muda.
    await db.update(assetsTable).set({ quantity: String(remainingQty) }).where(eq(assetsTable.id, asset.id));
  } else {
    // Venda total: a posição encerrou de verdade, não faz sentido mostrar quantidade
    // zero em "Minha Carteira".
    await db.delete(assetsTable).where(eq(assetsTable.id, asset.id));
  }

  res.status(201).json(serializeSale(sale));
});

router.get("/sales", requireAuth, async (req, res): Promise<void> => {
  const sales = await db.select().from(salesTable)
    .where(eq(salesTable.userId, req.session.userId!))
    .orderBy(desc(salesTable.saleDate), desc(salesTable.id));
  res.json(sales.map(serializeSale));
});

// Consolidação mensal por categoria — sempre recalculada a partir do histórico real
// de vendas (nunca persistida), então reflete automaticamente qualquer venda nova
// registrada. Ordenado por mês mais recente primeiro (mesmo sentido de GET /sales).
router.get("/sales/monthly-tax", requireAuth, async (req, res): Promise<void> => {
  const sales = await db.select().from(salesTable).where(eq(salesTable.userId, req.session.userId!));
  const summary = computeMonthlyTaxSummary(
    sales.map((s) => ({
      category: s.category,
      saleDate: s.saleDate,
      quantity: parseFloat(s.quantity),
      salePrice: parseFloat(s.salePrice),
      grossGain: parseFloat(s.grossGain),
    }))
  );
  res.json(summary);
});

export default router;
