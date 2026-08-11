import type { DividendEvent, Fundamentals, FiiProfile } from "./market-data";
import { classifyDividendFrequency, computeDistributionMomentum, sumLast12Months } from "./market-data";
import { computeFinancialHealth, financialHealthSignals } from "./financial-health-engine";

export type AnalysisStatus = "COMPRAR" | "MANTER" | "VENDER";
export type ScoreClassification = "Excelente" | "Forte" | "Estavel" | "Atencao" | "Critico";

/**
 * Por que o status é o que é. Só faz sentido para VENDER, onde a mesma palavra vinha
 * de duas causas que pedem ações opostas — ver resolveStatusReason.
 */
export type StatusReason = "fundamentos" | "concentracao" | "fundamentos_e_concentracao";

export interface AnalysisResult {
  available: boolean;
  score: number;
  scoreClassification: ScoreClassification;
  status: AnalysisStatus;
  /** Preenchido só quando status é VENDER. Null nos demais. */
  statusReason: StatusReason | null;
  positives: string[];
  risks: string[];
  monitoringRecommendation: string;
}

interface MetricEval {
  score: number;
  positive?: string;
  risk?: string;
}

/**
 * Interpola linearmente entre pontos de ancoragem `[valor do indicador, nota]`, com
 * os extremos achatados (abaixo do primeiro ponto vale a nota do primeiro; acima do
 * último, a do último).
 *
 * Existe porque as faixas discretas que havia antes ("P/L até 15 vale 90, de 15 a 25
 * vale 65") apagavam quase toda a informação: dois ativos com P/L 8 e 15 recebiam a
 * mesma nota, e um centavo de diferença no indicador derrubava 25 pontos. Medindo o
 * universo real, 29% dos ativos caíam no mesmo score final e o intervalo inteiro
 * cabia entre 43 e 74 — não por serem parecidos, mas porque a régua não tinha
 * resolução para separá-los.
 *
 * Os pontos de ancoragem mantêm de propósito as mesmas notas das faixas antigas nos
 * mesmos limites (P/L 15 continua valendo ~85, P/L 25 ~62): a mudança é dar
 * resolução entre eles, não reinventar o que é bom ou ruim.
 */
function interpolate(value: number, points: readonly (readonly [number, number])[]): number {
  const first = points[0];
  if (value <= first[0]) return first[1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (value <= x1) {
      const [x0, y0] = points[i - 1];
      const t = (value - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return points[points.length - 1][1];
}

// Nas funções abaixo a nota vem da interpolação, mas as frases de positivo/risco
// continuam presas exatamente aos mesmos limites de antes. É deliberado: a nota é
// contínua, o texto não pode ser — "P/L atrativo" ou aparece ou não aparece, e mudar
// junto o gatilho das frases misturaria duas mudanças diferentes numa só.

function evalPE(pe: number | null): MetricEval | null {
  if (pe == null) return null;
  // P/L negativo não é "P/L muito baixo": é prejuízo. Fica fora da curva, com nota fixa.
  if (pe <= 0) return { score: 20, risk: "Empresa reportou prejuízo no período (P/L negativo)" };
  const score = interpolate(pe, [[8, 92], [15, 85], [25, 62], [40, 35], [60, 22]]);
  if (pe <= 15) return { score, positive: "P/L atrativo frente à média histórica do mercado" };
  if (pe <= 25) return { score };
  return { score, risk: "P/L elevado — valuation esticado frente aos fundamentos" };
}

function evalPriceToBook(pb: number | null): MetricEval | null {
  if (pb == null) return null;
  const score = interpolate(pb, [[0.7, 92], [1, 88], [2.5, 62], [4, 42], [6, 30]]);
  if (pb <= 1) return { score, positive: "Negociado abaixo do valor patrimonial (P/VP ≤ 1)" };
  if (pb <= 2.5) return { score };
  return { score, risk: "P/VP elevado frente ao valor patrimonial" };
}

function evalROE(roe: number | null): MetricEval | null {
  if (roe == null) return null;
  if (roe < 0) return { score: 20, risk: "Retorno sobre patrimônio (ROE) negativo" };
  const score = interpolate(roe, [[0, 40], [0.08, 62], [0.15, 85], [0.25, 95]]);
  if (roe >= 0.15) return { score, positive: "ROE elevado — boa geração de retorno sobre o patrimônio" };
  return { score };
}

export interface DuPontBreakdown {
  taxBurden: number; // netIncome / incomeBeforeTax — quanto do lucro antes de impostos sobra depois deles
  interestBurden: number; // incomeBeforeTax / ebit — quanto do EBIT sobra depois das despesas financeiras
  ebitMargin: number; // ebit / totalRevenue
  assetTurnover: number; // totalRevenue / totalAssets — eficiência de uso dos ativos
  leverage: number; // totalAssets / shareholdersEquity — multiplicador de alavancagem
}

// Precisa vir de fora — analysis-engine.ts não importa nada de market-data.ts além
// de Fundamentals, e revenueGrowth já é derivado ali a partir de totalRevenue (que
// não é exposto cru). Aqui recebemos totalRevenue explicitamente porque a
// decomposição DuPont precisa dele — os outros 5 insumos já estão em Fundamentals.
interface DuPontInput {
  totalRevenue: number | null;
  netIncome: number | null;
  incomeBeforeTax: number | null;
  ebit: number | null;
  totalAssets: number | null;
  shareholdersEquity: number | null;
}

// Decomposição de 5 fatores do ROE (padrão CFA/DuPont estendido) — interpretativa,
// não entra na pontuação (o ROE bruto já é avaliado por evalROE acima; decompor de
// novo aqui contaria o mesmo fundamento duas vezes no score). Só calcula quando os 6
// insumos reais estão disponíveis — nunca uma decomposição parcial ou estimada.
export function computeDuPontBreakdown(input: DuPontInput): DuPontBreakdown | null {
  const { totalRevenue, netIncome, incomeBeforeTax, ebit, totalAssets, shareholdersEquity } = input;
  if (
    totalRevenue == null || totalRevenue === 0 ||
    netIncome == null ||
    incomeBeforeTax == null || incomeBeforeTax === 0 ||
    ebit == null || ebit === 0 ||
    totalAssets == null || totalAssets === 0 ||
    shareholdersEquity == null || shareholdersEquity === 0
  ) {
    return null;
  }

  return {
    taxBurden: netIncome / incomeBeforeTax,
    interestBurden: incomeBeforeTax / ebit,
    ebitMargin: ebit / totalRevenue,
    assetTurnover: totalRevenue / totalAssets,
    leverage: totalAssets / shareholdersEquity,
  };
}

// Identifica o fator que mais se distancia de um "neutro" de referência (giro de
// ativos ~1x é o único que não tem teto natural — os outros 4 têm faixa 0-1 ou perto
// disso) e usa isso pra apontar qual alavanca domina o ROE, em vez de só listar os 5
// números — é a leitura que a decomposição DuPont existe pra habilitar.
export function describeDuPontBreakdown(d: DuPontBreakdown | null): string {
  if (!d) return "Decomposição de ROE não disponível (DRE/balanço incompletos para este ativo).";

  const roeCheck = d.taxBurden * d.interestBurden * d.ebitMargin * d.assetTurnover * d.leverage;
  const parts = [
    `carga tributária ${(d.taxBurden * 100).toFixed(0)}%`,
    `carga de juros ${(d.interestBurden * 100).toFixed(0)}%`,
    `margem EBIT ${(d.ebitMargin * 100).toFixed(1)}%`,
    `giro de ativos ${d.assetTurnover.toFixed(2)}x`,
    `alavancagem ${d.leverage.toFixed(2)}x`,
  ];

  const driver =
    d.leverage >= 2.5
      ? " — alavancagem elevada é o fator que mais se destaca nesse ROE, não a operação em si"
      : d.ebitMargin >= 0.25
        ? " — margem operacional forte é o fator que mais se destaca nesse ROE"
        : d.assetTurnover >= 1.5
          ? " — giro de ativos elevado (eficiência operacional) é o fator que mais se destaca nesse ROE"
          : "";

  return `ROE de ${(roeCheck * 100).toFixed(1)}% decomposto em: ${parts.join(", ")}${driver}.`;
}

function evalDebtToEquity(de: number | null): MetricEval | null {
  if (de == null) return null;
  const score = interpolate(de, [[0.2, 93], [0.5, 87], [1.5, 62], [3, 38], [5, 25]]);
  if (de <= 0.5) return { score, positive: "Baixo endividamento em relação ao patrimônio" };
  if (de <= 1.5) return { score };
  return { score, risk: "Endividamento elevado em relação ao patrimônio" };
}

function evalMargin(margin: number | null): MetricEval | null {
  if (margin == null) return null;
  const score = interpolate(margin, [[-0.1, 18], [0, 35], [0.05, 55], [0.15, 82], [0.3, 93], [0.45, 96]]);
  if (margin < 0) return { score, risk: "Margem líquida negativa no período" };
  if (margin >= 0.15) return { score, positive: "Margens líquidas saudáveis" };
  if (margin >= 0.05) return { score };
  return { score, risk: "Margens líquidas reduzidas" };
}

// Yield muito alto costuma ser preço caindo, não distribuição generosa — por isso a
// curva para de subir em 10% em vez de continuar premiando. Não vira penalidade
// porque, sozinho, o yield não distingue os dois casos; quem faz isso é o payout.
export function evalDividendYield(dy: number | null): MetricEval | null {
  if (dy == null) return null;
  const score = interpolate(dy, [[0, 42], [0.03, 58], [0.06, 82], [0.1, 92]]);
  if (dy >= 0.06) return { score, positive: "Dividend yield acima da média do mercado" };
  return { score };
}

// Payout ratio real = DPS dos últimos 12 meses (soma real de proventos pagos, ver
// sumLast12Months em market-data.ts — usa só a janela de 12 meses, não os 24 exigidos
// por computeDividendTrend, pra não descartar dado real disponível quando o provider
// não cobre os 12 meses anteriores) dividido pelo EPS (price/priceEarnings — não há
// campo de EPS direto no plano atual, mas dá pra derivar do P/L, que já é real). Só
// avalia quando há prova de que o ativo de fato pagou provento no período
// (dps12m != null) — sem isso, não dá pra saber payout nenhum, não vira 0. P/L
// negativo com provento pago no período é o pior caso: empresa distribuindo mesmo
// reportando prejuízo — sinal de alerta explícito, não descartado como null.
function evalPayoutRatio(priceEarnings: number | null, price: number, dps12m: number | null): MetricEval | null {
  if (dps12m == null || dps12m <= 0) return null;
  if (priceEarnings == null) return null;
  if (priceEarnings <= 0) {
    return { score: 15, risk: "Distribuiu proventos mesmo reportando prejuízo no período — sustentabilidade do pagamento em risco" };
  }
  const eps = price / priceEarnings;
  if (eps <= 0) return null;
  const payoutRatio = dps12m / eps;
  const score = interpolate(payoutRatio, [[0.1, 88], [0.6, 80], [1, 52], [1.5, 22], [2, 15]]);
  if (payoutRatio <= 0.6) return { score, positive: "Distribuição bem coberta pelo lucro (payout ratio saudável)" };
  if (payoutRatio <= 1.0) return { score };
  return { score, risk: "Distribuição acima do lucro do período (payout ratio acima de 100%) — sustentabilidade em risco" };
}

export function evalRevenueGrowth(growth: number | null): MetricEval | null {
  if (growth == null) return null;
  const score = interpolate(growth, [[-0.25, 18], [-0.05, 50], [0.05, 75], [0.2, 90], [0.4, 95]]);
  if (growth >= 0.05) return { score, positive: "Crescimento de receita consistente" };
  if (growth >= -0.05) return { score };
  return { score, risk: "Queda de receita no período" };
}

function evalTrend(change52w: number | null): MetricEval | null {
  if (change52w == null) return null;
  const score = interpolate(change52w, [[-0.4, 18], [-0.15, 42], [0, 62], [0.2, 85], [0.5, 95]]);
  if (change52w >= 0.2) return { score, positive: "Forte valorização nos últimos 12 meses" };
  if (change52w >= -0.15) return { score };
  return { score, risk: "Forte desvalorização nos últimos 12 meses" };
}

export function evalVolatility(beta: number | null): MetricEval | null {
  if (beta == null) return null;
  const score = interpolate(beta, [[0.4, 92], [0.7, 84], [1.2, 62], [1.8, 38], [2.5, 25]]);
  if (beta <= 0.7) return { score, positive: "Baixa volatilidade frente ao mercado (beta baixo)" };
  if (beta <= 1.2) return { score };
  return { score, risk: "Alta volatilidade frente ao mercado (beta elevado)" };
}

/**
 * Faixas calibradas sobre a distribuição REAL do universo (171 tickers, fundamentos
 * capturados da brapi), não sobre números redondos escolhidos no papel. As faixas
 * antigas (90/75/60/40) foram desenhadas para uma escala que na prática ia de 43 a
 * 74: "Excelente" e "Crítico" eram inalcançáveis e 85% do universo caía em
 * "Estável", o que fazia a classificação não classificar nada.
 *
 * Onde as faixas caem hoje, medido separadamente nas duas réguas:
 *   ações (81)  — Excelente 6%, Forte 12%, Estável 67%, Atenção 12%, Crítico 2%
 *   FIIs  (45)  — Excelente 0%, Forte 18%, Estável 66%, Atenção 9%, Crítico 7%
 *
 * As duas réguas são independentes mas caem quase na mesma distribuição (mediana 75,
 * terceiro quartil 81 em ambas), então a mesma tabela de faixas serve para as duas —
 * um FII "Forte" e uma ação "Forte" significam aproximadamente a mesma coisa.
 */
function scoreClassification(score: number): ScoreClassification {
  if (score >= 88) return "Excelente";
  if (score >= 82) return "Forte";
  if (score >= 65) return "Estavel";
  if (score >= 45) return "Atencao";
  return "Critico";
}

// Limiares de status, alinhados às faixas acima de propósito: Forte ou Excelente
// pede COMPRAR, Crítico pede VENDER, o meio é MANTER. Antes os dois conjuntos de
// números divergiam sem motivo, o que permitia um ativo "Forte" com status "Manter" e
// tornava impossível explicar a relação entre o badge e a classificação.
const BUY_SCORE_THRESHOLD = 82;
const SELL_SCORE_THRESHOLD = 45;

/**
 * Mínimo de indicadores reais para publicar um veredito sobre uma ação.
 *
 * Com um indicador só, a nota do ativo É esse indicador, e o app passa a afirmar com
 * a mesma cara de confiança de quem olhou oito. Medindo o universo, é exatamente onde
 * aparecem os absurdos: os BDRs chegam com apenas o P/L, e o P/L que o provider
 * devolve para eles está corrompido pela razão de conversão do recibo — TSMC34 vem com
 * P/L 149.050 e MSCD34 com 954, enquanto LILY34 vem com 2,6. Sem este piso, os
 * primeiros viravam "Crítico/Vender" e o último "Excelente/Comprar", tudo a partir de
 * um número que não descreve a empresa. Mesma história com os quatro tickers da MRS
 * Logística, que ocupavam quatro das seis primeiras posições do ranking com um P/L
 * cada.
 *
 * Três é o menor número que exclui esses casos sem tocar em nenhuma ação de verdade:
 * as 81 ações do universo têm 6,9 indicadores em média. Ficar sem análise aqui é a
 * resposta honesta — "dados insuficientes" é o que de fato existe —, e é o mesmo
 * critério que a análise de FII aplica no seu próprio conjunto de dimensões.
 */
const MIN_FUNDAMENTAL_METRICS = 3;

/**
 * Limiares de concentração de posição. Antes viviam duplicados em analysis-ai.ts;
 * ficam aqui porque o status determinístico depende deles, e o prompt da IA
 * precisa falar da mesma régua que o badge exibe.
 *
 * Variam por perfil: a mesma posição de 30% é excesso para quem não tem prazo nem
 * reserva para atravessar uma queda, e escolha defensável para quem tem. Sem
 * perfil definido usa a régua do Moderado — os valores originais.
 */
export interface ConcentrationLimits {
  high: number;
  critical: number;
}

const CONCENTRATION_BY_PROFILE: Record<string, ConcentrationLimits> = {
  Conservador: { high: 15, critical: 25 },
  Moderado: { high: 25, critical: 40 },
  Arrojado: { high: 30, critical: 50 },
};

export const DEFAULT_CONCENTRATION_LIMITS = CONCENTRATION_BY_PROFILE.Moderado;

export function concentrationLimitsFor(profileClassification: string | null): ConcentrationLimits {
  return CONCENTRATION_BY_PROFILE[profileClassification ?? ""] ?? DEFAULT_CONCENTRATION_LIMITS;
}

/**
 * Status de posição, determinístico. Cruza qualidade fundamentalista (score) com
 * quanto do patrimônio já está nesse ativo.
 *
 * A concentração entra porque score alto não é sinal de compra: um ativo ótimo que
 * já representa metade da carteira não deve receber "Comprar" — reforçá-lo aumenta
 * o risco em vez de reduzir. Sem esse cruzamento o badge contradiria o texto da
 * própria IA, que nesses casos recomenda reduzir.
 *
 * `positionPercent` é 0 para quem ainda não tem o ativo (parecer pré-compra), o que
 * deixa a decisão por conta do score — que é o correto nesse contexto.
 */
export function resolveAnalysisStatus(
  score: number,
  positionPercent: number,
  limits: ConcentrationLimits = DEFAULT_CONCENTRATION_LIMITS,
): AnalysisStatus {
  if (score < SELL_SCORE_THRESHOLD || positionPercent > limits.critical) return "VENDER";
  if (score >= BUY_SCORE_THRESHOLD && positionPercent < limits.high) return "COMPRAR";
  return "MANTER";
}

/**
 * Qual das duas condições acima disparou o VENDER.
 *
 * Existe porque as duas pedem coisas opostas e o badge sozinho não distinguia:
 *
 * - `fundamentos` (score abaixo de SELL_SCORE_THRESHOLD): o argumento é sobre o ATIVO. Não há quantidade certa a
 *   vender — quanto reduzir de um papel cuja tese piorou depende de convicção, prazo e
 *   imposto, que o app não tem como decidir por ninguém.
 * - `concentracao` (posição acima do crítico do perfil): o argumento é sobre o TAMANHO,
 *   e o ativo pode ser ótimo. Aqui existe resposta aritmética — reduzir até a faixa
 *   saudável — e vender tudo destruiria uma posição boa por um problema de proporção.
 *
 * Quando as duas disparam, as duas precisam ser ditas: reduzir a posição não conserta
 * fundamento ruim, e reavaliar a tese não conserta concentração.
 */
export function resolveStatusReason(
  score: number,
  positionPercent: number,
  limits: ConcentrationLimits = DEFAULT_CONCENTRATION_LIMITS,
): StatusReason | null {
  const weakFundamentals = score < SELL_SCORE_THRESHOLD;
  const overConcentrated = positionPercent > limits.critical;
  if (weakFundamentals && overConcentrated) return "fundamentos_e_concentracao";
  if (weakFundamentals) return "fundamentos";
  if (overConcentrated) return "concentracao";
  return null;
}

export interface TrimSuggestion {
  /** Valor a reduzir para a posição voltar à faixa saudável (limite `high`). */
  value: number;
  /** Percentual da posição que isso representa. */
  percentOfPosition: number;
  targetPercent: number;
}

/**
 * Quanto vender para a posição voltar ao limite `high` do perfil.
 *
 * Com patrimônio T, posição v e alvo h, resolve v − X = h·T, ou seja X = v − h·T.
 *
 * Isso assume que o valor vendido é REALOCADO dentro da carteira, mantendo T. Se o
 * dinheiro sair, o patrimônio medido pelo app encolhe junto e a conta correta seria
 * X = (v − h·T)/(1 − h), que dá quase um terço a mais. As duas contas são defensáveis
 * e a diferença é grande demais para escolher em silêncio — a premissa vai escrita na
 * tela, e realocar é o que o resto do app já assume (o plano de aporte rebalanceia sem
 * vender, então reduzir aqui é a outra ponta do mesmo movimento).
 */
export function computeTrimSuggestion(
  positionValue: number,
  totalPortfolioValue: number,
  limits: ConcentrationLimits = DEFAULT_CONCENTRATION_LIMITS,
): TrimSuggestion | null {
  if (!(positionValue > 0) || !(totalPortfolioValue > 0)) return null;
  const target = (limits.high / 100) * totalPortfolioValue;
  const value = positionValue - target;
  if (!(value > 0)) return null;
  return {
    value,
    percentOfPosition: (value / positionValue) * 100,
    targetPercent: limits.high,
  };
}

function buildRecommendation(risks: string[]): string {
  if (risks.length === 0) {
    return "Fundamentos sólidos no momento. Acompanhar os próximos resultados trimestrais e eventuais mudanças no cenário macroeconômico.";
  }
  return `Principal ponto de atenção: ${risks[0].toLowerCase()}. Acompanhar os próximos resultados trimestrais para confirmar se a tendência se mantém.`;
}

const NO_FUNDAMENTALS_RESULT: AnalysisResult = {
  available: false,
  score: 0,
  scoreClassification: "Estavel",
  status: "MANTER",
  statusReason: null,
  positives: [],
  risks: [],
  monitoringRecommendation: "Dados fundamentalistas não disponíveis para este ativo no momento.",
};

// Renda fixa não é pontuada por fundamento — este score é um marcador neutro, não uma
// medição, e existe só porque o contrato da API exige um número. Ficava em 60, que era
// o piso do "Estavel" na escala antiga; com as faixas recalibradas 60 virou "Atencao",
// o que faria um Tesouro IPCA+ aparecer com cara de problema. 73 é o meio da faixa
// Estavel de hoje, mantendo o marcador coerente com o rótulo que ele sempre teve.
const NOT_QUOTED_RESULT: AnalysisResult = {
  available: true,
  score: 73,
  scoreClassification: "Estavel",
  status: "MANTER",
  statusReason: null,
  positives: [],
  risks: [],
  monitoringRecommendation: "Ativo de renda fixa ou fundo sem ticker de bolsa — fora do escopo da análise fundamentalista automatizada.",
};

// Fallback pra quando getFundamentals() não devolve dado real pra um ticker
// específico (falha pontual do provider, ticker sem cobertura) — "Em breve" em vez
// de fingir um score completo. Ver `computeAnalysis` em routes/analysis.ts.
const PENDING_RESULT: AnalysisResult = {
  available: false,
  score: 0,
  scoreClassification: "Estavel",
  status: "MANTER",
  statusReason: null,
  positives: [],
  risks: [],
  monitoringRecommendation: "Não foi possível obter os fundamentos deste ativo agora — tente gerar a análise novamente em alguns minutos.",
};

export function analysisForUnquotedAsset(): AnalysisResult {
  return NOT_QUOTED_RESULT;
}

export function pendingAnalysis(): AnalysisResult {
  return PENDING_RESULT;
}

// Exportado pra GET /analysis/opinion/:ticker (routes/analysis.ts) reaproveitar o mesmo
// fallback quando um ticker tem cotação mas nenhum fundamento aproveitável — em vez de
// duplicar a mensagem.
export function noFundamentalsAnalysis(): AnalysisResult {
  return NO_FUNDAMENTALS_RESULT;
}

/**
 * Deterministic, rules-based analysis over real fundamentals (brapi.dev) — no AI/LLM
 * involved. Weights mirror the "Score do Radar" formula from the product spec:
 * Fundamentos 40%, Notícias 20%, Macro 20%, Tendência histórica 10%, Volatilidade 10%.
 * Notícias/Macro don't have a real data source yet (Fase 3), so they are left OUT of
 * the average and the remaining weights are renormalized — ver o comentário no corpo
 * da função sobre por que o "60 neutro" que havia antes não era neutro.
 *
 * Called from routes/analysis.ts via computeAnalysis(), fed by market-data.ts's
 * getFundamentals() (brapi.dev — ver o comentário lá sobre como ROE/dívida-patrimônio/
 * crescimento são calculados a partir do balanço e DRE reais, não do módulo pago).
 *
 * dps12m (DPS real dos últimos 12 meses, ver sumLast12Months em market-data.ts) é
 * opcional (default null) — nem toda chamada tem o histórico de proventos já buscado;
 * sem ele, o payout ratio simplesmente não entra na média, igual a qualquer outro
 * fundamento indisponível, nunca vira um valor chutado.
 */
export function analyzeFundamentals(
  f: Fundamentals,
  dps12m: number | null = null,
  positionPercent = 0,
  limits: ConcentrationLimits = DEFAULT_CONCENTRATION_LIMITS,
): AnalysisResult {
  const fundamentalMetrics = [
    evalPE(f.priceEarnings),
    evalPriceToBook(f.priceToBook),
    evalROE(f.returnOnEquity),
    evalDebtToEquity(f.debtToEquity),
    evalMargin(f.profitMargins),
    evalDividendYield(f.dividendYield),
    evalRevenueGrowth(f.revenueGrowth),
    evalPayoutRatio(f.priceEarnings, f.price, dps12m),
  ].filter((m): m is MetricEval => m != null);

  if (fundamentalMetrics.length < MIN_FUNDAMENTAL_METRICS) return NO_FUNDAMENTALS_RESULT;

  const fundamentosScore = fundamentalMetrics.reduce((sum, m) => sum + m.score, 0) / fundamentalMetrics.length;

  const trend = evalTrend(f.fiftyTwoWeekChange);
  const volatility = evalVolatility(f.beta);

  // Notícias (20%) e macro (20%) não têm fonte de dados real ainda, então ficam FORA
  // da média em vez de entrar valendo um "60 neutro". Entrar valendo 60 não era
  // neutro coisa nenhuma: era 40% do peso total puxando todo mundo para o mesmo
  // ponto, e foi a maior causa de o universo inteiro caber entre 43 e 74. Excluir o
  // que não se sabe e renormalizar o resto é o mesmo critério que os fundamentos já
  // usavam (indicador ausente não entra na média) — agora aplicado um nível acima.
  const components = [
    { score: fundamentosScore, weight: 0.4 },
    ...(trend ? [{ score: trend.score, weight: 0.1 }] : []),
    ...(volatility ? [{ score: volatility.score, weight: 0.1 }] : []),
  ];
  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const score = Math.round(components.reduce((sum, c) => sum + c.score * c.weight, 0) / totalWeight);

  const allMetrics = [...fundamentalMetrics, trend, volatility].filter((m): m is MetricEval => m != null);

  // Saúde financeira entra na LISTA, não na média. Os indicadores de caixa já eram
  // calculados e mandados para a IA, mas nunca viravam bullet — e a tela se
  // contradizia: fundamentos com zero riscos ao lado de um parecer descrevendo
  // dividendo pago com dívida. Fora do score de propósito; ver financialHealthSignals.
  const healthSignals = financialHealthSignals(computeFinancialHealth(f, dps12m), f.sector);

  const positives = [...allMetrics.filter((m) => m.positive).map((m) => m.positive!), ...healthSignals.positives];
  const risks = [...allMetrics.filter((m) => m.risk).map((m) => m.risk!), ...healthSignals.risks];

  if (positives.length === 0 && risks.length === 0) {
    positives.push("Fundamentos dentro de padrões medianos, sem sinais de alerta relevantes");
  }

  return {
    available: true,
    score,
    scoreClassification: scoreClassification(score),
    status: resolveAnalysisStatus(score, positionPercent, limits),
    statusReason: resolveStatusReason(score, positionPercent, limits),
    positives,
    risks,
    monitoringRecommendation: buildRecommendation(risks),
  };
}

// ---------------------------------------------------------------------------
// FII: régua própria
// ---------------------------------------------------------------------------
//
// FII não pode ser medido pela régua de ação, e isso foi medido, não suposto. Um FII
// tem 1,8 indicador aproveitável em `Fundamentals` (P/VP e dividend yield) contra 6,9
// de uma ação, e os dois que tem significam coisas diferentes ali: a curva de ação
// trata dividend yield >= 6% como "acima da média do mercado" quando a MEDIANA dos 45
// FIIs do universo é 12%, e trata P/VP <= 1 como desconto quando a mediana do FII é
// 0,88. O resultado era todo FII espremido entre 90 e 92, sem distinguir HGLG11 de um
// fundo de papel com carteira inadimplente.
//
// A régua daqui usa quatro entradas reais, três delas sobre a distribuição — que é o
// que de fato importa em FII:
//   1. yield contra a Selic líquida de IR (35%)
//   2. P/VP com curva de FII (25%)
//   3. regularidade dos pagamentos nos últimos 12 meses (20%)
//   4. direção da distribuição, 6 meses contra os 6 anteriores (20%)

/**
 * Rendimento de FII é isento de IR para pessoa física; renda fixa não é. Comparar o
 * yield do FII com a Selic cheia compararia líquido com bruto e faria todo FII parecer
 * pior do que é. A referência justa é a Selic depois do IR de 15% (alíquota de renda
 * fixa acima de 720 dias, o prazo compatível com quem carrega FII).
 */
const FIXED_INCOME_TAX_RATE = 0.15;

function evalFiiYield(dividendYield: number | null, selicPercent: number | null): MetricEval | null {
  if (dividendYield == null || selicPercent == null) return null;
  const referenceYield = selicPercent * (1 - FIXED_INCOME_TAX_RATE);
  const premium = dividendYield * 100 - referenceYield;
  const score = interpolate(premium, [[-6, 20], [-3, 42], [0, 62], [2, 78], [4, 88], [6, 92]]);
  const pct = (dividendYield * 100).toFixed(1).replace(".", ",");
  const ref = referenceYield.toFixed(1).replace(".", ",");
  if (premium >= 2) {
    return { score, positive: `Rendimento de ${pct}% ao ano, acima da Selic líquida de IR (${ref}%)` };
  }
  if (premium <= -2) {
    return { score, risk: `Rendimento de ${pct}% ao ano, abaixo da Selic líquida de IR (${ref}%)` };
  }
  return { score };
}

/**
 * A curva de P/VP do FII sobe até o desconto saudável (~0,85-0,95) e volta a cair dos
 * dois lados — diferente da curva de ação, que só premia quanto mais barato.
 *
 * A diferença tem razão: o valor patrimonial de um FII não é contábil histórico, é
 * laudo de avaliação dos imóveis ou marcação dos CRIs, reavaliado periodicamente.
 * Quando a cota é negociada a uma fração disso, o mercado não está distraído — está
 * discordando do laudo, normalmente por inadimplência na carteira de recebíveis ou
 * vacância que ainda não entrou na reavaliação. Desconto profundo em FII é sinal de
 * alerta, não pechincha. Do outro lado, ágio relevante sobre o patrimônio também
 * cobra caro por um fluxo que já está precificado.
 */
function evalFiiPriceToNav(priceToNav: number | null): MetricEval | null {
  if (priceToNav == null || priceToNav <= 0) return null;
  const score = interpolate(priceToNav, [[0.3, 25], [0.55, 45], [0.7, 65], [0.85, 82], [0.95, 85], [1.05, 70], [1.2, 48]]);
  const formatted = priceToNav.toFixed(2).replace(".", ",");
  if (priceToNav < 0.6) {
    return { score, risk: `Cotado a ${formatted} do valor patrimonial — desconto dessa ordem costuma indicar problema na carteira, não pechincha` };
  }
  if (priceToNav > 1.1) {
    return { score, risk: `Cotado a ${formatted} do valor patrimonial (ágio sobre o patrimônio)` };
  }
  if (priceToNav <= 1) {
    return { score, positive: `Cotado a ${formatted} do valor patrimonial` };
  }
  return { score };
}

function evalFiiConsistency(paymentsLast12m: number): MetricEval {
  const score = interpolate(paymentsLast12m, [[3, 15], [6, 32], [8, 48], [10, 68], [11, 80], [12, 92]]);
  if (paymentsLast12m >= 12) {
    return { score, positive: "Distribuiu rendimento em todos os 12 últimos meses" };
  }
  if (paymentsLast12m < 10) {
    return { score, risk: `Distribuição irregular — pagou em ${paymentsLast12m} dos últimos 12 meses` };
  }
  return { score };
}

function evalFiiMomentum(ratio: number): MetricEval {
  const score = interpolate(ratio, [[0.5, 20], [0.75, 45], [0.9, 62], [1, 76], [1.15, 88], [1.4, 92]]);
  const changePercent = Math.round((ratio - 1) * 100);
  if (ratio >= 1.1) {
    return { score, positive: `Distribuições ${changePercent}% maiores no último semestre` };
  }
  if (ratio <= 0.85) {
    return { score, risk: `Distribuições ${Math.abs(changePercent)}% menores no último semestre` };
  }
  return { score };
}

export interface FiiAnalysisInput {
  /** Perfil do endpoint dedicado de FII (segmento, P/VP). Null quando o provider não cobre o ticker. */
  profile: FiiProfile | null;
  /** Histórico real de proventos — a base de 3 das 4 dimensões. */
  dividendEvents: DividendEvent[];
  /** Cotação atual, para derivar o yield quando o perfil não traz o campo pronto. */
  price: number | null;
  /** Selic em % ao ano (macro-data). Sem ela o yield não entra na média — não há referência para dizer se é alto. */
  selicPercent: number | null;
}

/**
 * Análise de FII. Mesmo contrato de saída de analyzeFundamentals (AnalysisResult), mas
 * dimensões próprias — ver o bloco de comentário acima sobre por que a régua de ação
 * não serve aqui.
 */
export function analyzeFii(
  input: FiiAnalysisInput,
  positionPercent = 0,
  limits: ConcentrationLimits = DEFAULT_CONCENTRATION_LIMITS,
  now: number = Date.now(),
): AnalysisResult {
  const { profile, dividendEvents, price, selicPercent } = input;

  // O yield vem pronto do endpoint de FII quando disponível; senão é derivado dos
  // proventos reais dos últimos 12 meses sobre a cotação. Os dois caminhos foram
  // conferidos um contra o outro nos 45 FIIs do universo e batem em todos.
  const dps12m = sumLast12Months(dividendEvents, now);
  const derivedYield = dps12m != null && price != null && price > 0 ? dps12m / price : null;
  const dividendYield = profile?.dividendYield12m ?? derivedYield;

  const frequency = classifyDividendFrequency(dividendEvents, now);
  const momentum = computeDistributionMomentum(dividendEvents, now);

  const yieldEval = evalFiiYield(dividendYield, selicPercent);
  const navEval = evalFiiPriceToNav(profile?.priceToNav ?? null);
  const consistencyEval = frequency ? evalFiiConsistency(frequency.paymentsLast12m) : null;
  const momentumEval = momentum ? evalFiiMomentum(momentum.ratio) : null;

  // Armadilha de yield: quando a cota está muito abaixo do patrimônio E a distribuição
  // está encolhendo, o yield alto não é mérito — é aritmética de preço caindo mais
  // rápido que o rendimento. Uma média ponderada pura não sabe expressar isso: ela
  // somaria a nota alta do yield JUNTO com a nota baixa do P/VP, e o fundo problemático
  // sairia no meio da tabela. Aqui o yield deixa de contar como ponto positivo (fica
  // preso no neutro) e o risco é dito com todas as letras.
  const priceToNav = profile?.priceToNav ?? null;
  const yieldIsTrap =
    yieldEval != null &&
    priceToNav != null &&
    priceToNav < 0.7 &&
    momentum != null &&
    momentum.ratio < 0.95;

  const yieldComponent = yieldIsTrap ? { score: Math.min(yieldEval.score, 60) } : yieldEval;

  const components = [
    ...(yieldComponent ? [{ score: yieldComponent.score, weight: 0.35 }] : []),
    ...(navEval ? [{ score: navEval.score, weight: 0.25 }] : []),
    ...(consistencyEval ? [{ score: consistencyEval.score, weight: 0.2 }] : []),
    ...(momentumEval ? [{ score: momentumEval.score, weight: 0.2 }] : []),
  ];

  // Sem nenhuma das quatro dimensões não há análise — o mesmo critério das ações, e o
  // caso real dos 5 tickers do universo que o provider não reconhece como FII.
  if (components.length === 0) return NO_FUNDAMENTALS_RESULT;

  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const score = Math.round(components.reduce((sum, c) => sum + c.score * c.weight, 0) / totalWeight);

  const metrics = [yieldEval, navEval, consistencyEval, momentumEval].filter((m): m is MetricEval => m != null);
  const positives = metrics.filter((m) => m.positive).map((m) => m.positive!);
  const risks = metrics.filter((m) => m.risk).map((m) => m.risk!);

  if (yieldIsTrap) {
    // Entra na frente dos demais riscos: é a leitura que muda a conclusão.
    risks.unshift("Rendimento alto acompanhado de cota muito descontada e distribuição em queda — sinal de carteira deteriorando, não de oportunidade");
    const yieldPositiveIndex = positives.findIndex((p) => p.startsWith("Rendimento de"));
    if (yieldPositiveIndex >= 0) positives.splice(yieldPositiveIndex, 1);
  }

  if (profile?.segmentType) {
    positives.push(`Segmento ${FII_SEGMENT_LABELS[profile.segmentType]}`);
  }

  if (positives.length === 0 && risks.length === 0) {
    positives.push("Distribuição dentro de padrões medianos, sem sinais de alerta relevantes");
  }

  return {
    available: true,
    score,
    scoreClassification: scoreClassification(score),
    status: resolveAnalysisStatus(score, positionPercent, limits),
    statusReason: resolveStatusReason(score, positionPercent, limits),
    positives,
    risks,
    monitoringRecommendation: buildRecommendation(risks),
  };
}

const FII_SEGMENT_LABELS: Record<NonNullable<FiiProfile["segmentType"]>, string> = {
  tijolo: "tijolo (imóvel físico)",
  papel: "papel (CRI/recebíveis)",
  hibrido: "híbrido",
  fof: "fundo de fundos",
};
