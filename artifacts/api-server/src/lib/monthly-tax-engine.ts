import { ACOES_EXEMPTION_THRESHOLD, TAX_RATE_BY_CATEGORY } from "./tax-engine";

export interface SaleRecord {
  category: string;
  saleDate: string; // ISO (YYYY-MM-DD)
  quantity: number;
  salePrice: number;
  grossGain: number;
}

export interface MonthlyCategoryTax {
  month: string; // "YYYY-MM"
  category: string;
  totalSaleValue: number; // soma de quantity*salePrice de todas as vendas da categoria no mês
  totalGrossGain: number; // resultado bruto do mês (pode ser negativo)
  lossOffset: number; // quanto de prejuízo acumulado de meses anteriores foi usado pra abater o ganho deste mês
  taxableGain: number; // resultado tributável após compensação (0 se prejuízo ou isento)
  exempt: boolean; // true só pra ações com venda ≤ R$20 mil no mês
  taxOwed: number;
  lossCarriedForward: number; // prejuízo acumulado que sobra pro próximo mês dessa categoria
}

// Ordem cronológica é essencial — a compensação de prejuízo só olha pra trás
// (meses anteriores abatendo meses futuros), nunca o contrário.
function monthKey(saleDate: string): string {
  return saleDate.slice(0, 7); // "YYYY-MM"
}

/**
 * Consolida um histórico real de vendas (sales table) em apuração mensal de IR por
 * categoria — a evolução natural da estimativa isolada de tax-engine.ts, agora que
 * existe histórico de verdade (Fase 1) pra saber se a faixa de isenção de ações já
 * foi usada no mês e se há prejuízo acumulado pra compensar.
 *
 * Categorias são apuradas de forma independente entre si (prejuízo de FII não abate
 * ganho de ação, por exemplo) — mesma granularidade por categoria já usada em
 * estimateCapitalGainsTax. Isenção de ações (venda ≤ R$20 mil/mês) nunca consome o
 * prejuízo acumulado — um mês isento simplesmente não gera IR nem abate o saldo
 * negativo existente, que permanece intacto pra um mês futuro tributável.
 *
 * LIMITAÇÃO: reflete somente as vendas registradas no app (Fase 1, "Vender" em
 * Minha Carteira) — vendas feitas fora do app (direto na corretora, sem passar por
 * aqui) não entram nessa apuração. Não é o valor final que a Receita cobraria, é a
 * melhor consolidação possível com o dado real disponível.
 */
export function computeMonthlyTaxSummary(sales: SaleRecord[]): MonthlyCategoryTax[] {
  const byCategoryMonth = new Map<string, Map<string, { totalSaleValue: number; totalGrossGain: number }>>();

  for (const sale of sales) {
    const month = monthKey(sale.saleDate);
    if (!byCategoryMonth.has(sale.category)) byCategoryMonth.set(sale.category, new Map());
    const monthsForCategory = byCategoryMonth.get(sale.category)!;
    const existing = monthsForCategory.get(month) ?? { totalSaleValue: 0, totalGrossGain: 0 };
    existing.totalSaleValue += sale.quantity * sale.salePrice;
    existing.totalGrossGain += sale.grossGain;
    monthsForCategory.set(month, existing);
  }

  const results: MonthlyCategoryTax[] = [];

  for (const [category, monthsMap] of byCategoryMonth) {
    const rate = TAX_RATE_BY_CATEGORY[category];
    if (rate == null) continue; // categoria fora do escopo de ganho de capital em renda variável (ex. renda_fixa)

    const months = Array.from(monthsMap.keys()).sort(); // cronológico, string YYYY-MM ordena naturalmente
    let lossCarry = 0;

    for (const month of months) {
      const { totalSaleValue, totalGrossGain } = monthsMap.get(month)!;
      const exempt = category === "acoes" && totalSaleValue <= ACOES_EXEMPTION_THRESHOLD;

      let lossOffset = 0;
      let taxableGain = 0;
      let taxOwed = 0;

      if (exempt) {
        // Isenção nunca consome prejuízo acumulado — só dispensa o IR sobre o ganho
        // deste mês. Se o mês em si deu prejuízo, ele soma ao saldo acumulado.
        if (totalGrossGain < 0) lossCarry += -totalGrossGain;
      } else if (totalGrossGain <= 0) {
        lossCarry += -totalGrossGain;
      } else {
        lossOffset = Math.min(lossCarry, totalGrossGain);
        taxableGain = totalGrossGain - lossOffset;
        lossCarry -= lossOffset;
        taxOwed = taxableGain * rate;
      }

      results.push({
        month,
        category,
        totalSaleValue,
        totalGrossGain,
        lossOffset,
        taxableGain,
        exempt,
        taxOwed,
        lossCarriedForward: lossCarry,
      });
    }
  }

  results.sort((a, b) => (a.month === b.month ? a.category.localeCompare(b.category) : b.month.localeCompare(a.month)));
  return results;
}
