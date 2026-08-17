import { pgTable, text, serial, timestamp, integer, date, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Provento pendente que o usuário decidiu NÃO registrar como transação — ex.: valor
 * errado, duplicado, ou já contabilizado por fora do app de outro jeito.
 *
 * Deliberadamente uma tabela separada de `transactions`, não uma linha nela: "Registrar
 * um provento" e "dispensar sem registrar" são ações diferentes por definição — a
 * primeira entra no total acumulado, no yield e no cálculo de IR; a segunda só some da
 * lista de pendentes. Misturar as duas faria uma dispensa mentir como se fosse renda de
 * verdade recebida.
 *
 * A lista de pendentes (GET /portfolio/dividends/pending) é recalculada a cada consulta
 * a partir do evento real do provedor — não existe linha "pendente" para apagar. A
 * dispensa é o que filtra esse recálculo, pela mesma chave ticker+data usada para casar
 * com transações.
 */
export const dividendDismissalsTable = pgTable("dividend_dismissals", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  ticker: text("ticker").notNull(),
  paymentDate: date("payment_date", { mode: "string" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("dividend_dismissals_user_ticker_date_unique").on(table.userId, table.ticker, table.paymentDate),
]);

export const insertDividendDismissalSchema = createInsertSchema(dividendDismissalsTable).omit({ id: true, createdAt: true });
export type InsertDividendDismissal = z.infer<typeof insertDividendDismissalSchema>;
export type DividendDismissal = typeof dividendDismissalsTable.$inferSelect;
