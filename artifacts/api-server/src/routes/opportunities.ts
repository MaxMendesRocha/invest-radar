import { Router, type IRouter } from "express";
import { db, jobRunsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { getPricesFor, getDividendEvents, classifyDividendFrequency } from "../lib/market-data";
import { OPPORTUNITIES_JOB } from "../lib/opportunities-engine";
import { rankOpportunitiesFor } from "../lib/opportunity-ranking";

const router: IRouter = Router();

router.get("/opportunities", requireAuth, async (req, res): Promise<void> => {
  // Ordenação vive em lib/opportunity-ranking.ts porque o plano de aporte
  // (/portfolio/allocation/plan) precisa exatamente da mesma ordem, só que filtrada
  // por classe de ativo.
  const { orderedBy, dividendPremiumPending, items, dividendValueByTicker } = await rankOpportunitiesFor(req.session.userId!);
  const valueByTicker = dividendValueByTicker;

  const top10 = items.slice(0, 10);

  // Only fetch quotes/dividendos pro que é realmente mostrado (top 10), não a lista
  // curada inteira — mesmo padrão de getPricesFor logo abaixo.
  const [prices, dividendEventsByTicker] = await Promise.all([
    getPricesFor(top10),
    getDividendEvents(top10.map((item) => ({ ticker: item.ticker, category: item.category }))),
  ]);
  const now = Date.now();
  // A lista passa a vir envelopada: o consumidor precisa saber por qual critério ela
  // foi ordenada, senão a ordem muda sem explicação quando o objetivo do perfil muda.
  const items10 = top10.map((item) => {
    const value = valueByTicker.get(item.ticker) ?? null;
    return {
    ...item,
    currentPrice: prices.get(item.ticker.toUpperCase())?.price ?? null,
    dividendFrequency: classifyDividendFrequency(dividendEventsByTicker.get(item.ticker.toUpperCase()) ?? [], now)?.label ?? null,
    dividendPremiumPP: value?.premiumOverSectorPP ?? null,
    sectorMedianYield: value?.sectorMedianYield ?? null,
    sectorSampleSize: value?.sampleSize ?? null,
    implausibleYield: value?.implausible ?? false,
    };
  });

  res.json({ orderedBy, dividendPremiumPending, items: items10 });
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
