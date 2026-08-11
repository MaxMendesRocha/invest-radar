import { Router, type IRouter } from "express";
import { db, priceTargetsTable, type PriceTarget } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { UpsertPriceTargetBody } from "@workspace/api-zod";
import { getPricesFor } from "../lib/market-data";

const router: IRouter = Router();

/**
 * Upside contra a cotação real. É a única coisa que o app calcula aqui — o alvo em si
 * é dado do usuário, e misturar os dois seria apresentar opinião de terceiro como
 * medição do Radar.
 */
function serialize(row: PriceTarget, price: number | null) {
  const targetPrice = parseFloat(row.targetPrice);
  return {
    ticker: row.ticker,
    targetPrice,
    source: row.source,
    notes: row.notes,
    currentPrice: price,
    upsidePercent: price != null && price > 0 ? Math.round(((targetPrice - price) / price) * 10000) / 100 : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get("/price-targets", requireAuth, async (req, res): Promise<void> => {
  const rows = await db.select().from(priceTargetsTable).where(eq(priceTargetsTable.userId, req.session.userId!));
  // Categoria "acoes" só para satisfazer o filtro de getPricesFor: o que importa é a
  // cotação, e ticker sem alvo cadastrado não chega aqui.
  const prices = await getPricesFor(rows.map((r) => ({ ticker: r.ticker, category: "acoes" })));
  res.json(rows.map((r) => serialize(r, prices.get(r.ticker.toUpperCase())?.price ?? null)));
});

router.put("/price-targets/:ticker", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpsertPriceTargetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const ticker = String(req.params.ticker).toUpperCase();
  const { targetPrice, source, notes } = parsed.data;

  const [row] = await db
    .insert(priceTargetsTable)
    .values({ userId: req.session.userId!, ticker, targetPrice: String(targetPrice), source: source ?? null, notes: notes ?? null })
    .onConflictDoUpdate({
      target: [priceTargetsTable.userId, priceTargetsTable.ticker],
      set: { targetPrice: String(targetPrice), source: source ?? null, notes: notes ?? null },
    })
    .returning();

  const prices = await getPricesFor([{ ticker, category: "acoes" }]);
  res.json(serialize(row, prices.get(ticker)?.price ?? null));
});

router.delete("/price-targets/:ticker", requireAuth, async (req, res): Promise<void> => {
  await db
    .delete(priceTargetsTable)
    .where(and(eq(priceTargetsTable.userId, req.session.userId!), eq(priceTargetsTable.ticker, String(req.params.ticker).toUpperCase())));
  res.status(204).send();
});

export default router;
