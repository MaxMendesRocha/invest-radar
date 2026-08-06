import { Router, type IRouter } from "express";
import { db, assetsTable, transactionsTable, investorProfilesTable, incomeGoalsTable } from "@workspace/db";
import { eq, sum, and, gte } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { getPricesFor, getFundamentals, sectorFor, QUOTED_CATEGORIES, getDividendEvents, sumLast12Months } from "../lib/market-data";
import { recordSnapshot, getSnapshotsForUser, findSnapshotForMonth } from "../lib/portfolio-history";
import { getCdiMonthlyReturns, syncAndGetIndexCloses } from "../lib/benchmark-data";
import { evalVolatility, evalDividendYield, evalRevenueGrowth } from "../lib/analysis-engine";
import { synthesizePortfolioDiagnosis } from "../lib/portfolio-ai";
import { getMacroSnapshot } from "../lib/macro-data";
import { computeIncomeGoalProgress } from "../lib/income-goal-engine";
import { UpsertIncomeGoalBody } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/portfolio/summary", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));
  const txRows = await db.select({ total: sum(transactionsTable.amount) }).from(transactionsTable).where(eq(transactionsTable.userId, req.session.userId!));
  // Janela de 12 meses para o YIELD. O total acima é o acumulado de sempre — número
  // legítimo como "quanto já recebi", mas dividi-lo pelo custo produzia um yield que
  // crescia indefinidamente com o tempo de carteira: com três anos de proventos o
  // card exibia o acumulado dos três anos rotulado como yield.
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
  const [tx12mRow] = await db
    .select({ total: sum(transactionsTable.amount) })
    .from(transactionsTable)
    .where(and(eq(transactionsTable.userId, req.session.userId!), gte(transactionsTable.date, twelveMonthsAgo.toISOString().slice(0, 10))));
  const prices = await getPricesFor(assets);

  let totalPatrimony = 0;
  let totalCost = 0;

  for (const a of assets) {
    const qty = parseFloat(a.quantity);
    const avgPrice = parseFloat(a.averagePrice);
    const price = prices.get(a.ticker.toUpperCase()) ?? avgPrice;
    totalPatrimony += qty * price;
    totalCost += qty * avgPrice;
  }

  const totalProfitLoss = totalPatrimony - totalCost;
  const totalProfitLossPercent = totalCost > 0 ? (totalProfitLoss / totalCost) * 100 : 0;
  const totalDividends = parseFloat(String(txRows[0]?.total ?? "0")) || 0;
  const dividendsLast12m = parseFloat(String(tx12mRow?.total ?? "0")) || 0;
  // Sobre o VALOR DE MERCADO, não sobre o custo — é a definição usual de dividend
  // yield, e é a mesma base usada para dimensionar a meta de renda passiva
  // (income-goal-engine.ts). Antes eram duas definições diferentes convivendo.
  const portfolioYield = totalPatrimony > 0 ? (dividendsLast12m / totalPatrimony) * 100 : 0;
  // Yield on cost: quanto a carteira rende sobre o que foi efetivamente pago por ela.
  // Métrica distinta e útil para quem investe em dividendos — sobe conforme o preço
  // médio fica para trás — mas não substitui a de cima.
  const yieldOnCost = totalCost > 0 ? (dividendsLast12m / totalCost) * 100 : 0;

  // Upserts today's row in portfolio_snapshots — this is the only place real history
  // gets recorded, from ordinary use of the app, no scheduled job involved.
  await recordSnapshot(req.session.userId!, totalPatrimony, totalCost);

  res.json({
    totalPatrimony,
    totalProfitLoss,
    totalProfitLossPercent,
    totalDividends,
    dividendsLast12m,
    portfolioYield,
    yieldOnCost,
    assetCount: assets.length,
  });
});

router.get("/portfolio/distribution", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));
  const prices = await getPricesFor(assets);
  const fundamentalsByTicker = await getFundamentals(
    assets.filter((a) => QUOTED_CATEGORIES.has(a.category)).map((a) => a.ticker)
  );

  const byCategoryMap: Record<string, number> = {};
  const bySectorMap: Record<string, number> = {};
  const byRiskMap: Record<string, number> = { Baixo: 0, Médio: 0, Alto: 0 };

  let total = 0;

  for (const a of assets) {
    const qty = parseFloat(a.quantity);
    const price = prices.get(a.ticker.toUpperCase()) ?? parseFloat(a.averagePrice);
    const value = qty * price;
    total += value;

    byCategoryMap[a.category] = (byCategoryMap[a.category] ?? 0) + value;
    const sector = sectorFor(a, fundamentalsByTicker.get(a.ticker.toUpperCase())?.sector);
    bySectorMap[sector] = (bySectorMap[sector] ?? 0) + value;

    const risk = a.category === "acoes" ? "Alto" : a.category === "renda_fixa" ? "Baixo" : "Médio";
    byRiskMap[risk] = (byRiskMap[risk] ?? 0) + value;
  }

  const toItems = (map: Record<string, number>) =>
    Object.entries(map).map(([label, value]) => ({
      label,
      value: Math.round(value * 100) / 100,
      percent: total > 0 ? Math.round((value / total) * 10000) / 100 : 0,
    })).sort((a, b) => b.value - a.value);

  res.json({
    byCategory: toItems(byCategoryMap),
    bySector: toItems(bySectorMap),
    byRisk: toItems(byRiskMap),
  });
});

router.get("/portfolio/evolution", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));
  const prices = await getPricesFor(assets);

  let currentValue = 0;
  for (const a of assets) {
    const qty = parseFloat(a.quantity);
    const price = prices.get(a.ticker.toUpperCase()) ?? parseFloat(a.averagePrice);
    currentValue += qty * price;
  }

  // Months with a real snapshot (portfolio_snapshots) use it; months without one still
  // fall back to a simulated approximation around the current value. The real portion
  // grows on its own as portfolio_snapshots accumulates one row per day of app usage.
  const snapshots = await getSnapshotsForUser(req.session.userId!);

  const points = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const label = d.toLocaleDateString("pt-BR", { month: "short", year: "2-digit" });
    const snapshot = findSnapshotForMonth(snapshots, d.getFullYear(), d.getMonth());

    let value: number;
    if (snapshot) {
      value = parseFloat(snapshot.totalValue);
    } else {
      const factor = 1 - i * 0.015 + Math.random() * 0.02 - 0.01;
      value = Math.round(currentValue * factor * 100) / 100;
    }
    points.push({ date: label, value, cdi: null, ibov: null });
  }

  res.json(points);
});

/**
 * Dispersão real de um conjunto de valores, 0-100. 100 = perfeitamente distribuído,
 * 0 = tudo em um só.
 *
 * Usa o índice de Herfindahl-Hirschman (soma dos quadrados das participações), que é
 * a medida padrão de concentração e leva em conta a distribuição inteira, não só a
 * maior posição. O score é (1 - HHI) × 100.
 *
 * Substitui `100 - (100/nº de ativos) × 2`, que dependia SÓ da contagem: com três
 * ativos o resultado era 33 tanto para 33/33/33 quanto para 98,7/0,7/0,6 —
 * reproduzido antes da correção. O dado de participação já existia e era usado nos
 * alertas de concentração e no perfil revelado; só não chegava aqui.
 *
 * Referência de leitura: 2 posições iguais → 50; 3 iguais → 67; 10 iguais → 90.
 */
function spreadScore(values: number[]): number {
  const total = values.reduce((sum, v) => sum + v, 0);
  if (values.length === 0 || total <= 0) return 0;
  const hhi = values.reduce((sum, v) => sum + (v / total) ** 2, 0);
  return Math.round(Math.max(0, Math.min(100, (1 - hhi) * 100)));
}

router.get("/portfolio/health", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));

  const prices = await getPricesFor(assets);
  const fundamentalsByTicker = await getFundamentals(
    assets.filter((a) => QUOTED_CATEGORIES.has(a.category)).map((a) => a.ticker)
  );

  // Valor de cada posição — a base das duas dimensões abaixo. Antes ambas contavam
  // ITENS (nº de ativos, nº de categorias) e ignoravam completamente quanto havia em
  // cada um: uma carteira 33/33/33 recebia exatamente a mesma nota que uma 98/1/1.
  const valueByTicker = new Map<string, number>();
  const valueBySector = new Map<string, number>();
  for (const a of assets) {
    const qty = parseFloat(a.quantity);
    const price = prices.get(a.ticker.toUpperCase()) ?? parseFloat(a.averagePrice);
    const value = qty * price;
    const ticker = a.ticker.toUpperCase();
    valueByTicker.set(ticker, (valueByTicker.get(ticker) ?? 0) + value);
    const sector = sectorFor(a, fundamentalsByTicker.get(ticker)?.sector);
    valueBySector.set(sector, (valueBySector.get(sector) ?? 0) + value);
  }

  // With no assets, every dimension is honestly 0 — the risk/dividends/growth fallbacks
  // below are heuristics for an existing portfolio's composition, not a default score
  // for having no portfolio at all (that was a bug: an empty carteira showed Score 34).
  //
  // As duas usam o mesmo método (dispersão real do valor, via spreadScore) sobre
  // eixos diferentes: concentração olha ativo a ativo, diversificação olha setor a
  // setor. Assim deixam de ser duas contagens quase redundantes — juntas pesam 50%
  // do score de saúde — e passam a responder perguntas distintas.
  const concentration = spreadScore(Array.from(valueByTicker.values()));
  const diversification = spreadScore(Array.from(valueBySector.values()));

  // Risco/dividendos/crescimento são médias ponderadas pelo valor de cada posição,
  // usando os mesmos buckets de evalVolatility/evalDividendYield/evalRevenueGrowth do
  // motor de análise — só ativos com dado real contribuem peso; um ativo sem
  // fundamentos disponível simplesmente não pesa nessa dimensão, nunca herda um valor
  // chutado. Renda fixa não tem beta, mas segue o mesmo mapeamento de baixo risco já
  // usado em /portfolio/distribution.
  let totalValue = 0;
  let riskWeighted = 0, riskWeight = 0;
  let dividendsWeighted = 0, dividendsWeight = 0;
  let growthWeighted = 0, growthWeight = 0;
  const composition: { ticker: string; category: string; percent: number }[] = [];

  for (const a of assets) {
    const qty = parseFloat(a.quantity);
    const price = prices.get(a.ticker.toUpperCase()) ?? parseFloat(a.averagePrice);
    const value = qty * price;
    totalValue += value;
    composition.push({ ticker: a.ticker, category: a.category, percent: 0 }); // percent preenchido depois de somar totalValue

    const fundamentals = fundamentalsByTicker.get(a.ticker.toUpperCase());

    if (a.category === "renda_fixa") {
      riskWeighted += 85 * value; // mesmo score de baixa-volatilidade usado pra beta baixo
      riskWeight += value;
    } else {
      const volatility = fundamentals ? evalVolatility(fundamentals.beta) : null;
      if (volatility) { riskWeighted += volatility.score * value; riskWeight += value; }
    }

    const dividendYield = fundamentals ? evalDividendYield(fundamentals.dividendYield) : null;
    if (dividendYield) { dividendsWeighted += dividendYield.score * value; dividendsWeight += value; }

    const revenueGrowth = fundamentals ? evalRevenueGrowth(fundamentals.revenueGrowth) : null;
    if (revenueGrowth) { growthWeighted += revenueGrowth.score * value; growthWeight += value; }
  }

  for (const c of composition) {
    const a = assets.find((x) => x.ticker === c.ticker)!;
    const qty = parseFloat(a.quantity);
    const price = prices.get(a.ticker.toUpperCase()) ?? parseFloat(a.averagePrice);
    c.percent = totalValue > 0 ? ((qty * price) / totalValue) * 100 : 0;
  }

  // Sem nenhum dado real disponível pra pesar a dimensão, cai num neutro documentado
  // (mesmos valores do fallback anterior) em vez de inventar — só acontece se o
  // provider falhar pra todos os ativos cotados da carteira.
  const risk = riskWeight > 0 ? Math.round(riskWeighted / riskWeight) : assets.length > 0 ? 60 : 0;
  const dividends = dividendsWeight > 0 ? Math.round(dividendsWeighted / dividendsWeight) : assets.length > 0 ? 50 : 0;
  const growth = growthWeight > 0 ? Math.round(growthWeighted / growthWeight) : assets.length > 0 ? 55 : 0;

  const score = Math.round((diversification * 0.25 + concentration * 0.25 + risk * 0.2 + dividends * 0.15 + growth * 0.15));

  let classification: string;
  if (score >= 80) classification = "Excelente";
  else if (score >= 65) classification = "Boa";
  else if (score >= 45) classification = "Regular";
  else classification = "Ruim";

  const aiDiagnosis =
    assets.length > 0
      ? await synthesizePortfolioDiagnosis({
          score,
          classification,
          diversification,
          concentration,
          risk,
          dividends,
          growth,
          composition,
          macro: await getMacroSnapshot(),
          investorProfile: await db.select().from(investorProfilesTable).where(eq(investorProfilesTable.userId, req.session.userId!))
            .then(([p]) => p?.classification ?? null),
        })
      : null;

  res.json({ score, classification, diversification, risk, dividends, growth, concentration, aiDiagnosis });
});

// Cruza os eventos de provento já buscados (getDividendEvents, mesma fonte usada em
// POST /analysis/generate pro total dos últimos 12 meses) com a quantidade atual de
// cada ativo, filtrando só paymentDate futuro. "confirmed" reflete approvedOn: quando
// a brapi já tem a aprovação em ata registrada é um valor formalizado; quando vem null
// é só um cronograma projetado (ou, no caso de FIIs, um campo que a brapi não rastreia
// nesse endpoint — nunca tratado como confirmado nesse caso, por segurança).
router.get("/portfolio/dividends/upcoming", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));
  const dividendEventsByTicker = await getDividendEvents(assets.map((a) => ({ ticker: a.ticker, category: a.category })));

  const now = Date.now();
  const upcoming: { ticker: string; paymentDate: string; label: string; rate: number; expectedAmount: number; confirmed: boolean }[] = [];

  for (const a of assets) {
    const qty = parseFloat(a.quantity);
    const events = dividendEventsByTicker.get(a.ticker.toUpperCase()) ?? [];
    for (const event of events) {
      if (new Date(event.paymentDate).getTime() <= now) continue;
      upcoming.push({
        ticker: a.ticker,
        paymentDate: event.paymentDate,
        label: event.label,
        rate: event.rate,
        expectedAmount: Math.round(event.rate * qty * 100) / 100,
        confirmed: event.approvedOn !== null,
      });
    }
  }

  upcoming.sort((a, b) => new Date(a.paymentDate).getTime() - new Date(b.paymentDate).getTime());
  res.json(upcoming);
});

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// Renda passiva projetada a partir de DPS real dos últimos 12 meses (sumLast12Months,
// não o dividendYield agregado do provider) × quantidade atual de cada ativo — mais
// preciso porque usa o histórico real de pagamentos, não uma métrica só do preço/DY do
// momento. sumLast12Months (não computeDividendTrend) porque só a janela de 12 meses
// importa aqui — exigir os 24 meses de computeDividendTrend descartaria dado real de
// ativos cujo provider só cobre os últimos ~12 meses (comum em FIIs). Ativo sem
// histórico suficiente entra com dps12m null e não soma na projeção, nunca via atalho.
// byMonth reflete quando os proventos REALMENTE caíram nos últimos 12 meses — mostra
// se a carteira está concentrada em poucos meses do ano ou bem distribuída, insumo
// direto pra quem está montando a carteira pensando em fluxo de caixa mensal.
router.get("/portfolio/dividends/projection", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));
  const prices = await getPricesFor(assets);
  const dividendEventsByTicker = await getDividendEvents(assets.map((a) => ({ ticker: a.ticker, category: a.category })));
  const now = Date.now();

  const byAsset: {
    ticker: string; category: string; quantity: number;
    dps12m: number | null; projectedAnnualIncome: number | null;
    dyOnPrice: number | null; dyOnCost: number | null;
  }[] = [];
  const byMonthMap = new Map<string, number>();
  let projectedAnnualIncome = 0;

  for (const a of assets) {
    if (!QUOTED_CATEGORIES.has(a.category)) continue; // renda fixa/fundos não têm provento de bolsa

    const qty = parseFloat(a.quantity);
    const averagePrice = parseFloat(a.averagePrice);
    const currentPrice = prices.get(a.ticker.toUpperCase()) ?? null;
    const events = dividendEventsByTicker.get(a.ticker.toUpperCase()) ?? [];
    const dps12m = sumLast12Months(events, now);
    const assetAnnualIncome = dps12m != null ? dps12m * qty : null;
    if (assetAnnualIncome != null) projectedAnnualIncome += assetAnnualIncome;

    byAsset.push({
      ticker: a.ticker,
      category: a.category,
      quantity: qty,
      dps12m,
      projectedAnnualIncome: assetAnnualIncome != null ? Math.round(assetAnnualIncome * 100) / 100 : null,
      dyOnPrice: dps12m != null && currentPrice ? Math.round((dps12m / currentPrice) * 10000) / 100 : null,
      dyOnCost: dps12m != null && averagePrice > 0 ? Math.round((dps12m / averagePrice) * 10000) / 100 : null,
    });

    for (const event of events) {
      const paidAt = new Date(event.paymentDate).getTime();
      if (paidAt > now || now - paidAt > ONE_YEAR_MS) continue;
      const d = new Date(event.paymentDate);
      const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      byMonthMap.set(monthKey, (byMonthMap.get(monthKey) ?? 0) + event.rate * qty);
    }
  }

  byAsset.sort((a, b) => (b.projectedAnnualIncome ?? 0) - (a.projectedAnnualIncome ?? 0));
  const byMonth = Array.from(byMonthMap.entries())
    .map(([month, amount]) => ({ month, amount: Math.round(amount * 100) / 100 }))
    .sort((a, b) => a.month.localeCompare(b.month));

  res.json({
    projectedAnnualIncome: Math.round(projectedAnnualIncome * 100) / 100,
    projectedMonthlyAverage: Math.round((projectedAnnualIncome / 12) * 100) / 100,
    byAsset,
    byMonth,
  });
});

router.get("/portfolio/benchmarks", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));
  const prices = await getPricesFor(assets);

  let totalCost = 0;
  let totalValue = 0;
  for (const a of assets) {
    const qty = parseFloat(a.quantity);
    const avgPrice = parseFloat(a.averagePrice);
    const price = prices.get(a.ticker.toUpperCase()) ?? avgPrice;
    totalCost += qty * avgPrice;
    totalValue += qty * price;
  }
  // Fallback for months without a real snapshot: current return held flat, since we
  // have no other honest estimate for the past. A portfolio with 0 assets correctly
  // shows 0%, not a fabricated gain.
  const portfolioReturn = totalCost > 0 ? Math.round(((totalValue - totalCost) / totalCost) * 10000) / 100 : 0;
  const snapshots = await getSnapshotsForUser(req.session.userId!);

  // CDI is real for the full window (BCB publishes years of monthly history for free).
  // IBOV/IFIX are real wherever we have two consecutive months of closes on file —
  // IBOV starts with ~3 real months backfilled from brapi.dev's free tier; IFIX has no
  // historical data available for free, so it only accumulates one day at a time from
  // here on. Months without real data on either side still fall back to the old
  // simulated approximation, same "real crowds out simulated, never fabricated" rule
  // used for the portfolio's own snapshot history.
  const [cdiReturns, ibovCloses, ifixCloses] = await Promise.all([
    getCdiMonthlyReturns(),
    syncAndGetIndexCloses("^BVSP", "ibov"),
    syncAndGetIndexCloses("IFIX", "ifix"),
  ]);

  const points = [];
  const now = new Date();

  let cdiAcc = 100, ibovAcc = 100, ifixAcc = 100;

  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const prevD = new Date(now.getFullYear(), now.getMonth() - i - 1, 1);
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const prevMonthKey = `${prevD.getFullYear()}-${String(prevD.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("pt-BR", { month: "short", year: "2-digit" });
    const snapshot = findSnapshotForMonth(snapshots, d.getFullYear(), d.getMonth());

    let portfolioForMonth = portfolioReturn;
    if (snapshot) {
      const snapCost = parseFloat(snapshot.totalCost);
      const snapValue = parseFloat(snapshot.totalValue);
      portfolioForMonth = snapCost > 0 ? Math.round(((snapValue - snapCost) / snapCost) * 10000) / 100 : 0;
    }

    const cdiMonthReturn = cdiReturns.get(monthKey);
    cdiAcc *= cdiMonthReturn != null ? 1 + cdiMonthReturn / 100 : 1.0087;

    const ibovThis = ibovCloses.get(monthKey);
    const ibovPrev = ibovCloses.get(prevMonthKey);
    ibovAcc *= ibovThis != null && ibovPrev != null ? ibovThis / ibovPrev : 1 + (0.008 + Math.random() * 0.03 - 0.015);

    const ifixThis = ifixCloses.get(monthKey);
    const ifixPrev = ifixCloses.get(prevMonthKey);
    ifixAcc *= ifixThis != null && ifixPrev != null ? ifixThis / ifixPrev : 1 + (0.007 + Math.random() * 0.015 - 0.007);

    points.push({
      label,
      portfolio: portfolioForMonth,
      cdi: Math.round((cdiAcc - 100) * 100) / 100,
      ibov: Math.round((ibovAcc - 100) * 100) / 100,
      ifix: Math.round((ifixAcc - 100) * 100) / 100,
    });
  }

  res.json({
    points,
    portfolioTotal: portfolioReturn,
    cdiTotal: Math.round((cdiAcc - 100) * 100) / 100,
    ibovTotal: Math.round((ibovAcc - 100) * 100) / 100,
    ifixTotal: Math.round((ifixAcc - 100) * 100) / 100,
  });
});

/**
 * Renda projetada e patrimônio atuais — a mesma base de
 * /portfolio/dividends/projection, extraída para servir também à meta.
 */
async function currentIncomeAndPatrimony(userId: number): Promise<{ monthlyIncome: number; totalPatrimony: number; portfolioYield: number | null }> {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, userId));
  const prices = await getPricesFor(assets);
  const dividendEventsByTicker = await getDividendEvents(assets.map((a) => ({ ticker: a.ticker, category: a.category })));
  const now = Date.now();

  let annualIncome = 0;
  let totalPatrimony = 0;
  for (const a of assets) {
    const qty = parseFloat(a.quantity);
    const price = prices.get(a.ticker.toUpperCase()) ?? parseFloat(a.averagePrice);
    totalPatrimony += qty * price;
    if (!QUOTED_CATEGORIES.has(a.category)) continue;
    const dps12m = sumLast12Months(dividendEventsByTicker.get(a.ticker.toUpperCase()) ?? [], now);
    if (dps12m != null) annualIncome += dps12m * qty;
  }

  return {
    monthlyIncome: annualIncome / 12,
    totalPatrimony,
    portfolioYield: totalPatrimony > 0 && annualIncome > 0 ? annualIncome / totalPatrimony : null,
  };
}

router.get("/portfolio/income-goal", requireAuth, async (req, res): Promise<void> => {
  const [goal] = await db.select().from(incomeGoalsTable).where(eq(incomeGoalsTable.userId, req.session.userId!));
  if (!goal) {
    res.status(404).json({ error: "Meta de renda passiva ainda não definida" });
    return;
  }
  const { monthlyIncome, totalPatrimony, portfolioYield } = await currentIncomeAndPatrimony(req.session.userId!);
  res.json({
    targetYear: goal.targetYear,
    ...computeIncomeGoalProgress({
      targetMonthlyIncome: parseFloat(goal.targetMonthlyIncome),
      targetYear: goal.targetYear,
      currentMonthlyIncome: monthlyIncome,
      totalPatrimony,
      portfolioYield,
      now: new Date(),
    }),
  });
});

router.put("/portfolio/income-goal", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpsertIncomeGoalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const values = {
    userId: req.session.userId!,
    targetMonthlyIncome: String(parsed.data.targetMonthlyIncome),
    targetYear: parsed.data.targetYear,
  };
  const [goal] = await db
    .insert(incomeGoalsTable)
    .values(values)
    .onConflictDoUpdate({ target: incomeGoalsTable.userId, set: values })
    .returning();

  const { monthlyIncome, totalPatrimony, portfolioYield } = await currentIncomeAndPatrimony(req.session.userId!);
  res.json({
    targetYear: goal.targetYear,
    ...computeIncomeGoalProgress({
      targetMonthlyIncome: parseFloat(goal.targetMonthlyIncome),
      targetYear: goal.targetYear,
      currentMonthlyIncome: monthlyIncome,
      totalPatrimony,
      portfolioYield,
      now: new Date(),
    }),
  });
});

export default router;
