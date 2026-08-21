import { pgTable, serial, text, numeric, date, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Série mensal do Informe Mensal de FII da CVM — global, não por usuário. Uma linha
// por fundo por mês de referência.
//
// Existe porque cvm-data.ts baixa só o ano corrente e colapsa tudo numa linha por CNPJ
// (a composição de carteira só precisa do mês mais recente). Detectar evento corporativo
// exige o oposto: a série ao longo dos anos, pra comparar a quantidade de cotas de um mês
// com a do mês seguinte e enxergar desdobramento/grupamento, e pra somar amortização
// desde a data de compra da pessoa.
//
// `amortizacaoFracao` guarda o campo Percentual_Amortizacao_Cotas_Mes COMO VEM da CVM,
// que apesar do nome é FRAÇÃO e não percentual — 0,018768 quer dizer 1,8768% no mês.
// Conferido por igualdade exata no DVFF11: Percentual_Dividend_Yield_Mes (0,0074884)
// vezes o valor patrimonial da cota (8,6801) dá R$ 0,0650, exatamente o rendimento que
// o fundo pagou naquele mês. Converter na gravação esconderia essa pegadinha do próximo
// leitor; o motor converte na hora de usar.
export const fiiMonthlyReportsTable = pgTable("fii_monthly_reports", {
  id: serial("id").primaryKey(),
  cnpj: text("cnpj").notNull(),
  dataReferencia: date("data_referencia", { mode: "string" }).notNull(),
  cotasEmitidas: numeric("cotas_emitidas", { precision: 20, scale: 2 }),
  amortizacaoFracao: numeric("amortizacao_fracao", { precision: 18, scale: 10 }),
  valorPatrimonialCota: numeric("valor_patrimonial_cota", { precision: 18, scale: 6 }),
  isin: text("isin"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("fii_monthly_reports_cnpj_data_unique").on(table.cnpj, table.dataReferencia),
]);

export const insertFiiMonthlyReportSchema = createInsertSchema(fiiMonthlyReportsTable).omit({ id: true, createdAt: true });
export type InsertFiiMonthlyReport = z.infer<typeof insertFiiMonthlyReportSchema>;
export type FiiMonthlyReport = typeof fiiMonthlyReportsTable.$inferSelect;
