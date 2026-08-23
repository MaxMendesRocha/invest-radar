import { db, opportunitiesTable, investorProfilesTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { getSectorBenchmark } from "./sector-benchmarks";
import { computeDividendValue, compareDividendValue, type DividendValue } from "./dividend-value-engine";
import type { ProfileClassification } from "./investor-profile-engine";

/**
 * Ordenação da lista de oportunidades, extraída de routes/opportunities.ts para poder
 * ser reaproveitada pelo plano de aporte (routes/portfolio.ts), que precisa da mesma
 * ordem só que filtrada por classe de ativo.
 *
 * Ficar em dois lugares seria pior do que parece: a ordem depende do objetivo do perfil
 * e do prêmio de dividendo sobre o setor, e duas cópias divergindo fariam a tela de
 * Oportunidades e a sugestão de aporte recomendarem ativos diferentes com a mesma
 * justificativa — sem que nada no código dissesse qual das duas está certa.
 */

// Menor número = aparece antes. Classes de risco ausentes caem no meio.
const RISK_PRIORITY: Record<string, Record<string, number>> = {
  Conservador: { Baixo: 0, Medio: 1, Alto: 2 },
  Moderado: { Medio: 0, Baixo: 1, Alto: 2 },
  Arrojado: { Alto: 0, Medio: 1, Baixo: 2 },
};

export interface RankedOpportunity {
  id: number;
  sector: string | null;
  dividendSustainability: string | null;
  persistedFrequency: string | null;
  ticker: string;
  name: string;
  category: string;
  score: number;
  potentialReturn: number;
  dividendYield: number;
  riskLevel: string;
  reason: string;
  positives: string[];
  risks: string[];
  horizon: string;
}

export interface RankedOpportunities {
  orderedBy: string;
  dividendPremiumPending: boolean;
  items: RankedOpportunity[];
  /** Prêmio de dividendo por ticker — exibido no card independente da ordenação. */
  dividendValueByTicker: Map<string, DividendValue>;
}

export async function rankOpportunitiesFor(userId: number): Promise<RankedOpportunities> {
  const rows = await db.select().from(opportunitiesTable).orderBy(desc(opportunitiesTable.score));
  const [profile] = await db.select().from(investorProfilesTable).where(eq(investorProfilesTable.userId, userId));

  const items: RankedOpportunity[] = rows.map((r) => ({
    id: r.id,
    sector: r.sector,
    dividendSustainability: r.dividendSustainability,
    persistedFrequency: r.dividendFrequency,
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

  // Calculado SEMPRE, não só quando ordena: o prêmio é exibido no card em qualquer
  // objetivo — é informação útil mesmo para quem não está ordenando por ela.
  const sectors = Array.from(new Set(items.map((i) => i.sector).filter((x): x is string => x != null)));
  const benchmarks = new Map(
    await Promise.all(sectors.map(async (sector) => [sector, await getSectorBenchmark(sector)] as const)),
  );
  const dividendValueByTicker = new Map<string, DividendValue>();
  for (const item of items) {
    const result = computeDividendValue({
      dividendYield: item.dividendYield / 100, // a coluna guarda em %, o motor espera decimal
      sector: item.sector,
      benchmark: benchmarks.get(item.sector ?? "") ?? null,
      frequency: item.persistedFrequency as never, // gravada na varredura
      financialHealth: null,
    });
    if (result.available) {
      dividendValueByTicker.set(item.ticker, {
        ...result.value,
        // A sustentabilidade vem gravada da varredura, onde os fundamentos existiam.
        sustainability: (item.dividendSustainability as DividendValue["sustainability"]) ?? "desconhecido",
      });
    }
  }

  // Quem declarou objetivo de renda passiva está escolhendo onde colocar o próximo
  // aporte pensando em fluxo, não em valorização — então a lista é ordenada pelo
  // prêmio de dividendo sobre o setor (ver dividend-value-engine.ts) em vez do
  // score geral. Para os demais objetivos a ordenação por perfil de risco continua.
  // Só declara ordenação por prêmio se houver prêmio para ordenar. Linhas gravadas
  // por uma varredura anterior à coluna `sector` não têm referência setorial, e
  // nesse caso TODAS as comparações caem no fallback por score — o cabeçalho
  // afirmaria um critério que não está sendo aplicado.
  const wantsIncomeOrdering = profile?.objective === "renda";
  const dividendPremiumPending = wantsIncomeOrdering && dividendValueByTicker.size === 0;
  const orderedBy = wantsIncomeOrdering && !dividendPremiumPending
    ? "premio_dividendo"
    : profile
      ? "perfil_de_risco"
      : "score";

  if (orderedBy === "premio_dividendo") {
    items.sort((a, b) => {
      const va = dividendValueByTicker.get(a.ticker);
      const vb = dividendValueByTicker.get(b.ticker);
      // Sem referência setorial o ativo não é comparável por prêmio — vai pro fim da
      // lista em vez de receber um prêmio zero que o misturaria aos comparáveis.
      if (!va || !vb) return va ? -1 : vb ? 1 : b.score - a.score;
      return compareDividendValue(va, vb);
    });
  } else if (orderedBy === "perfil_de_risco" && profile) {
    orderByRiskProfile(items, profile.classification as ProfileClassification);
  }

  return { orderedBy, dividendPremiumPending, items, dividendValueByTicker };
}

/**
 * Ordena a lista pelo apetite a risco de UMA classificação, no lugar (in place), e
 * devolve o mesmo array por conveniência de encadeamento.
 *
 * Existe separada de `rankOpportunitiesFor` porque a Carteira de Partida
 * (routes/portfolio.ts) mostra as três classificações lado a lado para quem ainda não
 * respondeu o questionário — não há um `userId` com perfil de onde derivar a ordem, e
 * são três ordens sobre a MESMA lista, não três consultas.
 *
 * É a mesma razão que trouxe este arquivo à existência, aplicada um nível abaixo: com a
 * ordenação copiada, a tela de partida poderia sugerir para o Arrojado um ativo que a
 * tela de Oportunidades não sugere para o mesmo perfil — e nada no código diria qual
 * das duas está certa.
 */
export function orderByRiskProfile(
  items: RankedOpportunity[],
  classification: ProfileClassification,
): RankedOpportunity[] {
  const priority = RISK_PRIORITY[classification] ?? {};
  return items.sort((a, b) => {
    const pa = priority[a.riskLevel] ?? 1;
    const pb = priority[b.riskLevel] ?? 1;
    if (pa !== pb) return pa - pb;
    return b.score - a.score;
  });
}
