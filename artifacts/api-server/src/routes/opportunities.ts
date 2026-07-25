import { Router, type IRouter } from "express";
import { db, opportunitiesTable, investorProfilesTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { getPricesFor } from "../lib/market-data";

const router: IRouter = Router();

// Lower number = shown first. Missing risk levels fall back to the middle tier.
const RISK_PRIORITY: Record<string, Record<string, number>> = {
  Conservador: { Baixo: 0, Medio: 1, Alto: 2 },
  Moderado: { Medio: 0, Baixo: 1, Alto: 2 },
  Arrojado: { Alto: 0, Medio: 1, Baixo: 2 },
};

router.get("/opportunities", requireAuth, async (req, res): Promise<void> => {
  const rows = await db.select().from(opportunitiesTable).orderBy(desc(opportunitiesTable.score));
  const [profile] = await db.select().from(investorProfilesTable).where(eq(investorProfilesTable.userId, req.session.userId!));

  const items = rows.map((r) => ({
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
  }));

  // No profile set yet: keep plain score ranking, don't personalize.
  if (profile) {
    const priority = RISK_PRIORITY[profile.classification] ?? {};
    items.sort((a, b) => {
      const pa = priority[a.riskLevel] ?? 1;
      const pb = priority[b.riskLevel] ?? 1;
      if (pa !== pb) return pa - pb;
      return b.score - a.score;
    });
  }

  const top10 = items.slice(0, 10);

  // Only fetch quotes for what's actually shown, not the full curated list.
  const prices = await getPricesFor(top10);
  res.json(top10.map((item) => ({ ...item, currentPrice: prices.get(item.ticker.toUpperCase()) ?? null })));
});

export default router;
