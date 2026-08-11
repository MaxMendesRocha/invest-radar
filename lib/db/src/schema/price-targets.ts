import { pgTable, text, serial, timestamp, integer, numeric, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Preço-alvo informado PELO USUÁRIO, por ticker.
 *
 * Existe porque o provedor não entrega preço-alvo de analista em nenhum plano
 * (`targetMeanPrice` dá 403 tanto na v1 quanto na v2), e o `potentialReturn` das
 * Oportunidades é uma heurística documentada justamente por isso. Quem assina uma casa
 * de análise tem esse número; o app só não tinha onde recebê-lo.
 *
 * Deliberadamente NÃO fica em `assets`: a pergunta "quanto vale este papel" é anterior
 * a ter posição — o caso de uso principal é o Parecer de Ativo, consultado sobre
 * ticker que a pessoa ainda não comprou. Amarrar à posição perderia exatamente o
 * momento em que o alvo é mais útil.
 *
 * `source` é texto livre porque é a procedência que o usuário reconhece ("Eleven",
 * "meu cálculo", "consenso"), não um enum que o app tenha autoridade para definir. E
 * o app nunca preenche isto sozinho: é entrada de quem usa, e por isso não se mistura
 * com nada que o Radar calcula.
 */
export const priceTargetsTable = pgTable("price_targets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  ticker: text("ticker").notNull(),
  targetPrice: numeric("target_price", { precision: 18, scale: 4 }).notNull(),
  source: text("source"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  unique("price_targets_user_ticker_unique").on(table.userId, table.ticker),
]);

export const insertPriceTargetSchema = createInsertSchema(priceTargetsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPriceTarget = z.infer<typeof insertPriceTargetSchema>;
export type PriceTarget = typeof priceTargetsTable.$inferSelect;
