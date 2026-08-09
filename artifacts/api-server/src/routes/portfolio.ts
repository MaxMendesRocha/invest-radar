import { Router, type IRouter } from "express";
import { db, assetsTable, transactionsTable, investorProfilesTable, incomeGoalsTable, allocationPoliciesTable } from "@workspace/db";
import { eq, sum, and, gte } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { getPricesFor, getFundamentals, sectorFor, QUOTED_CATEGORIES, getDividendEvents, sumLast12Months } from "../lib/market-data";
import { recordSnapshot, getSnapshotsForUser, findSnapshotForMonth } from "../lib/portfolio-history";
import { getCdiMonthlyReturns, syncAndGetIndexCloses } from "../lib/benchmark-data";
import { evalVolatility, evalDividendYield, evalRevenueGrowth } from "../lib/analysis-engine";
import { synthesizePortfolioDiagnosis } from "../lib/portfolio-ai";
import { getMacroSnapshot } from "../lib/macro-data";
import { computeIncomeGoalProgress } from "../lib/income-goal-engine";
import { UpsertIncomeGoalBody, UpsertAllocationBody, GetAllocationPlanQueryParams, GetTreasuryPriceOnDateQueryParams } from "@workspace/api-zod";
import {
  ALLOCATION_CATEGORIES,
  defaultPolicyFor,
  computeAllocation,
  planContribution,
  type AllocationCategory,
  type PolicySource,
  type PolicyTargets,
} from "../lib/allocation-engine";
import { rankOpportunitiesFor } from "../lib/opportunity-ranking";
import { suggestTreasuryBonds } from "../lib/treasury-engine";
import { listTreasuryBondOptions, latestTreasuryBonds, priceOnDate } from "../lib/treasury-identity";
import type { ProfileClassification } from "../lib/investor-profile-engine";
import { isoDate } from "../lib/local-date";

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
  // Ativos cotados sem preço NENHUM disponível — nem ao vivo, nem último conhecido
  // dentro da janela. A posição continua entrando no patrimônio pelo preço médio de
  // compra — excluí-la subestimaria mais do que aproximá-la — mas o fato é exposto:
  // sem isso, uma falha do provider fazia o ativo aparecer com 0,00% de lucro/prejuízo,
  // número calculado apresentado como se fosse medido.
  const pricesUnavailable: string[] = [];
  // Ativos avaliados pelo último preço conhecido em vez da cotação de agora. Continua
  // sendo preço real de mercado, só defasado — bem mais próximo da verdade do que o
  // preço médio de compra —, e a data vai junto para a tela poder dizer de quando é.
  const pricesStale: { ticker: string; asOf: string }[] = [];

  for (const a of assets) {
    const qty = parseFloat(a.quantity);
    const avgPrice = parseFloat(a.averagePrice);
    const quoted = prices.get(a.ticker.toUpperCase());
    if (quoted == null) {
      if (QUOTED_CATEGORIES.has(a.category)) pricesUnavailable.push(a.ticker.toUpperCase());
    } else if (quoted.asOf != null && QUOTED_CATEGORIES.has(a.category)) {
      // Só categoria de bolsa entra aqui. Título público também vem com preço datado,
      // mas por natureza — o Tesouro publica o PU com um ou dois dias úteis de atraso,
      // e isso é o normal, não falha de provedor. Incluí-lo faria o Dashboard alertar
      // "cotação indisponível" todos os dias para uma carteira perfeitamente saudável,
      // e um aviso que aparece sempre deixa de ser lido. A data do PU continua visível
      // onde é relevante: na linha do ativo, em Minha Carteira.
      pricesStale.push({ ticker: a.ticker.toUpperCase(), asOf: quoted.asOf.toISOString() });
    }
    const price = quoted?.price ?? avgPrice;
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
    pricesUnavailable,
    pricesStale,
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
    const price = prices.get(a.ticker.toUpperCase())?.price ?? parseFloat(a.averagePrice);
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
    const price = prices.get(a.ticker.toUpperCase())?.price ?? parseFloat(a.averagePrice);
    currentValue += qty * price;
  }

  // SÓ mês com snapshot real vira ponto. Antes, mês sem snapshot recebia
  // `currentValue * (1 - i*0.015 + Math.random()*0.02 - 0.01)` — ou seja, o gráfico
  // desenhava uma curva de 12 meses inventada para quem tinha um dia de uso, e o
  // "passado" mudava a cada F5 porque o Math.random era reavaliado a cada requisição.
  // Uma linha curta e verdadeira vale mais que uma longa e fabricada; quantos meses
  // existem de verdade é informação, e a tela mostra isso em vez de disfarçar.
  const snapshots = await getSnapshotsForUser(req.session.userId!);

  const points: { date: string; value: number }[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const snapshot = findSnapshotForMonth(snapshots, d.getFullYear(), d.getMonth());
    if (!snapshot) continue;
    points.push({
      date: d.toLocaleDateString("pt-BR", { month: "short", year: "2-digit" }),
      value: parseFloat(snapshot.totalValue),
    });
  }

  // O mês corrente é conhecido mesmo sem snapshot gravado: são as posições de hoje
  // pelas cotações de hoje. Entra como último ponto — é medição, não estimativa.
  const currentLabel = now.toLocaleDateString("pt-BR", { month: "short", year: "2-digit" });
  const last = points[points.length - 1];
  if (last?.date === currentLabel) {
    last.value = Math.round(currentValue * 100) / 100;
  } else if (assets.length > 0) {
    points.push({ date: currentLabel, value: Math.round(currentValue * 100) / 100 });
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
    const price = prices.get(a.ticker.toUpperCase())?.price ?? parseFloat(a.averagePrice);
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
    const price = prices.get(a.ticker.toUpperCase())?.price ?? parseFloat(a.averagePrice);
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
    const price = prices.get(a.ticker.toUpperCase())?.price ?? parseFloat(a.averagePrice);
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

const PENDING_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Quantos dias antes do pagamento a compra precisa ter ocorrido para o direito ao
 * provento ser inequívoco.
 *
 * O provider NÃO entrega data-com (ex-date) — o DividendEvent tem paymentDate, rate,
 * label e approvedOn, e só. Sem ela não há como afirmar que a posição existia na data
 * que dá direito. O que dá para usar é a data de compra do ativo, que é uma checagem
 * mais grosseira: comprou depois do pagamento, certamente não recebeu; comprou muito
 * antes, certamente recebeu; no meio, é ambíguo.
 *
 * 45 dias cobre com folga a distância usual entre data-com e pagamento nos dois
 * regimes: ação costuma pagar semanas depois da aprovação em ata, e FII tem data-com
 * no último pregão do mês com pagamento por volta da metade do mês seguinte.
 */
const EX_DATE_UNCERTAINTY_MS = 45 * 24 * 60 * 60 * 1000;

/**
 * Proventos que JÁ FORAM PAGOS e ainda não têm lançamento correspondente.
 *
 * Existe porque nada no app registra provento automaticamente — o único insert em
 * `transactions` é o POST manual. Na prática isso fazia "Dividendos Acumulados" e o
 * histórico de recebimentos ficarem parados em zero para quem não digita cada
 * pagamento à mão, enquanto a projeção (que vem do histórico real do provider) andava
 * sozinha. Aqui o app mostra o que ele já sabe que foi pago e oferece o lançamento
 * pronto; quem confirma é o usuário, porque é registro financeiro dele e entra no
 * cálculo de IR.
 */
router.get("/portfolio/dividends/pending", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));
  const [dividendEventsByTicker, existingTransactions] = await Promise.all([
    getDividendEvents(assets.map((a) => ({ ticker: a.ticker, category: a.category }))),
    db.select().from(transactionsTable).where(eq(transactionsTable.userId, req.session.userId!)),
  ]);

  // Correspondência por ticker + data, CONTANDO em vez de marcar presença. Dois
  // motivos, os dois encontrados testando:
  //
  //  1. A data precisa ser comparada como "YYYY-MM-DD" nos dois lados. O evento vem do
  //     provider como instante ISO completo ("2026-03-20T03:00:00.000Z") e a coluna
  //     guarda só a data — comparar as strings cruas nunca casava, então nada saía da
  //     lista de pendentes depois de registrado.
  //  2. Um mesmo ticker pode pagar mais de uma vez no mesmo dia (PETR4 pagou DIVIDENDO
  //     e JCP em 20/03). Com um Set, registrar um dos dois esconderia o outro. O
  //     contador consome um evento por lançamento existente e mantém o excedente.
  //
  // O valor continua fora da chave de propósito: um lançamento corrigido à mão
  // (quantidade diferente na data, imposto retido) não deve fazer o provento
  // reaparecer como pendente para sempre.
  const registeredCount = new Map<string, number>();
  for (const t of existingTransactions) {
    const key = `${t.ticker.toUpperCase()}|${isoDate(t.date)}`;
    registeredCount.set(key, (registeredCount.get(key) ?? 0) + 1);
  }

  const now = Date.now();
  const pending: {
    ticker: string;
    paymentDate: string;
    label: string;
    rate: number;
    quantity: number;
    suggestedAmount: number;
    certainty: "confirmado" | "incerto";
    // Separa os dois tipos porque eles pedem apresentações diferentes: "sem data de
    // compra" é uma propriedade do ATIVO e se repetiria idêntica em todas as linhas
    // dele (na conta de teste, a mesma frase 20 vezes); "compra próxima" é do EVENTO e
    // muda de linha para linha.
    uncertaintyKind: "sem_data_compra" | "compra_proxima" | null;
    uncertaintyReason: string | null;
  }[] = [];

  for (const a of assets) {
    if (!QUOTED_CATEGORIES.has(a.category)) continue;
    const ticker = a.ticker.toUpperCase();
    const qty = parseFloat(a.quantity);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const purchasedAt = a.purchaseDate ? new Date(a.purchaseDate).getTime() : null;

    for (const event of dividendEventsByTicker.get(ticker) ?? []) {
      const paidAt = new Date(event.paymentDate).getTime();
      if (paidAt > now) continue; // ainda não pago — isso é /upcoming
      if (now - paidAt > PENDING_WINDOW_MS) continue;
      const key = `${ticker}|${isoDate(event.paymentDate)}`;
      const alreadyRegistered = registeredCount.get(key) ?? 0;
      if (alreadyRegistered > 0) {
        registeredCount.set(key, alreadyRegistered - 1);
        continue;
      }
      // Comprou depois do pagamento: não havia posição, não há o que registrar. Este é
      // o único caso descartado — nos demais o usuário decide, porque esconder um
      // provento legítimo custa mais que mostrar um duvidoso sinalizado.
      if (purchasedAt != null && purchasedAt > paidAt) continue;

      let certainty: "confirmado" | "incerto" = "confirmado";
      let uncertaintyKind: "sem_data_compra" | "compra_proxima" | null = null;
      let uncertaintyReason: string | null = null;
      if (purchasedAt == null) {
        certainty = "incerto";
        uncertaintyKind = "sem_data_compra";
        uncertaintyReason = null; // agregado por ticker na tela, não repetido por linha
      } else if (paidAt - purchasedAt < EX_DATE_UNCERTAINTY_MS) {
        const days = Math.max(0, Math.round((paidAt - purchasedAt) / (24 * 60 * 60 * 1000)));
        certainty = "incerto";
        uncertaintyKind = "compra_proxima";
        uncertaintyReason = `Comprado ${days} ${days === 1 ? "dia" : "dias"} antes do pagamento — confira se tinha direito na data-com.`;
      }

      pending.push({
        ticker: a.ticker,
        paymentDate: event.paymentDate,
        label: event.label,
        rate: event.rate,
        quantity: qty,
        suggestedAmount: Math.round(event.rate * qty * 100) / 100,
        certainty,
        uncertaintyKind,
        uncertaintyReason,
      });
    }
  }

  // Mais recentes primeiro: é o que o usuário provavelmente acabou de receber.
  pending.sort((a, b) => new Date(b.paymentDate).getTime() - new Date(a.paymentDate).getTime());
  res.json(pending);
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
    const currentPrice = prices.get(a.ticker.toUpperCase())?.price ?? null;
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
    const price = prices.get(a.ticker.toUpperCase())?.price ?? avgPrice;
    totalCost += qty * avgPrice;
    totalValue += qty * price;
  }
  const portfolioReturn = totalCost > 0 ? Math.round(((totalValue - totalCost) / totalCost) * 10000) / 100 : 0;
  const snapshots = await getSnapshotsForUser(req.session.userId!);

  // Nada aqui é preenchido quando falta dado. Antes, mês sem fechamento de índice
  // recebia `1 + Math.random()*0.03` para o IBOV e `1 + Math.random()*0.015` para o
  // IFIX (esse último sempre positivo — o índice falso só sabia subir), e mês sem CDI
  // recebia 1,0087 fixo. Duas chamadas seguidas devolviam históricos diferentes: o
  // IBOV acumulado saltava de +4,56% para +7,71% num F5.
  //
  // A regra agora é a janela COMUM. Retorno acumulado só é comparável entre séries
  // medidas no mesmo intervalo — plotar "carteira em 12 meses" contra "IBOV em 3
  // meses" no mesmo eixo compara coisas diferentes mesmo com todo dado real. Então a
  // janela é o trecho contíguo, terminando no mês corrente, em que TODAS as séries
  // exibidas têm dado real, e todas são rebaseadas a 0% no início dela.
  const [cdiReturns, ibovCloses, ifixCloses] = await Promise.all([
    getCdiMonthlyReturns(),
    syncAndGetIndexCloses("^BVSP", "ibov"),
    syncAndGetIndexCloses("IFIX", "ifix"),
  ]);

  const now = new Date();
  const monthKeyOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const factorBetween = (closes: Map<string, number>, key: string, prevKey: string): number | null => {
    const a = closes.get(key);
    const b = closes.get(prevKey);
    return a != null && b != null ? a / b : null;
  };

  interface MonthSlot {
    label: string;
    cdiReturn: number | null; // % do mês
    ibovFactor: number | null; // fechamento do mês ÷ fechamento do mês anterior
    ifixFactor: number | null;
    portfolioReturn: number | null; // retorno sobre custo no fim do mês
  }

  const slots: MonthSlot[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const prevD = new Date(now.getFullYear(), now.getMonth() - i - 1, 1);
    const key = monthKeyOf(d);
    const prevKey = monthKeyOf(prevD);
    const snapshot = findSnapshotForMonth(snapshots, d.getFullYear(), d.getMonth());

    // O mês corrente tem retorno conhecido mesmo sem snapshot: são as posições de hoje
    // pelas cotações de hoje. Os meses passados dependem do snapshot — sem ele, não há
    // como saber quanto a carteira rendia naquela data.
    let portfolioForMonth: number | null = null;
    if (snapshot) {
      const snapCost = parseFloat(snapshot.totalCost);
      const snapValue = parseFloat(snapshot.totalValue);
      portfolioForMonth = snapCost > 0 ? Math.round(((snapValue - snapCost) / snapCost) * 10000) / 100 : 0;
    } else if (i === 0 && assets.length > 0) {
      portfolioForMonth = portfolioReturn;
    }

    slots.push({
      label: d.toLocaleDateString("pt-BR", { month: "short", year: "2-digit" }),
      cdiReturn: cdiReturns.get(key) ?? null,
      ibovFactor: factorBetween(ibovCloses, key, prevKey),
      ifixFactor: factorBetween(ifixCloses, key, prevKey),
      portfolioReturn: portfolioForMonth,
    });
  }

  // Caminha do mês mais recente para trás enquanto carteira, CDI e IBOV têm dado real.
  // O IFIX fica fora desta decisão: ele não tem histórico gratuito e exigi-lo zeraria
  // a janela para todo mundo. Ele é reportado só quando cobre a janela inteira.
  const REQUIRED_FOR_WINDOW = (s: MonthSlot) =>
    s.cdiReturn != null && s.ibovFactor != null && s.portfolioReturn != null;

  let firstIdx = slots.length;
  for (let i = slots.length - 1; i >= 0; i--) {
    if (!REQUIRED_FOR_WINDOW(slots[i])) break;
    firstIdx = i;
  }
  // O mês-base não precisa dos fatores (ele vale 0% por definição), só do retorno da
  // carteira, que é a referência contra a qual os meses seguintes são medidos.
  if (firstIdx > 0 && slots[firstIdx - 1].portfolioReturn != null) firstIdx -= 1;

  const windowSlots = slots.slice(firstIdx);

  if (windowSlots.length < 2) {
    const blocker = slots[slots.length - 1];
    const missing = [
      blocker?.portfolioReturn == null ? "histórico da carteira" : null,
      blocker?.cdiReturn == null ? "CDI" : null,
      blocker?.ibovFactor == null ? "IBOV" : null,
    ].filter((m): m is string => m != null);
    res.json({
      points: [],
      windowMonths: 0,
      windowNote:
        missing.length > 0
          ? `Ainda não há dois meses seguidos com dado real de ${missing.join(", ")} para comparar.`
          : "Ainda não há dois meses seguidos de histórico para comparar.",
      portfolioTotal: null,
      cdiTotal: null,
      ibovTotal: null,
      ifixTotal: null,
    });
    return;
  }

  const base = windowSlots[0];
  let cdiAcc = 1;
  let ibovAcc = 1;
  // Uma única lacuna invalida a série inteira do IFIX na janela — acumular por cima de
  // um buraco produziria um número que parece medido e não é.
  let ifixAcc: number | null = 1;

  const points = windowSlots.map((s, i) => {
    if (i > 0) {
      cdiAcc *= 1 + s.cdiReturn! / 100;
      ibovAcc *= s.ibovFactor!;
      ifixAcc = ifixAcc != null && s.ifixFactor != null ? ifixAcc * s.ifixFactor : null;
    }
    const pct = (acc: number) => Math.round((acc - 1) * 10000) / 100;
    return {
      label: s.label,
      portfolio: Math.round((s.portfolioReturn! - base.portfolioReturn!) * 100) / 100,
      cdi: pct(cdiAcc),
      ibov: pct(ibovAcc),
      ifix: ifixAcc != null ? pct(ifixAcc) : null,
    };
  });

  const lastPoint = points[points.length - 1];
  const windowNote =
    windowSlots.length < slots.length
      ? `Comparativo limitado a ${windowSlots.length} meses — é o histórico real disponível para todas as séries.`
      : null;

  res.json({
    points,
    windowMonths: points.length,
    windowNote,
    portfolioTotal: lastPoint.portfolio,
    cdiTotal: lastPoint.cdi,
    ibovTotal: lastPoint.ibov,
    ifixTotal: lastPoint.ifix,
  });
});

/**
 * Valor de mercado por classe de ativo — base do desvio e do plano de aporte.
 * Posição sem cotação entra pelo preço médio, igual ao resto do app.
 */
async function valueByCategoryFor(userId: number): Promise<Map<string, number>> {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, userId));
  const prices = await getPricesFor(assets);
  const byCategory = new Map<string, number>();
  for (const a of assets) {
    const qty = parseFloat(a.quantity);
    const price = prices.get(a.ticker.toUpperCase())?.price ?? parseFloat(a.averagePrice);
    byCategory.set(a.category, (byCategory.get(a.category) ?? 0) + qty * price);
  }
  return byCategory;
}

/**
 * Política em uso e de onde ela veio. A tabela só tem linha quando o usuário salvou
 * algo — ausência significa "nunca personalizou", não alvo zero, e aí vale o padrão
 * derivado do perfil. Sem perfil preenchido o padrão ainda existe, mas se identifica
 * como "generico" para a tela não apresentar um palpite como se fosse cálculo.
 */
async function policyFor(userId: number): Promise<{ targets: PolicyTargets; source: PolicySource }> {
  const rows = await db.select().from(allocationPoliciesTable).where(eq(allocationPoliciesTable.userId, userId));
  if (rows.length > 0) {
    const targets = { ...defaultPolicyFor(null) };
    for (const key of ALLOCATION_CATEGORIES) targets[key] = 0;
    for (const row of rows) {
      if ((ALLOCATION_CATEGORIES as readonly string[]).includes(row.category)) {
        targets[row.category as AllocationCategory] = parseFloat(row.targetPercent);
      }
    }
    return { targets, source: "personalizado" };
  }

  const [profile] = await db.select().from(investorProfilesTable).where(eq(investorProfilesTable.userId, userId));
  const classification = (profile?.classification ?? null) as ProfileClassification | null;
  return { targets: defaultPolicyFor(classification), source: classification ? "perfil" : "generico" };
}

async function allocationOverview(userId: number) {
  const [{ targets, source }, valueByCategory] = await Promise.all([policyFor(userId), valueByCategoryFor(userId)]);
  const { total, items } = computeAllocation(valueByCategory, targets);
  return { source, totalPatrimony: total, items };
}

// Alimenta o seletor de título no cadastro de ativo. Lista vazia significa que a
// sincronização diária ainda não rodou — a tela precisa dizer isso em vez de sugerir
// que não existem títulos.
router.get("/treasury/bonds", requireAuth, async (_req, res): Promise<void> => {
  res.json(await listTreasuryBondOptions());
});

/**
 * PU de compra na data em que o usuário comprou, para o cadastro não exigir que ele
 * descubra o número em outro lugar — e para o app não precisar pré-preencher com o PU
 * de hoje, que gravaria um preço médio errado.
 */
router.get("/treasury/price", requireAuth, async (req, res): Promise<void> => {
  const parsed = GetTreasuryPriceOnDateQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { bondType, maturityDate, date } = parsed.data;

  const found = await priceOnDate({ bondType, maturityDate }, date);
  if (!found) {
    res.status(404).json({ error: "Sem publicação para esse título até a data informada." });
    return;
  }
  res.json(found);
});

router.get("/portfolio/allocation", requireAuth, async (req, res): Promise<void> => {
  res.json(await allocationOverview(req.session.userId!));
});

router.put("/portfolio/allocation", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpsertAllocationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Alvo que não soma 100% não é política, é engano de digitação: qualquer desvio
  // calculado sobre ele estaria errado por construção, e silenciosamente. A folga de
  // 0,01 existe só para não brigar com arredondamento de casa decimal.
  const totalTarget = parsed.data.targets.reduce((sum, t) => sum + t.targetPercent, 0);
  if (Math.abs(totalTarget - 100) > 0.01) {
    res.status(400).json({ error: `Os alvos precisam somar 100% — a soma enviada foi ${totalTarget.toFixed(2)}%.` });
    return;
  }

  const byCategory = new Map(parsed.data.targets.map((t) => [t.category, t.targetPercent]));
  await db.transaction(async (tx) => {
    await tx.delete(allocationPoliciesTable).where(eq(allocationPoliciesTable.userId, req.session.userId!));
    await tx.insert(allocationPoliciesTable).values(
      ALLOCATION_CATEGORIES.map((category) => ({
        userId: req.session.userId!,
        category,
        // Classe omitida no corpo vira alvo zero explícito, e não herda o padrão do
        // perfil: depois de personalizar, a política é inteiramente do usuário — meia
        // política dele e meia nossa seria impossível de explicar na tela.
        targetPercent: String(byCategory.get(category) ?? 0),
      })),
    );
  });

  res.json(await allocationOverview(req.session.userId!));
});

router.get("/portfolio/allocation/plan", requireAuth, async (req, res): Promise<void> => {
  const parsed = GetAllocationPlanQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const amount = parsed.data.amount;

  const [{ targets, source }, valueByCategory] = await Promise.all([
    policyFor(req.session.userId!),
    valueByCategoryFor(req.session.userId!),
  ]);

  const slices = planContribution(amount, valueByCategory, targets);

  // Quanto o aporte sugerido de fato aproxima a carteira do alvo — o número que
  // justifica a sugestão. Sem ele a tela mandaria o usuário mover dinheiro sem dizer
  // o que ele ganha com isso.
  const before = computeAllocation(valueByCategory, targets);
  const projected = new Map(valueByCategory);
  for (const slice of slices) projected.set(slice.category, (projected.get(slice.category) ?? 0) + slice.amount);
  const after = computeAllocation(projected, targets);
  const sumAbsDeviation = (items: { deviationPp: number }[]) => items.reduce((sum, i) => sum + Math.abs(i.deviationPp), 0);

  // Sugestões de ativo vêm do MESMO ranking da tela de Oportunidades, só filtrado por
  // classe — ver lib/opportunity-ranking.ts. Renda fixa e fundos não têm ticker de
  // bolsa, então saem com lista vazia em vez de uma sugestão inventada.
  const ranking = await rankOpportunitiesFor(req.session.userId!);

  // Renda fixa não passa pelo ranking de bolsa — vem do Tesouro Direto, escolhido por
  // característica do título contra o perfil declarado (ver treasury-engine.ts). Só
  // busca se o plano de fato destinar algo à classe.
  const wantsTreasury = slices.some((slice) => slice.category === "renda_fixa");
  const [profileRow] = wantsTreasury
    ? await db.select().from(investorProfilesTable).where(eq(investorProfilesTable.userId, req.session.userId!))
    : [];
  const treasuryBonds = wantsTreasury ? await latestTreasuryBonds() : [];
  const treasurySuggestions = wantsTreasury
    ? suggestTreasuryBonds(treasuryBonds, {
        liquidityNeed: profileRow?.liquidityNeed ?? null,
        emergencyFund: profileRow?.emergencyFund ?? null,
        horizonYears: profileRow?.horizonYears ?? null,
        objective: profileRow?.objective ?? null,
      })
    : [];

  const items = slices.map((slice) => {
    const suggestions = ranking.items
      .filter((item) => item.category === slice.category)
      .slice(0, 3)
      .map((item) => ({ ticker: item.ticker, name: item.name, score: item.score, reason: item.reason }));

    const bondsForSlice = slice.category === "renda_fixa" ? treasurySuggestions : [];

    // Lista vazia tem causas diferentes, e a tela precisa saber qual — deixar todas
    // como "vazio" faria o app dar a mesma explicação para situações que não têm nada
    // a ver entre si: ETF sem fundamento para triar, fundo sem fonte alguma, e Tesouro
    // que só não sincronizou ainda (esse último se resolve sozinho, os outros não).
    const suggestionsStatus = suggestions.length > 0 || bondsForSlice.length > 0
      ? "ok"
      : QUOTED_CATEGORIES.has(slice.category)
        ? "sem_candidato"
        : slice.category === "renda_fixa"
          ? "tesouro_indisponivel"
          : "sem_ticker_de_bolsa";

    return {
      category: slice.category,
      amount: slice.amount,
      sharePercent: slice.sharePercent,
      suggestionsStatus,
      suggestions,
      treasurySuggestions: bondsForSlice,
    };
  });

  res.json({
    amount,
    source,
    orderedBy: ranking.orderedBy,
    items,
    deviationBefore: sumAbsDeviation(before.items),
    deviationAfter: sumAbsDeviation(after.items),
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
    const price = prices.get(a.ticker.toUpperCase())?.price ?? parseFloat(a.averagePrice);
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
