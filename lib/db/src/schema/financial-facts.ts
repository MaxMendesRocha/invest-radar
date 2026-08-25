import { pgTable, serial, text, numeric, date, integer, timestamp, unique, index } from "drizzle-orm/pg-core";

/**
 * Fatos financeiros das companhias abertas, direto das demonstrações padronizadas que a
 * CVM publica em dados abertos (DFP anual).
 *
 * Existe porque o app só tinha o retrato de HOJE. A brapi entrega o último valor de cada
 * indicador e nada antes dele, então nenhuma pergunta sobre TENDÊNCIA — "o lucro está
 * caindo?", "a dívida está crescendo?" — tinha como ser respondida. Guardar o retrato
 * semanal a partir de agora resolveria isso daqui a alguns anos; a CVM resolve
 * retroativamente, porque publica a série inteira.
 *
 * Três colunas carregam o que separa esta tabela de um cache de indicadores:
 *
 * - `periodEnd` é a que o número descreve; `publishedAt` é quando ele passou a ser
 *   público. Os dois quase nunca coincidem — a demonstração de 31/12 costuma sair em
 *   fevereiro ou março. Sem essa distinção, qualquer estudo retrospectivo usaria em
 *   janeiro um número que só existiu em março, e concluiria que o modelo acerta.
 * - `version` guarda republicação. A CVM reemite a mesma demonstração quando há
 *   retificação, e as duas versões convivem no arquivo. Manter as duas e ler a maior é
 *   o que permite saber que houve retificação, em vez de apagar a evidência.
 * - `sourceUrl` é o documento no site da CVM de onde a linha saiu. Todo número exibido
 *   ao usuário precisa poder ser rastreado até a origem.
 * - `periodKind` diz o que o período É, e não é redundante com as datas: o informe
 *   trimestral publica o MESMO `periodEnd` duas vezes, uma com o trimestre isolado e
 *   outra com o acumulado do ano. Medido no ITR de 2025: **1.794 de 2.706 chaves** têm
 *   mais de um período. Sem esta coluna na chave única, dois terços do dado trimestral
 *   seriam descartados em silêncio — e o que sobreviveria dependeria da ordem das linhas
 *   no arquivo.
 *
 * Chaveada por CNPJ e não por ticker de propósito: a CVM identifica a companhia, e uma
 * companhia tem vários papéis (PETR3 e PETR4 são a mesma demonstração). Amarrar ticker
 * aqui obrigaria a duplicar cada linha por classe de ação.
 */
export const financialFactsTable = pgTable("financial_facts", {
  id: serial("id").primaryKey(),
  cnpj: text("cnpj").notNull(),
  /** Código CVM da companhia — identificador estável, sobrevive a mudança de nome. */
  cvmCode: text("cvm_code").notNull(),
  companyName: text("company_name").notNull(),
  /** Nome normalizado da métrica (ver ACCOUNT_MAP em lib/cvm-statements.ts). */
  metric: text("metric").notNull(),
  /** Null em conta de balanço, que é saldo numa data e não fluxo de um período. */
  periodStart: date("period_start", { mode: "string" }),
  periodEnd: date("period_end", { mode: "string" }).notNull(),
  /** DT_RECEB: quando a CVM recebeu o documento. É o "known at" da série. */
  publishedAt: date("published_at", { mode: "string" }),
  version: integer("version").notNull(),
  /** Já convertido para reais — o arquivo publica em MIL, e a escala vem por linha. */
  value: numeric("value", { precision: 24, scale: 2 }).notNull(),
  /** DFP (anual). ITR (trimestral) entra depois, com a mesma chave. */
  documentType: text("document_type").notNull(),
  /**
   * `saldo` (balanço, um instante), `exercicio` (o ano fiscal de um DFP — quase sempre
   * 12 meses, mais curto quando a companhia muda a data de fechamento), `trimestre`
   * (~3 meses de um ITR) ou `acumulado` (6 ou 9 meses de um ITR).
   */
  periodKind: text("period_kind").notNull(),
  sourceUrl: text("source_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
// Forma de array e nome de constraint curto seguem a convenção do repositório (ver
// fii-monthly-reports.ts).
}, (t) => [
  // Versão entra na chave para a retificação conviver com a publicação original em vez
  // de sobrescrevê-la — quem lê pega a maior versão do período.
  //
  // O nome é explícito porque o automático teria 67 caracteres e o Postgres trunca
  // identificador em 63, deixando banco e schema com nomes diferentes.
  //
  // AVISO: `drizzle-kit push` reporta esta constraint como ausente mesmo quando ela
  // existe, e oferece TRUNCAR a tabela para poder criá-la — o que apagaria a série
  // inteira. Investiguei e descartei nome longo, forma do callback, índice secundário,
  // número de colunas e `mode` das datas; a causa continua desconhecida, e a tabela
  // irmã (fii_monthly_reports, 72 mil linhas) não apresenta o problema. Enquanto isso,
  // **esta tabela é criada pelo script em docs/sql/financial-facts.sql**, e um push
  // nesta base precisa ser respondido com "não" na pergunta de truncar.
  unique("financial_facts_periodo_unico").on(t.cnpj, t.metric, t.periodEnd, t.periodKind, t.documentType, t.version),
  index("financial_facts_cnpj_idx").on(t.cnpj, t.metric, t.periodEnd),
]);

export type FinancialFact = typeof financialFactsTable.$inferSelect;
export type InsertFinancialFact = typeof financialFactsTable.$inferInsert;
