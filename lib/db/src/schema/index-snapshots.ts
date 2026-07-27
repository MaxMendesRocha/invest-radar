import { pgTable, serial, text, numeric, date, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// One row per market index (ibov, ifix) per day — global, not per user. Upserted
// whenever /portfolio/benchmarks is computed, same snapshot-on-read approach as
// portfolio_snapshots. IBOV gets backfilled with ~3 months of real history from
// brapi.dev on first use (its free tier exposes that much); IFIX has no historical
// data on the free tier at all, so it only accumulates from whenever we started
// recording — the recent-months gap fills in real data over time, older months keep
// falling back to the simulated approximation until enough daily closes pile up.
export const indexSnapshotsTable = pgTable("index_snapshots", {
  id: serial("id").primaryKey(),
  indexName: text("index_name").notNull(),
  date: date("date", { mode: "string" }).notNull(),
  closeValue: numeric("close_value", { precision: 18, scale: 4 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("index_snapshots_index_date_unique").on(table.indexName, table.date),
]);

export const insertIndexSnapshotSchema = createInsertSchema(indexSnapshotsTable).omit({ id: true, createdAt: true });
export type InsertIndexSnapshot = z.infer<typeof insertIndexSnapshotSchema>;
export type IndexSnapshot = typeof indexSnapshotsTable.$inferSelect;
