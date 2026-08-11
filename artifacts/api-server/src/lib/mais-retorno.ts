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

/** Formas de autenticação a tentar, em ordem. A documentação não diz qual é a certa. */
const AUTH_STRATEGIES = [
  { name: "bearer", headers: (t: string) => ({ Authorization: `Bearer ${t}` }) },
  { name: "x-api-key", headers: (t: string) => ({ "x-api-key": t }) },
  { name: "api-key", headers: (t: string) => ({ "api-key": t }) },
] as const;

/** Descoberta na primeira chamada bem-sucedida e reusada — evita 401 desnecessário. */
let workingStrategy: (typeof AUTH_STRATEGIES)[number] | null = null;

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

const DATE_KEYS = ["date", "data", "dt", "reference_date", "referenceDate", "quote_date"];
const VALUE_KEYS = ["value", "valor", "close", "quote", "price", "fechamento", "cota"];

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

/** Série histórica de um identificador (IFIX, IBOV, CDI, ticker…). Null se indisponível. */
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

export function isMaisRetornoConfigured(): boolean {
  return !!process.env.MAIS_RETORNO_TOKEN;
}
