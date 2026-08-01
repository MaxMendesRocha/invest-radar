import { logger } from "./logger";

export interface UniverseEntry {
  ticker: string;
  category: "acoes" | "fiis" | "etfs" | "bdrs";
  fallbackName: string; // só usado se getFundamentals() não trouxer o nome real
}

const BRAPI_LIST_URL = "https://brapi.dev/api/quote/list";

// Quantos tickers por categoria entram no universo de screening — limitado pra
// manter o tempo/custo do job de regeneração (a cada 2 dias) razoável. Ordenado por
// market cap desc, então cobre os mais relevantes/líquidos de cada categoria antes
// de qualquer coisa obscura. Ajustável sem mudar arquitetura.
// "acoes" pede o dobro do alvo porque ~metade dos tickers de ação no plano atual
// são duplicatas do mercado fracionário (PETR4F = mesma empresa que PETR4),
// filtradas depois em fetchCategory — confirmado que FIIs/ETFs/BDRs não têm esse
// problema, então não precisam do mesmo ajuste.
const CATEGORY_QUERIES: { category: UniverseEntry["category"]; type: string; subType?: string; limit: number }[] = [
  { category: "acoes", type: "stock", limit: 160 },
  { category: "fiis", type: "fund", subType: "fii", limit: 50 },
  { category: "etfs", type: "fund", subType: "etf", limit: 15 },
  { category: "bdrs", type: "bdr", limit: 25 },
];

interface BrapiListStock {
  stock: string;
  name: string | null;
}

async function fetchCategory(query: (typeof CATEGORY_QUERIES)[number]): Promise<UniverseEntry[]> {
  const token = process.env.BRAPI_TOKEN;
  const params = new URLSearchParams({
    type: query.type,
    sortBy: "market_cap_basic",
    sortOrder: "desc",
    limit: String(query.limit),
  });
  if (query.subType) params.set("subType", query.subType);
  const url = `${BRAPI_LIST_URL}?${params.toString()}`;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const response = await fetch(url, { headers });
  if (!response.ok) {
    logger.warn({ status: response.status, category: query.category }, "brapi.dev quote/list request failed");
    return [];
  }

  const body = (await response.json()) as { stocks?: BrapiListStock[] };
  return (body.stocks ?? [])
    // Tickers terminados em dígito+F são o mercado fracionário da mesma empresa
    // (ex: PETR4 e PETR4F são a Petrobras duas vezes) — confirmado comparando o
    // `name` de vários pares, nunca aparece em FIIs/ETFs/BDRs. Sem esse filtro a
    // lista de oportunidades mostra a mesma empresa duplicada.
    .filter((s) => !/\dF$/.test(s.stock))
    .map((s) => ({
      ticker: s.stock.toUpperCase(),
      category: query.category,
      fallbackName: s.name ?? s.stock,
    }));
}

/**
 * Universo de tickers pra screening de oportunidades, buscado ao vivo da brapi.dev
 * (top N por market cap de cada categoria via GET /api/quote/list) em vez de uma
 * lista fixa — elimina o risco de ticker desatualizado por evento societário (já
 * vimos ELET3→AXIA3, EMBR3→EMBJ3, JBSS3→JBSS32 na lista curada anterior) e cobre
 * muito mais do mercado sem manutenção manual. Retorna [] se todas as categorias
 * falharem (provider fora do ar) — regenerateOpportunities() trata universo vazio
 * como falha e não mexe na tabela existente, em vez de esvaziá-la.
 */
export async function fetchTickerUniverse(): Promise<UniverseEntry[]> {
  // allSettled — uma categoria com erro de rede não deve descartar as outras três.
  const outcomes = await Promise.allSettled(CATEGORY_QUERIES.map(fetchCategory));
  return outcomes.flatMap((outcome, i) => {
    if (outcome.status === "rejected") {
      logger.warn({ err: outcome.reason, category: CATEGORY_QUERIES[i].category }, "brapi.dev quote/list category errored");
      return [];
    }
    return outcome.value;
  });
}
