import { Router, type IRouter } from "express";
import { db, jobRunsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { getPricesFor, getDividendEvents, classifyDividendFrequency, getFundamentals } from "../lib/market-data";
import { OPPORTUNITIES_JOB } from "../lib/opportunities-engine";
import { rankOpportunitiesFor } from "../lib/opportunity-ranking";
import { getSectorBenchmark } from "../lib/sector-benchmarks";
import { normalizedEarningsFor } from "../lib/normalized-earnings";
import { computeStockPriceZones, sectorReferenceFrom, summarizeStockPriceZones, type ZonesVerdict } from "../lib/stock-price-zones";

const router: IRouter = Router();

/**
 * A linha de veredito da lista: onde a cotação cai em relação às duas faixas de entrada.
 *
 * É a MESMA conta que a régua do detalhe mostra desenhada — a lista traz a conclusão, o
 * detalhe traz a conta. Por isso passa por `computeStockPriceZones` e
 * `summarizeStockPriceZones` em vez de guardar um veredito na tabela: a faixa é fixa
 * entre varreduras, mas o preço não é, e um veredito gravado no domingo estaria afirmando
 * na quinta uma coisa que o preço de quinta desmente.
 *
 * Só sai para ação: FII tem régua própria (`computeFiiPriceZones`), e P/L e P/VP de fundo
 * não significam o que significam numa empresa. Renda fixa e fundos não têm faixa nenhuma.
 * Em todos esses casos o campo vai `null` e a linha simplesmente não aparece.
 */
async function priceZoneVerdictsFor(
  items: { ticker: string; category: string; sector: string | null }[],
  prices: Map<string, { price: number }>,
): Promise<Map<string, ZonesVerdict>> {
  const cotados = items.filter((i) => i.category !== "fiis" && prices.get(i.ticker.toUpperCase())?.price != null);
  if (cotados.length === 0) return new Map();

  // Um `getSectorBenchmark` por setor DISTINTO, não por ativo: dez oportunidades caem
  // tipicamente em três ou quatro setores.
  const setores = Array.from(new Set(cotados.map((i) => i.sector).filter((s): s is string => s != null)));
  const benchmarks = new Map(
    await Promise.all(setores.map(async (s) => [s, await getSectorBenchmark(s)] as const)),
  );

  const fundamentalsByTicker = await getFundamentals(cotados.map((i) => i.ticker));

  const pares = await Promise.all(
    cotados.map(async (item) => {
      const fundamentals = fundamentalsByTicker.get(item.ticker.toUpperCase());
      const price = prices.get(item.ticker.toUpperCase())?.price;
      if (!fundamentals || price == null) return null;

      const zones = computeStockPriceZones({
        price,
        priceEarnings: fundamentals.priceEarnings,
        priceToBook: fundamentals.priceToBook,
        normalized: await normalizedEarningsFor(item.ticker),
        sector: sectorReferenceFrom(item.sector ? benchmarks.get(item.sector) ?? null : null),
      });
      const verdict = summarizeStockPriceZones(zones, price);
      return verdict ? ([item.ticker, verdict] as const) : null;
    }),
  );

  return new Map(pares.filter((p): p is readonly [string, ZonesVerdict] => p != null));
}

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
  // Depende de `prices`, então não entra no Promise.all acima.
  const verdictByTicker = await priceZoneVerdictsFor(top10, prices);
  // A lista passa a vir envelopada: o consumidor precisa saber por qual critério ela
  // foi ordenada, senão a ordem muda sem explicação quando o objetivo do perfil muda.
  const items10 = top10.map((item) => {
    const value = valueByTicker.get(item.ticker) ?? null;
    const quoted = prices.get(item.ticker.toUpperCase());
    return {
    ...item,
    currentPrice: quoted?.price ?? null,
    // Mesma regra do Dashboard e da Carteira: quando o preço é o último conhecido em
    // vez da cotação de agora, a data vai junto. Faltava só aqui, e a exceção não se
    // sustentava — durante uma queda do provedor esta tela mostraria preço datado com
    // a mesma cara de preço ao vivo enquanto as outras duas avisavam.
    priceAsOf: quoted?.asOf?.toISOString() ?? null,
    dividendFrequency: classifyDividendFrequency(dividendEventsByTicker.get(item.ticker.toUpperCase()) ?? [], now)?.label ?? null,
    dividendPremiumPP: value?.premiumOverSectorPP ?? null,
    sectorMedianYield: value?.sectorMedianYield ?? null,
    sectorSampleSize: value?.sampleSize ?? null,
    implausibleYield: value?.implausible ?? false,
    priceZoneVerdict: verdictByTicker.get(item.ticker) ?? null,
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
