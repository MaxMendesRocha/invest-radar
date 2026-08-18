import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import { describeMacroContext, type MacroContext } from "./macro-data";
import type { DividendTrend } from "./market-data";
import { describeTechnicalIndicators, type TechnicalIndicators } from "./technical-engine";
import { describeRiskAdjustedMetrics, type RiskAdjustedMetrics } from "./risk-metrics-engine";
import { describeDuPontBreakdown, type DuPontBreakdown } from "./analysis-engine";
import { describeFinancialHealth, type FinancialHealth } from "./financial-health-engine";
import { describeFiiProfile, describeFiiInterestRateSensitivity, describeFiiCvmComposition, describeFiiPriceZones, type FiiPriceZones } from "./fii-engine";
import { describeFiiPeers, type FiiPeer } from "./sector-benchmarks";
import type { FiiProfile } from "./market-data";
import type { FiiCvmData } from "./cvm-data";

const OPINION_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // preço/notícias mudam ao longo do dia, mas não a ponto de justificar cache mais curto pra um parecer sob demanda

export interface PrePurchaseOpinionInput {
  ticker: string;
  name: string | null;
  available: boolean; // fundamentos disponíveis (analyzeFundamentals)
  score: number;
  scoreClassification: string;
  positives: string[];
  risks: string[];
  price: number;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  fiveDayChangePercent: number | null;
  dividendTrend: DividendTrend | null;
  technical: TechnicalIndicators | null; // null quando não há candles suficientes (technical-engine.ts)
  riskAdjusted: RiskAdjustedMetrics | null; // null quando não há candles suficientes (risk-metrics-engine.ts)
  duPont: DuPontBreakdown | null; // null quando DRE/balanço estão incompletos (computeDuPontBreakdown, analysis-engine.ts)
  financialHealth: FinancialHealth | null; // métricas de caixa/liquidez (financial-health-engine.ts) — null se o provider não trouxer nada
  sector: string | null; // usado só pra ressalva de comparabilidade em setor financeiro (ver describeFinancialHealth)
  fiiProfile: FiiProfile | null; // só pra FIIs — null pra qualquer outra categoria (ver getFiiProfiles)
  fiiCvmData: FiiCvmData | null; // composição real + taxa de administração real, via CVM (ver cvm-data.ts) — null pra qualquer outra categoria ou fundo fora do informe mais recente
  fiiPriceZones: FiiPriceZones | null; // zonas de preço em R$ derivadas das curvas reais de P/VP e yield (ver computeFiiPriceZones, fii-engine.ts) — null pra qualquer outra categoria ou sem P/VP real
  fiiPeers: FiiPeer[]; // pares reais nomeados do mesmo segmento (ver getFiiPeers, sector-benchmarks.ts) — array vazio pra qualquer outra categoria ou sem pares na última varredura
  sectorComparison: string;
  dividendValue: string; // já formatado pelo chamador via describeDividendValue (dividend-value-engine.ts) // já formatado pelo chamador via describeSectorComparison (sector-benchmarks.ts)
  newsItems: string[]; // já formatadas com "[Impacto] título"
  macro: MacroContext;
}

let anthropicClient: Anthropic | null | undefined;

function getClient(): Anthropic | null {
  if (anthropicClient !== undefined) return anthropicClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  anthropicClient = apiKey ? new Anthropic({ apiKey }) : null;
  return anthropicClient;
}

const opinionCache = new Map<string, { text: string; fetchedAt: number }>();

function buildPrompt(input: PrePurchaseOpinionInput): string {
  const { ticker, name, available, score, scoreClassification, positives, risks, price, fiftyTwoWeekHigh, fiftyTwoWeekLow, fiveDayChangePercent, dividendTrend, technical, riskAdjusted, duPont, financialHealth, sector, fiiProfile, fiiCvmData, fiiPriceZones, fiiPeers, sectorComparison, dividendValue, newsItems, macro } = input;

  const fundamentalsLine = available
    ? `Score do Radar: ${score}/100 (${scoreClassification})\nPontos positivos (fundamentos reais): ${positives.join("; ") || "nenhum"}\nPontos de atenção (fundamentos reais): ${risks.join("; ") || "nenhum"}`
    : "Fundamentos detalhados não disponíveis pra este ativo no momento — baseie a leitura só em preço, notícias e macro, e deixe claro essa limitação.";

  const rangeLine =
    fiftyTwoWeekHigh != null && fiftyTwoWeekLow != null
      ? `Preço atual: R$${price.toFixed(2)}. Range de 52 semanas: R$${fiftyTwoWeekLow.toFixed(2)} - R$${fiftyTwoWeekHigh.toFixed(2)} (preço atual está a ${(((price - fiftyTwoWeekLow) / (fiftyTwoWeekHigh - fiftyTwoWeekLow)) * 100).toFixed(0)}% do range, onde 0% é a mínima e 100% é a máxima de 52 semanas).${fiveDayChangePercent != null ? ` Variação nos últimos 5 pregões: ${fiveDayChangePercent >= 0 ? "+" : ""}${fiveDayChangePercent.toFixed(1)}%.` : ""}`
      : `Preço atual: R$${price.toFixed(2)}. Range de 52 semanas indisponível.`;

  const dividendLine = dividendTrend
    ? `Proventos pagos nos últimos 12 meses: R$${dividendTrend.last12mTotal.toFixed(2)}/unidade, vs. R$${dividendTrend.prior12mTotal.toFixed(2)}/unidade nos 12 meses anteriores (variação de ${dividendTrend.growthPercent >= 0 ? "+" : ""}${dividendTrend.growthPercent.toFixed(1)}%).`
    : "Histórico de provento insuficiente pra avaliar tendência (não avalie isso, apenas não mencione).";

  const technicalLine = describeTechnicalIndicators(technical);
  const riskAdjustedLine = describeRiskAdjustedMetrics(riskAdjusted);
  const duPontLine = describeDuPontBreakdown(duPont);
  const financialHealthLine = financialHealth ? describeFinancialHealth(financialHealth, sector) : "Métricas de caixa e liquidez não disponíveis para este ativo.";
  const fiiProfileLine = describeFiiProfile(fiiProfile);
  const fiiRateSensitivityLine = describeFiiInterestRateSensitivity(fiiProfile?.segmentType ?? null, macro.selicTrend);
  const fiiCvmCompositionLine = describeFiiCvmComposition(fiiCvmData);
  const fiiPriceZonesLine = describeFiiPriceZones(fiiPriceZones);
  const fiiPeersLine = describeFiiPeers(fiiPeers);

  return (
    `Você é um analista financeiro sênior dando uma PRIMEIRA LEITURA sobre um ativo pra alguém que ` +
    `está avaliando comprar — a pessoa ainda não tem posição nesse ativo, então isso não é sobre segurar ` +
    `ou vender nada, é sobre se o momento parece razoável pra começar ou reforçar uma posição. Não é uma ` +
    `recomendação formal de investimento, é uma ferramenta de uso pessoal — pode e deve ser direto, como ` +
    `um analista de verdade seria numa conversa privada. Escreva em português do Brasil, de forma objetiva.\n\n` +
    `Ativo: ${ticker}${name ? ` (${name})` : ""}\n` +
    `${fundamentalsLine}\n` +
    `${rangeLine}\n` +
    `${dividendLine}\n` +
    `Indicadores técnicos (candles reais, 1 ano): ${technicalLine}\n` +
    `Retorno ajustado ao risco (1 ano, CDI como taxa livre de risco): ${riskAdjustedLine}\n` +
    `Decomposição DuPont do ROE: ${duPontLine}\n` +
    `Saúde financeira (caixa, liquidez, alavancagem): ${financialHealthLine}\n` +
    (fiiProfileLine ? `Perfil do FII: ${fiiProfileLine}\n` : "") +
    (fiiRateSensitivityLine ? `${fiiRateSensitivityLine}\n` : "") +
    (fiiCvmCompositionLine ? `${fiiCvmCompositionLine}\n` : "") +
    (fiiPriceZonesLine ? `${fiiPriceZonesLine}\n` : "") +
    (fiiPeersLine ? `${fiiPeersLine}\n` : "") +
    `Comparação com pares do setor: ${sectorComparison}\n` +
    `${dividendValue}\n` +
    `Notícias recentes classificadas: ${newsItems.join(" | ") || "nenhuma"}\n` +
    `${describeMacroContext(macro)}\n\n` +
    `Escreva um parecer curto (2-6 frases) cruzando TODOS os fatores acima. Pode dizer diretamente se o ` +
    `momento parece bom pra entrada ou se vale esperar — cruze a posição do preço no range de 52 semanas ` +
    `com os fundamentos (quando disponíveis): comprar perto da máxima de 52 semanas com fundamentos ` +
    `fracos pede mais cautela do que comprar perto da mínima com fundamentos sólidos, por exemplo. Quando ` +
    `os pontos de atenção envolverem piora de ROE, dívida subindo ou desaceleração de crescimento, pode ` +
    `enquadrar isso como enfraquecimento da vantagem competitiva do negócio (moat). Use a decomposição ` +
    `DuPont pra qualificar o ROE, não só repeti-lo — um ROE alto puxado majoritariamente por alavancagem é ` +
    `um sinal de qualidade bem diferente de um ROE alto puxado por margem operacional forte. Use a saúde financeira como o teste mais duro de sustentabilidade de dividendo: cobertura por fluxo de caixa livre abaixo de 1x significa que a empresa distribuiu mais caixa do que gerou no período — isso pesa MAIS que um payout ratio contábil confortável, porque payout usa lucro e lucro não paga dividendo, caixa paga. Dívida líquida alta sobre EBITDA agrava esse quadro (empresa alavancada corta dividendo antes de deixar de pagar credor). Respeite a ressalva de comparabilidade quando ela aparecer. Se houver linha de perfil de FII, use o segmento pra qualificar o yield em vez de tratá-lo como número solto: yield alto em fundo de papel costuma refletir juro alto e encolhe no ciclo de queda, enquanto em fundo de tijolo reflete aluguel contratado; FoF carrega taxa em duas camadas. Se houver linha de composição real da carteira (dado da CVM), use os percentuais pra qualificar o segmento com números reais — por exemplo, um FII rotulado híbrido mas com 80%+ em imóveis diretos se comporta mais como tijolo na prática — e trate a taxa de administração real (quando disponível) como um custo concreto que corrói o yield líquido do cotista. Se houver linha de zonas de preço (FII), essa é a informação mais direta pra responder "vale a pena entrar agora" — diga explicitamente se o preço atual está dentro, acima ou abaixo das zonas, sem propor uma faixa própria diferente da calculada. Se houver linha de pares reais do segmento, use-a pra dizer se este ativo está mais barato ou mais caro que fundos comparáveis nomeados, não só que a mediana. Use a ` +
    `comparação com o setor como contexto, nunca como sinal automático — um múltiplo mais barato que a ` +
    `média do setor pode ser oportunidade real ou desconto justificado por fundamentos piores; interprete ` +
    `à luz dos outros dados. Use o indicador ` +
    `técnico como contexto de TIMING de entrada, complementar aos fundamentos — nunca como fator decisório ` +
    `principal (ex.: "fundamentos bons e RSI em sobrevenda pode ser um bom ponto de entrada" ou ` +
    `"fundamentos bons mas tecnicamente esticado — talvez valha esperar uma correção"). Use o ` +
    `Sharpe/Sortino/Treynor como contexto de qualidade do retorno passado — retorno alto com Sharpe baixo ` +
    `indica que veio à custa de volatilidade desproporcional, não de qualidade; mencione só quando destoar ` +
    `claramente do que os fundamentos sozinhos sugeririam. NÃO invente nenhum ` +
    `dado que não esteja listado acima. NÃO proponha um score diferente do informado quando os ` +
    `fundamentos estiverem disponíveis — a decisão de score é sempre do motor determinístico, você só ` +
    `interpreta.\n\n` +
    `Formato de saída: texto plano, sem markdown, 2-6 frases.`
  );
}

/**
 * Parecer qualitativo via Claude sobre um ativo AINDA NÃO possuído, pra apoiar decisão
 * de compra — mesmo padrão de synthesizeAssetRecommendation (analysis-ai.ts), mas sem
 * contexto de posição/IR/concentração, que não existem antes da compra. Cacheado por
 * ticker (não por usuário — o dado de entrada é o mesmo pra qualquer um perguntando
 * sobre o mesmo ticker no mesmo dia). Retorna null sem ANTHROPIC_API_KEY ou em caso de
 * erro, pra o chamador cair num texto determinístico em vez de quebrar a rota.
 */
export async function synthesizePrePurchaseOpinion(input: PrePurchaseOpinionInput): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  const dividendKeyPart = input.dividendTrend ? Math.round(input.dividendTrend.growthPercent) : "na";
  const technicalKeyPart = input.technical
    ? `${input.technical.crossSignal ?? "na"}:${input.technical.rsi14 != null ? Math.round(input.technical.rsi14 / 5) * 5 : "na"}`
    : "na";
  const riskAdjustedKeyPart = input.riskAdjusted ? Math.round(input.riskAdjusted.sharpeRatio * 10) : "na";
  const cacheKey = `${input.ticker}:${input.score}:${Math.round(input.price)}:${dividendKeyPart}:${technicalKeyPart}:${riskAdjustedKeyPart}`;
  const cached = opinionCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < OPINION_CACHE_TTL_MS) return cached.text;

  try {
    const message = await client.messages.create({
      // Sonnet, não Haiku — mesmo raciocínio de analysis-ai.ts: este é um dos dois
      // pontos que cruzam mais sinais ao mesmo tempo, onde a qualidade da síntese
      // compensa o custo/latência extra. Os pontos de classificação simples e de
      // geração em lote (news.ts, opportunities-ai.ts) continuam em Haiku.
      model: "claude-sonnet-5",
      max_tokens: 750, // 2-6 frases cruzando fundamentos+range+dividendo+técnico+notícias+macro passam de 650 com o prompt maior
      messages: [{ role: "user", content: buildPrompt(input) }],
    });

    const text = message.content.find((block) => block.type === "text")?.text?.trim() ?? "";
    if (!text) return null;

    opinionCache.set(cacheKey, { text, fetchedAt: Date.now() });
    return text;
  } catch (err) {
    logger.warn({ err, ticker: input.ticker }, "Anthropic pre-purchase opinion synthesis failed");
    return null;
  }
}
