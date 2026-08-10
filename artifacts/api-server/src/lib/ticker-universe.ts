import { logger } from "./logger";

export interface UniverseEntry {
  ticker: string;
  category: "acoes" | "fiis" | "etfs" | "bdrs";
  fallbackName: string; // só usado se getFundamentals() não trouxer o nome real
}

const BRAPI_LIST_URL = "https://brapi.dev/api/quote/list";

// Quantos tickers por categoria entram no universo de screening — limitado pra
// manter o tempo/custo do job de regeneração (a cada semana) razoável. Ordenado por
// market cap desc, então cobre os mais relevantes/líquidos de cada categoria antes
// de qualquer coisa obscura. Ajustável sem mudar arquitetura.
// "acoes" pede o dobro do alvo porque ~metade dos tickers de ação no plano atual
// são duplicatas do mercado fracionário (PETR4F = mesma empresa que PETR4),
// filtradas depois em fetchCategory — confirmado que FIIs/ETFs/BDRs não têm esse
// problema, então não precisam do mesmo ajuste.
interface CategoryQuery {
  category: UniverseEntry["category"];
  type: string;
  subType?: string;
  limit: number;
  /** Padrão market_cap_basic. Ver a passada de resgate abaixo. */
  sortBy?: string;
  /**
   * Fica só com o que a ordenação por market cap NÃO consegue enxergar.
   * Usado exclusivamente pela passada de resgate.
   */
  onlyUnranked?: boolean;
}

const CATEGORY_QUERIES: CategoryQuery[] = [
  { category: "acoes", type: "stock", limit: 160 },
  { category: "fiis", type: "fund", subType: "fii", limit: 50 },
  { category: "etfs", type: "fund", subType: "etf", limit: 15 },
  { category: "bdrs", type: "bdr", limit: 25 },
  // Passada de resgate. A brapi devolve `market_cap: null` para units (BPAC11,
  // SANB11, TAEE11, KLBN11, ENGI11, ALUP11, SAPR11, IGTI11, BRBI11), e como as
  // consultas acima ordenam por market cap decrescente e cortam no topo N, um
  // valor nulo nunca alcança o corte — em nenhuma posição, com nenhum limite.
  // Medido: `type=stock&sortBy=market_cap_basic&limit=400` não traz BPAC11, um
  // banco de R$ 218 bi. Na prática, empresas grandes e líquidas da B3 eram
  // invisíveis para a tela de Oportunidades desde sempre.
  //
  // Ordenar por volume traz todas de volta. O critério de corte é o próprio
  // defeito — market cap ausente —, e não "ticker terminado em 11": se o
  // provedor deixar de preencher o campo para qualquer outro papel, esta
  // passada pega do mesmo jeito, sem precisar catalogar o caso novo.
  { category: "acoes", type: "stock", sortBy: "volume", limit: 400, onlyUnranked: true },
];

interface BrapiListStock {
  stock: string;
  name: string | null;
  market_cap?: number | null;
}

async function fetchCategory(query: CategoryQuery): Promise<UniverseEntry[]> {
  const token = process.env.BRAPI_TOKEN;
  const params = new URLSearchParams({
    type: query.type,
    sortBy: query.sortBy ?? "market_cap_basic",
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
    // Na passada de resgate, o que já tem market cap já foi considerado (e
    // ranqueado) pela consulta principal — incluir aqui só reordenaria a lista
    // por liquidez, que é outra decisão de produto e não o que se está
    // consertando.
    .filter((s) => !query.onlyUnranked || s.market_cap == null)
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
 *
 * Inclui uma passada de resgate para o que a ordenação por market cap não alcança
 * (ver CATEGORY_QUERIES), e deduplica por ticker no fim.
 */
export async function fetchTickerUniverse(): Promise<UniverseEntry[]> {
  // allSettled — uma categoria com erro de rede não deve descartar as outras.
  const outcomes = await Promise.allSettled(CATEGORY_QUERIES.map(fetchCategory));
  const entries = outcomes.flatMap((outcome, i) => {
    if (outcome.status === "rejected") {
      logger.warn({ err: outcome.reason, category: CATEGORY_QUERIES[i].category }, "brapi.dev quote/list category errored");
      return [];
    }
    return outcome.value;
  });

  // Duas consultas agora varrem `type=stock`, então o mesmo ticker pode chegar
  // duas vezes. Sem isto a tela de Oportunidades repetiria a empresa, que é
  // exatamente o sintoma que o filtro de fracionário já existia para evitar.
  const byTicker = new Map<string, UniverseEntry>();
  for (const entry of entries) {
    if (!byTicker.has(entry.ticker)) byTicker.set(entry.ticker, entry);
  }
  return [...byTicker.values()];
}
