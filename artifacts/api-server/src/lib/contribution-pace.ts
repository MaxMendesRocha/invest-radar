/**
 * Quanto a pessoa realmente aporta por mês — medido, não perguntado.
 *
 * O plano de aporte responde "quanto falta para voltar ao alvo". A pergunta seguinte,
 * que é a que decide se dá para corrigir só comprando, é "quantos meses isso leva no meu
 * ritmo". O app não precisa perguntar o ritmo: ele está no registro de lançamentos.
 *
 * ## O saldo inicial fica de fora, e sem ele a conta seria absurda
 *
 * O backfill criou um lançamento de saldo inicial para toda posição anterior ao registro
 * (`isInitialBalance`). Ele representa a carteira inteira num único dia — somá-lo faria o
 * "ritmo mensal" incluir anos de patrimônio como se fossem um aporte, e o app concluiria
 * que qualquer desvio se corrige no mês seguinte.
 *
 * ## Meses corridos, não meses com aporte
 *
 * O denominador é a janela inteira, incluindo os meses em que nada foi comprado. Dividir
 * só pelos meses com lançamento mediria "quanto ele aporta quando aporta", que é outra
 * pergunta e sempre otimista — quem aportou uma vez em seis meses apareceria com o ritmo
 * de quem aporta todo mês.
 */

export interface LedgerEntry {
  tradeDate: string; // "YYYY-MM-DD"
  quantity: number;
  unitPrice: number;
  isInitialBalance: boolean;
}

export interface ContributionPace {
  /** Média mensal em reais sobre a janela. */
  monthlyAverage: number;
  /** Meses corridos considerados — o denominador, exposto porque ele qualifica a média. */
  months: number;
  /** Quantos lançamentos reais entraram na conta. */
  entries: number;
}

/** Janela padrão. Curta o bastante para refletir o hábito atual, longa o bastante para
 *  um mês sem aporte não dominar a média. */
export const PACE_WINDOW_MONTHS = 6;

/** Mínimo de lançamentos para a média significar alguma coisa. Com um só, "ritmo
 *  mensal" seria a extrapolação de um evento. */
const MIN_ENTRIES = 2;

function monthIndex(iso: string): number {
  const [y, m] = iso.slice(0, 7).split("-").map(Number);
  return (y ?? 0) * 12 + (m ?? 1) - 1;
}

/**
 * `null` quando não há lançamentos reais suficientes na janela — a tela então não fala
 * em prazo, em vez de projetar meses a partir de um aporte único.
 */
export function computeContributionPace(
  entries: LedgerEntry[],
  now: Date = new Date(),
  windowMonths: number = PACE_WINDOW_MONTHS,
): ContributionPace | null {
  const mesAtual = now.getFullYear() * 12 + now.getMonth();
  const primeiroMes = mesAtual - (windowMonths - 1);

  const naJanela = entries.filter(
    (e) => !e.isInitialBalance && monthIndex(e.tradeDate) >= primeiroMes && monthIndex(e.tradeDate) <= mesAtual,
  );
  if (naJanela.length < MIN_ENTRIES) return null;

  const total = naJanela.reduce((soma, e) => soma + e.quantity * e.unitPrice, 0);
  if (!(total > 0)) return null;

  return {
    monthlyAverage: Math.round((total / windowMonths) * 100) / 100,
    months: windowMonths,
    entries: naJanela.length,
  };
}

/**
 * Quantos aportes, no ritmo medido, para cobrir um valor.
 *
 * Arredonda para CIMA: três aportes e meio não devolvem a carteira ao alvo — o quarto é
 * que fecha. `null` sem ritmo ou sem valor a cobrir.
 */
export function contributionsUntil(amount: number, pace: ContributionPace | null): number | null {
  if (!pace || !(pace.monthlyAverage > 0) || !(amount > 0)) return null;
  return Math.ceil(amount / pace.monthlyAverage);
}
