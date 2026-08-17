import type { FiiProfile, FiiSegment, Fundamentals, OhlcPoint } from "./market-data";

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
  if (profile.equity != null) {
    parts.push(`patrimônio líquido de R$ ${(profile.equity / 1_000_000).toFixed(0)} milhões`);
  }
  if (profile.totalInvestors != null) {
    // Número de cotistas mede POPULARIDADE, não qualidade de gestão — o app não tem
    // (nem a brapi, nem o Informe Mensal da CVM têm) o nome do gestor de fato, só do
    // administrador, que é papel legal diferente. A ressalva vai no prompt pra IA não
    // ler "muitos cotistas" como "gestão confiável", que não é o que o número mede.
    parts.push(`${profile.totalInvestors.toLocaleString("pt-BR")} cotistas (mede alcance do fundo, não qualidade de gestão)`);
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

/**
 * Elegibilidade de FII para entrar em "Sugestão de Ativos" — dois pisos, medidos
 * contra o universo real, não escolhidos de cabeça.
 *
 * **Liquidez de negociação, R$ 700 mil/dia.** Pedido direto do usuário. Testado
 * contra os 50 FIIs do universo (volume × cotação de um dia real): exclui 10 de 50
 * (20%), com a mediana do dia em ~R$ 3 milhões — corte real, não cosmético, mas que
 * não esvazia a lista. Medido sobre a MÉDIA de 21 pregões (≈1 mês), não um dia só —
 * um dia isolado é ruidoso pra cima ou pra baixo.
 *
 * **Patrimônio, R$ 200 milhões.** Medido contra os mesmos 50 FIIs pelo `equity` real
 * da brapi: a mediana do universo é ~R$ 1,4 bilhão, e R$ 200 milhões exclui só os 3
 * genuinamente pequenos (7% do universo) — LSOP11 (R$ 34mi), PMIS11 (R$ 138mi),
 * MIDW11 (R$ 184mi) na amostra testada. R$ 100 milhões excluiria só 1; R$ 300
 * milhões já excluiria 5 (11%). Escolhido pra filtrar o extremo sem restringir o
 * meio da distribuição.
 *
 * Os dois são convenção declarada — como VARIABLE_SPLIT em allocation-engine.ts —
 * não lei de mercado. Revisáveis com nova medição, não com achismo.
 */
export const MIN_FII_DAILY_VOLUME_BRL = 700_000;
export const MIN_FII_EQUITY_BRL = 200_000_000;

const VOLUME_AVERAGING_DAYS = 21;

/**
 * Valor médio negociado por dia (R$), sobre os últimos `days` pregões da série —
 * volume em cotas × fechamento ajustado do mesmo dia. Null sem pregões suficientes,
 * nunca um valor calculado sobre menos dias do que o pedido (pareceria medido e
 * seria só um pedaço).
 */
export function averageDailyVolumeValue(series: OhlcPoint[], days: number = VOLUME_AVERAGING_DAYS): number | null {
  if (series.length < days) return null;
  const recent = series.slice(-days);
  const total = recent.reduce((sum, p) => sum + p.volume * p.adjustedClose, 0);
  return total / days;
}

export interface FiiEligibility {
  eligible: boolean;
  /** Por que não passou — null quando eligible é true. */
  reason: string | null;
}

/**
 * `null` em `avgDailyVolumeBrl` ou `equity` reprova, não aprova por omissão — sem
 * dado real pra checar o piso, mais seguro tratar como não verificado do que deixar
 * passar um fundo que pode estar abaixo dele.
 */
export function evalFiiEligibility(avgDailyVolumeBrl: number | null, equity: number | null): FiiEligibility {
  if (equity == null || equity < MIN_FII_EQUITY_BRL) {
    return { eligible: false, reason: `Patrimônio abaixo de R$ ${(MIN_FII_EQUITY_BRL / 1_000_000).toFixed(0)} milhões ou indisponível` };
  }
  if (avgDailyVolumeBrl == null || avgDailyVolumeBrl < MIN_FII_DAILY_VOLUME_BRL) {
    return { eligible: false, reason: `Volume médio abaixo de R$ ${(MIN_FII_DAILY_VOLUME_BRL / 1000).toFixed(0)} mil/dia ou indisponível` };
  }
  return { eligible: true, reason: null };
}
