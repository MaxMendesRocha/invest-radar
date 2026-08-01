import { pgTable, serial, text, integer, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Rastreia a última execução de jobs agendados in-process (ver lib/scheduler.ts no
// api-server) — persistido no banco, não em memória, porque o processo pode reiniciar
// a qualquer momento (Railway ON_FAILURE) e precisa saber se já passou tempo
// suficiente desde a última rodada real sem depender de o processo ter ficado no ar
// o intervalo inteiro.
export const jobRunsTable = pgTable("job_runs", {
  id: serial("id").primaryKey(),
  jobName: text("job_name").notNull(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastStatus: text("last_status"), // "sucesso" | "erro"
  lastError: text("last_error"),
  lastDurationMs: integer("last_duration_ms"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  unique("job_runs_job_name_unique").on(table.jobName),
]);

export const insertJobRunSchema = createInsertSchema(jobRunsTable).omit({ id: true, updatedAt: true });
export type InsertJobRun = z.infer<typeof insertJobRunSchema>;
export type JobRun = typeof jobRunsTable.$inferSelect;
