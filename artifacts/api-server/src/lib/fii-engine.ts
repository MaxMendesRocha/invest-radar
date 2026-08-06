import type { FiiProfile, FiiSegment, Fundamentals } from "./market-data";

// O que cada segmento implica de risco — é o contexto que falta pra IA ler o dividend
// yield de um FII corretamente. Um DY de 12% num fundo de papel e num de tijolo
// significam coisas diferentes: no primeiro costuma refletir CDI/IPCA alto (e some
// quando o juro cai), no segundo reflete aluguel contratado (mais estável, mas
// vulnerável a vacância).
const SEGMENT_CONTEXT: Record<FiiSegment, string> = {
  papel:
    "FII de papel (carteira de CRI/LCI): o rendimento acompanha juro e inflação, então yield alto em ciclo de Selic elevada tende a encolher quando o juro cai; o risco principal é de crédito dos devedores, não de vacância",
  tijolo:
    "FII de tijolo (imóveis físicos): o rendimento vem de aluguel contratado e costuma ser mais estável e indexado à inflação; o risco principal é vacância e renegociação de contratos, não crédito",
  hibrido:
    "FII híbrido (mistura papel e imóvel físico): combina risco de crédito e de vacância em proporções que variam com a alocação do momento",
  fof:
    "FII de fundos (FoF, investe em cotas de outros FIIs): entrega diversificação imediata, mas cobra uma segunda camada de taxa de administração sobre os fundos investidos, o que corrói parte do yield",
};

/**
 * Traduz o perfil do FII em uma linha de prompt — mesmo padrão de
 * describeTechnicalIndicators e describeFinancialHealth. Retorna string vazia pra
 * ativo que não é FII, pra o chamador simplesmente não incluir a linha no prompt em
 * vez de poluí-lo com "não disponível" em toda ação analisada.
 */
export function describeFiiProfile(profile: FiiProfile | null): string {
  if (!profile) return "";

  const parts: string[] = [];

  if (profile.segmentType) {
    parts.push(SEGMENT_CONTEXT[profile.segmentType]);
  }
  if (profile.segmentoAtuacao) {
    parts.push(`segmento de atuação: ${profile.segmentoAtuacao}`);
  }
  if (profile.tipoGestao) {
    parts.push(`gestão ${profile.tipoGestao.toLowerCase()}`);
  }
  if (profile.priceToNav != null) {
    const vsNav =
      profile.priceToNav < 1
        ? ` (negociando ${((1 - profile.priceToNav) * 100).toFixed(0)}% abaixo do valor patrimonial)`
        : profile.priceToNav > 1
          ? ` (negociando ${((profile.priceToNav - 1) * 100).toFixed(0)}% acima do valor patrimonial)`
          : "";
    parts.push(`P/VP de ${profile.priceToNav.toFixed(2)}${vsNav}`);
  }
  if (profile.dividendYield12m != null) {
    parts.push(`dividend yield de ${(profile.dividendYield12m * 100).toFixed(1)}% nos últimos 12 meses`);
  }

  if (parts.length === 0) return "";
  return parts.join("; ") + ".";
}

const FII_SEGMENT_LABEL: Record<FiiSegment, string> = {
  papel: "FII de Papel",
  tijolo: "FII de Tijolo",
  hibrido: "FII Híbrido",
  fof: "FII de Fundos",
};

/**
 * Grupo contra o qual o ativo é comparado. Para ações e ETFs é o setor da brapi;
 * para FII é o SEGMENTO, não o guarda-chuva "Fundos Imobiliários".
 *
 * A distinção importa porque o segmento define o nível estrutural de yield. FII de
 * papel carrega risco de crédito e rende mais que FII de tijolo por natureza, não
 * por estar barato. Medido contra a mediana de todos os FIIs juntos, um fundo de
 * papel aparece com prêmio alto só por ser de papel — foi o que colocou o HCTR11,
 * um FII de crédito de alto yield, no topo da lista com "8,1 p.p. acima da mediana
 * do setor". Contra os pares de papel o prêmio dele é o que de fato sobra.
 *
 * Sem perfil de FII disponível cai no setor genérico: comparação mais grosseira,
 * mas ainda real — melhor que excluir o ativo da comparação.
 */
export function benchmarkGroupFor(f: Fundamentals, profile: FiiProfile | undefined): string | null {
  const segment = profile?.segmentType;
  if (segment) return FII_SEGMENT_LABEL[segment];
  return f.sector;
}
