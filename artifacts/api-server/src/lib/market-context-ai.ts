import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import { describeMacroContext, type MacroContext } from "./macro-data";
import type { MarketContext } from "./market-context-engine";

/**
 * O "por quê" da variação, escrito por cima de números JÁ calculados.
 *
 * Este é o ponto de IA mais arriscado do app, e a razão é específica: perguntar a um
 * modelo "por que o mercado caiu" é um convite a inventar causa. Existe sempre uma
 * narrativa macro disponível — juro, eleição, commodity, exterior — que soa plausível
 * para qualquer movimento, em qualquer direção. Texto assim não é análise, é adivinhação
 * com voz de autoridade, e seria a primeira coisa neste app a passar por medição sem ser.
 *
 * Três amarras contra isso:
 *
 * 1. A IA só recebe MANCHETES REAIS já buscadas por ativo e o snapshot macro medido.
 *    Não há campo livre para "contexto de mercado" saído do treino do modelo.
 * 2. O prompt manda dizer explicitamente quando as manchetes NÃO explicam o movimento.
 *    "Não sei" é resposta aceita e pedida, não falha.
 * 3. Nenhum número sai daqui. Os percentuais e a atribuição já estão na tela, calculados
 *    em market-context-engine.ts; este texto interpreta, e a tela continua de pé sem ele.
 *
 * Sem ANTHROPIC_API_KEY o campo vem null e o card fica exatamente como estava.
 */

const NARRATIVE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface MarketNarrativeInput {
  context: MarketContext;
  /** Manchetes reais por ativo, já classificadas por impacto em news.ts. */
  headlines: { ticker: string; title: string; impact: string | null }[];
  macro: MacroContext;
}

let anthropicClient: Anthropic | null | undefined;

function getClient(): Anthropic | null {
  if (anthropicClient !== undefined) return anthropicClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  anthropicClient = apiKey ? new Anthropic({ apiKey }) : null;
  return anthropicClient;
}

const narrativeCache = new Map<string, { text: string; fetchedAt: number }>();

function buildPrompt(input: MarketNarrativeInput): string {
  const { context, headlines, macro } = input;

  const windowsText = context.windows
    .map(
      (w) =>
        `${w.label}: carteira ${w.portfolioPercent.toFixed(2)}%` +
        (w.benchmarkPercent != null ? `, ${context.benchmarkLabel} ${w.benchmarkPercent.toFixed(2)}%` : ""),
    )
    .join(" | ");

  const attributionText = context.attribution
    .map(
      (a) =>
        `${a.ticker} pesa ${a.weightPercent.toFixed(0)}%, variou ${a.movePercent.toFixed(2)}%, ` +
        `contribuiu ${a.contributionPp.toFixed(2)}pp`,
    )
    .join("; ");

  const headlinesText =
    headlines.length > 0
      ? headlines.map((h) => `- [${h.ticker}${h.impact ? ` · ${h.impact}` : ""}] ${h.title}`).join("\n")
      : "(nenhuma manchete recente encontrada para os ativos desta carteira)";

  const week = context.windows.find((w) => w.sessions === 5) ?? context.windows[0];
  const versusMarket =
    week?.benchmarkPercent != null
      ? week.portfolioPercent > week.benchmarkPercent
        ? `A carteira foi MELHOR que o ${context.benchmarkLabel} no período de ${week.label.toLowerCase()}.`
        : `A carteira foi PIOR ou igual ao ${context.benchmarkLabel} no período de ${week.label.toLowerCase()}.`
      : "";

  return (
    `Você escreve para um investidor pessoa física, em português do Brasil, explicando o que ` +
    `aconteceu com a carteira dele no período recente. Os números abaixo já foram calculados e ` +
    `NÃO devem ser recalculados nem contestados.\n\n` +
    `Variação por janela — ${windowsText}\n` +
    `Benchmark usado: ${context.benchmarkLabel}. ${versusMarket}\n` +
    `Atribuição em ${context.attributionSessions} pregões (total ${context.attributionTotalPercent.toFixed(2)}%): ` +
    `${attributionText}\n` +
    `${describeMacroContext(macro)}\n\n` +
    `Manchetes recentes dos ativos desta carteira:\n${headlinesText}\n\n` +
    `REGRA MAIS IMPORTANTE: só atribua causa ao movimento se as manchetes acima sustentarem essa ` +
    `causa. Se elas não explicarem o que aconteceu, diga isso com todas as letras — algo como "as ` +
    `notícias disponíveis não explicam esse movimento" — E PARE AÍ. Não emende hipótese própria ` +
    `depois de admitir que não sabe: nada de "parece refletir", "provavelmente ligado a", "deve ser ` +
    `um movimento mais amplo do setor", "reflete o cenário de juros". Frases assim são chute com ` +
    `cara de conclusão, e são exatamente o que esta regra existe para impedir.\n\n` +
    `NÃO invente contexto macroeconômico, eventos, decisões de política monetária, cenário ` +
    `eleitoral, movimento de mercado externo, nem comportamento de um SETOR ou CLASSE de ativo que ` +
    `não esteja medido nos dados acima — você não recebeu índice setorial nenhum, então não afirme ` +
    `nada sobre "o mercado de FIIs", "o setor elétrico" ou equivalentes. Existe sempre uma ` +
    `narrativa plausível para qualquer queda, e inventá-la é pior do que não explicar.\n\n` +
    `Comece pelo que mais importa: se a carteira caiu MENOS que o mercado, isso é o fato principal e ` +
    `deve vir primeiro — quatro ativos no vermelho assustam mais do que deveriam quando o índice caiu ` +
    `mais. Depois, aponte qual ativo realmente moveu o resultado, usando a CONTRIBUIÇÃO e não a ` +
    `variação: um ativo que caiu muito mas pesa pouco não é o responsável, e vale dizer isso quando ` +
    `for o caso.\n\n` +
    `Não recomende compra nem venda. Não repita os números literalmente — interprete. Se o movimento ` +
    `for pequeno em dinheiro, pode dizer que é ruído.\n\n` +
    `Formato de saída: texto plano, sem markdown, 2 a 4 frases.`
  );
}

export async function synthesizeMarketNarrative(input: MarketNarrativeInput): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  // A chave inclui a atribuição arredondada e as manchetes: dois dias com a mesma queda
  // mas notícias diferentes merecem textos diferentes, e sem isso o cache serviria a
  // explicação de ontem para o movimento de hoje.
  const cacheKey = JSON.stringify({
    windows: input.context.windows.map((w) => [w.sessions, Math.round(w.portfolioPercent * 10), Math.round((w.benchmarkPercent ?? 0) * 10)]),
    attribution: input.context.attribution.map((a) => [a.ticker, Math.round(a.contributionPp * 100)]),
    headlines: input.headlines.map((h) => h.title),
    asOf: input.context.asOf,
  });
  const cached = narrativeCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < NARRATIVE_CACHE_TTL_MS) return cached.text;

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{ role: "user", content: buildPrompt(input) }],
    });
    const text = message.content.find((block) => block.type === "text")?.text?.trim() ?? "";
    if (!text) return null;
    narrativeCache.set(cacheKey, { text, fetchedAt: Date.now() });
    return text;
  } catch (err) {
    logger.warn({ err }, "market narrative synthesis failed");
    return null;
  }
}
