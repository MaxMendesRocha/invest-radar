import { pgTable, text, serial, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Meta de renda passiva. Uma por usuário — o objetivo é "quanto quero receber por
 * mês, e até quando", que é a pergunta que transforma a projeção de proventos já
 * existente em acompanhamento de progresso.
 */
export const incomeGoalsTable = pgTable("income_goals", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique(),
  targetMonthlyIncome: numeric("target_monthly_income", { precision: 14, scale: 2 }).notNull(),
  targetYear: integer("target_year").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertIncomeGoalSchema = createInsertSchema(incomeGoalsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertIncomeGoal = z.infer<typeof insertIncomeGoalSchema>;
export type IncomeGoal = typeof incomeGoalsTable.$inferSelect;
