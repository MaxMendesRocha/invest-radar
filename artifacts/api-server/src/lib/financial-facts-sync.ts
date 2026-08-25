import { db, financialFactsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  fetchStatements,
  dropInconsistentScale,
  DOCUMENT_TYPES,
  type DocumentType,
  type ScaledFact,
  type StatementFact,
} from "./cvm-statements";
import { syncCompanyTickers } from "./company-tickers";
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
 * Até onde a janela de cada documento vai — e ela é relida inteira toda semana, ver
 * `yearsToSync`.
 *
 * Anual desde 2015 (cobre 2014, porque cada arquivo traz dois exercícios): onze anos
 * atravessam mais de um ciclo econômico, e cada ano custa ~13 MB.
 *
 * Trimestral desde 2020 — janela menor de propósito, e não por simetria. O valor do
 * trimestre é a RECENTIDADE: ele encurta a defasagem de um ano para um trimestre. Para
 * profundidade histórica o anual já responde, e o arquivo do ITR é 31 MB por ano contra
 * 13 MB do DFP. Sete anos de trimestre cobrem qualquer detecção de tendência com folga.
 */
const BACKFILL_START: Record<DocumentType, number> = { DFP: 2015, ITR: 2020 };

/** Um ano do DFP gera ~9 mil fatos; o Postgres tem teto de parâmetros por statement. */
const CHUNK = 500;

/**
 * Grava os fatos já conferidos.
 *
 * A escrita acontece depois de TODOS os anos serem baixados, e não ano a ano, porque a
 * conferência de escala precisa da série inteira para funcionar — ver
 * `dropInconsistentScale`. O custo é segurar os fatos em memória (um backfill de nove anos
 * de ITR dá ~130 mil, na casa de dezenas de MB); o ganho é a conferência enxergar a
 * contradição que um arquivo sozinho não mostra.
 */
async function insertFacts(facts: StatementFact[]): Promise<number> {
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
    periodKind: f.periodKind,
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
        financialFactsTable.periodKind,
        financialFactsTable.documentType,
        financialFactsTable.version,
      ],
    }).returning({ id: financialFactsTable.id });
    written += inserted.length;
  }
  return written;
}

/**
 * Anos a puxar para um tipo de documento: SEMPRE a janela inteira.
 *
 * Havia aqui uma otimização — só os dois anos mais recentes depois do primeiro backfill —
 * com o argumento de que retificação de exercício antigo é rara demais para valer
 * rebaixar uma década toda semana. O argumento continua verdadeiro sobre retificação e
 * mesmo assim a otimização teve de sair, por um motivo que só apareceu quando a
 * conferência de escala entrou (`dropInconsistentScale`).
 *
 * A conferência enxerga a contradição comparando anos. Com janela de dois anos ela deixa
 * de ver o que a janela de nove via, e as linhas que o backfill tinha descartado voltam a
 * ser inseridas na execução seguinte. Medido: uma execução de dois anos logo depois de um
 * backfill de nove regravou 308 linhas de ITR. Ou seja, a correção se desfaria sozinha,
 * semana após semana — e em silêncio, que é a pior parte.
 *
 * Então o custo passou a valer a pena: ~375 MB e alguns minutos por execução SEMANAL, em
 * troca de a conferência valer sempre a mesma coisa. De brinde, retificação de ano antigo
 * — rara, mas não inexistente — passa a ser captada.
 */
function yearsToSync(documentType: DocumentType, currentYear: number): number[] {
  const start = BACKFILL_START[documentType];
  return Array.from({ length: currentYear - start + 1 }, (_, i) => start + i);
}

export async function syncFinancialFacts(): Promise<{ summary: string }> {
  const currentYear = new Date().getUTCFullYear();

  let written = 0;
  let attempted = 0;
  let anosComDado = 0;
  const failures: string[] = [];
  const porTipo: string[] = [];

  for (const documentType of DOCUMENT_TYPES) {
    const years = yearsToSync(documentType, currentYear);
    attempted += years.length;
    const baixados: ScaledFact[] = [];
    for (const year of years) {
      try {
        const facts = await fetchStatements(year, documentType);
        if (facts.length === 0) failures.push(`${documentType} ${year}: arquivo sem contas reconhecidas`);
        else anosComDado++;
        baixados.push(...facts);
      } catch (err) {
        // Um ano que falha não derruba os outros — a série fica mais curta, não quebrada.
        // O ano corrente falha por natureza no começo do ano, antes de a CVM publicar.
        logger.warn({ err, year, documentType }, "ano de demonstração da CVM falhou");
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
    // A conferência de escala roda sobre todos os anos juntos de propósito: uma companhia
    // que declare a escala errada de forma coerente dentro de um arquivo só se contradiz
    // quando se olha o arquivo do ano seguinte ao lado.
    const doTipo = await insertFacts(dropInconsistentScale(baixados, documentType));
    written += doTipo;
    porTipo.push(`${doTipo} ${documentType}`);
  }

  // Mesma lição do sync de FII: nenhum ano ter entregue dado não é sucesso com pouco
  // resultado, é o job não ter conseguido dado nenhum. Sem este lançamento, job_runs
  // mostraria sucesso e erro nulo com a tabela vazia — o silêncio que já custou caro.
  //
  // O que se exige é ANO COM DADO, não linha nova: fora da primeira execução a janela
  // inteira vem igual e conflita inteira, e `written` zera sem nada ter dado errado —
  // medido, a segunda execução seguida grava exatamente 0. Exigir linha nova
  // transformaria "nada mudou desde a semana passada" em falha semanal.
  if (anosComDado === 0) {
    throw new Error(`nenhum ano entregou dado em ${attempted} tentado(s) — ${failures.join(" | ")}`);
  }

  // A ponte ticker→CNPJ vem do mesmo portal e é inseparável do resto: sem ela nenhuma
  // linha gravada acima alcança um ativo da carteira. Roda DEPOIS de propósito — se as
  // demonstrações falharem por inteiro, o lançamento acima já interrompeu, e atualizar o
  // mapa sem ter o que mapear não ajudaria ninguém.
  //
  // Uma falha aqui não derruba o job: a série continua correta, só continua inalcançável
  // por ticker até a próxima execução. Silenciar seria o erro; por isso entra no resumo.
  let ponte: string;
  try {
    const mapa = await syncCompanyTickers();
    ponte = `${mapa.written} tickers mapeados em ${mapa.anos} anos de FCA`
      + (mapa.falhas.length > 0 ? ` (falhas: ${mapa.falhas.join(" | ")})` : "");
  } catch (err) {
    const motivo = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "mapa ticker→CNPJ falhou");
    ponte = `mapa ticker→CNPJ falhou: ${motivo}`;
  }

  const summary = `${written} fatos novos (${porTipo.join(" + ")}) em ${anosComDado}/${attempted} anos; ${ponte}`
    + (failures.length > 0 ? ` (falhas: ${failures.join(" | ")})` : "");
  logger.info({ written, porTipo, anosComDado, attempted, failures, ponte }, "sync de demonstrações da CVM concluído");
  return { summary };
}

/**
 * Semanal. A DFP sai uma vez por ano por companhia, mas espalhada entre fevereiro e maio,
 * e o ITR três vezes por ano em janelas parecidas; checar toda semana pega cada
 * publicação com poucos dias de atraso, e as retificações junto.
 */
export const FINANCIAL_FACTS_JOB: JobDefinition = {
  name: "sync-financial-facts",
  minGapMs: 7 * 24 * 60 * 60 * 1000,
  run: syncFinancialFacts,
};
