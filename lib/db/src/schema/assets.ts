import { pgTable, text, serial, timestamp, integer, numeric, date, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const assetsTable = pgTable("assets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  ticker: text("ticker").notNull(),
  quantity: numeric("quantity", { precision: 18, scale: 6 }).notNull(),
  averagePrice: numeric("average_price", { precision: 18, scale: 6 }).notNull(),
  purchaseDate: date("purchase_date", { mode: "string" }),
  category: text("category").notNull(), // acoes, fiis, etfs, bdrs, fundos, renda_fixa
  /**
   * Identificação do título público, quando a posição é Tesouro Direto: par
   * (família, vencimento) apontando para `treasury_bonds`. Ambos nulos em qualquer
   * outro caso — inclusive em renda fixa privada (CDB/LCI/LCA), que não tem fonte
   * pública e por isso segue valendo o preço médio de compra.
   *
   * É o par natural, e não uma foreign key para treasury_bonds.id, porque aquela
   * tabela é substituída inteira a cada sincronização diária: os ids não sobrevivem
   * ao dia seguinte e a FK apontaria para linha inexistente. Família e vencimento
   * identificam o título para sempre.
   *
   * Só a presença deste par permite marcar a posição a mercado. Sem ele — o que era
   * o único comportamento possível antes — o título ficava congelado no preço de
   * compra para sempre, rendendo sem que o app percebesse.
   */
  treasuryBondType: text("treasury_bond_type"),
  treasuryMaturityDate: date("treasury_maturity_date", { mode: "string" }),
  /**
   * Marca uma posição de `renda_fixa` como conta poupança — sem ser categoria própria,
   * porque poupança deve entrar na mesma fatia de alocação que Tesouro e CDB/LCI/LCA,
   * não numa classe separada. `quantity` fica travada em 1, `averagePrice` guarda o
   * saldo conhecido, `purchaseDate` guarda a DATA desse saldo (não a data de abertura da
   * conta) — é o par que `savings-engine.ts` usa como ponto de partida pra projetar o
   * saldo de hoje via a série 195 do Banco Central (rendimento real da poupança, já com
   * a regra de TR aplicada, publicado por dia-aniversário).
   */
  isSavingsAccount: boolean("is_savings_account").notNull().default(false),
  sector: text("sector"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertAssetSchema = createInsertSchema(assetsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAsset = z.infer<typeof insertAssetSchema>;
export type Asset = typeof assetsTable.$inferSelect;
