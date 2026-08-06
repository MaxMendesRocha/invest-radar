/**
 * Perfil de investidor.
 *
 * A régua anterior somava 5 respostas de peso igual (0/10/20 cada) e classificava
 * pelo total. Isso permitia que restrições absolutas fossem diluídas por respostas
 * não relacionadas a risco: quem respondia horizonte curto + tolerância baixa +
 * precisa de liquidez, mas também "crescimento" e "avançado", somava 40 e saía como
 * Moderado — três sinais de Conservador anulados por dois que não medem risco.
 *
 * O modelo aqui separa os dois eixos que a literatura de suitability trata como
 * distintos:
 *
 *   CAPACIDADE  — objetiva: quanto tempo o dinheiro pode ficar investido, se há
 *                 reserva, se vai precisar sacar, o peso desta carteira no
 *                 patrimônio, estabilidade da renda.
 *   TOLERÂNCIA  — subjetiva: quanta oscilação a pessoa aguenta sem vender no
 *                 fundo, e o quanto já viu de ciclo.
 *
 * A classificação final é a MENOR das duas, não a média: tolerar 30% de queda não
 * ajuda se o dinheiro é da entrada do apartamento, e um horizonte de 20 anos não
 * ajuda se a pessoa vende na primeira correção.
 *
 * "Objetivo" (preservar/renda/crescimento) continua sendo coletado, mas saiu do
 * cálculo de risco: é meta, não risco. Carteira de dividendos não é intrinsecamente
 * menos arriscada que carteira de crescimento, e pontuá-la como se fosse empurrava
 * investidor de renda para baixo sem razão ligada a risco.
 */

export type ProfileClassification = "Conservador" | "Moderado" | "Arrojado";

export interface ProfileAnswers {
  lossTolerance: string;
  objective: string;
  experience: string;
  liquidityNeed: string;
  horizonYears: number | null;
  emergencyFund: string | null;
  portfolioShare: string | null;
  incomeStability: string | null;
}

export interface ProfileAssessment {
  capacityScore: number;
  toleranceScore: number;
  score: number;
  classification: ProfileClassification;
  /** Qual eixo limitou o resultado — alimenta a explicação na tela. */
  limitedBy: "capacidade" | "tolerancia" | "equilibrado";
  /** Travas acionadas, em texto pronto para exibição. Vazio quando nenhuma. */
  constraints: string[];
  /**
   * false quando o perfil foi gravado antes das perguntas de capacidade existirem.
   * Sem isso, um perfil legado que só respondeu "não preciso de liquidez" exibiria
   * capacidade 100/100 — número derivado de uma resposta só, apresentado com a
   * mesma confiança de um questionário completo.
   */
  capacityComplete: boolean;
}

const CONSERVADOR_CEILING = 33;
const MODERADO_CEILING = 66;

export function classifyProfileScore(score: number): ProfileClassification {
  if (score > MODERADO_CEILING) return "Arrojado";
  if (score > CONSERVADOR_CEILING) return "Moderado";
  return "Conservador";
}

/**
 * Horizonte em anos → 0-100. O degrau mais forte é entre 2 e 5 anos: abaixo de 2
 * não há tempo de recuperar uma correção relevante da bolsa brasileira, e é
 * exatamente onde a régua antiga ("curto") mal penalizava.
 */
function horizonPoints(years: number | null): number | null {
  if (years == null) return null;
  if (years < 2) return 0;
  if (years < 5) return 40;
  if (years < 10) return 75;
  return 100;
}

const EMERGENCY_FUND_POINTS: Record<string, number> = { nao: 0, sim: 100 };
const LIQUIDITY_NEED_POINTS: Record<string, number> = { sim: 0, nao: 100 };
const PORTFOLIO_SHARE_POINTS: Record<string, number> = { mais_75: 20, de_50_75: 50, de_25_50: 80, menos_25: 100 };
const INCOME_STABILITY_POINTS: Record<string, number> = { instavel: 0, variavel: 50, estavel: 100 };
const LOSS_TOLERANCE_POINTS: Record<string, number> = { baixa: 0, media: 50, alta: 100 };
const EXPERIENCE_POINTS: Record<string, number> = { iniciante: 0, intermediario: 50, avancado: 100 };

/**
 * Média ponderada que ignora os fatores ausentes e redistribui o peso entre os
 * presentes. Perfis gravados antes dos campos novos existirem continuam sendo
 * pontuados pelo que responderam, em vez de levarem zero por uma pergunta que não
 * lhes foi feita.
 */
function weightedAverage(factors: { value: number | null; weight: number }[]): { score: number; answeredWeight: number; totalWeight: number } {
  let total = 0;
  let answeredWeight = 0;
  let totalWeight = 0;
  for (const { value, weight } of factors) {
    totalWeight += weight;
    if (value == null) continue;
    total += value * weight;
    answeredWeight += weight;
  }
  return { score: answeredWeight === 0 ? 0 : total / answeredWeight, answeredWeight, totalWeight };
}

function pointsFor(table: Record<string, number>, answer: string | null): number | null {
  if (answer == null) return null;
  return table[answer] ?? null;
}

export function assessInvestorProfile(answers: ProfileAnswers): ProfileAssessment {
  const capacity = weightedAverage([
    { value: horizonPoints(answers.horizonYears), weight: 35 },
    { value: pointsFor(EMERGENCY_FUND_POINTS, answers.emergencyFund), weight: 25 },
    { value: pointsFor(LIQUIDITY_NEED_POINTS, answers.liquidityNeed), weight: 20 },
    { value: pointsFor(PORTFOLIO_SHARE_POINTS, answers.portfolioShare), weight: 10 },
    { value: pointsFor(INCOME_STABILITY_POINTS, answers.incomeStability), weight: 10 },
  ]);

  const tolerance = weightedAverage([
    { value: pointsFor(LOSS_TOLERANCE_POINTS, answers.lossTolerance), weight: 70 },
    { value: pointsFor(EXPERIENCE_POINTS, answers.experience), weight: 30 },
  ]);

  const capacityScore = capacity.score;
  const toleranceScore = tolerance.score;
  let score = Math.min(capacityScore, toleranceScore);

  // Travas. Diferente dos pesos acima, estas não são compensáveis: são condições
  // em que um perfil mais agressivo não se justifica por mais favorável que seja
  // o resto das respostas.
  const constraints: string[] = [];
  if (answers.emergencyFund === "nao") {
    score = Math.min(score, CONSERVADOR_CEILING);
    constraints.push("Sem reserva de emergência: enquanto ela não existir, o perfil fica limitado a Conservador — uma emergência forçaria vender na baixa.");
  }
  if (answers.horizonYears != null && answers.horizonYears < 2) {
    score = Math.min(score, CONSERVADOR_CEILING);
    constraints.push("Horizonte abaixo de 2 anos: não há tempo para recuperar uma correção relevante, o que limita o perfil a Conservador.");
  }
  if (answers.liquidityNeed === "sim") {
    score = Math.min(score, MODERADO_CEILING);
    constraints.push("Necessidade de resgate no curto prazo: limita o perfil a Moderado, independentemente da tolerância declarada.");
  }

  // Limita quem tem o MENOR score, já que a classificação é o mínimo dos dois.
  const gap = capacityScore - toleranceScore;
  const limitedBy = Math.abs(gap) < 10 ? "equilibrado" : gap < 0 ? "capacidade" : "tolerancia";

  return {
    capacityScore: Math.round(capacityScore * 100) / 100,
    toleranceScore: Math.round(toleranceScore * 100) / 100,
    score: Math.round(score * 100) / 100,
    classification: classifyProfileScore(score),
    limitedBy,
    constraints,
    capacityComplete: capacity.answeredWeight === capacity.totalWeight,
  };
}

/** Mantém a coluna legada `horizon` coerente com a resposta em anos. */
export function horizonBucketFromYears(years: number): "curto" | "medio" | "longo" {
  if (years < 2) return "curto";
  if (years < 5) return "medio";
  return "longo";
}
