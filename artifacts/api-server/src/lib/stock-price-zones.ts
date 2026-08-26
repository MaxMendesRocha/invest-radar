import type { NormalizedEarnings } from "./normalized-earnings";
import { normalizationFactor } from "./normalized-earnings";

/**
 * Faixa de entrada em reais para AÇÃO, por múltiplo normalizado contra o próprio setor.
 *
 * O app já produzia isso para FII (`computeFiiPriceZones`) e não produzia para ação —
 * era a maior assimetria entre as duas réguas. Este módulo fecha a lacuna seguindo a
 * mesma estrutura, de propósito: se as duas telas dizem "faixa de entrada", a expressão
 * tem de significar a mesma coisa nas duas.
 *
 * ## Duas leituras que podem discordar, e não uma média
 *
 * Como no FII, são duas contas independentes:
 *
 * - **por lucro**: o que o setor paga por lucro, aplicado ao lucro NORMALIZADO da
 *   companhia (mediana de até cinco exercícios da CVM, não os últimos doze meses);
 * - **por patrimônio**: o que o setor paga por patrimônio, aplicado ao valor patrimonial
 *   por ação.
 *
 * Elas medem coisas diferentes e podem discordar — e o desacordo É a informação. Forçar
 * uma média esconderia justamente o caso interessante: empresa barata pelo patrimônio e
 * cara pelo lucro é uma descrição, não um erro de conta.
 *
 * ## Qual das duas é mais firme, medido
 *
 * A de patrimônio. Sobre cinco exercícios das companhias na base da CVM, a volatilidade
 * mediana do patrimônio líquido é **0,20** contra **0,70** do lucro, e 101 de 500
 * companhias tiveram algum ano de patrimônio não positivo contra 258 de 491 no lucro. Ou
 * seja: a leitura por lucro tem mais poder de discriminar e menos estabilidade. As duas
 * aparecem, e a ordem em que se lê é do leitor — o motor não escolhe por ele.
 *
 * ## A faixa vem da dispersão do setor, não de uma margem de segurança arbitrada
 *
 * A especificação sugere `MaximumBuyPrice = FairValue × (1 − MOS)` com MOS de 20%. Os 20%
 * seriam um número escolhido. Aqui o intervalo é o **primeiro quartil e a mediana do
 * próprio setor**: comprar ao múltiplo do p25 é pagar o que se paga pelas mais baratas do
 * setor; ao da mediana, o que se paga por uma típica. É a mesma lógica de
 * `FII_PVP_HEALTHY_DISCOUNT_RANGE`, com a diferença de que ali a faixa é fixa (0,85–0,95
 * do VP) e aqui ela é medida em cada setor, a cada varredura.
 *
 * ## Por que não é preciso saber o número de ações
 *
 * O lucro por ação do último exercício é `preço ÷ P/L`, e o valor patrimonial por ação é
 * `preço ÷ P/VP` — os dois derivam de números que o provedor já entrega. Mesmo truque de
 * `computeFiiPriceZones`, que obtém o VP/cota sem nunca pedir a quantidade de cotas. A
 * série da CVM entra como FATOR de normalização (`normalizado ÷ último`), não como valor
 * absoluto, o que também a torna imune a erro de escala na conversão por ação.
 */

/** Uma leitura: o preço que a companhia teria ao múltiplo do setor. */
export interface PriceZone {
  /** Preço ao múltiplo do primeiro quartil do setor — a ponta barata da faixa. */
  low: number;
  /** Preço ao múltiplo da mediana do setor — o "preço típico para este setor". */
  fair: number;
}

export interface StockPriceZones {
  /** Pela conta de lucro normalizado. Null sem histórico, ou com lucro não positivo. */
  earnings: PriceZone | null;
  /** Pela conta de patrimônio. Null sem P/VP real ou sem referência do setor. */
  book: PriceZone | null;
  /**
   * Quantos exercícios entraram na normalização e quantos foram de prejuízo — vai junto
   * porque uma faixa apoiada em três anos, dois deles no vermelho, não vale o mesmo que
   * uma apoiada em cinco anos lucrativos, e quem lê precisa ver a diferença.
   */
  earningsBasis: { years: number; lossYears: number; volatility: number } | null;
}

export interface StockZonesInput {
  price: number;
  /** P/L corrente do provedor — usado só para derivar o lucro por ação, nunca comparado. */
  priceEarnings: number | null;
  priceToBook: number | null;
  normalized: NormalizedEarnings | null;
  sector: {
    medianPriceEarnings: number | null;
    p25PriceEarnings: number | null;
    medianPriceToBook: number | null;
    p25PriceToBook: number | null;
  };
}

/**
 * Converte a linha de `sector_benchmarks` no insumo deste módulo.
 *
 * Os campos vêm como `numeric` (string) do Postgres, e os quartis são nulos até a
 * primeira varredura semanal depois do deploy que os introduziu — nesse intervalo as
 * faixas simplesmente não saem, que é melhor do que sair com o mesmo número nas duas
 * pontas fingindo ser um intervalo.
 */
export function sectorReferenceFrom(row: {
  avgPriceEarnings: string | null;
  p25PriceEarnings: string | null;
  avgPriceToBook: string | null;
  p25PriceToBook: string | null;
} | null): StockZonesInput["sector"] {
  const num = (v: string | null | undefined): number | null => {
    if (v == null) return null;
    const parsed = parseFloat(v);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    medianPriceEarnings: num(row?.avgPriceEarnings),
    p25PriceEarnings: num(row?.p25PriceEarnings),
    medianPriceToBook: num(row?.avgPriceToBook),
    p25PriceToBook: num(row?.p25PriceToBook),
  };
}

/**
 * `null` quando NENHUMA das duas leituras sai — sem preço, sem referência de setor, ou
 * sem os dois múltiplos correntes. Nunca estima o que falta.
 *
 * Quando só uma sai, o objeto volta com a outra em null: é o mesmo comportamento da zona
 * de yield do FII, que fica nula sem derrubar a de P/VP.
 */
export function computeStockPriceZones(input: StockZonesInput): StockPriceZones | null {
  const { price, priceEarnings, priceToBook, normalized, sector } = input;
  if (!(price > 0)) return null;

  const earnings = earningsZone(price, priceEarnings, normalized, sector);
  const book = bookZone(price, priceToBook, sector);
  if (!earnings && !book) return null;

  return {
    earnings,
    book,
    earningsBasis: normalized
      ? { years: normalized.years, lossYears: normalized.lossYears, volatility: normalized.volatility }
      : null,
  };
}

function earningsZone(
  price: number,
  priceEarnings: number | null,
  normalized: NormalizedEarnings | null,
  sector: StockZonesInput["sector"],
): PriceZone | null {
  if (normalized == null) return null;
  // P/L não positivo significa prejuízo no último exercício: `preço ÷ P/L` daria um lucro
  // por ação negativo, e a faixa inteira sairia com sinal trocado.
  if (priceEarnings == null || !(priceEarnings > 0)) return null;

  const fator = normalizationFactor(normalized);
  if (fator == null) return null;

  const { medianPriceEarnings: mediana, p25PriceEarnings: p25 } = sector;
  if (mediana == null || p25 == null || !(mediana > 0) || !(p25 > 0)) return null;

  const lucroPorAcaoNormalizado = (price / priceEarnings) * fator;
  return { low: lucroPorAcaoNormalizado * p25, fair: lucroPorAcaoNormalizado * mediana };
}

function bookZone(
  price: number,
  priceToBook: number | null,
  sector: StockZonesInput["sector"],
): PriceZone | null {
  if (priceToBook == null || !(priceToBook > 0)) return null;

  const { medianPriceToBook: mediana, p25PriceToBook: p25 } = sector;
  if (mediana == null || p25 == null || !(mediana > 0) || !(p25 > 0)) return null;

  const valorPatrimonialPorAcao = price / priceToBook;
  return { low: valorPatrimonialPorAcao * p25, fair: valorPatrimonialPorAcao * mediana };
}

/** Onde a cotação cai em relação a uma das duas faixas. */
export type ZoneReading = "abaixo" | "dentro" | "acima";

/**
 * As duas leituras reduzidas ao que cabe numa linha, mais qual delas encabeça a frase.
 *
 * Existe para que a lista de Oportunidades e o detalhe do ativo não possam divergir: a
 * lista mostra a conclusão, o detalhe mostra a conta, e a comparação `preço × faixa`
 * acontece uma vez só, aqui. Se o frontend refizesse o `<` de cada lado, bastaria um
 * `<=` desalinhado para uma tela dizer "dentro" e a outra "abaixo" do mesmo número.
 */
export interface ZonesVerdict {
  earnings: ZoneReading | null;
  book: ZoneReading | null;
  /**
   * Qual leitura vai na frente na linha da lista, onde só cabe uma.
   *
   * É a de patrimônio sempre que ela existe, e o motivo está medido no topo deste
   * arquivo: sobre cinco exercícios, a volatilidade mediana do patrimônio líquido é 0,20
   * contra 0,70 do lucro. A mais firme encabeça; a outra vai como ressalva. Nunca é a
   * mais favorável — encabeçar pela que estiver mais barata seria escolher a conclusão
   * antes de fazer a conta.
   */
  lead: "lucro" | "patrimonio";
  /** As duas existem e não dizem a mesma coisa. O desacordo é a informação, não defeito. */
  disagree: boolean;
}

/** `null` quando não há faixa — nunca "dentro" por ausência de referência. */
export function readPriceZone(zone: PriceZone | null, price: number): ZoneReading | null {
  if (!zone || !(price > 0)) return null;
  if (price < zone.low) return "abaixo";
  if (price > zone.fair) return "acima";
  return "dentro";
}

export function summarizeStockPriceZones(zones: StockPriceZones | null, price: number): ZonesVerdict | null {
  if (!zones) return null;
  const earnings = readPriceZone(zones.earnings, price);
  const book = readPriceZone(zones.book, price);
  if (earnings == null && book == null) return null;

  return {
    earnings,
    book,
    lead: book != null ? "patrimonio" : "lucro",
    disagree: earnings != null && book != null && earnings !== book,
  };
}

const brl = (v: number): string => `R$ ${v.toFixed(2)}`;

/**
 * Texto para o prompt da IA e para a tela.
 *
 * Diz explicitamente que as duas leituras podem discordar, porque a alternativa é o
 * leitor achar que uma delas está errada quando as duas estão certas medindo coisas
 * diferentes.
 */
export function describeStockPriceZones(zones: StockPriceZones | null, price: number): string {
  if (!zones) return "";

  const partes: string[] = [];
  if (zones.earnings) {
    const b = zones.earningsBasis;
    const base = b
      ? ` (lucro normalizado de ${b.years} exercícios${b.lossYears > 0 ? `, ${b.lossYears} com prejuízo` : ""})`
      : "";
    partes.push(
      `Pelo lucro: faixa de compra entre ${brl(zones.earnings.low)} (múltiplo das mais baratas do setor) e `
      + `${brl(zones.earnings.fair)} (múltiplo da mediana do setor)${base}.`,
    );
  }
  if (zones.book) {
    partes.push(
      `Pelo patrimônio: entre ${brl(zones.book.low)} e ${brl(zones.book.fair)}, aplicando o P/VP do setor `
      + `ao valor patrimonial por ação.`,
    );
  }
  if (partes.length === 0) return "";

  partes.push(`Cotação atual: ${brl(price)}.`);
  if (zones.earnings && zones.book) {
    partes.push(
      "As duas contas medem coisas diferentes e podem discordar — barata pelo patrimônio e cara pelo "
      + "lucro é uma descrição da empresa, não erro de cálculo.",
    );
  }
  // O que estas faixas NÃO são: nem preço-alvo, nem previsão. São o preço que a companhia
  // teria se o mercado a tratasse como trata as pares dela HOJE.
  partes.push(
    "As faixas dizem o que o setor paga hoje por lucro e por patrimônio, aplicado a esta empresa — "
    + "não são preço-alvo nem projeção.",
  );
  return partes.join(" ");
}
