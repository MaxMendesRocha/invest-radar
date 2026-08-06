import type { SectorBenchmark } from "@workspace/db";
import type { DividendFrequencyLabel } from "./market-data";
import type { FinancialHealth } from "./financial-health-engine";

/**
 * Prêmio de dividendo sobre o setor — para responder "onde colocar o próximo
 * aporte" ordenando ativos entre si.
 *
 * Existe porque as duas alternativas óbvias não servem:
 *
 * Ordenar por dividend yield puro premia armadilha de dividendo — yield alto por
 * preço em queda, ou distribuição acima do que o caixa sustenta.
 *
 * E valor justo por Gordon não se sustenta com os dados disponíveis. A brapi serve
 * só 12 meses de histórico de provento para FII, então não há como medir crescimento
 * justamente onde a cadência é regular; e o crescimento ano-a-ano das ações é
 * volátil demais para servir de perpetuidade (PETR4 −46,9%, TAEE11 +91,7%, WEGE3
 * +19,6% no último ano). Pior: com g fixo, o desconto de Gordon é DY/r − 1, que
 * sendo r a mesma constante para todos ordena EXATAMENTE igual ao dividend yield —
 * a complexidade toda não acrescentaria informação ao ranking.
 *
 * Aqui o yield é comparado com a mediana do próprio setor, o que neutraliza o nível
 * de yield característico de cada segmento (FII de papel paga estruturalmente mais
 * que tijolo), e é qualificado pela sustentabilidade real da distribuição. Os dois
 * lados da comparação são dado observado: nenhum parâmetro escolhido entra na conta.
 */

export type SustainabilityFlag = "coberto" | "apertado" | "descoberto" | "desconhecido";

export interface DividendValueInput {
  dividendYield: number | null; // decimal (0.089 = 8,9%)
  sector: string | null;
  benchmark: SectorBenchmark | null;
  frequency: DividendFrequencyLabel | null;
  financialHealth: FinancialHealth | null;
}

export interface DividendValue {
  /** Diferença em pontos percentuais entre o DY do ativo e a mediana do setor. */
  premiumOverSectorPP: number;
  sectorMedianYield: number;
  sampleSize: number;
  sustainability: SustainabilityFlag;
  /** Cadência regular é pré-requisito para tratar o yield como fluxo esperado. */
  regularCadence: boolean;
}

export type DividendValueResult =
  | { available: true; value: DividendValue }
  | { available: false; reason: "sem_yield" | "sem_referencia_setorial" };

const REGULAR_FREQUENCIES = new Set<DividendFrequencyLabel>(["Mensal", "Trimestral", "Semestral"]);

/**
 * Cobertura do dividendo pelo fluxo de caixa livre. Acima de 1 o caixa gerado paga a
 * distribuição; abaixo, ela está saindo de outro lugar (caixa acumulado, dívida ou
 * venda de ativo) e não se sustenta indefinidamente.
 *
 * "desconhecido" quando o provider não traz fluxo de caixa — comum em FII, cuja
 * estrutura não publica DFC como empresa operacional. Nunca é tratado como coberto.
 */
function classifySustainability(health: FinancialHealth | null): SustainabilityFlag {
  const coverage = health?.dividendCashCoverage;
  if (coverage == null) return "desconhecido";
  if (coverage >= 1.2) return "coberto";
  if (coverage >= 1) return "apertado";
  return "descoberto";
}

export function computeDividendValue(input: DividendValueInput): DividendValueResult {
  const { dividendYield, benchmark, frequency, financialHealth } = input;

  if (dividendYield == null || dividendYield <= 0) return { available: false, reason: "sem_yield" };

  const medianYield = benchmark?.avgDividendYield != null ? parseFloat(benchmark.avgDividendYield) : null;
  if (medianYield == null || medianYield <= 0) return { available: false, reason: "sem_referencia_setorial" };

  return {
    available: true,
    value: {
      premiumOverSectorPP: Math.round((dividendYield - medianYield) * 10000) / 100,
      sectorMedianYield: Math.round(medianYield * 10000) / 100,
      sampleSize: benchmark!.sampleSize,
      sustainability: classifySustainability(financialHealth),
      regularCadence: frequency != null && REGULAR_FREQUENCIES.has(frequency),
    },
  };
}

const SUSTAINABILITY_LABEL: Record<SustainabilityFlag, string> = {
  coberto: "distribuição coberta pelo fluxo de caixa livre",
  apertado: "distribuição no limite do que o caixa gera",
  descoberto: "distribuição acima do fluxo de caixa livre — não se sustenta sem outra fonte",
  desconhecido: "cobertura por caixa não disponível para este ativo",
};

/**
 * Ordena do mais atrativo para o menos, para responder onde vai o próximo aporte.
 *
 * Sustentabilidade e cadência entram como critério de DESEMPATE ANTERIOR ao prêmio,
 * não como peso somado: um yield descoberto não é um yield bom com um desconto — é
 * uma distribuição que vai cair. Ordenar por uma média ponderada deixaria um prêmio
 * grande o bastante compensar a falta de cobertura, que é exatamente a armadilha que
 * este ranking existe para evitar.
 */
//
// "desconhecido" empata com "coberto" em vez de ficar entre ele e "apertado". A
// cobertura por caixa vem de financialData, que não cobre FII — a estrutura de um
// fundo imobiliário não publica DFC como empresa operacional. Penalizar o
// desconhecido jogaria TODO FII abaixo de qualquer ação com dado, o que seria
// ordenar por diferença de divulgação contábil e não por mérito do ativo. O que o
// desempate precisa fazer é demover quem comprovadamente não cobre a distribuição,
// não premiar quem por acaso publica mais.
const SUSTAINABILITY_RANK: Record<SustainabilityFlag, number> = {
  coberto: 0,
  desconhecido: 0,
  apertado: 1,
  descoberto: 2,
};

export function compareDividendValue(a: DividendValue, b: DividendValue): number {
  if (a.regularCadence !== b.regularCadence) return a.regularCadence ? -1 : 1;
  const rank = SUSTAINABILITY_RANK[a.sustainability] - SUSTAINABILITY_RANK[b.sustainability];
  if (rank !== 0) return rank;
  return b.premiumOverSectorPP - a.premiumOverSectorPP;
}

/** Linha pronta para os prompts de IA e para o card. */
export function describeDividendValue(result: DividendValueResult, sector: string | null): string {
  if (!result.available) {
    return result.reason === "sem_yield"
      ? "Prêmio de dividendo não calculado (ativo sem dividend yield real no período)."
      : `Prêmio de dividendo não calculado (sem mediana setorial${sector ? ` para "${sector}"` : ""} com amostra suficiente).`;
  }
  const v = result.value;
  const posicao = v.premiumOverSectorPP >= 0
    ? `${v.premiumOverSectorPP.toFixed(1)} p.p. ACIMA`
    : `${Math.abs(v.premiumOverSectorPP).toFixed(1)} p.p. ABAIXO`;
  return (
    `Prêmio de dividendo: ${posicao} da mediana do setor${sector ? ` "${sector}"` : ""}, ` +
    `que é de ${v.sectorMedianYield.toFixed(1)}% (amostra real de ${v.sampleSize} tickers). ` +
    `${SUSTAINABILITY_LABEL[v.sustainability][0].toUpperCase()}${SUSTAINABILITY_LABEL[v.sustainability].slice(1)}. ` +
    `${v.regularCadence ? "Cadência de pagamento regular." : "Cadência de pagamento irregular — o yield passado não indica fluxo esperado."}`
  );
}
