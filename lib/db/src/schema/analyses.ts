import { pgTable, text, serial, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const analysesTable = pgTable("analyses", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  ticker: text("ticker").notNull(),
  status: text("status").notNull(), // COMPRAR, MANTER, VENDER (ver resolveAnalysisStatus)
  score: numeric("score", { precision: 5, scale: 2 }).notNull(),
  scoreClassification: text("score_classification").notNull(),
  positives: text("positives").notNull(), // JSON array
  risks: text("risks").notNull(),
  newsItems: text("news_items").notNull(),
  alerts: text("alerts").notNull(),
  monitoringRecommendation: text("monitoring_recommendation").notNull(),
  taxEstimate: text("tax_estimate"), // JSON de TaxEstimate (tax-engine.ts) ou null — nullable pois nem toda categoria tem estimativa de IR
  technical: text("technical"), // JSON de TechnicalIndicators (technical-engine.ts) ou null — nullable pois ativos sem candles suficientes (ex: renda_fixa) não têm indicador técnico
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertAnalysisSchema = createInsertSchema(analysesTable).omit({ id: true, updatedAt: true });
export type InsertAnalysis = z.infer<typeof insertAnalysisSchema>;
export type Analysis = typeof analysesTable.$inferSelect;
