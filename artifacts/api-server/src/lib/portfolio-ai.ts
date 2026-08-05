import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import { describeMacroContext, type MacroContext } from "./macro-data";

const DIAGNOSIS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface PortfolioDiagnosisInput {
  score: number;
  classification: string;
  diversification: number;
  concentration: number;
  risk: number;
  dividends: number;
  growth: number;
  composition: { ticker: string; category: string; percent: number }[];
  macro: MacroContext;
  investorProfile: string | null; // "Conservador" | "Moderado" | "Arrojado" — null se o usuário nunca preencheu o questionário
}

// Faixas de referência (renda fixa x variável) por perfil, usadas só como contexto
// interpretativo pra IA — não recalculam nem sobrescrevem nenhuma dimensão do score.
const ALLOCATION_GUIDANCE: Record<string, string> = {
  Conservador: "para perfil conservador, praxe de mercado sugere 70-90% em renda fixa",
  Moderado: "para perfil moderado, praxe de mercado sugere 50-70% em renda fixa",
  Arrojado: "para perfil arrojado, praxe de mercado sugere 20-40% em renda fixa",
};

let anthropicClient: Anthropic | null | undefined;

function getClient(): Anthropic | null {
  if (anthropicClient !== undefined) return anthropicClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  anthropicClient = apiKey ? new Anthropic({ apiKey }) : null;
  return anthropicClient;
}

const diagnosisCache = new Map<string, { text: string; fetchedAt: number }>();

function buildPrompt(input: PortfolioDiagnosisInput): string {
  const { score, classification, diversification, concentration, risk, dividends, growth, composition, macro, investorProfile } = input;
  const compositionText = composition.map((c) => `${c.ticker} (${c.category}): ${c.percent.toFixed(1)}%`).join(", ");

  const distinctAssets = composition.length;
  const maxPosition = composition.reduce((max, c) => Math.max(max, c.percent), 0);
  const concentrationNote =
    maxPosition >= 25
      ? `A maior posição individual é ${maxPosition.toFixed(1)}% da carteira — acima da faixa de 3-5% por ativo que gestores profissionais costumam usar fora de posições de altíssima convicção. Mencione isso explicitamente se fizer sentido.`
      : `Nenhuma posição individual passa de ${maxPosition.toFixed(1)}%, dentro de uma faixa de concentração saudável.`;
  const diversificationNote = `A carteira tem ${distinctAssets} ativo(s) distinto(s) — literatura de diversificação (Markowitz) costuma apontar a faixa de 10-20 ativos bem distribuídos por setor como ponto de retorno marginal decrescente; poucos ativos concentram risco, muitos deixam de agregar diversificação de verdade.`;

  const allocationNote = investorProfile && ALLOCATION_GUIDANCE[investorProfile]
    ? `Perfil de investidor do usuário: ${investorProfile} (${ALLOCATION_GUIDANCE[investorProfile]}). Se a composição real da carteira (renda_fixa vs. o resto) estiver claramente fora dessa faixa de referência, pode mencionar — é só um contexto de mercado, não uma regra rígida.`
    : "Perfil de investidor: não preenchido pelo usuário — não compare a alocação com nenhuma faixa de referência.";

  return (
    `Você é um consultor de carteira de investimentos pessoal explicando, de forma acessível e em ` +
    `português do Brasil, o resultado de um score de saúde de carteira JÁ CALCULADO. Você não deve ` +
    `recalcular nem propor um score diferente.\n\n` +
    `Score geral: ${score}/100 (${classification})\n` +
    `Diversificação: ${diversification}/100\n` +
    `Concentração: ${concentration}/100\n` +
    `Risco: ${risk}/100\n` +
    `Dividendos: ${dividends}/100\n` +
    `Crescimento: ${growth}/100\n` +
    `Composição: ${compositionText || "carteira vazia"}\n` +
    `${describeMacroContext(macro)}\n` +
    `${concentrationNote}\n` +
    `${diversificationNote}\n` +
    `${allocationNote}\n\n` +
    `Escreva um diagnóstico qualitativo (3-6 frases) explicando os pontos fortes e fracos desta ` +
    `carteira com base SOMENTE nos números acima — interprete, não repita os números literalmente. ` +
    `Use as referências de concentração, diversificação e alocação por perfil como pano de fundo do ` +
    `seu raciocínio, citando-as quando forem relevantes pro diagnóstico, mas sem transformar isso numa ` +
    `lista de regras soltas. Se o diagnóstico geral for fraco (score baixo ou classificação Regular/Ruim), ` +
    `inclua um lembrete breve de que decisões de rebalanceamento não devem ser tomadas por impulso após ` +
    `um movimento recente de mercado — vieses como aversão a perda e viés de recência levam a decisões ` +
    `piores nesse momento. Não invente nenhum dado novo.\n\n` +
    `Formato de saída: texto plano, sem markdown, 3-6 frases.`
  );
}

/**
 * Diagnóstico qualitativo via Claude por cima do score de saúde já calculado
 * deterministicamente em routes/portfolio.ts — a IA nunca recalcula o score, só
 * interpreta os números em texto. Retorna null sem ANTHROPIC_API_KEY ou em caso de
 * erro; o campo `aiDiagnosis` da resposta simplesmente fica null nesse caso.
 */
export async function synthesizePortfolioDiagnosis(input: PortfolioDiagnosisInput): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  // maxPosition/distinctAssets entram na chave porque o texto agora cita esses
  // números diretamente — sem isso duas carteiras com os mesmos 5 scores mas
  // composição diferente serviriam o mesmo texto cacheado (bug preexistente que
  // ficaria mais visível com essas novas referências no prompt).
  const maxPosition = input.composition.reduce((max, c) => Math.max(max, c.percent), 0);
  const cacheKey = JSON.stringify({
    score: input.score,
    diversification: input.diversification,
    concentration: input.concentration,
    risk: input.risk,
    dividends: input.dividends,
    growth: input.growth,
    distinctAssets: input.composition.length,
    maxPosition: Math.round(maxPosition),
    investorProfile: input.investorProfile,
  });
  const cached = diagnosisCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < DIAGNOSIS_CACHE_TTL_MS) return cached.text;

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 550, // 3-6 frases com concentração+diversificação+alocação+viés comportamental passam de 400 com o prompt maior
      messages: [{ role: "user", content: buildPrompt(input) }],
    });

    const text = message.content.find((block) => block.type === "text")?.text?.trim() ?? "";
    if (!text) return null;

    diagnosisCache.set(cacheKey, { text, fetchedAt: Date.now() });
    return text;
  } catch (err) {
    logger.warn({ err }, "Anthropic portfolio diagnosis synthesis failed");
    return null;
  }
}
