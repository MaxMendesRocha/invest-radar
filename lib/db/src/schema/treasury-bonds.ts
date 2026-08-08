import { pgTable, serial, text, numeric, date, timestamp, unique, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Série histórica de preços do Tesouro Direto: uma linha por título por data-base.
 * Global, não por usuário.
 *
 * Fonte: dados abertos do Tesouro Nacional (Tesouro Transparente, CKAN, licença ODbL),
 * sincronizados uma vez por dia — ver treasury-data.ts.
 *
 * Começou guardando só a data-base mais recente, o que bastava para sugerir aporte e
 * marcar posição a mercado. Passou a guardar o histórico inteiro (desde 2002, ~175 mil
 * linhas) por causa de uma pergunta que a foto do dia não responde: **quanto o título
 * custava no dia em que o usuário comprou**. Sem isso, cadastrar uma compra antiga
 * exigia que ele descobrisse o PU pago em outro lugar — e pré-preencher com o PU de
 * hoje teria gravado um preço médio errado, corrompendo o lucro/prejuízo da posição
 * para sempre.
 *
 * Quem precisa do "hoje" filtra pela data-base máxima (`latestTreasuryBonds()` em
 * treasury-identity.ts); quem precisa de uma data específica busca a data-base mais
 * recente ANTERIOR OU IGUAL à procurada, porque compra em fim de semana ou feriado não
 * tem publicação no próprio dia.
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
  /**
   * Taxa e PU de RECOMPRA — o que o Tesouro paga a quem vende o título de volta.
   *
   * Existe separado do lado de compra porque os dois servem a perguntas diferentes, e
   * trocá-los produz erro material: quem AINDA VAI COMPRAR se guia pelo PU de compra,
   * mas uma posição JÁ DETIDA vale o que se consegue ao vender, que é sempre menos. No
   * arquivo de 06/08 o spread ia de 0,06% (Selic curto) a 2,66% (IPCA+ 2050) — marcar
   * a carteira pelo preço de compra infla o patrimônio exatamente nessa medida, e mais
   * nos títulos longos, justamente os de posição maior.
   */
  sellRate: numeric("sell_rate", { precision: 8, scale: 4 }),
  sellUnitPrice: numeric("sell_unit_price", { precision: 14, scale: 2 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  // A chave natural inclui a data-base: o mesmo título aparece uma vez por pregão.
  unique("treasury_bonds_type_maturity_base_unique").on(table.bondType, table.maturityDate, table.baseDate),
  // Todas as consultas ou filtram pela data-base máxima ou procuram a data mais
  // recente até um limite — as duas varrem por esta coluna.
  index("IDX_treasury_bonds_base_date").on(table.baseDate),
]);

export const insertTreasuryBondSchema = createInsertSchema(treasuryBondsTable).omit({ id: true, updatedAt: true });
export type InsertTreasuryBond = z.infer<typeof insertTreasuryBondSchema>;
export type TreasuryBond = typeof treasuryBondsTable.$inferSelect;
