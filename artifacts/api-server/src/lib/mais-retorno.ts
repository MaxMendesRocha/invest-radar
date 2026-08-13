import { logger } from "./logger";

/**
 * Cliente da API de dados da Mais Retorno (D-1, fim de dia).
 *
 * Existe para cobrir dois pontos cegos que a brapi e o BCB não resolvem:
 *
 * - **IFIX com histórico.** O plano gratuito da brapi não expõe histórico do IFIX, só
 *   o fechamento do dia, então a série do app só acumula a partir de quando começamos
 *   a gravar — e o IFIX vira `null` no comparativo sempre que não cobre a janela.
 * - **CDI de reserva.** Em 11/08/2026 o SGS do Banco Central devolveu 502 em todas as
 *   séries e o comparativo apagou inteiro, porque não havia segunda fonte para o CDI.
 *
 * ## Nada aqui é usado sem verificação
 *
 * A documentação da Mais Retorno não especifica o formato do cabeçalho de autenticação
 * nem os nomes dos campos de resposta. Este módulo NÃO adivinha: `parseQuoteSeries`
 * aceita um conjunto pequeno de formatos plausíveis e, quando nenhum bate, devolve
 * null REGISTRANDO AS CHAVES QUE VIERAM. Assim a primeira chamada real descreve o
 * contrato em vez de produzir número errado em silêncio — que é a única falha que este
 * projeto trata como inaceitável.
 *
 * Motivo de tanta cautela: nesta mesma base, a documentação da brapi divergiu do
 * comportamento real duas vezes (o endpoint de proventos de FII só trazia pagamento
 * liquidado; units vinham com valor de mercado nulo e sumiam do universo).
 */

const BASE_URL = "https://data.maisretorno.com/mr-data/v4/api";

export interface QuotePoint {
  /** "YYYY-MM-DD" */
  date: string;
  value: number;
}

/**
 * `X-Api-Key` primeiro porque é o recomendado na documentação para uso server-side;
 * `Bearer` fica como alternativa documentada. A lista sobrevive à descoberta porque
 * uma das duas pode ser desativada sem aviso, e cair para a outra é mais barato que
 * uma indisponibilidade.
 */
const AUTH_STRATEGIES = [
  { name: "x-api-key", headers: (t: string) => ({ "X-Api-Key": t }) },
  { name: "bearer", headers: (t: string) => ({ Authorization: `Bearer ${t}` }) },
] as const;

/**
 * Índices têm sufixo `:idx` — a documentação mostra `cdi:idx`. Para IFIX e IBOV o
 * formato é o mesmo por analogia, mas NÃO foi visto num exemplo, então quem chama
 * tenta o alternativo quando o primeiro vem vazio (ver INDEX_IDENTIFIERS).
 */
export const INDEX_IDENTIFIERS: Record<"cdi" | "ifix" | "ibov", string[]> = {
  cdi: ["cdi:idx", "CDI"],
  ifix: ["ifix:idx", "IFIX"],
  ibov: ["ibov:idx", "IBOV"],
};

/** Descoberta na primeira chamada bem-sucedida e reusada — evita 401 desnecessário. */
let workingStrategy: (typeof AUTH_STRATEGIES)[number] | null = null;

/**
 * Cache de série de índice. Não é otimização, é orçamento: o plano gratuito dá 500
 * créditos POR MÊS e cada /quotes custa 1. Sem cache, uma tela que consulta o índice a
 * cada carregamento gasta a cota inteira em poucos dias de uso normal — 20 aberturas
 * por dia dariam 600 chamadas no mês. Com 6h, caem para ~4 por dia.
 *
 * Dado D-1 não muda dentro do dia, então a janela larga não custa frescor nenhum.
 */
const INDEX_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const indexCache = new Map<string, { series: QuotePoint[]; fetchedAt: number }>();

async function request(path: string): Promise<unknown | null> {
  const token = process.env.MAIS_RETORNO_TOKEN;
  if (!token) return null;

  const url = `${BASE_URL}${path}`;
  const strategies = workingStrategy ? [workingStrategy] : AUTH_STRATEGIES;

  for (const strategy of strategies) {
    let response: Response;
    try {
      response = await fetch(url, { headers: strategy.headers(token) as Record<string, string> });
    } catch (err) {
      logger.warn({ err, path }, "Mais Retorno request errored");
      return null;
    }
    if (response.status === 401 || response.status === 403) continue; // tenta a próxima forma de auth
    if (!response.ok) {
      logger.warn({ status: response.status, path }, "Mais Retorno request failed");
      return null;
    }
    if (workingStrategy == null) {
      workingStrategy = strategy;
      logger.info({ strategy: strategy.name }, "Mais Retorno auth strategy resolved");
    }
    return await response.json();
  }

  logger.warn({ path }, "Mais Retorno rejected every auth strategy");
  return null;
}

/**
 * `d` e `c` vêm primeiro porque são os nomes REAIS, tirados do exemplo da
 * documentação — a resposta de /quotes é `{ market, currency, nicename, shortname,
 * quotes: [{ d, c, p, q }] }`, com d = data, c = fechamento, p = volume financeiro e
 * q = quantidade. Vale registrar que a primeira versão deste parser procurava
 * `date`/`value` e teria falhado em tudo; achou-se o contrato lendo a documentação de
 * exemplos, não adivinhando. Os nomes longos ficam como rede caso a v4 mude.
 */
const DATE_KEYS = ["d", "date", "data", "dt", "reference_date", "referenceDate", "quote_date"];
const VALUE_KEYS = ["c", "value", "valor", "close", "quote", "price", "fechamento", "cota"];

function pick(item: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (k in item) return item[k];
  return undefined;
}

/**
 * Extrai uma série de (data, valor) de um corpo cujo formato ainda não foi confirmado.
 *
 * Reconhece o array na raiz ou sob as chaves usuais, e dentro de cada item procura um
 * campo de data e um de valor entre os nomes plausíveis. Não achando, devolve null e
 * registra as chaves observadas — é essa mensagem que revela o contrato real.
 */
export function parseQuoteSeries(body: unknown, context: string): QuotePoint[] | null {
  const container = Array.isArray(body)
    ? body
    : typeof body === "object" && body != null
      ? (["data", "quotes", "results", "values", "items", "series"]
          .map((k) => (body as Record<string, unknown>)[k])
          .find(Array.isArray) as unknown[] | undefined)
      : undefined;

  if (!Array.isArray(container) || container.length === 0) {
    logger.warn(
      { context, topLevelKeys: typeof body === "object" && body != null ? Object.keys(body) : typeof body },
      "Mais Retorno: nenhuma série reconhecida no corpo",
    );
    return null;
  }

  const points: QuotePoint[] = [];
  for (const raw of container) {
    if (typeof raw !== "object" || raw == null) continue;
    const item = raw as Record<string, unknown>;
    const rawDate = pick(item, DATE_KEYS);
    const rawValue = pick(item, VALUE_KEYS);
    const value = typeof rawValue === "number" ? rawValue : Number(rawValue);
    if (typeof rawDate !== "string" || !Number.isFinite(value)) continue;
    // Aceita "2026-08-11" e "2026-08-11T00:00:00Z"; recusa qualquer outro formato em
    // vez de tentar interpretar — data mal lida vira mês errado no comparativo.
    const iso = rawDate.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
    points.push({ date: iso, value });
  }

  if (points.length === 0) {
    logger.warn(
      { context, sampleKeys: Object.keys(container[0] as Record<string, unknown>) },
      "Mais Retorno: série encontrada mas sem par data/valor reconhecível",
    );
    return null;
  }

  return points.sort((a, b) => a.date.localeCompare(b.date));
}

/** Série histórica de um identificador. Null se indisponível. */
export async function fetchQuoteSeries(
  identifier: string,
  startDate: string,
  endDate: string,
): Promise<QuotePoint[] | null> {
  const body = await request(
    `/quotes/${encodeURIComponent(identifier)}?start_date=${startDate}&end_date=${endDate}`,
  );
  return body == null ? null : parseQuoteSeries(body, identifier);
}

/**
 * Série de um índice, tentando os identificadores conhecidos em ordem.
 *
 * Só `cdi:idx` aparece num exemplo da documentação; IFIX e IBOV seguem o padrão por
 * analogia. Em vez de apostar num, tenta o provável e cai para o alternativo — uma
 * requisição a mais custa 1 crédito e evita ficar sem a série por causa de um sufixo.
 */
export async function fetchIndexSeries(
  index: keyof typeof INDEX_IDENTIFIERS,
  startDate: string,
  endDate: string,
): Promise<QuotePoint[] | null> {
  const key = `${index}:${startDate}:${endDate}`;
  const cached = indexCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < INDEX_CACHE_TTL_MS) return cached.series;

  for (const identifier of INDEX_IDENTIFIERS[index]) {
    const series = await fetchQuoteSeries(identifier, startDate, endDate);
    if (series != null && series.length > 0) {
      logger.info({ index, identifier, points: series.length }, "Mais Retorno index series resolved");
      indexCache.set(key, { series, fetchedAt: Date.now() });
      return series;
    }
  }
  // Falha NÃO é cacheada — mesma lição do CDI do BCB, cuja indisponibilidade ficava
  // guardada por 6h e mantinha o gráfico apagado depois de a fonte já ter voltado.
  return null;
}

export function isMaisRetornoConfigured(): boolean {
  return !!process.env.MAIS_RETORNO_TOKEN;
}
