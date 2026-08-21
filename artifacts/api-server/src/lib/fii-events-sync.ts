import { db, fiiMonthlyReportsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { fetchFiiMonthlyRows } from "./cvm-data";
import type { JobDefinition } from "./scheduler";
import { logger } from "./logger";

/**
 * Mantém `fii_monthly_reports` — a série mensal do informe de FII da CVM — em dia.
 *
 * O detector de evento corporativo precisa comparar a quantidade de cotas de um mês com
 * a do seguinte, e somar amortização desde a data de compra da pessoa. Nada disso cabe
 * no caminho de `getFiiCvmData`, que baixa só o ano corrente e guarda uma linha por
 * fundo. Daí a persistência: o histórico tem que sobreviver ao processo e cobrir anos
 * anteriores à compra.
 */

/**
 * Até onde o backfill vai. A CVM publica o informe estruturado desde 2016; parar em
 * 2019 cobre com folga qualquer carteira real sem baixar uma década de arquivo — cada
 * ano é ~1,5 MB e só é lido uma vez, na primeira execução.
 */
const BACKFILL_START_YEAR = 2019;

async function upsertYear(year: number): Promise<number> {
  const rows = await fetchFiiMonthlyRows(year);
  if (rows.length === 0) return 0;

  const values = rows.map((r) => ({
    cnpj: r.cnpj,
    dataReferencia: r.dataReferencia,
    cotasEmitidas: r.cotasEmitidas != null ? String(r.cotasEmitidas) : null,
    amortizacaoFracao: r.amortizacaoFracao != null ? String(r.amortizacaoFracao) : null,
    valorPatrimonialCota: r.valorPatrimonialCota != null ? String(r.valorPatrimonialCota) : null,
    isin: r.isin,
  }));

  // Em lotes porque um ano tem ~9 mil linhas e o Postgres tem teto de parâmetros por
  // statement. onConflictDoUpdate porque a CVM retifica informe publicado (Versao
  // maior) — o valor novo tem que substituir o antigo, não ser ignorado.
  const CHUNK = 1000;
  let written = 0;
  for (let i = 0; i < values.length; i += CHUNK) {
    const chunk = values.slice(i, i + CHUNK);
    await db.insert(fiiMonthlyReportsTable).values(chunk).onConflictDoUpdate({
      target: [fiiMonthlyReportsTable.cnpj, fiiMonthlyReportsTable.dataReferencia],
      set: {
        cotasEmitidas: sql`excluded.cotas_emitidas`,
        amortizacaoFracao: sql`excluded.amortizacao_fracao`,
        valorPatrimonialCota: sql`excluded.valor_patrimonial_cota`,
        isin: sql`excluded.isin`,
      },
    });
    written += chunk.length;
  }
  return written;
}

export async function syncFiiMonthlyReports(): Promise<{ summary: string }> {
  const currentYear = new Date().getUTCFullYear();

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(fiiMonthlyReportsTable);

  // Tabela vazia significa primeira execução (ou banco novo): puxa o histórico todo.
  // Depois disso só o ano corrente muda — anos fechados não são republicados, e
  // rebaixá-los toda semana seria desperdício puro.
  const years = count === 0
    ? Array.from({ length: currentYear - BACKFILL_START_YEAR + 1 }, (_, i) => BACKFILL_START_YEAR + i)
    : [currentYear];

  let total = 0;
  const failed: number[] = [];
  for (const year of years) {
    try {
      const written = await upsertYear(year);
      if (written === 0) failed.push(year);
      total += written;
    } catch (err) {
      // Um ano que falha não derruba os outros — o detector funciona com histórico
      // parcial, só enxerga menos longe.
      logger.warn({ err, year }, "ano do informe de FII da CVM falhou");
      failed.push(year);
    }
  }

  const summary = `${total} linhas de informe mensal de FII em ${years.length - failed.length}/${years.length} anos`
    + (failed.length > 0 ? ` (sem dado: ${failed.join(", ")})` : "");
  logger.info({ total, years, failed }, "sync de informe mensal de FII concluído");
  return { summary };
}

/**
 * Semanal. A CVM publica o informe uma vez por mês, então checar toda semana já pega a
 * publicação nova e as retificações com folga.
 */
export const FII_EVENTS_JOB: JobDefinition = {
  name: "sync-fii-monthly-reports",
  minGapMs: 7 * 24 * 60 * 60 * 1000,
  run: syncFiiMonthlyReports,
};
