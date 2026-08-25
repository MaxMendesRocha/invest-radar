import { pgTable, text, integer, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Médias reais por setor (P/L, P/VP, ROE, DY, margem líquida), recalculadas como
// subproduto do mesmo job semanal que já varre o universo de ~170 tickers pra
// regenerar `opportunities` (opportunities-engine.ts) — nunca um scan dedicado, seria
// caro demais rodar em toda leitura de Parecer de Ativo/Radar. `sampleSize` guarda
// quantos tickers reais entraram na média, pra nunca publicar média de amostra
// pequena demais (ver MIN_SECTOR_SAMPLE em opportunities-engine.ts).
export const sectorBenchmarksTable = pgTable("sector_benchmarks", {
  sector: text("sector").primaryKey(),
  avgPriceEarnings: numeric("avg_price_earnings", { precision: 10, scale: 4 }),
  avgPriceToBook: numeric("avg_price_to_book", { precision: 10, scale: 4 }),
  avgReturnOnEquity: numeric("avg_return_on_equity", { precision: 10, scale: 6 }),
  avgDividendYield: numeric("avg_dividend_yield", { precision: 10, scale: 6 }),
  avgProfitMargins: numeric("avg_profit_margins", { precision: 10, scale: 6 }),
  /**
   * Primeiro e terceiro quartis de P/L e P/VP do setor.
   *
   * A mediana sozinha responde "caro ou barato contra os pares", que é uma pergunta de
   * comparação. Faixa de entrada em reais é outra pergunta — precisa de DISPERSÃO, porque
   * a faixa é justamente o intervalo entre "preço de pechincha para este setor" e "preço
   * normal para este setor". Sem os quartis só dá para produzir um ponto, e ponto único
   * afirma uma precisão que não existe.
   *
   * Nulos até a primeira varredura semanal depois do deploy: são subproduto do mesmo scan
   * que já calcula a mediana, sem chamada nova a provedor nenhum.
   */
  p25PriceEarnings: numeric("p25_price_earnings", { precision: 10, scale: 4 }),
  p75PriceEarnings: numeric("p75_price_earnings", { precision: 10, scale: 4 }),
  p25PriceToBook: numeric("p25_price_to_book", { precision: 10, scale: 4 }),
  p75PriceToBook: numeric("p75_price_to_book", { precision: 10, scale: 4 }),
  sampleSize: integer("sample_size").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertSectorBenchmarkSchema = createInsertSchema(sectorBenchmarksTable).omit({ updatedAt: true });
export type InsertSectorBenchmark = z.infer<typeof insertSectorBenchmarkSchema>;
export type SectorBenchmark = typeof sectorBenchmarksTable.$inferSelect;
