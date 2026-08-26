import { getFinancialSeriesForTicker, type FinancialPeriod } from "./financial-history";

/**
 * De onde vem o ROE: margem × giro × alavancagem.
 *
 * A identidade é aritmética, não modelo: `lucro/PL` é o mesmo que
 * `(lucro/receita) × (receita/ativo) × (ativo/PL)` — receita e ativo se cancelam. Por isso
 * a decomposição não afirma nada além do que os quatro números já dizem; ela só abre o
 * ROE nas três alavancas que o produzem.
 *
 * ## Por que vale a pena mostrar
 *
 * Dois ROEs de 21% podem ser coisas opostas. Um vem de margem alta com pouca dívida; o
 * outro, de margem fina multiplicada por alavancagem de 15×. O segundo é frágil a juro e
 * a inadimplência, e o número agregado esconde isso — é exatamente o que um banco parece
 * quando olhado só pelo ROE.
 *
 * ## O que este módulo se recusa a fazer
 *
 * **Não emite diagnóstico interpretativo.** Nem sequer elege uma alavanca dominante — ver
 * o registro adiante sobre por que essa ideia foi derrubada pelo harness. Dizer que a
 * rentabilidade "vem de forte poder de precificação" seria afirmar sobre o negócio, não
 * sobre a conta, e num banco alavancado a frase contradiz os próprios números.
 *
 * **Não usa ROE de provedor.** O ROE aqui é o produto das três alavancas medidas na mesma
 * fonte e no mesmo exercício. Misturar com o ROE da brapi produziria duas respostas para
 * a mesma pergunta na mesma tela, que é o defeito que esta decomposição existe para
 * tornar impossível de esconder.
 */

/** As quatro contas da CVM que a identidade consome. Todas com cobertura de 100%. */
const METRICAS = ["lucro_liquido", "receita", "ativo_total", "patrimonio_liquido"] as const;

export interface DupontBreakdown {
  /** Fim do exercício de onde os quatro números saíram. */
  periodEnd: string;
  /** Lucro ÷ receita. */
  netMargin: number;
  /** Receita ÷ ativo total. */
  assetTurnover: number;
  /** Ativo total ÷ patrimônio líquido. */
  leverage: number;
  /** O produto das três. É o ROE que a tela mostra — não vem de provedor. */
  roe: number;
}

/**
 * O valor mais recente de uma série, ou null.
 *
 * A série vem do mais antigo para o mais recente e já resolve versão e retificação em
 * `financial-history.ts` — aqui só interessa a última linha.
 */
function ultimo(series: FinancialPeriod[]): FinancialPeriod | null {
  return series.length > 0 ? series[series.length - 1] : null;
}

/**
 * A decomposição, ou null quando não dá para fazê-la honestamente.
 *
 * Devolve null — e não um número parcial — em quatro situações:
 *
 * 1. **Falta alguma das quatro métricas.** Sem ativo total não há giro, e sem giro a
 *    identidade não fecha; mostrar duas das três alavancas convidaria a multiplicá-las.
 * 2. **Os quatro não são do mesmo exercício.** Margem de 2025 com alavancagem de 2023 dá
 *    um produto que não é o ROE de ano nenhum.
 * 3. **Receita, ativo ou patrimônio não positivos.** Divisão por zero, e patrimônio
 *    negativo (que existe de verdade em empresa quebrada) inverte o sinal do ROE e
 *    produziria uma alavancagem negativa sem significado como alavanca.
 * 4. **Prejuízo.** Aqui a decomposição continua valendo aritmeticamente — margem negativa
 *    × giro × alavancagem = ROE negativo, e isso é informação legítima. Prejuízo NÃO é
 *    motivo de recusa.
 */
export function computeDupont(valores: {
  periodEnd: string;
  lucro: number;
  receita: number;
  ativo: number;
  patrimonio: number;
}): DupontBreakdown | null {
  const { periodEnd, lucro, receita, ativo, patrimonio } = valores;
  if (!(receita > 0) || !(ativo > 0) || !(patrimonio > 0)) return null;

  const netMargin = lucro / receita;
  const assetTurnover = receita / ativo;
  const leverage = ativo / patrimonio;

  return {
    periodEnd,
    netMargin,
    assetTurnover,
    leverage,
    roe: netMargin * assetTurnover * leverage,
  };
}

/**
 * ## Por que NÃO existe aqui uma "alavanca dominante"
 *
 * A primeira versão deste módulo eleria a alavanca dominante comparando os logaritmos das
 * três — o raciocínio sendo que, como o ROE é o PRODUTO delas, no log ele é a SOMA, e a
 * maior parcela contribuiria mais.
 *
 * O harness derrubou a ideia no primeiro caso não-banco. Margem é sempre uma fração
 * (log negativo) e giro quase sempre também; alavancagem é sempre maior que 1 (log
 * positivo). Então a alavancagem ganhava SEMPRE — numa indústria de margem de 30% e
 * alavancagem de 1,3× ela ainda era eleita "dominante", o que é o oposto da verdade.
 *
 * Comparar 17,6% com 0,08× e 15,2× não significa nada: são grandezas diferentes. A
 * comparação que teria sentido é contra a MEDIANA DO SETOR de cada alavanca — quem está
 * mais acima dos pares é o que distingue a companhia. Só que não temos essas medianas
 * medidas, e inventá-las seria a mesma classe de erro que este projeto já recusou.
 *
 * Então a decomposição mostra os três números e a identidade, e não os ordena. Quem lê vê
 * que 15,2× é grande sem precisar que o app diga isso.
 */

/** A decomposição de um ticker a partir da série anual da CVM. Null sem série. */
export async function dupontFor(ticker: string): Promise<DupontBreakdown | null> {
  const series = await Promise.all(
    METRICAS.map((m) => getFinancialSeriesForTicker(ticker, m)),
  );
  const ultimos = series.map(ultimo);
  if (ultimos.some((u) => u == null)) return null;

  // Mesmo exercício nos quatro. Companhia que publicou o balanço e ainda não a DRE do ano
  // seguinte deixaria as séries desalinhadas, e o produto não seria o ROE de ano nenhum.
  const periodos = new Set(ultimos.map((u) => u!.periodEnd));
  if (periodos.size !== 1) return null;

  const [lucro, receita, ativo, patrimonio] = ultimos.map((u) => u!.value);
  return computeDupont({ periodEnd: ultimos[0]!.periodEnd, lucro, receita, ativo, patrimonio });
}

/** A identidade escrita por extenso, para a tela mostrar a conta fechando. */
export function describeDupont(d: DupontBreakdown): string {
  const pct = (v: number) => `${(v * 100).toFixed(1).replace(".", ",")}%`;
  const mult = (v: number) => `${v.toFixed(2).replace(".", ",")}×`;
  return `${pct(d.netMargin)} × ${mult(d.assetTurnover)} × ${mult(d.leverage)} = ${pct(d.roe)}`;
}
