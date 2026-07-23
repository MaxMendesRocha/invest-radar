import { Router, type IRouter } from "express";
import { db, alertsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { MarkAlertReadParams, DeleteAlertParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/alerts", requireAuth, async (req, res): Promise<void> => {
  const alerts = await db.select().from(alertsTable)
    .where(eq(alertsTable.userId, req.session.userId!))
    .orderBy(alertsTable.createdAt);

  res.json(alerts.map(a => ({
    id: a.id,
    userId: a.userId,
    type: a.type,
    severity: a.severity,
    title: a.title,
    message: a.message,
    ticker: a.ticker,
    isRead: a.isRead,
    createdAt: a.createdAt.toISOString(),
  })));
});

router.patch("/alerts/:id/read", requireAuth, async (req, res): Promise<void> => {
  const params = MarkAlertReadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [alert] = await db.update(alertsTable)
    .set({ isRead: true })
    .where(and(eq(alertsTable.id, params.data.id), eq(alertsTable.userId, req.session.userId!)))
    .returning();

  if (!alert) {
    res.status(404).json({ error: "Alerta não encontrado" });
    return;
  }
  res.json({
    id: alert.id, userId: alert.userId, type: alert.type, severity: alert.severity,
    title: alert.title, message: alert.message, ticker: alert.ticker,
    isRead: alert.isRead, createdAt: alert.createdAt.toISOString(),
  });
});

router.delete("/alerts/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteAlertParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await db.delete(alertsTable).where(
    and(eq(alertsTable.id, params.data.id), eq(alertsTable.userId, req.session.userId!))
  );
  res.sendStatus(204);
});

export default router;
