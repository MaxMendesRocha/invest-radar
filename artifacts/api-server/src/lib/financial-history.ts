import { db, financialFactsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

/**
 * Leitura da série histórica de `financial_facts`.
 *
 * Existe porque a tabela guarda MAIS de uma linha por período, de propósito, e ler ela
 * cru leva a duas conclusões erradas.
 *
 * **1. O mesmo período aparece em dois documentos.** Cada DFP traz o exercício corrente
 * e o anterior, então o resultado de 2023 está no DFP de 2023 (como último) e no de 2024
 * (como penúltimo). Medido na Petrobras: o lucro de 31/12/2023 aparece publicado em
 * 25/03/2024 e de novo em 26/02/2025 — mesmo valor, documentos diferentes.
 *
 * Para saber quando o número ficou público, o que vale é a **primeira** publicação. Usar
 * a última faria um estudo retrospectivo achar que o resultado de 2023 só existia em
 * 2025, e descartar quase um ano de informação que estava disponível.
 *
 * **2. Retificação convive com a publicação original.** A CVM reemite demonstração
 * corrigida com versão maior, e a tabela mantém as duas. O valor corrente é o da
 * **maior** versão; a existência de mais de uma é, ela mesma, informação — companhia que
 * retifica balanço merece olhar diferente.
 *
 * Então a regra desta leitura é: **valor da maior versão, publicação da menor data.**
 */

export interface FinancialPeriod {
  periodEnd: string;
  value: number;
  /** Primeira vez que este número apareceu num documento público. */
  firstPublishedAt: string | null;
  /** Maior versão vista. > 1 significa que houve retificação. */
  version: number;
  /** true quando o mesmo período foi publicado em mais de uma versão. */
  restated: boolean;
  sourceUrl: string | null;
}

/**
 * Série de uma métrica para uma companhia, do período mais antigo para o mais recente.
 *
 * `asOf` limita ao que já era público numa data — é o que permite perguntar "o que o app
 * saberia se tivesse sido consultado naquele dia" sem contaminar a resposta com
 * informação que ainda não existia.
 */
export async function getFinancialSeries(
  cnpj: string,
  metric: string,
  asOf?: string,
): Promise<FinancialPeriod[]> {
  const rows = await db
    .select()
    .from(financialFactsTable)
    .where(and(eq(financialFactsTable.cnpj, cnpj), eq(financialFactsTable.metric, metric)));

  const byPeriod = new Map<string, FinancialPeriod>();
  for (const row of rows) {
    // Fato sem data de publicação não pode ser filtrado por `asOf` com honestidade —
    // fica de fora quando a pergunta é sobre o passado, em vez de entrar assumindo que
    // já era conhecido.
    if (asOf) {
      if (!row.publishedAt || row.publishedAt > asOf) continue;
    }
    const current = byPeriod.get(row.periodEnd);
    const value = parseFloat(row.value);
    if (!current) {
      byPeriod.set(row.periodEnd, {
        periodEnd: row.periodEnd,
        value,
        firstPublishedAt: row.publishedAt,
        version: row.version,
        restated: false,
        sourceUrl: row.sourceUrl,
      });
      continue;
    }
    // Publicação mais antiga vence na data; versão mais alta vence no valor. São
    // critérios diferentes de propósito — ver o cabeçalho.
    if (row.publishedAt && (!current.firstPublishedAt || row.publishedAt < current.firstPublishedAt)) {
      current.firstPublishedAt = row.publishedAt;
    }
    if (row.version > current.version) {
      current.version = row.version;
      current.value = value;
      current.sourceUrl = row.sourceUrl;
    }
    if (row.version !== current.version || parseFloat(row.value) !== current.value) {
      // Duas linhas com valores diferentes para o mesmo período: houve retificação de
      // conteúdo, não só reapresentação do mesmo número no documento seguinte.
      current.restated = current.restated || value !== current.value;
    }
  }

  return Array.from(byPeriod.values()).sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
}

/**
 * Tendência de uma série: quantos períodos consecutivos vieram abaixo do anterior.
 *
 * Deliberadamente uma contagem, não uma nota de 0 a 100. "Três anos seguidos de queda" é
 * um fato verificável; convertê-lo em "TrendScore 34" acrescentaria uma escala inventada
 * em cima de uma medição boa. Quem decide o limiar é o motor de decisão, com o número
 * cru na mão.
 */
export function consecutiveDeclines(series: FinancialPeriod[]): number {
  let streak = 0;
  for (let i = series.length - 1; i > 0; i--) {
    if (series[i].value < series[i - 1].value) streak++;
    else break;
  }
  return streak;
}
