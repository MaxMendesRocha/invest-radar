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
  periodStart: date("period_start"),
  periodEnd: date("period_end").notNull(),
  /** DT_RECEB: quando a CVM recebeu o documento. É o "known at" da série. */
  publishedAt: date("published_at"),
  version: integer("version").notNull(),
  /** Já convertido para reais — o arquivo publica em MIL, e a escala vem por linha. */
  value: numeric("value", { precision: 24, scale: 2 }).notNull(),
  /** DFP (anual). ITR (trimestral) entra depois, com a mesma chave. */
  documentType: text("document_type").notNull(),
  sourceUrl: text("source_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  // Versão entra na chave para a retificação conviver com a publicação original em vez
  // de sobrescrevê-la — quem lê pega a maior versão do período.
  uniqueFact: unique().on(t.cnpj, t.metric, t.periodEnd, t.documentType, t.version),
  byCnpj: index("financial_facts_cnpj_idx").on(t.cnpj, t.metric, t.periodEnd),
}));

export type FinancialFact = typeof financialFactsTable.$inferSelect;
export type InsertFinancialFact = typeof financialFactsTable.$inferInsert;
