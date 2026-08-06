import { classifyProfileScore, type ProfileClassification } from "./investor-profile-engine";

/**
 * Perfil revelado — o que a carteira REAL diz sobre o risco assumido, em oposição
 * ao que o questionário declara.
 *
 * Existe porque o declarado é auto-relato e o app tem algo que nenhum questionário
 * entrega: a alocação de fato. Quem se declara Moderado mas está com 44% do
 * patrimônio em um único ativo cíclico está operando como Arrojado, e é essa
 * divergência que vale mostrar.
 *
 * Só usa dado real da carteira. Não estima nada: se falta preço ou beta, o fator
 * correspondente sai da conta em vez de receber um valor de referência.
 */

const VARIABLE_INCOME_CATEGORIES = new Set(["acoes", "fiis", "etfs", "bdrs"]);

// Abaixo disso o beta de um punhado de posições não representa a carteira. Na
// carteira de teste só PETR4 tem beta (44% do valor): chamar aquilo de "beta médio
// da carteira" seria estender um dado real para além do que ele cobre.
const MIN_BETA_COVERAGE_PERCENT = 50;

export interface RevealedProfilePosition {
  ticker: string;
  category: string;
  value: number;
  beta: number | null;
}

export interface RevealedProfile {
  classification: ProfileClassification;
  score: number;
  variableIncomePercent: number;
  largestPositionPercent: number;
  largestPositionTicker: string | null;
  /** Beta médio ponderado; null quando a cobertura é baixa demais para representar a carteira. */
  weightedBeta: number | null;
  /** Fatia do valor da carteira que tem beta real, 0-100. */
  betaCoveragePercent: number;
}

export interface ProfileDivergence {
  declared: ProfileClassification;
  revealed: ProfileClassification;
  /** Positivo = carteira mais arriscada que o perfil declarado. */
  stepsApart: number;
  message: string;
}

const ORDER: ProfileClassification[] = ["Conservador", "Moderado", "Arrojado"];

/**
 * Três fatores, todos observáveis:
 *
 * - Quanto está em renda variável (peso 50) — o divisor de águas entre carteira
 *   defensiva e exposta.
 * - Concentração na maior posição (peso 30) — risco idiossincrático, que a fatia
 *   de renda variável sozinha não captura: 100% em ações pode ser um ETF amplo ou
 *   uma única small cap.
 * - Beta médio ponderado (peso 20) — o quanto a carteira amplifica o mercado.
 *   Entra só se houver beta real; sem ele, os outros dois redistribuem o peso.
 */
export function computeRevealedProfile(positions: RevealedProfilePosition[]): RevealedProfile | null {
  const total = positions.reduce((sum, p) => sum + p.value, 0);
  if (positions.length === 0 || total <= 0) return null;

  const variableValue = positions
    .filter((p) => VARIABLE_INCOME_CATEGORIES.has(p.category))
    .reduce((sum, p) => sum + p.value, 0);
  const variableIncomePercent = (variableValue / total) * 100;

  const largest = positions.reduce((max, p) => (p.value > max.value ? p : max), positions[0]);
  const largestPositionPercent = (largest.value / total) * 100;

  const withBeta = positions.filter((p) => p.beta != null);
  const betaWeight = withBeta.reduce((sum, p) => sum + p.value, 0);
  const betaCoveragePercent = (betaWeight / total) * 100;
  const weightedBeta = betaCoveragePercent >= MIN_BETA_COVERAGE_PERCENT
    ? withBeta.reduce((sum, p) => sum + p.beta! * p.value, 0) / betaWeight
    : null;

  // Cada fator vira 0-100 na mesma direção do score declarado: mais alto = mais
  // agressivo.
  const concentrationPoints = Math.min(100, (largestPositionPercent / 50) * 100);
  const betaPoints = weightedBeta != null ? Math.min(100, (weightedBeta / 1.5) * 100) : null;

  let weighted = variableIncomePercent * 50 + concentrationPoints * 30;
  let weightSum = 80;
  if (betaPoints != null) {
    weighted += betaPoints * 20;
    weightSum += 20;
  }
  const score = weighted / weightSum;

  return {
    classification: classifyProfileScore(score),
    score: Math.round(score * 100) / 100,
    variableIncomePercent: Math.round(variableIncomePercent * 100) / 100,
    largestPositionPercent: Math.round(largestPositionPercent * 100) / 100,
    largestPositionTicker: largest.ticker,
    weightedBeta: weightedBeta != null ? Math.round(weightedBeta * 100) / 100 : null,
    betaCoveragePercent: Math.round(betaCoveragePercent * 100) / 100,
  };
}

export function compareProfiles(
  declared: ProfileClassification,
  revealed: RevealedProfile,
): ProfileDivergence | null {
  const stepsApart = ORDER.indexOf(revealed.classification) - ORDER.indexOf(declared);
  if (stepsApart === 0) return null;

  const detail =
    `${revealed.variableIncomePercent.toFixed(0)}% em renda variável` +
    (revealed.largestPositionTicker
      ? `, maior posição em ${revealed.largestPositionTicker} com ${revealed.largestPositionPercent.toFixed(0)}% do patrimônio`
      : "") +
    (revealed.weightedBeta != null
      ? `, beta médio de ${revealed.weightedBeta.toFixed(2)}` +
        (revealed.betaCoveragePercent < 99 ? ` (cobrindo ${revealed.betaCoveragePercent.toFixed(0)}% da carteira)` : "")
      : "");

  const message = stepsApart > 0
    ? `Você se declarou ${declared}, mas a carteira está posicionada como ${revealed.classification}: ${detail}. O risco assumido é maior que o perfil declarado.`
    : `Você se declarou ${declared}, mas a carteira está posicionada como ${revealed.classification}: ${detail}. Há espaço para assumir mais risco do que a carteira reflete hoje.`;

  return { declared, revealed: revealed.classification, stepsApart, message };
}
