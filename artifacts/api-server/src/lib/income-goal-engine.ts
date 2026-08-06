/**
 * Progresso rumo à meta de renda passiva.
 *
 * Tudo aqui é aritmética sobre dado real: a renda projetada vem do DPS efetivamente
 * pago nos últimos 12 meses (sumLast12Months), e o yield usado para dimensionar o
 * capital que falta é o da própria carteira, não uma taxa de referência.
 *
 * O aporte necessário é calculado SEM reinvestimento dos proventos. Reinvestir
 * acelera bastante o percurso, mas projetar isso exigiria assumir que o yield atual
 * se mantém por todo o período — e o erro cairia do lado otimista, dizendo que basta
 * aportar menos do que realmente basta. Sem reinvestimento o número é conservador
 * por construção: o percurso real tende a ser mais curto, nunca mais longo.
 */

export interface IncomeGoalInput {
  targetMonthlyIncome: number;
  targetYear: number;
  /** Renda mensal média projetada a partir dos proventos reais dos últimos 12 meses. */
  currentMonthlyIncome: number;
  totalPatrimony: number;
  /** Yield da carteira sobre valor de mercado, em decimal. */
  portfolioYield: number | null;
  now: Date;
}

export interface IncomeGoalProgress {
  targetMonthlyIncome: number;
  currentMonthlyIncome: number;
  progressPercent: number;
  monthsRemaining: number;
  achieved: boolean;
  /** Patrimônio necessário para a meta ao yield atual da carteira. null sem yield real. */
  requiredCapital: number | null;
  capitalGap: number | null;
  /** Aporte mensal para fechar a lacuna no prazo, sem contar reinvestimento. */
  requiredMonthlyContribution: number | null;
  /** true quando o prazo já passou e a meta não foi atingida. */
  overdue: boolean;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export function computeIncomeGoalProgress(input: IncomeGoalInput): IncomeGoalProgress {
  const { targetMonthlyIncome, targetYear, currentMonthlyIncome, totalPatrimony, portfolioYield, now } = input;

  // O alvo é o fim do ano escolhido — dezembro conta como prazo cheio.
  const deadline = new Date(Date.UTC(targetYear, 11, 31));
  const monthsRemaining = Math.max(
    0,
    (deadline.getUTCFullYear() - now.getUTCFullYear()) * 12 + (deadline.getUTCMonth() - now.getUTCMonth()),
  );

  const achieved = currentMonthlyIncome >= targetMonthlyIncome;
  const progressPercent = targetMonthlyIncome > 0
    ? Math.min(100, round2((currentMonthlyIncome / targetMonthlyIncome) * 100))
    : 0;

  // Sem yield real da carteira não há como dimensionar o capital necessário. Devolve
  // null em vez de recorrer a uma taxa de mercado que não é a desta carteira.
  const requiredCapital = portfolioYield != null && portfolioYield > 0
    ? round2((targetMonthlyIncome * 12) / portfolioYield)
    : null;
  const capitalGap = requiredCapital != null ? round2(Math.max(0, requiredCapital - totalPatrimony)) : null;
  const requiredMonthlyContribution = capitalGap != null && monthsRemaining > 0
    ? round2(capitalGap / monthsRemaining)
    : null;

  return {
    targetMonthlyIncome: round2(targetMonthlyIncome),
    currentMonthlyIncome: round2(currentMonthlyIncome),
    progressPercent,
    monthsRemaining,
    achieved,
    requiredCapital,
    capitalGap,
    requiredMonthlyContribution,
    overdue: monthsRemaining === 0 && !achieved,
  };
}
