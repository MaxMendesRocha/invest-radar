import { db, portfolioSnapshotsTable, type PortfolioSnapshot } from "@workspace/db";
import { eq } from "drizzle-orm";
import { todayInAppTimezone } from "./local-date";



/**
 * Upserts today's snapshot for the user — called from /portfolio/summary, so real
 * history builds up from ordinary app usage instead of needing a cron job. Safe to
 * call repeatedly in the same day: keeps overwriting with the latest computed value.
 */
export async function recordSnapshot(userId: number, totalValue: number, totalCost: number): Promise<void> {
  await db
    .insert(portfolioSnapshotsTable)
    .values({ userId, date: todayInAppTimezone(), totalValue: String(totalValue), totalCost: String(totalCost) })
    .onConflictDoUpdate({
      target: [portfolioSnapshotsTable.userId, portfolioSnapshotsTable.date],
      set: { totalValue: String(totalValue), totalCost: String(totalCost) },
    });
}

export async function getSnapshotsForUser(userId: number): Promise<PortfolioSnapshot[]> {
  return db.select().from(portfolioSnapshotsTable).where(eq(portfolioSnapshotsTable.userId, userId)).orderBy(portfolioSnapshotsTable.date);
}

/** Last snapshot on or before a given year/month (0-indexed month, JS Date style). */
export function findSnapshotForMonth(snapshots: PortfolioSnapshot[], year: number, month: number): PortfolioSnapshot | undefined {
  const prefix = `${year}-${String(month + 1).padStart(2, "0")}`;
  const matches = snapshots.filter((s) => s.date.startsWith(prefix));
  return matches[matches.length - 1];
}
