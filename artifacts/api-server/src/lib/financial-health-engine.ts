import type { Fundamentals } from "./market-data";

export interface FinancialHealth {
  dividendCashCoverage: number | null; // FCF / dividendos totais pagos nos últimos 12m — quantas vezes o caixa livre cobre o que foi distribuído
  cashConversion: number | null; // FCF / lucro líquido — quanto do lucro contábil vira caixa de verdade
  currentRatio: number | null; // liquidez corrente
  ebitdaMargin: number | null; // EBITDA / receita
  netDebtToEbitda: number | null; // (dívida - caixa) / EBITDA — alavancagem em múltiplos de geração operacional
}

// Setores em que as métricas de caixa/liquidez acima NÃO são comparáveis com o resto
// do mercado: o balanço de banco/seguradora é estruturalmente diferente (captação é
// passivo operacional, liquidez corrente gira perto de 1 por natureza, e o "fluxo de
// caixa livre" reportado pode superar o lucro em várias vezes sem significar folga).
// Não descartamos o cálculo — só sinalizamos no texto pra IA não ler como se fosse
// uma empresa não-financeira.
const CASH_METRICS_NOT_COMPARABLE_SECTORS = new Set(["Serviços Financeiros", "Seguros"]);

/**
 * Métricas de saúde financeira derivadas do módulo financialData (plano Pro da
 * brapi.dev — ver fetchFinancialData em market-data.ts). Cada uma vira null quando
 * falta qualquer insumo real, nunca é estimada.
 *
 * dps12m vem de sumLast12Months (market-data.ts): dividendos por ação realmente pagos
 * nos últimos 12 meses. Multiplicado por sharesOutstanding vira o total distribuído,
 * que é o denominador da cobertura por caixa — a métrica que separa um dividendo
 * sustentável (pago com geração de caixa) de um insustentável (pago com dívida ou
 * caixa acumulado), algo que o payout ratio contábil sozinho não distingue.
 */
export function computeFinancialHealth(f: Fundamentals, dps12m: number | null): FinancialHealth {
  const totalDividendsPaid =
    dps12m != null && dps12m > 0 && f.sharesOutstanding != null && f.sharesOutstanding > 0
      ? dps12m * f.sharesOutstanding
      : null;

  return {
    dividendCashCoverage:
      f.freeCashflow != null && totalDividendsPaid != null && totalDividendsPaid > 0
        ? f.freeCashflow / totalDividendsPaid
        : null,
    cashConversion:
      f.freeCashflow != null && f.netIncome != null && f.netIncome > 0 ? f.freeCashflow / f.netIncome : null,
    currentRatio: f.currentRatio,
    ebitdaMargin:
      f.ebitda != null && f.totalRevenue != null && f.totalRevenue > 0 ? f.ebitda / f.totalRevenue : null,
    // Dívida líquida negativa (caixa > dívida) é informação legítima — mantida como
    // valor negativo em vez de zerada, porque "caixa líquido" é um sinal de folga real.
    // Só exige EBITDA positivo: com EBITDA zero ou negativo o múltiplo não tem sentido.
    netDebtToEbitda:
      f.totalDebt != null && f.totalCash != null && f.ebitda != null && f.ebitda > 0
        ? (f.totalDebt - f.totalCash) / f.ebitda
        : null,
  };
}

/**
 * Traduz em uma linha de prompt — mesmo padrão de describeTechnicalIndicators e
 * describeDuPontBreakdown. Recebe o setor pra avisar quando as métricas de caixa não
 * são comparáveis (bancos/seguradoras), em vez de deixar a IA interpretar um FCF de
 * banco como se fosse de uma indústria.
 */
export function describeFinancialHealth(h: FinancialHealth, sector: string | null): string {
  const parts: string[] = [];

  if (h.dividendCashCoverage != null) {
    parts.push(
      `fluxo de caixa livre cobre ${h.dividendCashCoverage.toFixed(2)}x os dividendos pagos nos últimos 12 meses` +
        (h.dividendCashCoverage < 1
          ? " (abaixo de 1x: distribuiu mais caixa do que gerou no período)"
          : "")
    );
  }
  if (h.cashConversion != null) {
    parts.push(`conversão de lucro em caixa de ${(h.cashConversion * 100).toFixed(0)}%`);
  }
  if (h.currentRatio != null) {
    parts.push(`liquidez corrente de ${h.currentRatio.toFixed(2)}`);
  }
  if (h.ebitdaMargin != null) {
    parts.push(`margem EBITDA de ${(h.ebitdaMargin * 100).toFixed(1)}%`);
  }
  if (h.netDebtToEbitda != null) {
    parts.push(
      h.netDebtToEbitda < 0
        ? `caixa líquido (caixa supera a dívida em ${Math.abs(h.netDebtToEbitda).toFixed(2)}x o EBITDA)`
        : `dívida líquida de ${h.netDebtToEbitda.toFixed(2)}x o EBITDA`
    );
  }

  if (parts.length === 0) return "Métricas de caixa e liquidez não disponíveis para este ativo.";

  const caveat =
    sector && CASH_METRICS_NOT_COMPARABLE_SECTORS.has(sector)
      ? ` ATENÇÃO: este ativo é do setor "${sector}" — métricas de caixa e liquidez corrente não são comparáveis com empresas não-financeiras (o balanço de banco/seguradora funciona de outra forma), então não as trate como sinal de folga ou aperto sem esse contexto.`
      : "";

  return parts.join(", ") + "." + caveat;
}
