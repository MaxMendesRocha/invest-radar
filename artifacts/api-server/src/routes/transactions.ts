import { Router, type IRouter } from "express";
import { db, transactionsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { CreateTransactionBody, DeleteTransactionParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/transactions", requireAuth, async (req, res): Promise<void> => {
  const rows = await db.select().from(transactionsTable)
    .where(eq(transactionsTable.userId, req.session.userId!))
    .orderBy(transactionsTable.date);

  res.json(rows.map(t => ({
    id: t.id,
    userId: t.userId,
    ticker: t.ticker,
    amount: parseFloat(t.amount),
    type: t.type,
    date: t.date,
    notes: t.notes,
    createdAt: t.createdAt.toISOString(),
  })));
});

router.post("/transactions", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateTransactionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { ticker, amount, type, date, notes } = parsed.data;
  const [tx] = await db.insert(transactionsTable).values({
    userId: req.session.userId!,
    ticker: ticker.toUpperCase(),
    amount: String(amount),
    type,
    date: typeof date === "string" ? date : String(date),
    notes: notes ?? null,
  }).returning();
  res.status(201).json({
    id: tx.id, userId: tx.userId, ticker: tx.ticker,
    amount: parseFloat(tx.amount), type: tx.type, date: tx.date,
    notes: tx.notes, createdAt: tx.createdAt.toISOString(),
  });
});

router.delete("/transactions/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteTransactionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await db.delete(transactionsTable).where(
    and(eq(transactionsTable.id, params.data.id), eq(transactionsTable.userId, req.session.userId!))
  );
  res.sendStatus(204);
});

export default router;
