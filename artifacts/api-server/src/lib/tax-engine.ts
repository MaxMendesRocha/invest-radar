export interface TaxEstimate {
  grossGain: number; // valor de venda - custo de aquisição (pode ser negativo = prejuízo)
  taxRate: number; // alíquota aplicada: 0, 0.15 ou 0.20
  taxOwed: number; // IR estimado sobre o ganho
  netGain: number; // ganho líquido após IR (grossGain - taxOwed)
  exempt: boolean; // true quando dentro da isenção de ações (venda ≤ R$20.000 no mês)
}

// Compartilhado com monthly-tax-engine.ts — mesma fonte pra alíquota/faixa de
// isenção usada tanto na estimativa isolada por venda quanto na consolidação mensal.
export const ACOES_EXEMPTION_THRESHOLD = 20000;
export const TAX_RATE_BY_CATEGORY: Record<string, number> = {
  acoes: 0.15,
  fiis: 0.2,
  etfs: 0.15,
  bdrs: 0.15,
};

// Regras de IR sobre ganho de capital em renda variável (Lei 11.033/2004, IN RFB
// 1.585/2015) — não muda com frequência, mas é lei tributária real, não uma
// heurística nossa; se a Receita mudar a faixa de isenção ou as alíquotas, isso
// precisa ser atualizado aqui.
//
// - Ações (operação comum, não day-trade): isentas de IR se o total vendido desse
//   tipo de ativo no mês for ≤ R$20.000 (soma de TODAS as vendas de ações do mês,
//   não só desse ticker). Acima disso, 15% sobre o ganho de capital.
// - FIIs: sempre 20% sobre o ganho, sem nenhuma faixa de isenção por valor.
// - ETFs e BDRs: 15% sobre o ganho, também sem a isenção de R$20 mil (essa isenção
//   é exclusiva de ações negociadas à vista, não se estende a fundos/BDRs).
//
// LIMITAÇÃO IMPORTANTE: isto é uma estimativa ISOLADA — assume que essa seria a
// única venda de ações/FIIs/ETFs/BDRs do usuário no mês. O app não guarda um
// histórico de vendas, então não sabe se a faixa de isenção de ações já foi usada
// por outra venda no mesmo mês, nem se há prejuízo acumulado de vendas anteriores
// pra compensar o ganho (o que reduziria o IR devido). Não é o valor exato que a
// Receita cobraria — é o que devolveria a mesma conta considerando somente esta
// posição, informação real mas parcial. Nunca deve ser apresentado como o valor
// final de IR sem essa ressalva.
export function estimateCapitalGainsTax(
  category: string,
  quantity: number,
  averagePrice: number,
  currentPrice: number,
): TaxEstimate | null {
  // Checagem de categoria vem ANTES de qualquer cálculo de ganho — renda_fixa/fundos
  // devem sempre voltar null, mesmo quando o "ganho" bruto calculado dá zero (ex:
  // sem cotação de mercado real, currentPrice cai no fallback do averagePrice).
  if (category !== "acoes" && category !== "fiis" && category !== "etfs" && category !== "bdrs") {
    return null; // regras de IR completamente diferentes (tabela regressiva por prazo), fora do escopo
  }

  const saleValue = quantity * currentPrice;
  const costBasis = quantity * averagePrice;
  const grossGain = saleValue - costBasis;

  if (grossGain <= 0) {
    // Prejuízo: sem IR a pagar nessa venda (poderia até gerar crédito compensável
    // em vendas futuras, mas isso exigiria rastrear histórico, fora do escopo aqui).
    return { grossGain, taxRate: 0, taxOwed: 0, netGain: grossGain, exempt: false };
  }

  let taxRate: number;
  let exempt = false;

  if (category === "acoes" && saleValue <= ACOES_EXEMPTION_THRESHOLD) {
    taxRate = 0;
    exempt = true;
  } else {
    taxRate = TAX_RATE_BY_CATEGORY[category];
  }

  const taxOwed = grossGain * taxRate;
  return { grossGain, taxRate, taxOwed, netGain: grossGain - taxOwed, exempt };
}
