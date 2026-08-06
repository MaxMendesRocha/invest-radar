import { pgTable, text, serial, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const investorProfilesTable = pgTable("investor_profiles", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique(),
  // Derivado de horizonYears, não perguntado — mantido porque a régua antiga o
  // gravava e há linhas em produção com ele preenchido.
  horizon: text("horizon").notNull(), // curto, medio, longo
  lossTolerance: text("loss_tolerance").notNull(), // baixa, media, alta
  objective: text("objective").notNull(), // preservar, renda, crescimento
  experience: text("experience").notNull(), // iniciante, intermediario, avancado
  liquidityNeed: text("liquidity_need").notNull(), // sim, nao

  // Campos da régua nova. Nullable porque as linhas gravadas antes deles existirem
  // continuam válidas — investor-profile-engine.ts trata a ausência explicitamente
  // em vez de assumir um valor.
  horizonYears: integer("horizon_years"),
  emergencyFund: text("emergency_fund"), // sim, nao — reserva cobrindo 6 meses de despesa
  portfolioShare: text("portfolio_share"), // menos_25, de_25_50, de_50_75, mais_75 (% do patrimônio total nesta carteira)
  incomeStability: text("income_stability"), // estavel, variavel, instavel

  // Guardados separados porque a classificação final é a MENOR das duas, e sem
  // registrá-las não dá pra explicar ao usuário qual delas limitou o perfil.
  capacityScore: numeric("capacity_score", { precision: 5, scale: 2 }),
  toleranceScore: numeric("tolerance_score", { precision: 5, scale: 2 }),

  score: numeric("score", { precision: 5, scale: 2 }).notNull(),
  classification: text("classification").notNull(), // Conservador, Moderado, Arrojado
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertInvestorProfileSchema = createInsertSchema(investorProfilesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertInvestorProfile = z.infer<typeof insertInvestorProfileSchema>;
export type InvestorProfile = typeof investorProfilesTable.$inferSelect;
