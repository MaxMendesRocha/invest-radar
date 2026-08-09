/**
 * Nome de exibição das categorias de ativo.
 *
 * Existe porque o mesmo mapa estava duplicado em três páginas — e uma das cópias
 * (dividendos.tsx) tinha só as categorias cotadas, então um ativo de renda fixa caía
 * no fallback e aparecia na tela como `renda_fixa`, a chave crua do banco. O gráfico
 * de alocação da home não usava mapa nenhum e mostrava `acoes`, `etfs`, `fiis`.
 *
 * A chave crua continua sendo o fallback de `categoryLabel` — categoria nova que
 * apareça no banco antes de ser mapeada aqui fica feia, mas visível, em vez de sumir.
 */
export const CATEGORY_LABELS: Record<string, string> = {
  acoes: "Ações",
  fiis: "FIIs",
  etfs: "ETFs",
  bdrs: "BDRs",
  fundos: "Fundos",
  renda_fixa: "Renda Fixa",
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}
