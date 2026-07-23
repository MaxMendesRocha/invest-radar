import { Router, type IRouter } from "express";
import { db, opportunitiesTable } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/opportunities", requireAuth, async (req, res): Promise<void> => {
  const rows = await db.select().from(opportunitiesTable).orderBy(opportunitiesTable.score);
  res.json(rows.map(r => ({
    id: r.id,
    ticker: r.ticker,
    name: r.name,
    category: r.category,
    score: parseFloat(r.score),
    potentialReturn: parseFloat(r.potentialReturn),
    dividendYield: parseFloat(r.dividendYield),
    riskLevel: r.riskLevel,
    reason: r.reason,
    positives: JSON.parse(r.positives) as string[],
    risks: JSON.parse(r.risks) as string[],
    horizon: r.horizon,
  })));
});

export default router;
