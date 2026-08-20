/**
 * Poupança rende só no aniversário mensal COMPLETO — sacar ou consultar antes disso não
 * dá direito a nada daquele ciclo. Por isso este motor nunca faz accrual linear/diário
 * (seria inventar um número que o banco não creditou): só compõe ciclos já fechados
 * entre a data do saldo conhecido e hoje, e o saldo fica parado até o próximo
 * aniversário fechar. Mesmo princípio de "dado que não existe não vira número" já usado
 * no resto do projeto.
 *
 * A taxa de cada ciclo vem pronta da série 195 do Banco Central (SGS) — rendimento real
 * da poupança já com a regra oficial de TR aplicada (TR + 0,5% a.m. com Selic > 8,5%
 * a.a.; TR + 70% da Selic nos demais casos), publicada por dia-aniversário. O motor não
 * reimplementa essa regra — só compõe a taxa que o BCB já calculou.
 */

export interface SavingsRatePoint {
  /** Data de ABERTURA do ciclo de um mês (o "aniversário"), formato ISO "YYYY-MM-DD". */
  date: string;
  /** Rendimento do ciclo em %, ex. 0.6716 para 0,6716%. */
  ratePercent: number;
}

export interface SavingsProjection {
  currentBalance: number;
  completedCycles: number;
  /** Data em que o último rendimento foi creditado. Null se nenhum ciclo fechou ainda. */
  lastAnniversary: string | null;
  /** Data em que o próximo rendimento credita — o saldo fica parado até lá. */
  nextAnniversary: string;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Um mês à frente de `d`, respeitando a regra oficial dos dias 29/30/31: depósito nesses
 * dias tem aniversário sempre no dia 1º do mês seguinte ao normal (garante pelo menos um
 * mês inteiro, já que nem todo mês tem 29/30/31). Uma vez ajustado pra dia 1, os ciclos
 * seguintes já caem nesse mesmo ramo (dia <= 28) e seguem normalmente todo dia 1.
 */
function nextAnniversary(d: Date): Date {
  const day = d.getUTCDate();
  if (day <= 28) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, day));
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 1));
}

/**
 * Projeta o saldo de hoje a partir de um saldo conhecido numa data. Só compõe ciclos
 * mensais já fechados (data de fim <= hoje); pra cada um, busca a taxa pela data de
 * INÍCIO do ciclo em `rateSeries`. Ciclo sem taxa publicada (fora do range buscado, ou
 * buraco real na série) interrompe a composição ali — devolve o que já foi calculado em
 * vez de chutar o resto, mesma disciplina do resto do projeto.
 */
export function projectSavingsBalance(
  checkpointBalance: number,
  checkpointDate: string,
  today: Date,
  rateSeries: SavingsRatePoint[],
): SavingsProjection {
  const rateByDate = new Map(rateSeries.map((p) => [p.date, p.ratePercent]));

  let balance = checkpointBalance;
  let cycleStart = new Date(`${checkpointDate}T00:00:00Z`);
  let completedCycles = 0;
  let lastAnniversary: string | null = null;

  for (;;) {
    const cycleEnd = nextAnniversary(cycleStart);
    if (cycleEnd > today) {
      return { currentBalance: balance, completedCycles, lastAnniversary, nextAnniversary: toIsoDate(cycleEnd) };
    }

    const cycleStartIso = toIsoDate(cycleStart);
    const cycleEndIso = toIsoDate(cycleEnd);
    const rate = rateByDate.get(cycleStartIso);
    if (rate == null) {
      // O crédito deste ciclo aconteceria em cycleEndIso — só não sabemos a taxa ainda
      // (fora do range buscado, ou buraco real na série), então é o próximo aniversário
      // real, mesmo sem conseguir compor por enquanto.
      return { currentBalance: balance, completedCycles, lastAnniversary, nextAnniversary: cycleEndIso };
    }

    balance = balance * (1 + rate / 100);
    completedCycles += 1;
    // O crédito acontece na DATA DE FIM do ciclo (= início do próximo), não na data em
    // que ele começou a contar.
    lastAnniversary = cycleEndIso;
    cycleStart = cycleEnd;
  }
}
