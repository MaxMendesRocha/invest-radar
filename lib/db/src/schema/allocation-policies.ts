import { pgTable, serial, integer, text, numeric, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

/**
 * Política de alocação-alvo do usuário: quanto ele QUER ter em cada classe de ativo.
 *
 * Até aqui o app só media onde a carteira está (dispersão real via HHI em
 * /portfolio/health). "Melhor equilíbrio" não é respondível sem uma referência — é
 * preferência sem régua. Esta tabela é essa régua, e é do investidor: existe um padrão
 * derivado do perfil, mas ele só vira linha aqui quando o usuário salva, e a partir daí
 * manda sobre o padrão.
 *
 * Uma linha por classe por usuário. A ausência de linhas significa "nunca personalizou"
 * e o padrão do perfil é usado — não significa alvo zero.
 */
export const allocationPoliciesTable = pgTable("allocation_policies", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  category: text("category").notNull(),
  targetPercent: numeric("target_percent", { precision: 6, scale: 2 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  unique("allocation_policies_user_category_unique").on(table.userId, table.category),
]);

export const insertAllocationPolicySchema = createInsertSchema(allocationPoliciesTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertAllocationPolicy = z.infer<typeof insertAllocationPolicySchema>;
export type AllocationPolicy = typeof allocationPoliciesTable.$inferSelect;
