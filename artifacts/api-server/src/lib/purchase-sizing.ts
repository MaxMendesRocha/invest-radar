/**
 * De reais para quantidade: quantas ações, cotas ou frações de título a fatia compra.
 *
 * O plano de aporte parava no valor por classe ("R$ 206,86 em FIIs") e listava os
 * candidatos sem dizer quanto de cada um. Quem recebe esse número ainda precisa abrir a
 * corretora, olhar a cotação e dividir na mão — e é justamente na divisão que aparece o
 * que a tela escondia: fatia que não compra nem uma cota, e sobra que fica sem destino.
 *
 * Duas granularidades diferentes, porque os mercados são diferentes:
 *
 * - **Bolsa**: unidade inteira. O lote padrão da B3 é 100, mas o mercado fracionário
 *   negocia a partir de 1 ação/cota e é assim que pessoa física compra — sugerir
 *   múltiplo de 100 tornaria quase todo aporte pequeno impossível.
 * - **Tesouro Direto**: fração de 0,01 título, com piso de R$ 30 por compra. São normas
 *   publicadas pelo Tesouro, não campos do arquivo de dados abertos — as mesmas
 *   constantes já documentadas em treasury-engine.ts.
 *
 * Nada aqui arredonda para cima. Sugerir uma quantidade que custa mais do que a fatia
 * seria mandar gastar dinheiro que o usuário não disse que tem.
 *
 * A conta inteira roda em CENTAVOS INTEIROS, e não é preciosismo: com divisão em ponto
 * flutuante, uma fatia que compra exatamente 3 ações a R$ 41,90 dá 2,9999999999999996 e
 * o floor devolve 2 — o app mandaria comprar uma ação a menos e sobrar R$ 41,90 justo
 * nos casos em que a conta fecha redonda.
 */

export interface PurchaseSizing {
  /** Cotação usada na conta — a tela precisa dela para o usuário conferir. */
  unitPrice: number;
  /** Quantidade a comprar. Zero é resposta válida: a fatia não alcança uma unidade. */
  units: number;
  investedAmount: number;
  /** O que sobra da fatia. Sem isso a soma não fecha e a tela parece errada. */
  leftover: number;
}

/** Fração mínima do Tesouro Direto, em centésimos de título. */
const TREASURY_FRACTION_STEPS = 100;
const TREASURY_MIN_PURCHASE_CENTS = 3000;

function toCents(value: number): number {
  return Math.round(value * 100);
}

function usable(slice: number, unitPrice: number | null | undefined): { sliceCents: number; priceCents: number } | null {
  if (unitPrice == null || !Number.isFinite(unitPrice) || unitPrice <= 0) return null;
  if (!Number.isFinite(slice) || slice <= 0) return null;
  const sliceCents = toCents(slice);
  const priceCents = toCents(unitPrice);
  return priceCents > 0 && sliceCents > 0 ? { sliceCents, priceCents } : null;
}

/**
 * Ações, FIIs, ETFs e BDRs — unidades inteiras.
 *
 * Devolve null quando não há cotação real. Estimar preço para poder mostrar uma
 * quantidade seria inventar o número mais fácil de conferir na tela, e o mais
 * constrangedor de errar.
 */
export function sizeWholeUnits(slice: number, unitPrice: number | null | undefined): PurchaseSizing | null {
  const cents = usable(slice, unitPrice);
  if (!cents) return null;

  const units = Math.floor(cents.sliceCents / cents.priceCents);
  const investedCents = units * cents.priceCents;
  return {
    unitPrice: cents.priceCents / 100,
    units,
    investedAmount: investedCents / 100,
    leftover: (cents.sliceCents - investedCents) / 100,
  };
}

/**
 * Tesouro Direto — múltiplos de 0,01 título, respeitando o piso de R$ 30.
 *
 * O piso é o que impede "0,01 título = R$ 8,42": abaixo de R$ 30 o Tesouro não executa,
 * então a resposta honesta é zero, e a tela diz que a fatia não dá para esse título.
 */
export function sizeTreasuryFraction(slice: number, unitPrice: number | null | undefined): PurchaseSizing | null {
  const cents = usable(slice, unitPrice);
  if (!cents) return null;

  // Custo de 0,01 título em centavos pode não ser inteiro (PU de R$ 196,415 daria
  // 1,96415 centavos), então a divisão é feita antes de dividir por 100.
  const steps = Math.floor((cents.sliceCents * TREASURY_FRACTION_STEPS) / cents.priceCents);
  const investedCents = Math.round((steps * cents.priceCents) / TREASURY_FRACTION_STEPS);

  if (investedCents < TREASURY_MIN_PURCHASE_CENTS) {
    return { unitPrice: cents.priceCents / 100, units: 0, investedAmount: 0, leftover: cents.sliceCents / 100 };
  }
  return {
    unitPrice: cents.priceCents / 100,
    units: steps / TREASURY_FRACTION_STEPS,
    investedAmount: investedCents / 100,
    leftover: (cents.sliceCents - investedCents) / 100,
  };
}
