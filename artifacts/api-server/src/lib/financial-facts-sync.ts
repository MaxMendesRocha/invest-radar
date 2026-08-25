import { db, financialFactsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { fetchAnnualStatements } from "./cvm-statements";
import type { JobDefinition } from "./scheduler";
import { logger } from "./logger";

/**
 * Mantém `financial_facts` — a série de demonstrações padronizadas das companhias
 * abertas — em dia.
 *
 * O ganho não é ter mais um indicador: é ter o MESMO indicador em vários períodos. Sem
 * série histórica, "o lucro está caindo?" não é uma pergunta difícil, é uma pergunta
 * impossível — e é a pergunta que separa desconto de armadilha de valor.
 */

/**
 * Até onde o backfill vai.
 *
 * Cada arquivo do DFP traz o exercício corrente E o anterior, então parar em 2015 cobre
 * de 2014 em diante — onze anos, o suficiente para atravessar mais de um ciclo
 * econômico. Cada ano é ~13 MB e só é lido uma vez, na primeira execução.
 */
const BACKFILL_START_YEAR = 2015;

/** Um ano do DFP gera ~9 mil fatos; o Postgres tem teto de parâmetros por statement. */
const CHUNK = 500;

async function upsertYear(year: number): Promise<number> {
  const facts = await fetchAnnualStatements(year);
  if (facts.length === 0) return 0;

  const values = facts.map((f) => ({
    cnpj: f.cnpj,
    cvmCode: f.cvmCode,
    companyName: f.companyName,
    metric: f.metric,
    periodStart: f.periodStart,
    periodEnd: f.periodEnd,
    publishedAt: f.publishedAt,
    version: f.version,
    value: f.value.toFixed(2),
    documentType: f.documentType,
    sourceUrl: f.sourceUrl,
  }));

  let written = 0;
  for (let i = 0; i < values.length; i += CHUNK) {
    const chunk = values.slice(i, i + CHUNK);
    // doNothing e não doUpdate: a versão faz parte da chave, então um conflito aqui
    // significa a MESMA versão do mesmo período chegando duas vezes — o penúltimo
    // exercício de um arquivo é o último do arquivo seguinte. Sobrescrever seria
    // gravar o mesmo número por cima dele mesmo. Retificação chega com versão nova e
    // vira linha nova, que é o comportamento desejado.
    // .returning() para contar o que REALMENTE entrou. Contar o tamanho do lote inflava
    // o resumo: cada exercício chega duas vezes (último de um arquivo, penúltimo do
    // seguinte), então o job dizia "80.678 fatos" com 57.048 linhas na tabela. Resumo de
    // job que não bate com o banco é a mesma classe de silêncio que já custou caro aqui.
    const inserted = await db.insert(financialFactsTable).values(chunk).onConflictDoNothing({
      target: [
        financialFactsTable.cnpj,
        financialFactsTable.metric,
        financialFactsTable.periodEnd,
        financialFactsTable.documentType,
        financialFactsTable.version,
      ],
    }).returning({ id: financialFactsTable.id });
    written += inserted.length;
  }
  return written;
}

export async function syncFinancialFacts(): Promise<{ summary: string }> {
  const currentYear = new Date().getUTCFullYear();
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(financialFactsTable);

  // Tabela vazia = primeira execução: puxa o histórico inteiro. Depois disso só os dois
  // anos mais recentes mudam — a DFP do exercício anterior sai no primeiro trimestre, e
  // retificação de exercício antigo é rara o bastante para não valer rebaixar uma década
  // toda semana.
  const years = count === 0
    ? Array.from({ length: currentYear - BACKFILL_START_YEAR + 1 }, (_, i) => BACKFILL_START_YEAR + i)
    : [currentYear - 1, currentYear];

  let total = 0;
  const failures: string[] = [];
  for (const year of years) {
    try {
      const written = await upsertYear(year);
      if (written === 0) failures.push(`CVM ${year}: arquivo sem contas reconhecidas`);
      total += written;
    } catch (err) {
      // Um ano que falha não derruba os outros — a série fica mais curta, não quebrada.
      // O ano corrente falha por natureza no começo do ano, antes de a CVM publicar.
      logger.warn({ err, year }, "ano do DFP da CVM falhou");
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }

  // Mesma lição do sync de FII: zero linha gravada não é sucesso com pouco resultado, é
  // o job não ter conseguido dado nenhum. Sem este lançamento, job_runs mostraria
  // sucesso e erro nulo com a tabela vazia — o silêncio que já custou caro uma vez.
  if (total === 0) {
    throw new Error(`nenhum fato gravado em ${years.length} ano(s) tentado(s) — ${failures.join(" | ")}`);
  }

  const succeeded = years.length - failures.length;
  const summary = `${total} fatos financeiros em ${succeeded}/${years.length} anos`
    + (failures.length > 0 ? ` (falhas: ${failures.join(" | ")})` : "");
  logger.info({ total, years, failures }, "sync de demonstrações da CVM concluído");
  return { summary };
}

/**
 * Semanal. A DFP sai uma vez por ano por companhia, mas espalhada entre fevereiro e
 * maio; checar toda semana pega cada publicação com poucos dias de atraso, e as
 * retificações junto.
 */
export const FINANCIAL_FACTS_JOB: JobDefinition = {
  name: "sync-financial-facts",
  minGapMs: 7 * 24 * 60 * 60 * 1000,
  run: syncFinancialFacts,
};
