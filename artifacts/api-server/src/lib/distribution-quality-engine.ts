import {
  classifyDividendFrequency,
  computeDistributionMomentum,
  computeDividendTrend,
  type DividendEvent,
  type DividendFrequencyLabel,
} from "./market-data";

/**
 * Qualidade da distribuição de proventos — quão confiável é a renda que o ativo paga,
 * em oposição a quão alta ela é.
 *
 * Existe porque ordenar por dividend yield puro premia armadilha: yield sobe quando o
 * preço cai, e um pagamento extraordinário infla a janela de 12 meses sem dizer nada
 * sobre o próximo ano. O que separa renda confiável de renda aparente é se o ativo
 * PAGA O QUE COSTUMA PAGAR, no ritmo em que costuma pagar.
 *
 * NEUTRO ENTRE CLASSES, e isso é o ponto delicado. A régua de FII (analysis-engine.ts)
 * mede regularidade como "pagou em N dos últimos 12 meses" — o que faz sentido para
 * quem distribui todo mês e REPROVARIA qualquer ação: uma pagadora trimestral exemplar
 * pontuaria 4/12 e pareceria irregular. Aqui a regularidade é medida contra a cadência
 * DO PRÓPRIO ATIVO: um FII mensal com 12/12 e uma ação trimestral com 4/4 valem o
 * mesmo. Quem cai é quem falha na própria cadência, que é o sinal que interessa em
 * qualquer classe.
 *
 * Renda fixa e fundos ficam de fora porque o app não rastreia cupom como evento de
 * provento — não é uma escolha de produto, é ausência de dado.
 */

export type DistributionClassification = "Consistente" | "Atencao" | "Irregular" | "SemHistorico";

export interface DistributionQuality {
  cadence: DividendFrequencyLabel;
  paymentsLast12m: number;
  /** Quantos pagamentos a cadência prevê em 12 meses. Null quando a cadência é irregular. */
  expectedPayments: number | null;
  /** Observado ÷ esperado, teto 1. Null quando não há cadência definida para comparar. */
  regularity: number | null;
  /** Variação % da distribuição entre duas janelas iguais. Null sem base de comparação. */
  trendPercent: number | null;
  /** Qual janela sustentou a tendência — a mais curta que tinha dado dos dois lados. */
  trendWindow: "6m" | "12m" | null;
  classification: DistributionClassification;
}

const EXPECTED_PAYMENTS: Record<Exclude<DividendFrequencyLabel, "Irregular">, number> = {
  Mensal: 12,
  Trimestral: 4,
  Semestral: 2,
  Anual: 1,
};

// Abaixo disso a queda deixa de ser oscilação normal de distribuição e passa a ser
// tendência. Os dois patamares são o que separa "Consistente" de "Atencao" e
// "Atencao" de "Irregular".
const TREND_WARNING = -10;
const TREND_CRITICAL = -30;

const REGULARITY_GOOD = 0.9;
const REGULARITY_WARNING = 0.6;

/**
 * Só pagador frequente tem massa para uma janela de 6 meses: um semestral compararia
 * 1 pagamento contra 1, e um anual teria um dos lados vazio. Para esses, a comparação
 * honesta é ano contra ano — quando o provider tiver 24 meses de histórico, o que nem
 * sempre acontece.
 */
function trendFor(
  events: DividendEvent[],
  now: number,
  cadence: DividendFrequencyLabel,
): { percent: number; window: "6m" | "12m" } | null {
  const prefersShortWindow = cadence === "Mensal" || cadence === "Trimestral";

  if (prefersShortWindow) {
    const momentum = computeDistributionMomentum(events, now);
    if (momentum) return { percent: (momentum.ratio - 1) * 100, window: "6m" };
  }

  const yearOverYear = computeDividendTrend(events, now);
  if (yearOverYear) return { percent: yearOverYear.growthPercent, window: "12m" };

  // Cadência longa sem 24 meses de histórico: tenta a janela curta como último
  // recurso, já que uma comparação ruidosa ainda diz mais que nenhuma.
  if (!prefersShortWindow) {
    const momentum = computeDistributionMomentum(events, now);
    if (momentum) return { percent: (momentum.ratio - 1) * 100, window: "6m" };
  }

  return null;
}

function classify(
  cadence: DividendFrequencyLabel,
  regularity: number | null,
  trendPercent: number | null,
): DistributionClassification {
  // Cadência irregular já é o veredito: não há ritmo contra o qual medir falha.
  if (cadence === "Irregular") return "Irregular";

  const failsBadly = regularity != null && regularity < REGULARITY_WARNING;
  const collapsing = trendPercent != null && trendPercent < TREND_CRITICAL;
  if (failsBadly || collapsing) return "Irregular";

  const missesSome = regularity != null && regularity < REGULARITY_GOOD;
  const shrinking = trendPercent != null && trendPercent < TREND_WARNING;
  if (missesSome || shrinking) return "Atencao";

  return "Consistente";
}

export function computeDistributionQuality(events: DividendEvent[], now: number): DistributionQuality | null {
  const frequency = classifyDividendFrequency(events, now);
  if (!frequency) return null; // nenhum provento em 12 meses — quem chama decide o que exibir

  const expectedPayments =
    frequency.label === "Irregular" ? null : EXPECTED_PAYMENTS[frequency.label];

  // Teto em 1: pagar MAIS que a cadência prevê (provento extraordinário, antecipação)
  // não é mais regular que pagar em dia — e sem o teto um extraordinário compensaria
  // um mês falho, escondendo a falha.
  const regularity =
    expectedPayments != null
      ? Math.min(1, frequency.paymentsLast12m / expectedPayments)
      : null;

  const trend = trendFor(events, now, frequency.label);

  return {
    cadence: frequency.label,
    paymentsLast12m: frequency.paymentsLast12m,
    expectedPayments,
    regularity: regularity != null ? Math.round(regularity * 100) / 100 : null,
    trendPercent: trend ? Math.round(trend.percent * 10) / 10 : null,
    trendWindow: trend?.window ?? null,
    classification: classify(frequency.label, regularity, trend?.percent ?? null),
  };
}

/** Frase curta explicando o veredito, para a tela não precisar reconstruir a lógica. */
export function describeDistributionQuality(q: DistributionQuality): string {
  const cadenceText =
    q.expectedPayments != null
      ? `Cadência ${q.cadence.toLowerCase()}: ${q.paymentsLast12m} de ${q.expectedPayments} pagamentos esperados em 12 meses.`
      : "Sem cadência definida — os intervalos entre pagamentos não se repetem.";

  if (q.trendPercent == null) return `${cadenceText} Sem base de comparação para medir a direção.`;

  const window = q.trendWindow === "6m" ? "no último semestre" : "no último ano";
  if (q.trendPercent > 1) return `${cadenceText} Distribuição ${Math.abs(q.trendPercent).toFixed(0)}% maior ${window}.`;
  if (q.trendPercent < -1) return `${cadenceText} Distribuição ${Math.abs(q.trendPercent).toFixed(0)}% menor ${window}.`;
  return `${cadenceText} Distribuição estável ${window}.`;
}
