import type { FiiCvmData } from "./cvm-data";
import type { FiiProfile, FiiSegment, Fundamentals, OhlcPoint } from "./market-data";
import { FII_PVP_HEALTHY_DISCOUNT_RANGE, FII_YIELD_PREMIUM_GOOD_THRESHOLD, FII_YIELD_PREMIUM_STRONG_THRESHOLD, FIXED_INCOME_TAX_RATE } from "./analysis-engine";

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

export const FII_SEGMENT_LABEL: Record<FiiSegment, string> = {
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

export type SelicTrend = "alta" | "queda" | "estavel";

/**
 * Como o ciclo de juro atual afeta ESTE segmento — o lado que faltava no
 * SEGMENT_CONTEXT acima. Aquele já dizia que papel acompanha juro e tijolo é mais
 * estável; isto diz o que "acompanha" significa quando a Selic está subindo, caindo
 * ou parada, cruzando com a tendência REAL medida em macro-data.ts.
 *
 * Dois canais diferentes, e a literatura (BTG, B3, brapi — ver docs/analises-ia.md
 * pro histórico da pesquisa) é consistente sobre qual pesa mais em cada segmento:
 *
 * - **Papel**: efeito é na RENDA. Maioria dos CRIs indexada a CDI/IPCA+, então a
 *   renda sobe com a Selic e encolhe quando ela cai — quase em tempo real. O efeito
 *   no PREÇO da cota depende de quanto do CRI é prefixado (sofre com Selic subindo,
 *   igual um título prefixado) vs. pós-fixado (não sofre) — proporção que a brapi
 *   não expõe por fundo, então não afirmamos direção de preço para papel, só de
 *   renda, que é o que está de fato medido.
 * - **Tijolo**: efeito é no PREÇO. Aluguel é contratado e reajustado por
 *   IGP-M/IPCA anual, então a renda não segue a Selic de perto. O preço da cota
 *   funciona como um ativo de longa duração: sobe quando a Selic cai (ou o mercado
 *   passa a esperar corte — a reprecificação costuma vir ANTES do corte de fato) e
 *   comprime quando a Selic sobe, porque o mercado desconta o aluguel futuro a uma
 *   taxa maior.
 * - **Híbrido e FoF**: dependem da proporção real entre papel e tijolo (híbrido) ou
 *   dos fundos que compõem a carteira (FoF), dado que a brapi não expõe por fundo —
 *   por isso não recebem leitura direcional, só a ressalva de que o efeito é misto.
 *
 * Retorna string vazia sem os dois insumos (segmento e tendência), pro chamador não
 * incluir a linha em vez de poluir o prompt com "não disponível".
 */
export function describeFiiInterestRateSensitivity(segment: FiiSegment | null, selicTrend: SelicTrend | null): string {
  if (!segment || !selicTrend) return "";

  if (segment === "papel") {
    if (selicTrend === "alta") return "Ciclo de Selic em alta: a renda deste FII de papel tende a subir, acompanhando CDI/IPCA+ dos CRIs da carteira.";
    if (selicTrend === "queda") return "Ciclo de Selic em queda: a renda deste FII de papel tende a encolher, acompanhando CDI/IPCA+ dos CRIs da carteira — o yield atual pode não se repetir.";
    return "Selic estável: a renda deste FII de papel tende a ficar perto do nível atual, sem pressão de alta nem de queda vinda do ciclo de juro.";
  }

  if (segment === "tijolo") {
    if (selicTrend === "alta") return "Ciclo de Selic em alta: a cota deste FII de tijolo tende a sentir mais no preço do que na renda — o mercado desconta o aluguel futuro a uma taxa maior, mesmo com o aluguel contratado intacto.";
    if (selicTrend === "queda") return "Ciclo de Selic em queda: a cota deste FII de tijolo tende a se beneficiar mais no preço do que na renda — o mercado costuma reprecificar antes mesmo do corte se completar, buscando retorno maior que a renda fixa em queda.";
    return "Selic estável: sem o ciclo de juro empurrando a cota deste FII de tijolo para cima ou para baixo, o preço tende a acompanhar mais o próprio mercado imobiliário (vacância, renegociação de contratos) do que o juro.";
  }

  // híbrido e FoF: proporção real não é exposta pela fonte de dados — dizer uma
  // direção aqui seria inventar precisão que não se tem.
  const kind = segment === "hibrido" ? "híbrido" : "de fundos (FoF)";
  return `FII ${kind}: o efeito do ciclo de juro atual depende da proporção real entre papel e tijolo na carteira, que não é possível medir por aqui — não dá para afirmar se o efeito dominante é de renda (papel) ou de preço (tijolo).`;
}

/**
 * Composição real da carteira do FII e taxa de administração real, direto do Informe
 * Mensal da CVM (ver cvm-data.ts) — não o rótulo de segmento (papel/tijolo/híbrido/
 * FoF) da brapi, que é uma classificação, não uma proporção.
 *
 * O ganho maior é justamente nos casos que `describeFiiInterestRateSensitivity` acima
 * se recusa a dar direção — híbrido e FoF — porque não temos a proporção real entre
 * papel e tijolo. Este dado É essa proporção. Mesmo assim a função não tenta refazer
 * aquela leitura de direção: cruzar composição com ciclo de juro exigiria uma segunda
 * calibração (quanto de "70% tijolo" already é "efeito dominante de preço"?) que não
 * foi medida contra casos reais — melhor entregar o número cru pra IA context do que
 * arriscar uma nova regra não validada.
 *
 * `null` sem dado (fundo fora do informe mais recente, CNPJ não encontrado, ou a CVM
 * fora do ar) devolve string vazia, mesmo padrão das outras describe* daqui.
 */
export function describeFiiCvmComposition(cvmData: FiiCvmData | null): string {
  if (!cvmData) return "";

  const [ano, mes] = cvmData.dataReferencia.split("-");
  const referencia = ano && mes ? `${mes}/${ano}` : cvmData.dataReferencia;

  const parts: string[] = [
    `${(cvmData.imoveisDiretosPct * 100).toFixed(0)}% em imóveis e direitos reais diretos`,
    `${(cvmData.recebiveisEstruturadosPct * 100).toFixed(0)}% em CRI e recebíveis estruturados`,
    `${(cvmData.outrosAtivosPct * 100).toFixed(0)}% em outros ativos financeiros (cotas de outros fundos, ações, SPEs)`,
  ];

  let taxaPart = "";
  if (cvmData.taxaAdministracaoMensalPct != null) {
    const anualizada = cvmData.taxaAdministracaoMensalPct * 12; // aproximação simples (sem juros compostos) só pra dar noção de ordem de grandeza anual — o dado oficial é o mensal
    taxaPart = ` Taxa de administração de ${(cvmData.taxaAdministracaoMensalPct * 100).toFixed(2)}% ao mês sobre o patrimônio (~${(anualizada * 100).toFixed(1)}% ao ano).`;
  }

  return `Composição real da carteira (CVM, referência ${referencia}): ${parts.join(", ")}.${taxaPart}`;
}

/**
 * Zonas de preço em R$ — não uma opinião nova, é a régua de FII que já existe
 * (`evalFiiPriceToNav`/`evalFiiYield` acima) convertida de nota 0-100 pra preço real,
 * usando o VP/cota e o provento real de hoje. As DUAS curvas já eram medidas contra o
 * universo real de FIIs antes de virarem constante (ver os comentários delas); aqui só
 * reaproveitamos os mesmos breakpoints, nunca um novo número.
 *
 * Duas zonas, propositalmente NÃO combinadas numa única faixa: a de P/VP mede desconto
 * patrimonial, a de yield mede renda exigida contra o risco-livre — são leituras
 * diferentes que podem discordar entre si, e forçar uma média esconderia esse
 * desacordo em vez de mostrá-lo.
 */
export interface FiiPriceZones {
  /** VP/cota real, derivado do preço atual e do P/VP (price ÷ priceToNav). */
  navPerShare: number;
  /** Zona pela curva de P/VP (0,85–0,95 do VP/cota) — mesma curva de evalFiiPriceToNav. */
  pvpZoneLow: number;
  pvpZoneHigh: number;
  /** Zona pelo yield exigido (2–4 p.p. acima da Selic líquida) — null sem provento real ou Selic. */
  yieldZoneLow: number | null;
  yieldZoneHigh: number | null;
}

/**
 * `null` sem preço ou P/VP real — nunca estima VP/cota a partir de nada. A zona de
 * yield fica null à parte (dentro do objeto) quando falta provento real dos últimos 12
 * meses ou Selic, sem derrubar a zona de P/VP, que não depende desses dois.
 */
export function computeFiiPriceZones(
  price: number,
  priceToNav: number,
  annualDividendPerUnit: number | null,
  selicPercent: number | null,
): FiiPriceZones | null {
  if (price <= 0 || priceToNav <= 0) return null;

  const navPerShare = price / priceToNav;
  const pvpZoneLow = FII_PVP_HEALTHY_DISCOUNT_RANGE[0] * navPerShare;
  const pvpZoneHigh = FII_PVP_HEALTHY_DISCOUNT_RANGE[1] * navPerShare;

  let yieldZoneLow: number | null = null;
  let yieldZoneHigh: number | null = null;
  if (annualDividendPerUnit != null && annualDividendPerUnit > 0 && selicPercent != null) {
    const referenceYield = selicPercent * (1 - FIXED_INCOME_TAX_RATE);
    const requiredGood = referenceYield + FII_YIELD_PREMIUM_GOOD_THRESHOLD;
    const requiredStrong = referenceYield + FII_YIELD_PREMIUM_STRONG_THRESHOLD;
    // Prêmio maior exige yield maior, o que implica preço MENOR (yield = provento/preço)
    // — por isso requiredStrong (o prêmio mais alto) vira o preço mais baixo da zona.
    if (requiredGood > 0 && requiredStrong > 0) {
      yieldZoneHigh = annualDividendPerUnit / (requiredGood / 100);
      yieldZoneLow = annualDividendPerUnit / (requiredStrong / 100);
    }
  }

  return { navPerShare, pvpZoneLow, pvpZoneHigh, yieldZoneLow, yieldZoneHigh };
}

export function describeFiiPriceZones(zones: FiiPriceZones | null): string {
  if (!zones) return "";

  const parts = [
    `zona de desconto saudável por P/VP (${FII_PVP_HEALTHY_DISCOUNT_RANGE[0].toFixed(2)}–${FII_PVP_HEALTHY_DISCOUNT_RANGE[1].toFixed(2)} do VP/cota real de R$${zones.navPerShare.toFixed(2)}): R$${zones.pvpZoneLow.toFixed(2)}–R$${zones.pvpZoneHigh.toFixed(2)}`,
  ];
  if (zones.yieldZoneLow != null && zones.yieldZoneHigh != null) {
    parts.push(
      `zona de preço pelo yield exigido (${FII_YIELD_PREMIUM_GOOD_THRESHOLD}–${FII_YIELD_PREMIUM_STRONG_THRESHOLD} p.p. acima da Selic líquida de IR, sobre o provento real dos últimos 12 meses): R$${zones.yieldZoneLow.toFixed(2)}–R$${zones.yieldZoneHigh.toFixed(2)}`,
    );
  }

  return `Zonas de preço calculadas a partir das mesmas curvas reais da régua de FII (não é previsão nem recomendação, é a régua de score convertida em R$): ${parts.join("; ")}.`;
}
