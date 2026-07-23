import { pgTable, text, serial, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const analysesTable = pgTable("analyses", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  ticker: text("ticker").notNull(),
  status: text("status").notNull(), // MANTER, ATENCAO, REAVALIAR, POSSIVEL_SAIDA
  score: numeric("score", { precision: 5, scale: 2 }).notNull(),
  scoreClassification: text("score_classification").notNull(),
  positives: text("positives").notNull(), // JSON array
  risks: text("risks").notNull(),
  newsItems: text("news_items").notNull(),
  alerts: text("alerts").notNull(),
  monitoringRecommendation: text("monitoring_recommendation").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertAnalysisSchema = createInsertSchema(analysesTable).omit({ id: true, updatedAt: true });
export type InsertAnalysis = z.infer<typeof insertAnalysisSchema>;
export type Analysis = typeof analysesTable.$inferSelect;
