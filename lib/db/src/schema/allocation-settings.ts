import { pgTable, integer, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

/**
 * Banda de tolerância do rebalanceamento: quanto a carteira pode se afastar do alvo
 * antes de valer a pena mexer.
 *
 * ## Por que ela existe
 *
 * O alvo sozinho não decide nada. Uma classe a 52% contra alvo de 50% está "fora do
 * alvo" pela aritmética e dentro do ruído pela prática — e o app tratava as duas
 * situações igual, sugerindo aporte para desvio de 0,06 p.p. A banda é o que transforma
 * desvio em decisão.
 *
 * ## Por que uma linha por USUÁRIO, e não por classe
 *
 * A banda é uma só para a carteira inteira, decisão tomada com o usuário: banda por
 * classe permitiria ser mais tolerante com o que oscila mais, mas complexidade de
 * configuração é justamente o que faz uma funcionalidade de disciplina não ser usada.
 *
 * Por isso ela não mora em `allocation_policies`, que é uma linha por classe — repetir
 * o mesmo número em seis linhas seria modelagem que convida à divergência.
 *
 * ## Ausência de linha não é banda zero
 *
 * Significa "nunca configurou", e o app usa o padrão declarado em allocation-engine.ts.
 * Mesmo contrato de `allocation_policies`, pelo mesmo motivo: banda zero faria toda
 * oscilação virar chamado para ação, que é o oposto do que a banda serve.
 */
export const allocationSettingsTable = pgTable("allocation_settings", {
  // Sem `serial` próprio: é uma linha por usuário, então o próprio usuário é a chave.
  userId: integer("user_id").primaryKey().references(() => usersTable.id, { onDelete: "cascade" }),
  /** Em pontos percentuais. 5 significa "mexe quando passar de 5 p.p. do alvo". */
  bandPp: numeric("band_pp", { precision: 5, scale: 2 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertAllocationSettingsSchema = createInsertSchema(allocationSettingsTable).omit({
  createdAt: true, updatedAt: true,
});
export type InsertAllocationSettings = z.infer<typeof insertAllocationSettingsSchema>;
export type AllocationSettings = typeof allocationSettingsTable.$inferSelect;
