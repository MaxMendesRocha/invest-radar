import { pgTable, text, serial, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const investorProfilesTable = pgTable("investor_profiles", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique(),
  horizon: text("horizon").notNull(), // curto, medio, longo
  lossTolerance: text("loss_tolerance").notNull(), // baixa, media, alta
  objective: text("objective").notNull(), // preservar, renda, crescimento
  experience: text("experience").notNull(), // iniciante, intermediario, avancado
  liquidityNeed: text("liquidity_need").notNull(), // sim, nao
  score: numeric("score", { precision: 5, scale: 2 }).notNull(),
  classification: text("classification").notNull(), // Conservador, Moderado, Arrojado
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertInvestorProfileSchema = createInsertSchema(investorProfilesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertInvestorProfile = z.infer<typeof insertInvestorProfileSchema>;
export type InvestorProfile = typeof investorProfilesTable.$inferSelect;
