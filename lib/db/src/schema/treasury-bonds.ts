import { pgTable, serial, text, numeric, date, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Títulos do Tesouro Direto na data-base mais recente publicada, com a taxa e o preço
 * unitário de compra. Global, não por usuário.
 *
 * Fonte: dados abertos do Tesouro Nacional (Tesouro Transparente, CKAN, licença ODbL),
 * sincronizados uma vez por dia — ver treasury-data.ts. Só a foto mais recente fica
 * aqui: a série histórica completa do arquivo (desde 2002, ~175 mil linhas) não serve
 * para sugerir onde aportar hoje, e guardá-la seria carregar 14 MB por nada.
 *
 * `baseDate` não é decorativo. O arquivo é publicado com um ou dois dias úteis de
 * atraso, então a taxa exibida nunca é "de agora" — a data vai junto na tela pelo mesmo
 * motivo que o preço defasado de ações leva a sua (ver price_snapshots).
 */
export const treasuryBondsTable = pgTable("treasury_bonds", {
  id: serial("id").primaryKey(),
  /** Nome da família como o Tesouro publica, ex. "Tesouro IPCA+ com Juros Semestrais". */
  bondType: text("bond_type").notNull(),
  maturityDate: date("maturity_date", { mode: "string" }).notNull(),
  baseDate: date("base_date", { mode: "string" }).notNull(),
  /**
   * Taxa de compra em % a.a., como publicada. ATENÇÃO: o significado muda por família —
   * no Prefixado é a taxa nominal total, no IPCA+ é o juro REAL somado à inflação, e no
   * Tesouro Selic é o ágio/deságio SOBRE a Selic (por isso aparece como 0,02 e não como
   * a taxa cheia). Quem exibir precisa rotular de acordo, sob pena de mostrar o título
   * mais conservador da praça rendendo zero.
   */
  buyRate: numeric("buy_rate", { precision: 8, scale: 4 }).notNull(),
  buyUnitPrice: numeric("buy_unit_price", { precision: 14, scale: 2 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  unique("treasury_bonds_type_maturity_unique").on(table.bondType, table.maturityDate),
]);

export const insertTreasuryBondSchema = createInsertSchema(treasuryBondsTable).omit({ id: true, updatedAt: true });
export type InsertTreasuryBond = z.infer<typeof insertTreasuryBondSchema>;
export type TreasuryBond = typeof treasuryBondsTable.$inferSelect;
