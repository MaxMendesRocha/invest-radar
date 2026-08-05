import { Router, type IRouter } from "express";
import { db, opportunitiesTable, investorProfilesTable, jobRunsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { getPricesFor, getDividendEvents, classifyDividendFrequency } from "../lib/market-data";
import { OPPORTUNITIES_JOB } from "../lib/opportunities-engine";

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

  // Only fetch quotes/dividendos pro que é realmente mostrado (top 10), não a lista
  // curada inteira — mesmo padrão de getPricesFor logo abaixo.
  const [prices, dividendEventsByTicker] = await Promise.all([
    getPricesFor(top10),
    getDividendEvents(top10.map((item) => ({ ticker: item.ticker, category: item.category }))),
  ]);
  const now = Date.now();
  res.json(top10.map((item) => ({
    ...item,
    currentPrice: prices.get(item.ticker.toUpperCase()) ?? null,
    dividendFrequency: classifyDividendFrequency(dividendEventsByTicker.get(item.ticker.toUpperCase()) ?? [], now)?.label ?? null,
  })));
});

// Quando a lista foi atualizada pela última vez e quando o scheduler (lib/scheduler.ts)
// deve rodar de novo — lastRunAt + minGapMs do mesmo OPPORTUNITIES_JOB usado pelo
// scheduler e pelo disparo manual (routes/internal.ts), então nunca dessincroniza.
// Ambos null se o job nunca rodou (banco novo, só com o seed manual).
router.get("/opportunities/next-refresh", requireAuth, async (req, res): Promise<void> => {
  const [row] = await db.select().from(jobRunsTable).where(eq(jobRunsTable.jobName, OPPORTUNITIES_JOB.name));
  const lastRefreshedAt = row?.lastRunAt ?? null;
  const nextRefreshAt = lastRefreshedAt ? new Date(lastRefreshedAt.getTime() + OPPORTUNITIES_JOB.minGapMs) : null;

  res.json({
    lastRefreshedAt: lastRefreshedAt ? lastRefreshedAt.toISOString() : null,
    nextRefreshAt: nextRefreshAt ? nextRefreshAt.toISOString() : null,
  });
});

export default router;
