import { pgTable, text, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Última cotação real conhecida por ticker — uma linha por ticker, global (não por
 * usuário), sobrescrita a cada cotação que a brapi.dev devolve de fato.
 *
 * Existe por causa de uma queda da API deles (07/08): o site ficou de pé, os
 * endpoints /api caíram, e a carteira inteira passou a ser avaliada pelo preço médio
 * de compra — patrimônio errado e rentabilidade travada em 0,00%. Um preço de ontem
 * é um preço que existiu de verdade; o preço médio de compra não tem nada a ver com
 * quanto o ativo vale hoje. Daí guardar o último e usá-lo como degrau intermediário.
 *
 * Só o preço e o instante da captura ficam aqui de propósito. O resto do payload da
 * cotação (P/L, nome) alimenta score e fundamentos — servir esses campos com dado
 * datado seria contrabandear defasagem para dentro de um cálculo que se apresenta
 * como atual. Aqui a defasagem é sempre carregada junto, em capturedAt, e chega ao
 * usuário escrita na tela.
 */
export const priceSnapshotsTable = pgTable("price_snapshots", {
  ticker: text("ticker").primaryKey(),
  price: numeric("price", { precision: 18, scale: 4 }).notNull(),
  // Instante em que NÓS recebemos a cotação, não o regularMarketTime da brapi.dev:
  // é isso que responde "há quanto tempo esse número está parado", que é a pergunta
  // que o fallback precisa responder.
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPriceSnapshotSchema = createInsertSchema(priceSnapshotsTable);
export type InsertPriceSnapshot = z.infer<typeof insertPriceSnapshotSchema>;
export type PriceSnapshot = typeof priceSnapshotsTable.$inferSelect;
