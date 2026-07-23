import { pgTable, text, serial, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const opportunitiesTable = pgTable("opportunities", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  score: numeric("score", { precision: 5, scale: 2 }).notNull(),
  potentialReturn: numeric("potential_return", { precision: 8, scale: 2 }).notNull(),
  dividendYield: numeric("dividend_yield", { precision: 8, scale: 2 }).notNull(),
  riskLevel: text("risk_level").notNull(), // Baixo, Medio, Alto
  reason: text("reason").notNull(),
  positives: text("positives").notNull(), // JSON array stored as text
  risks: text("risks").notNull(),         // JSON array stored as text
  horizon: text("horizon").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertOpportunitySchema = createInsertSchema(opportunitiesTable).omit({ id: true, updatedAt: true });
export type InsertOpportunity = z.infer<typeof insertOpportunitySchema>;
export type Opportunity = typeof opportunitiesTable.$inferSelect;
