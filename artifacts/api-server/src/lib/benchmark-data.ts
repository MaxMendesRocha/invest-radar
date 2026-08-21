import { db, indexSnapshotsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { fetchSeriesRange } from "./macro-data";
import { todayInAppTimezone } from "./local-date";
import { fetchIndexSeries, isMaisRetornoConfigured } from "./mais-retorno";

const BRAPI_BASE_URL = "https://brapi.dev/api/quote";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // same cadence as macro-data.ts

// CDI acumulado no mês (série 4390 do SGS/BCB) — each point IS already the month's
// return in %, so unlike IBOV/IFIX there's no "close value" math needed and, since
// BCB publishes years of history for free, no snapshot table or simulated fallback
// is needed either: it's real for the full 12-month window on every request.
const CDI_SERIES = "4390";

function monthKeyFromBcbDate(ddmmyyyy: string): string {
  const [, mm, yyyy] = ddmmyyyy.split("/");
  return `${yyyy}-${mm}`;
}

let cdiCache: { returns: Map<string, number>; fetchedAt: number } | null = null;

/** Map "YYYY-MM" -> CDI accumulated return (%) for that month, real BCB data. */
export async function getCdiMonthlyReturns(): Promise<Map<string, number>> {
  const now = Date.now();
  if (cdiCache && now - cdiCache.fetchedAt < CACHE_TTL_MS) return cdiCache.returns;

  const returns = new Map<string, number>();
  try {
    const points = await fetchSeriesRange(CDI_SERIES, 400); // >12 months of buffer
    for (const p of points) {
      const value = parseFloat(p.valor);
      if (!Number.isNaN(value)) returns.set(monthKeyFromBcbDate(p.data), value);
    }
  } catch (err) {
    logger.warn({ err }, "BCB CDI (série 4390) request errored");
  }

  // NÃO cacheia resultado vazio. `fetchSeriesRange` devolve [] tanto em erro de rede
  // quanto em resposta não-ok, então uma indisponibilidade do BCB produzia um mapa
  // vazio guardado por 6 HORAS — e o comparativo continuava apagado por todo esse
  // tempo depois que a fonte já tinha voltado. Aconteceu de verdade: em 11/08/2026 a
  // API do SGS devolvia 502 em todas as séries com o site do BCB no ar.
  //
  // Como o BCB publica anos de histórico, mapa vazio é sempre falha, nunca "não há
  // dado" — então guardar só o resultado preenchido não perde nada e faz a próxima
  // requisição tentar de novo.
  if (returns.size === 0) {
    const fallback = await cdiFromMaisRetorno();
    if (fallback != null) {
      logger.info({ months: fallback.size }, "CDI servido pela fonte de reserva (Mais Retorno)");
      cdiCache = { returns: fallback, fetchedAt: now };
      return fallback;
    }
  }

  if (returns.size > 0) cdiCache = { returns, fetchedAt: now };
  return returns;
}

/** Série 12 do SGS: CDI em % AO DIA, um ponto por dia útil. */
const CDI_DAILY_SERIES = "12";

let cdiDailyCache: { returns: Map<string, number>; fetchedAt: number } | null = null;

/**
 * Map "YYYY-MM-DD" -> retorno do CDI (%) NAQUELE DIA, dado real do BCB.
 *
 * Conferido contra a série mensal antes de entrar em uso: compondo os 23 pregões de
 * julho/2026 dá 1,2152%, contra 1,22% publicado na 4390 — a diferença de 0,0048 p.p. é o
 * arredondamento de duas casas da série mensal. Trocar a base de mensal para diário não
 * muda o número, só a resolução.
 */
export async function getCdiDailyReturns(): Promise<Map<string, number>> {
  const now = Date.now();
  if (cdiDailyCache && now - cdiDailyCache.fetchedAt < CACHE_TTL_MS) return cdiDailyCache.returns;

  const returns = new Map<string, number>();
  try {
    const points = await fetchSeriesRange(CDI_DAILY_SERIES, 400);
    for (const p of points) {
      const value = parseFloat(p.valor);
      // Banda de plausibilidade recalibrada para o dia. Reusar a mensal (0,1% a 4%)
      // rejeitaria TODO dado diário válido — o CDI diário roda na casa de 0,05%.
      if (!Number.isNaN(value) && value >= CDI_DAILY_MIN && value <= CDI_DAILY_MAX) {
        returns.set(isoFromBcbDate(p.data), value);
      }
    }
  } catch (err) {
    logger.warn({ err }, "BCB CDI diário (série 12) request errored");
  }

  // Mesma regra da série mensal: mapa vazio é falha, nunca "não há dado" — o BCB publica
  // anos de histórico. Cachear vazio deixaria o comparativo apagado por 6 horas depois de
  // a fonte já ter voltado.
  if (returns.size > 0) cdiDailyCache = { returns, fetchedAt: now };
  return returns;
}

/**
 * CDI diário fica na casa de 0,05% ao dia com a Selic em dois dígitos. O piso exclui zero
 * e valores degenerados; o teto de 0,5% ao dia equivale a ~250% ao ano, folgado acima de
 * qualquer pico histórico e ainda assim capaz de barrar um campo lido na escala errada.
 */
const CDI_DAILY_MIN = 0.001;
const CDI_DAILY_MAX = 0.5;

function isoFromBcbDate(ddmmyyyy: string): string {
  const [dd, mm, yyyy] = ddmmyyyy.split("/");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Faixa plausível para o CDI acumulado em UM mês, em %.
 *
 * Existe porque a fonte de reserva entrega o campo `c` ("fechamento") igual para ação e
 * para índice, e a documentação não diz se o CDI vem como NÍVEL de índice acumulado ou
 * como taxa. Aqui ele é tratado como nível, e a razão entre dois fechamentos vira o
 * retorno do mês — mas se a interpretação estiver errada, o número sai absurdo em vez
 * de sutilmente errado. Um CDI mensal fora desta faixa é sinal de leitura equivocada,
 * não de mercado atípico: mesmo na hiperinflação o piso e o teto abaixo seriam rompidos
 * por ordens de grandeza.
 *
 * Preferir NENHUM CDI a um CDI errado é a regra da casa: linha de benchmark plausível e
 * falsa é pior que gráfico ausente, porque ninguém desconfia dela.
 *
 * O PISO é positivo de propósito, e a razão é a falha que ele existe para pegar. CDI é
 * taxa de juro: não é negativo e não é zero. Se o campo `c` trouxer a TAXA em vez do
 * nível acumulado, a razão entre o fechamento de dois meses dá algo perto de 1 — ou
 * seja, ~0% ao mês, que passaria por um piso negativo sem levantar suspeita e pintaria
 * o CDI como parado. Piso em 0,1% ao mês corresponde a uma Selic de ~1,2% ao ano,
 * abaixo do mínimo histórico brasileiro (2% em 2021), então nenhum cenário real cai
 * ali — só leitura equivocada do campo. O teto de 4% cobre folgadamente o pico de
 * Selic da série histórica.
 */
const CDI_MONTHLY_MIN = 0.1;
const CDI_MONTHLY_MAX = 4;

/**
 * CDI mensal a partir da Mais Retorno, usado só quando o BCB não responde.
 *
 * Converte fechamentos diários em retorno mensal encadeando o último fechamento de cada
 * mês — mesma mecânica do IBOV, que também chega como nível. Devolve null se o token
 * não estiver configurado, se a série vier vazia, ou se QUALQUER mês cair fora da faixa
 * plausível.
 */
async function cdiFromMaisRetorno(): Promise<Map<string, number> | null> {
  if (!isMaisRetornoConfigured()) return null;

  const end = todayInAppTimezone();
  const start = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  const series = await fetchIndexSeries("cdi", start, end);
  if (series == null || series.length < 2) return null;

  // Último fechamento de cada mês; o mapa preserva a ordem de inserção da série, que
  // parseQuoteSeries já devolve crescente.
  const monthEnd = new Map<string, number>();
  for (const p of series) monthEnd.set(p.date.slice(0, 7), p.value);

  const months = [...monthEnd.keys()].sort();
  const returns = new Map<string, number>();
  for (let i = 1; i < months.length; i++) {
    const previous = monthEnd.get(months[i - 1])!;
    const current = monthEnd.get(months[i])!;
    if (previous <= 0) return null;
    const percent = (current / previous - 1) * 100;
    if (percent < CDI_MONTHLY_MIN || percent > CDI_MONTHLY_MAX) {
      logger.warn(
        { month: months[i], percent },
        "CDI de reserva fora da faixa plausível — série provavelmente não é nível de índice; descartada",
      );
      return null;
    }
    returns.set(months[i], Math.round(percent * 10000) / 10000);
  }

  return returns.size > 0 ? returns : null;
}

/**
 * CDI acumulado real dos últimos 12 meses em carteira (composto mês a mês, não uma
 * média simples) — usado como taxa livre de risco em risk-metrics-engine.ts. Real
 * pros 12 meses sempre (mesma garantia documentada em getCdiMonthlyReturns: BCB
 * publica anos de histórico de graça) — retorna null só se a série vier vazia
 * (BCB fora do ar), nunca uma taxa chutada.
 */
export async function getCdiTrailingAnnual(): Promise<number | null> {
  const monthlyReturns = await getCdiMonthlyReturns();
  if (monthlyReturns.size === 0) return null;

  const months = Array.from(monthlyReturns.keys()).sort().slice(-12);
  if (months.length === 0) return null;

  let acc = 1;
  for (const month of months) {
    acc *= 1 + (monthlyReturns.get(month) ?? 0) / 100;
  }
  return acc - 1;
}

interface BrapiHistoricalPoint {
  date: number; // unix seconds
  close: number;
}

async function fetchIndexHistory(ticker: string): Promise<{ current: number | null; history: BrapiHistoricalPoint[] }> {
  const token = process.env.BRAPI_TOKEN;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const url = `${BRAPI_BASE_URL}/${encodeURIComponent(ticker)}?range=3mo&interval=1d`;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    logger.warn({ status: response.status, ticker }, "brapi.dev index history request failed");
    return { current: null, history: [] };
  }

  const body = (await response.json()) as {
    results?: { regularMarketPrice?: number; historicalDataPrice?: BrapiHistoricalPoint[] }[];
  };
  const item = body.results?.[0];
  return {
    current: item?.regularMarketPrice ?? null,
    // IBOV's free tier returns ~3 months of daily closes; IFIX's returns only today's
    // point (no historical data available on the free plan) — both are handled the
    // same way here, IFIX just backfills one day at a time on each real request.
    history: item?.historicalDataPrice ?? [],
  };
}

export interface IndexQuote {
  price: number | null;
  changePercent: number | null;
}

// Bem mais curto que as 6h do resto do arquivo: os outros indicadores aqui são
// séries do BCB que mudam uma vez por dia, enquanto o Ibovespa se move durante o
// pregão. 15min mantém o card útil sem transformar cada acesso em uma chamada.
const INDEX_QUOTE_TTL_MS = 15 * 60 * 1000;

let ibovCache: { quote: IndexQuote; fetchedAt: number } | null = null;

/**
 * Cotação corrente do Ibovespa. Separada de fetchIndexHistory porque aqui só
 * interessam o ponto de agora e a variação do dia — não o histórico usado nas
 * comparações de performance.
 *
 * Falha de rede devolve os dois campos nulos, nunca um valor de outra origem:
 * o card mostra "-" e fica evidente que o dado não veio.
 */
export async function getIbovespaQuote(): Promise<IndexQuote> {
  const now = Date.now();
  if (ibovCache && now - ibovCache.fetchedAt < INDEX_QUOTE_TTL_MS) return ibovCache.quote;

  let quote: IndexQuote = { price: null, changePercent: null };
  try {
    const token = process.env.BRAPI_TOKEN;
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await fetch(`${BRAPI_BASE_URL}/%5EBVSP`, { headers });
    if (response.ok) {
      const body = (await response.json()) as {
        results?: { regularMarketPrice?: number; regularMarketChangePercent?: number }[];
      };
      const item = body.results?.[0];
      quote = {
        price: item?.regularMarketPrice ?? null,
        changePercent: item?.regularMarketChangePercent ?? null,
      };
    } else {
      logger.warn({ status: response.status }, "brapi.dev Ibovespa quote request failed");
    }
  } catch (err) {
    logger.warn({ err }, "brapi.dev Ibovespa quote errored");
  }

  ibovCache = { quote, fetchedAt: now };
  return quote;
}



function isoFromUnixSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

async function upsertCloses(indexName: string, closesByDate: Map<string, number>): Promise<void> {
  for (const [date, closeValue] of closesByDate) {
    await db
      .insert(indexSnapshotsTable)
      .values({ indexName, date, closeValue: String(closeValue) })
      .onConflictDoUpdate({
        target: [indexSnapshotsTable.indexName, indexSnapshotsTable.date],
        set: { closeValue: String(closeValue) },
      });
  }
}

/**
 * Igual à função acima, sem a agregação por mês: devolve "YYYY-MM-DD" -> fechamento.
 *
 * `index_snapshots` sempre guardou fechamento diário — o mês era só o recorte da chave na
 * leitura. O comparativo do Dashboard usa esta versão porque agregar por mês descartava
 * justamente a resolução que faz o gráfico mostrar percurso em vez de uma reta entre dois
 * pontos.
 */
export async function syncAndGetDailyIndexCloses(ticker: string, indexName: string): Promise<Map<string, number>> {
  try {
    const { current, history } = await fetchIndexHistory(ticker);
    const closesByDate = new Map<string, number>();
    for (const point of history) {
      closesByDate.set(isoFromUnixSeconds(point.date), point.close);
    }
    if (closesByDate.size === 0 && current != null) {
      closesByDate.set(todayInAppTimezone(), current);
    }
    if (closesByDate.size > 0) await upsertCloses(indexName, closesByDate);
  } catch (err) {
    logger.warn({ err, ticker }, "index history sync errored");
  }

  const rows = await db.select().from(indexSnapshotsTable).where(eq(indexSnapshotsTable.indexName, indexName)).orderBy(indexSnapshotsTable.date);

  const dailyCloses = new Map<string, number>();
  for (const row of rows) dailyCloses.set(row.date, parseFloat(row.closeValue));
  return dailyCloses;
}
