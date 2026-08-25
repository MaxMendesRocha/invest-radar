import { pgTable, serial, integer, text, numeric, date, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { assetsTable } from "./assets";

/**
 * Cada compra registrada de uma posição — a fonte da verdade do preço médio.
 *
 * Antes disso, `assets.average_price` era um número digitado, sem procedência e sem como
 * conferir. Uma divergência real com a corretora (R$ 5,68 no app contra R$ 5,04 no extrato)
 * custou três hipóteses erradas — amortização, desdobramento e uma compra antiga — até a
 * nota de corretagem mostrar que era simples erro de digitação no cadastro. Guardando as
 * compras, o preço médio passa a ser CALCULADO e essa classe de erro deixa de existir.
 *
 * Só compra entra aqui. Venda já é conceito de primeira classe em `sales`, com IR e
 * resultado realizado, e a regra brasileira é que venda não altera preço médio — só reduz
 * quantidade. Duplicá-la criaria duas verdades sobre o mesmo fato.
 *
 * A precisão acompanha as colunas que este lançamento alimenta: `assets.quantity` e
 * `assets.average_price` são ambas numeric(18,6).
 */
export const assetPurchasesTable = pgTable("asset_purchases", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  /**
   * Cascade porque o lançamento não sobrevive à posição: venda total apaga a linha de
   * `assets`, e `DELETE /assets/:id` também. Quando isso acontece a posição acabou, e o
   * histórico do que foi vendido continua onde já estava, em `sales`. Efeito desejado:
   * vender tudo e recomprar o mesmo papel recomeça o preço médio do zero.
   */
  assetId: integer("asset_id").notNull().references(() => assetsTable.id, { onDelete: "cascade" }),
  quantity: numeric("quantity", { precision: 18, scale: 6 }).notNull(),
  /** Preço pago por unidade — PU no caso de Tesouro Direto. */
  unitPrice: numeric("unit_price", { precision: 18, scale: 6 }).notNull(),
  /**
   * Data da NEGOCIAÇÃO, não da liquidação. A corretora costuma exibir a data de
   * liquidação (D+2), e as duas se confundem com facilidade: uma compra de DVFF11 aparecia
   * como 10/08 no extrato da B3 sendo de 06/08 — e só o preço do dia (R$ 5,25, dentro da
   * faixa de 06/08 e acima do topo de 10/08) permitiu distinguir.
   */
  tradeDate: date("trade_date", { mode: "string" }).notNull(),
  /**
   * Marca o lançamento criado a partir do saldo que já estava cadastrado, quando a posição
   * é anterior a este recurso. Não é uma nota de corretagem, é o que a pessoa informou — e
   * a interface diz isso em vez de fingir que houve uma operação registrada.
   */
  isInitialBalance: boolean("is_initial_balance").notNull().default(false),
  /**
   * Número da nota de corretagem, quando o lançamento veio da importação de PDF.
   *
   * É a chave de idempotência: reimportar o mesmo arquivo não pode duplicar a compra, e
   * o arquivo do Nubank exporta o período inteiro — quem importa em agosto e de novo em
   * setembro reenvia agosto junto. Sem isto a segunda importação dobraria a quantidade e
   * envenenaria o preço médio, que é justamente o número que esta tabela existe para
   * proteger.
   *
   * Nulo em lançamento digitado à mão e no saldo inicial: eles não têm nota, e inventar
   * um identificador para poder ter unicidade transformaria "não sei" em "é diferente".
   */
  brokerNoteNumber: text("broker_note_number"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAssetPurchaseSchema = createInsertSchema(assetPurchasesTable).omit({ id: true, createdAt: true });
export type InsertAssetPurchase = z.infer<typeof insertAssetPurchaseSchema>;
export type AssetPurchase = typeof assetPurchasesTable.$inferSelect;
