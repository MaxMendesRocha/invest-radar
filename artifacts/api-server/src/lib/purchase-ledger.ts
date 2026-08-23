/**
 * Reconstrói quantidade e preço médio de uma posição a partir das compras registradas.
 *
 * A regra é a brasileira, a mesma que qualquer corretora aplica e a mesma que o app já
 * praticava espalhada em dois lugares (a consolidação de `POST /assets` e a baixa de
 * venda):
 *
 *   - COMPRA faz média ponderada:  novoPM = (qtd·PM + qtdComprada·preço) / (qtd + qtdComprada)
 *   - VENDA reduz a quantidade e NÃO altera o preço médio.
 *
 * Consolidar deixa de ser um `update` que sobrescreve o número anterior e passa a ser
 * consequência de somar lançamentos — o que torna o preço médio auditável: dá pra ver de
 * onde veio, e corrigir uma linha errada sem apagar as outras.
 */

/** 1e-6 é a menor quantidade representável em numeric(18,6), a precisão das colunas. */
export const QUANTITY_EPSILON = 1e-6;

export interface LedgerPurchase {
  /** "YYYY-MM-DD" — data da negociação. */
  tradeDate: string;
  quantity: number;
  unitPrice: number;
}

export interface LedgerSale {
  /** "YYYY-MM-DD" */
  saleDate: string;
  quantity: number;
}

export interface ReplayedPosition {
  quantity: number;
  /** Preço médio das compras. Zero quando não sobrou nada comprado para promediar. */
  averagePrice: number;
  /** Data da compra mais antiga — o que `assets.purchaseDate` passa a guardar. null sem compras. */
  firstPurchaseDate: string | null;
}

type Event =
  | { kind: "compra"; date: string; quantity: number; unitPrice: number }
  | { kind: "venda"; date: string; quantity: number };

/**
 * Replay em ordem cronológica de compras e vendas.
 *
 * A ordem importa para a quantidade — vender antes de comprar não é a mesma coisa que o
 * inverso —, mas NÃO para o preço médio, que é média ponderada e portanto comutativa
 * entre compras. Empate de data resolve com a compra primeiro: é o único jeito de uma
 * venda no mesmo dia ter de onde sair.
 */
export function replayPosition(purchases: LedgerPurchase[], sales: LedgerSale[]): ReplayedPosition {
  const events: Event[] = [
    ...purchases.map((p): Event => ({ kind: "compra", date: p.tradeDate, quantity: p.quantity, unitPrice: p.unitPrice })),
    ...sales.map((s): Event => ({ kind: "venda", date: s.saleDate, quantity: s.quantity })),
  ].sort((a, b) => {
    const byDate = a.date.localeCompare(b.date);
    if (byDate !== 0) return byDate;
    return a.kind === b.kind ? 0 : a.kind === "compra" ? -1 : 1;
  });

  let quantity = 0;
  let averagePrice = 0;

  for (const e of events) {
    if (e.kind === "compra") {
      const novaQtd = quantity + e.quantity;
      if (novaQtd <= 0) continue; // compra de quantidade nula ou negativa não é evento
      averagePrice = (quantity * averagePrice + e.quantity * e.unitPrice) / novaQtd;
      quantity = novaQtd;
      continue;
    }

    quantity -= e.quantity;
    if (quantity <= QUANTITY_EPSILON) {
      // Posição zerada encerra o ciclo: o preço médio de uma recompra futura começa do
      // zero, não herda o da posição anterior. Somar dois ciclos daria um número que não
      // corresponde a nada que a pessoa pagou.
      quantity = 0;
      averagePrice = 0;
    }
  }

  const datas = purchases.map((p) => p.tradeDate).sort();
  return {
    quantity: round6(quantity),
    averagePrice: round6(averagePrice),
    // Só faz sentido enquanto há posição: zerou, a data da primeira compra do ciclo
    // anterior não descreve mais nada.
    firstPurchaseDate: quantity > 0 && datas.length > 0 ? datas[0] : null,
  };
}

/** Arredonda para a escala do banco (numeric(18,6)), evitando ruído de ponto flutuante. */
function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
