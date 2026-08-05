import type { FiiProfile, FiiSegment } from "./market-data";

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
