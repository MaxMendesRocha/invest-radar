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
 * Limiares dos sinais abaixo. Nenhum é novidade de mercado: 1x de cobertura é o ponto
 * em que a empresa passa a distribuir mais caixa do que gerou, e 3x de dívida líquida
 * sobre EBITDA é o patamar usual de covenant em crédito corporativo brasileiro.
 */
const COVERAGE_RISK = 1;
const COVERAGE_COMFORTABLE = 1.5;
/**
 * Teto do elogio de cobertura. Acima disso o dividendo é irrelevante perto do caixa
 * gerado, e "coberto com folga" deixa de dizer algo sobre sustentação do provento.
 * Não é hipótese: MGLU3 mediu 160x de cobertura — porque o provento tinha caído 73% —
 * e aparecia como ponto POSITIVO numa empresa que estava justamente cortando
 * distribuição. Um número altíssimo aqui é sinal de dividendo simbólico, não de folga.
 */
const COVERAGE_IMMATERIAL = 10;
const LEVERAGE_RISK = 3;
const CASH_CONVERSION_RISK = 0.5;
const CURRENT_RATIO_RISK = 1;

/**
 * Saúde financeira traduzida em pontos positivos e riscos para a tela.
 *
 * Existe porque esses números já eram calculados e entregues à IA, mas nunca viravam
 * item de lista — e o resultado era uma tela que se contradizia: o TAEE11 aparecia com
 * 6 positivos e ZERO riscos, um deles "Dividend yield acima da média do mercado",
 * enquanto o parecer da IA logo ao lado dizia que o fluxo de caixa livre cobria 41% do
 * dividendo e a dívida líquida estava em 4,74x EBITDA. Os bullets têm cara de fato e o
 * texto tem cara de opinião; quem lia ficava sem saber em qual acreditar, e quem estava
 * certo era o texto.
 *
 * NÃO ENTRA NO SCORE, de propósito. Incluir estes indicadores na média mudaria a nota
 * de todo ativo do app, e a régua deste projeto é medir antes de calibrar — foi assim
 * que a recalibração anterior foi feita, comparando as duas versões sobre os mesmos
 * fundamentos congelados. Aqui o objetivo é parar de esconder risco real na lista;
 * mexer na nota é uma decisão separada, que pede o mesmo comparativo antes.
 *
 * Banco e seguradora ficam de fora inteiros: o balanço deles é estruturalmente outro
 * (ver CASH_METRICS_NOT_COMPARABLE_SECTORS), e aplicar estes limiares marcaria como
 * risco o funcionamento normal do setor.
 */
export function financialHealthSignals(
  h: FinancialHealth,
  sector: string | null,
): { positives: string[]; risks: string[] } {
  const positives: string[] = [];
  const risks: string[] = [];

  if (sector != null && CASH_METRICS_NOT_COMPARABLE_SECTORS.has(sector)) return { positives, risks };

  if (h.dividendCashCoverage != null) {
    // Cobertura negativa é caixa livre negativo: a empresa QUEIMOU caixa no período e
    // ainda distribuiu. Dizer "cobre −73%" seria absurdo — não se cobre nada com valor
    // negativo —, e o caso não é hipotético: SBSP3 mediu −73% na verificação.
    if (h.dividendCashCoverage < 0) {
      risks.push(
        "Dividendo pago com caixa queimado — o fluxo de caixa livre foi negativo nos últimos 12 meses e ainda assim houve distribuição",
      );
    } else if (h.dividendCashCoverage < COVERAGE_RISK) {
      risks.push(
        `Dividendo não coberto pelo caixa — o fluxo de caixa livre cobre ${(h.dividendCashCoverage * 100).toFixed(0)}% do que foi distribuído em 12 meses`,
      );
    } else if (
      h.dividendCashCoverage >= COVERAGE_COMFORTABLE &&
      h.dividendCashCoverage <= COVERAGE_IMMATERIAL
    ) {
      positives.push(
        `Dividendo coberto com folga — o caixa livre cobre ${h.dividendCashCoverage.toFixed(1)}x o distribuído em 12 meses`,
      );
    }
  }

  if (h.netDebtToEbitda != null) {
    if (h.netDebtToEbitda > LEVERAGE_RISK) {
      risks.push(`Alavancagem alta — dívida líquida em ${h.netDebtToEbitda.toFixed(1)}x o EBITDA`);
    } else if (h.netDebtToEbitda < 0) {
      positives.push(
        `Caixa líquido — o caixa supera a dívida em ${Math.abs(h.netDebtToEbitda).toFixed(1)}x o EBITDA`,
      );
    }
  }

  if (h.cashConversion != null && h.cashConversion < CASH_CONVERSION_RISK) {
    // Mesma armadilha da cobertura: conversão negativa não é "converteu −179%", é lucro
    // contábil convivendo com caixa livre negativo — o que é um sinal mais forte, não
    // uma versão pior do mesmo aviso.
    risks.push(
      h.cashConversion < 0
        ? "Lucro contábil sem lastro em caixa — houve lucro no período, mas o fluxo de caixa livre foi negativo"
        : `Lucro convertendo pouco em caixa — ${(h.cashConversion * 100).toFixed(0)}% do lucro líquido virou caixa livre`,
    );
  }

  if (h.currentRatio != null && h.currentRatio < CURRENT_RATIO_RISK) {
    risks.push(
      `Liquidez corrente de ${h.currentRatio.toFixed(2)} — o ativo circulante não cobre o passivo circulante`,
    );
  }

  return { positives, risks };
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
