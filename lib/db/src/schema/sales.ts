import { pgTable, text, serial, timestamp, integer, numeric, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const salesTable = pgTable("sales", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  ticker: text("ticker").notNull(),
  category: text("category").notNull(), // copiado do asset no momento da venda
  quantity: numeric("quantity", { precision: 18, scale: 6 }).notNull(),
  averagePrice: numeric("average_price", { precision: 18, scale: 6 }).notNull(), // custo de compra da posição vendida
  salePrice: numeric("sale_price", { precision: 18, scale: 6 }).notNull(),
  saleDate: date("sale_date", { mode: "string" }).notNull(),
  grossGain: numeric("gross_gain", { precision: 18, scale: 6 }).notNull(),
  taxOwed: numeric("tax_owed", { precision: 18, scale: 6 }), // null pra categorias fora do escopo de estimateCapitalGainsTax
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSaleSchema = createInsertSchema(salesTable).omit({ id: true, createdAt: true });
export type InsertSale = z.infer<typeof insertSaleSchema>;
export type Sale = typeof salesTable.$inferSelect;
