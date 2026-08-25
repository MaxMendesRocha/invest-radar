import { getFinancialSeriesForTicker, type FinancialPeriod } from "./financial-history";

/**
 * Lucro normalizado: o que a companhia ganha num ano TÍPICO, e não no último.
 *
 * Existe porque avaliar uma ação pelo lucro dos últimos doze meses ancora a conta num
 * número que quase nunca representa a empresa. Medido sobre as 491 companhias com cinco
 * exercícios completos na base da CVM:
 *
 * - o desvio-padrão do lucro anual é **70% da média** na companhia mediana (p25 = 0,38,
 *   p75 = 1,64);
 * - **258 das 491 (53%) tiveram pelo menos um ano de prejuízo** nos últimos cinco;
 * - 41 tiveram prejuízo nos cinco.
 *
 * Ou seja: normalizar não é refinamento cosmético. É a diferença entre avaliar a empresa
 * e avaliar o ano dela.
 *
 * ## Mediana, e não média
 *
 * Com um ano de prejuízo grande, a média despenca ou vira negativa, e a companhia perde
 * a avaliação inteira por causa de um exercício. A mediana atravessa isso, e é a mesma
 * escolha que `sector-benchmarks` já fez pelo mesmo motivo — lá, uma empresa com P/L
 * corrompido distorcia a referência de todo o setor.
 *
 * ## Quanto isso muda, medido
 *
 * Entre as 307 companhias com último exercício e mediana de cinco anos ambos positivos,
 * a razão mediana normalizado/último é 0,93 — pequena no agregado. Mas a distribuição
 * não é: **88 (29%) têm lucro normalizado abaixo de 70% do último ano**, e 48 (16%) acima
 * de 140%. Em quase metade dos casos a base de avaliação se move mais de 30%.
 *
 * E há 66 casos em que o SINAL inverte: 27 companhias com último exercício positivo e
 * mediana não positiva — um ano bom depois de quatro ruins —, e 39 no contrário. São
 * exatamente os casos em que avaliar pelo último ano erra mais feio.
 */

/**
 * Exercícios usados na normalização.
 *
 * Cinco cobre um ciclo curto sem exigir história que a maioria não tem: 491 das 627
 * companhias da base têm cinco exercícios completos. Sete ou dez descreveriam melhor o
 * ciclo e reduziriam a cobertura sem contrapartida clara — e a série da CVM começa em
 * 2014, então dez anos excluiria quase toda companhia que abriu capital desde então.
 */
export const EXERCICIOS_NORMALIZACAO = 5;

/** Mínimo para a mediana significar alguma coisa: com dois, ela é a média dos dois. */
export const EXERCICIOS_MINIMOS = 3;

export interface NormalizedEarnings {
  /** Mediana do lucro líquido anual, em reais. Pode ser negativa. */
  value: number;
  /** Quantos exercícios entraram — entre EXERCICIOS_MINIMOS e EXERCICIOS_NORMALIZACAO. */
  years: number;
  /** Exercícios com prejuízo na janela. Mais da metade das companhias tem ao menos um. */
  lossYears: number;
  /** Lucro do exercício mais recente, para quem quiser comparar as duas bases. */
  latest: number;
  /**
   * Desvio-padrão sobre a média absoluta — quanto o lucro oscila. A mediana do universo
   * é 0,70. Acima disso, a companhia é mais cíclica que a média, e a própria normalização
   * é menos confiável: é informação sobre a CONTA, não sobre a empresa.
   */
  volatility: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const meio = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[meio - 1] + sorted[meio]) / 2 : sorted[meio];
}

/**
 * Normaliza a partir de uma série já lida. Puro — a leitura fica com quem chama.
 *
 * `null` com menos exercícios que o mínimo: com um ou dois anos não há o que normalizar,
 * e devolver a média de dois anos com nome de "normalizado" seria vestir o mesmo número
 * de outra roupa.
 */
export function normalizeEarnings(series: FinancialPeriod[]): NormalizedEarnings | null {
  // A série vem do mais antigo para o mais recente (getFinancialSeries ordena assim).
  const janela = series.slice(-EXERCICIOS_NORMALIZACAO);
  if (janela.length < EXERCICIOS_MINIMOS) return null;

  const valores = janela.map((p) => p.value);
  const media = valores.reduce((s, v) => s + v, 0) / valores.length;
  const variancia = valores.reduce((s, v) => s + (v - media) ** 2, 0) / valores.length;

  return {
    value: median(valores),
    years: janela.length,
    lossYears: valores.filter((v) => v < 0).length,
    latest: valores[valores.length - 1],
    // Média zero (raro, mas acontece em holding sem operação) tornaria a razão infinita.
    volatility: media === 0 ? 0 : Math.sqrt(variancia) / Math.abs(media),
  };
}

/**
 * O mesmo, buscando a série pelo ticker.
 *
 * `null` também quando não há ponte ticker→CNPJ — BDR, FII e ETF caem aqui, e é a
 * resposta certa: a CVM não publica demonstração de nenhum dos três.
 */
export async function normalizedEarningsFor(ticker: string): Promise<NormalizedEarnings | null> {
  return normalizeEarnings(await getFinancialSeriesForTicker(ticker, "lucro_liquido"));
}

/**
 * O fator que converte a base do último exercício na base normalizada.
 *
 * É por aqui que a série histórica entra na avaliação sem precisar do número de ações: o
 * lucro por ação do último exercício é derivável do preço e do P/L que o provedor já
 * entrega (`preço ÷ P/L`), e este fator o traduz para a base normalizada. Mesmo truque de
 * `computeFiiPriceZones`, que deriva o VP/cota de `preço ÷ P/VP` em vez de pedir a
 * quantidade de cotas.
 *
 * `null` quando o último exercício não é positivo (a razão não teria significado) ou
 * quando o normalizado não é positivo — nesse caso não existe avaliação por lucro, e
 * inventar uma produziria preço justo negativo.
 */
export function normalizationFactor(n: NormalizedEarnings): number | null {
  if (!(n.latest > 0) || !(n.value > 0)) return null;
  return n.value / n.latest;
}
