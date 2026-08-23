import { db, assetsTable, assetPurchasesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { QUANTITY_EPSILON } from "./purchase-ledger";
import type { JobDefinition } from "./scheduler";
import { logger } from "./logger";

/**
 * Cria o lançamento de saldo inicial das posições anteriores aos lançamentos.
 *
 * Cada posição ganha UMA compra com a quantidade, o preço médio e a data que já estavam
 * cadastrados, marcada `isInitialBalance`. Não é uma nota de corretagem — é o saldo que a
 * pessoa informou —, e a marca existe para a interface poder dizer isso em vez de fingir
 * que houve uma operação registrada.
 *
 * ## A invariante que este backfill não pode violar
 *
 * Depois dele, o replay tem que devolver EXATAMENTE a quantidade e o preço médio que já
 * estavam na posição. Não é preciosismo: o TWR deriva o fluxo de caixa da variação de
 * `total_cost` entre snapshots (`time-weighted-return.ts`). Se o backfill mexesse no custo
 * de alguma posição, essa variação apareceria como um APORTE RETROATIVO, e a rentabilidade
 * histórica já gravada em `portfolio_snapshots` mudaria sozinha — sem ninguém ter comprado
 * nada. Por isso cada posição é conferida depois de gravada, e qualquer divergência falha
 * o job em vez de passar batido.
 *
 * ## Por que as vendas anteriores não entram
 *
 * A quantidade cadastrada hoje já está LÍQUIDA das vendas — a baixa acontece no momento da
 * venda (`assets.ts:353`). O saldo inicial reproduz esse estado atual, então descontar de
 * novo as vendas antigas zeraria posições vivas. Só venda POSTERIOR ao backfill passa a
 * descontar, que é o comportamento correto daqui pra frente.
 *
 * Idempotente: posição que já tem lançamento é pulada, então rodar de novo não duplica
 * nada nem reescreve histórico.
 */
export async function backfillInitialPurchases(): Promise<{ summary: string }> {
  const assets = await db.select().from(assetsTable);

  let criados = 0;
  let pulados = 0;
  let poupanca = 0;
  const divergencias: string[] = [];

  for (const asset of assets) {
    // Poupança usa as mesmas colunas com outro significado: quantidade fixa em 1 e
    // "preço médio" que é o SALDO da conta. Lançamento de compra não descreve nada ali,
    // e depósito/saque já tem caminho próprio.
    if (asset.isSavingsAccount) {
      poupanca++;
      continue;
    }

    const existentes = await db
      .select({ id: assetPurchasesTable.id })
      .from(assetPurchasesTable)
      .where(eq(assetPurchasesTable.assetId, asset.id));
    if (existentes.length > 0) {
      pulados++;
      continue;
    }

    const quantity = parseFloat(asset.quantity);
    if (!(quantity > 0)) {
      divergencias.push(`${asset.ticker} (id ${asset.id}): quantidade ${asset.quantity} não é positiva`);
      continue;
    }

    // Sem data de compra registrada, o lançamento usa a data de criação da posição — é o
    // mais conservador disponível e não inventa uma negociação que ninguém sabe quando
    // houve. Onde a data importa de verdade (direito a provento), a interface continua
    // sinalizando a incerteza.
    const tradeDate = asset.purchaseDate ?? asset.createdAt.toISOString().slice(0, 10);

    await db.insert(assetPurchasesTable).values({
      userId: asset.userId,
      assetId: asset.id,
      quantity: asset.quantity,
      unitPrice: asset.averagePrice,
      tradeDate,
      isInitialBalance: true,
      note: "Saldo informado no cadastro, antes do registro de lançamentos.",
    });
    criados++;

    const [gravado] = await db
      .select({ quantity: assetPurchasesTable.quantity, unitPrice: assetPurchasesTable.unitPrice })
      .from(assetPurchasesTable)
      .where(eq(assetPurchasesTable.assetId, asset.id));
    const difQtd = Math.abs(parseFloat(gravado.quantity) - quantity);
    const difPreco = Math.abs(parseFloat(gravado.unitPrice) - parseFloat(asset.averagePrice));
    if (difQtd > QUANTITY_EPSILON || difPreco > QUANTITY_EPSILON) {
      divergencias.push(
        `${asset.ticker} (id ${asset.id}): qtd ${gravado.quantity} vs ${asset.quantity}, `
        + `preço ${gravado.unitPrice} vs ${asset.averagePrice}`,
      );
    }
  }

  if (divergencias.length > 0) {
    // Falha alto, com o motivo: seguir com divergência distorceria a rentabilidade
    // histórica, e um "sucesso" aqui esconderia isso — foi exatamente o silêncio que já
    // custou uma investigação inteira noutro job deste app.
    throw new Error(
      `${divergencias.length} posição(ões) divergiram do cadastro — ${divergencias.join(" | ")}`,
    );
  }

  const summary = `${criados} saldo(s) inicial(is) criado(s), ${pulados} já tinha(m) lançamento, `
    + `${poupanca} poupança(s) fora do escopo`;
  logger.info({ criados, pulados, poupanca }, "backfill de lançamentos concluído");
  return { summary };
}

/**
 * Não tem cadência: é uma transição, não rotina. Fica como JobDefinition só para
 * reaproveitar o registro em `job_runs` e o disparo manual autenticado — o intervalo
 * enorme garante que o scheduler não o repita sozinho.
 */
export const PURCHASE_BACKFILL_JOB: JobDefinition = {
  name: "backfill-asset-purchases",
  minGapMs: 365 * 24 * 60 * 60 * 1000,
  run: backfillInitialPurchases,
};
