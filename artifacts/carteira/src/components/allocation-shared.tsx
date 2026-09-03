import { formatCurrency } from "@/lib/utils";

/**
 * Peças de vocabulário compartilhadas entre a Alocação-alvo (Saúde do Portfólio) e a
 * Carteira de Partida.
 *
 * As duas telas falam do mesmo assunto — quanto vai em cada classe e quais ativos —, só
 * que uma para quem já tem carteira e outra para quem ainda não tem nenhuma. Duplicar
 * estes rótulos faria as duas explicarem a mesma situação com palavras diferentes: um
 * usuário que visse "sem_candidato" descrito de dois jeitos concluiria que são coisas
 * distintas.
 */

export const CATEGORY_LABEL: Record<string, string> = {
  renda_fixa: "Renda Fixa",
  acoes: "Ações",
  fiis: "FIIs",
  etfs: "ETFs",
  bdrs: "BDRs",
  fundos: "Fundos",
};

export const SUGGESTION_NOTE: Record<string, string> = {
  sem_ticker_de_bolsa: "Sem sugestão de ativo: fundos não têm ticker de bolsa nem fonte pública de dados para ranquear.",
  sem_candidato: "Sem candidato na varredura atual — ETFs não têm fundamento individual (P/L, ROE, margem), então não passam pela triagem por fundamentos.",
  tesouro_indisponivel: "A sincronização com o Tesouro Direto ainda não rodou. As sugestões aparecem assim que ela acontecer — é uma vez por dia.",
};

/** Unidade de negociação da classe, para a linha de quantidade não dizer "ações de FII". */
export function unitLabelFor(category: string): "ação" | "cota" {
  return category === "fiis" || category === "etfs" ? "cota" : "ação";
}

/** "2045-05-15" -> "2045" — o ano basta para o usuário reconhecer o título. */
export function maturityYear(iso: string): string {
  return iso.slice(0, 4);
}

/** "89,6" — pt-BR, uma casa. As barras e os textos falam em pontos percentuais. */
export const decimal = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const integer = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
/** Fração de título do Tesouro: "0,03". Duas casas, que é a granularidade da compra. */
export const fraction = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export type Sizing = { unitPrice: number; units: number; investedAmount: number; leftover: number };

/**
 * Quantas linhas do item exibem quantidade. Com uma só não há o que confundir — o aviso
 * de "não é soma" apareceria como ruído.
 */
export function sizedCount(item: { suggestions: { sizing?: Sizing | null }[]; treasurySuggestions?: { sizing?: Sizing | null }[] | null }): number {
  const bolsa = item.suggestions.filter((s) => s.sizing).length;
  const tesouro = (item.treasurySuggestions ?? []).filter((t) => t.sizing).length;
  return bolsa + tesouro;
}

/**
 * "ação" pluraliza para "ações", não "açãos" — a regra do `s` no fim só vale para as
 * outras duas. Exportado porque o card de aporte precisa da mesma flexão nas linhas de
 * reforço, e uma segunda cópia seria a que erraria.
 */
export function pluralizeUnit(unitLabel: "ação" | "cota" | "título", units: number): string {
  if (units === 1) return unitLabel;
  return unitLabel === "ação" ? "ações" : `${unitLabel}s`;
}

/**
 * A linha que converte reais em quantidade — o passo que faltava entre "R$ 206,86 em
 * FIIs" e a ordem de compra na corretora.
 *
 * `units: 0` não é ausência de resposta, é a resposta: a fatia não paga uma unidade.
 * Esconder esse caso deixaria o usuário procurando a informação que o app tem.
 */
export function SizingLine({ sizing, unitLabel }: { sizing: Sizing; unitLabel: "ação" | "cota" | "título" }) {
  const isFractional = unitLabel === "título";

  if (sizing.units === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        A fatia não alcança {isFractional ? "a compra mínima" : `1 ${unitLabel}`} — {formatCurrency(sizing.unitPrice)}
        {isFractional ? " o título inteiro (mínimo de R$ 30)" : " cada"}.
      </p>
    );
  }

  const quantity = isFractional ? fraction.format(sizing.units) : integer.format(sizing.units);
  const noun = pluralizeUnit(unitLabel, sizing.units);

  return (
    <p className="text-xs text-muted-foreground">
      <span className="font-mono font-medium text-foreground">{quantity} {noun}</span>
      {" × "}{formatCurrency(sizing.unitPrice)} = {formatCurrency(sizing.investedAmount)}
      {sizing.leftover > 0 && ` · sobram ${formatCurrency(sizing.leftover)}`}
    </p>
  );
}
