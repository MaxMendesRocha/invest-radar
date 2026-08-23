import { db, assetsTable, assetPurchasesTable, salesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { replayPosition, type LedgerPurchase, type LedgerSale, type ReplayedPosition } from "./purchase-ledger";

/**
 * Mantém `assets.quantity`, `assets.average_price` e `assets.purchase_date` em dia com os
 * lançamentos.
 *
 * As três colunas continuam existindo porque são lidas em cerca de trinta lugares — totais
 * de carteira, distribuição, saúde, alocação, meta de renda, proventos, score, IR, TWR,
 * risco, perfil revelado, prompts de IA e o frontend inteiro — e nenhum deles reconstrói
 * histórico. Fazer todos calcularem a partir dos lançamentos seria reescrever meia
 * aplicação para resolver um problema que é de escrita.
 *
 * O que muda é o lado da escrita: elas passam a ser um CACHE derivado, e esta função é o
 * único lugar autorizado a mexer nelas. O risco de cache é divergir da fonte, e ele só se
 * contém se não houver caminho alternativo — por isso a regra é que nenhum `update` de
 * quantidade ou preço médio existe fora daqui.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Executor: a transação quando há uma em curso, senão a conexão normal. */
type Executor = Tx | typeof db;

async function loadLedger(exec: Executor, asset: { id: number; userId: number; ticker: string; category: string }) {
  const purchases = await exec
    .select({
      tradeDate: assetPurchasesTable.tradeDate,
      quantity: assetPurchasesTable.quantity,
      unitPrice: assetPurchasesTable.unitPrice,
    })
    .from(assetPurchasesTable)
    .where(eq(assetPurchasesTable.assetId, asset.id));

  // Venda não tem FK para a posição (a tabela guarda ticker e categoria copiados no
  // momento da venda), então o casamento é pelo par natural — o mesmo que a consolidação
  // de POST /assets sempre usou para decidir se duas compras são da mesma posição.
  const sales = await exec
    .select({ saleDate: salesTable.saleDate, quantity: salesTable.quantity })
    .from(salesTable)
    .where(and(
      eq(salesTable.userId, asset.userId),
      eq(salesTable.ticker, asset.ticker),
      eq(salesTable.category, asset.category),
    ));

  const asPurchases: LedgerPurchase[] = purchases.map((p) => ({
    tradeDate: p.tradeDate,
    quantity: parseFloat(p.quantity),
    unitPrice: parseFloat(p.unitPrice),
  }));
  const asSales: LedgerSale[] = sales.map((s) => ({
    saleDate: s.saleDate,
    quantity: parseFloat(s.quantity),
  }));

  return { asPurchases, asSales };
}

/**
 * Recalcula e grava o cache da posição. Devolve o resultado do replay para quem precisar
 * responder na hora, sem uma segunda leitura.
 *
 * Posição sem nenhum lançamento **não é tocada**: é o estado de quem ainda não passou pelo
 * backfill, e sobrescrever com zero apagaria a posição da pessoa.
 */
export async function recomputeAssetCache(
  assetId: number,
  exec: Executor = db,
): Promise<ReplayedPosition | null> {
  const [asset] = await exec.select().from(assetsTable).where(eq(assetsTable.id, assetId));
  if (!asset) return null;

  // Poupança sobrecarrega as mesmas colunas com outro significado: quantidade fixa em 1 e
  // "preço médio" que na verdade é o SALDO, com purchase_date sendo a data dele. Lançamento
  // de compra não descreve nada ali, e depósito/saque tem caminho próprio.
  if (asset.isSavingsAccount) return null;

  const { asPurchases, asSales } = await loadLedger(exec, asset);
  if (asPurchases.length === 0) return null;

  const replayed = replayPosition(asPurchases, asSales);
  await exec
    .update(assetsTable)
    .set({
      quantity: String(replayed.quantity),
      averagePrice: String(replayed.averagePrice),
      purchaseDate: replayed.firstPurchaseDate,
    })
    .where(eq(assetsTable.id, assetId));

  return replayed;
}

/** Lançamentos de uma posição, do mais recente para o mais antigo. */
export async function listPurchases(assetId: number) {
  return db
    .select()
    .from(assetPurchasesTable)
    .where(eq(assetPurchasesTable.assetId, assetId))
    .orderBy(assetPurchasesTable.tradeDate);
}
