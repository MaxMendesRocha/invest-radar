import { db, assetsTable, assetPurchasesTable } from "@workspace/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { recomputeAssetCache } from "./purchase-ledger-sync";
import { categoryConflict } from "./b3-ticker";

/**
 * A gravação da importação — o segundo passo, depois de alguém ter olhado.
 *
 * ## Só compra entra
 *
 * A nota registra venda também, e ela **não** é importada. Não é omissão: `sales` exige
 * `average_price` (o custo da posição vendida), `gross_gain` e `tax_owed`, e **nada disso
 * está na nota**. Ela só traz o preço de venda. O custo sai do histórico da própria
 * carteira, que pode estar incompleto justamente em quem está importando pela primeira
 * vez — e errar ali grava um número de IMPOSTO errado.
 *
 * Venda continua tendo caminho próprio, com as regras dela. A tela mostra as vendas lidas
 * e diz onde registrá-las, em vez de fingir que não existem.
 *
 * ## A idempotência é por nota, e é verificada aqui
 *
 * O arquivo da corretora traz o período inteiro, então reimportar o que já entrou é o uso
 * normal, não engano. As notas já gravadas são puladas em silêncio — e a checagem é
 * refeita no momento da gravação, não herdada do preview: entre ver a tela e confirmar,
 * a pessoa pode ter importado em outra aba.
 *
 * ## Por que o cache é recalculado e não escrito
 *
 * `assets.quantity` e `assets.average_price` são derivados dos lançamentos, e
 * `recomputeAssetCache` é quem sabe derivá-los. Calcular a média aqui criaria uma segunda
 * fórmula que discordaria da primeira no primeiro caso de venda parcial.
 */

/** Uma posição confirmada na tela, pronta para virar lançamento. */
export interface ConfirmedPosition {
  ticker: string;
  category: string;
  trades: {
    noteNumber: string;
    tradeDate: string;
    side: "compra" | "venda";
    quantity: number;
    price: number;
  }[];
}

export interface CommitResult {
  /** Lançamentos criados, por ticker. */
  imported: { ticker: string; purchases: number; quantity: number }[];
  /** Notas puladas porque já estavam na carteira. */
  skippedNotes: string[];
  /** Vendas lidas e NÃO importadas, com o motivo — a tela precisa dizer isso. */
  salesNotImported: { ticker: string; quantity: number; price: number; tradeDate: string }[];
  /** Posições recusadas na validação, com o motivo. Nenhuma delas foi gravada. */
  rejected: { ticker: string; reason: string }[];
}

/** Erro de quem chamou — vira 400, não 500. */
export class ImportValidationError extends Error {}

const TICKER = /^[A-Z][A-Z0-9]{3}\d{1,2}$/;

/**
 * Grava as compras confirmadas. Tudo numa transação: metade importada é pior do que nada,
 * porque quem vê a carteira depois não tem como saber onde parou.
 */
export async function commitImport(
  userId: number,
  positions: ConfirmedPosition[],
): Promise<CommitResult> {
  if (positions.length === 0) throw new ImportValidationError("Nenhuma posição para importar.");

  const result: CommitResult = { imported: [], skippedNotes: [], salesNotImported: [], rejected: [] };

  // As notas que já estão na carteira, relidas agora. O preview pode ter minutos de idade.
  const todasNotas = positions.flatMap((p) => p.trades.map((t) => t.noteNumber));
  const jaImportadas = new Set(await importedNoteNumbers(userId, todasNotas));
  result.skippedNotes = Array.from(jaImportadas).sort();

  await db.transaction(async (tx) => {
    for (const pos of positions) {
      const ticker = pos.ticker.trim().toUpperCase();

      if (!TICKER.test(ticker)) {
        result.rejected.push({ ticker: pos.ticker, reason: "Não é um código de negociação da B3." });
        continue;
      }
      // A mesma régua do cadastro manual: o sufixo do ticker não pode contradizer a
      // categoria escolhida. Sem isto, a importação seria um caminho lateral para criar
      // exatamente o estado que a validação de cadastro existe para impedir.
      const conflito = categoryConflict(ticker, pos.category);
      if (conflito) {
        result.rejected.push({ ticker, reason: conflito });
        continue;
      }

      const compras = pos.trades.filter((t) => t.side === "compra" && !jaImportadas.has(t.noteNumber));
      for (const venda of pos.trades.filter((t) => t.side === "venda")) {
        result.salesNotImported.push({
          ticker,
          quantity: venda.quantity,
          price: venda.price,
          tradeDate: venda.tradeDate,
        });
      }

      if (compras.length === 0) continue;
      if (compras.some((t) => !(t.quantity > 0) || !(t.price > 0))) {
        result.rejected.push({ ticker, reason: "Quantidade ou preço não positivo em alguma operação." });
        continue;
      }

      const assetId = await ensureAsset(tx, userId, ticker, pos.category);

      await tx.insert(assetPurchasesTable).values(
        compras.map((t) => ({
          userId,
          assetId,
          quantity: String(t.quantity),
          unitPrice: String(t.price),
          tradeDate: t.tradeDate,
          brokerNoteNumber: t.noteNumber,
        })),
      );

      // O cache vem do replay dos lançamentos, nunca de uma média calculada aqui.
      await recomputeAssetCache(assetId, tx);

      result.imported.push({
        ticker,
        purchases: compras.length,
        quantity: compras.reduce((s, t) => s + t.quantity, 0),
      });
    }
  });

  return result;
}

/**
 * O id da posição, criando-a se ainda não existir.
 *
 * Nasce com quantidade e preço zerados de propósito: `recomputeAssetCache` preenche os
 * dois a partir dos lançamentos logo em seguida, e escrever um valor de palpite aqui
 * seria um número sem procedência com janela para ser lido por outra requisição.
 */
async function ensureAsset(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: number,
  ticker: string,
  category: string,
): Promise<number> {
  const [existente] = await tx
    .select({ id: assetsTable.id })
    .from(assetsTable)
    .where(and(eq(assetsTable.userId, userId), eq(assetsTable.ticker, ticker)));
  if (existente) return existente.id;

  const [criado] = await tx
    .insert(assetsTable)
    .values({ userId, ticker, category, quantity: "0", averagePrice: "0" })
    .returning({ id: assetsTable.id });
  return criado.id;
}

/** Quais destes números de nota o usuário já importou. */
export async function importedNoteNumbers(userId: number, noteNumbers: string[]): Promise<string[]> {
  if (noteNumbers.length === 0) return [];
  const rows = await db
    .selectDistinct({ noteNumber: assetPurchasesTable.brokerNoteNumber })
    .from(assetPurchasesTable)
    .innerJoin(assetsTable, eq(assetPurchasesTable.assetId, assetsTable.id))
    .where(
      and(
        eq(assetsTable.userId, userId),
        isNotNull(assetPurchasesTable.brokerNoteNumber),
        inArray(assetPurchasesTable.brokerNoteNumber, noteNumbers),
      ),
    );
  return rows.map((r) => r.noteNumber!);
}
