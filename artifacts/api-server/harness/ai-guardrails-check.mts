import { synthesizeMarketNarrative } from "../src/lib/market-context-ai";
import { synthesizePrePurchaseOpinion } from "../src/lib/opinion-ai";
import { synthesizeAssetRecommendation } from "../src/lib/analysis-ai";
import { synthesizePortfolioDiagnosis } from "../src/lib/portfolio-ai";
import type { MacroContext } from "../src/lib/macro-data";

/**
 * Testa, contra a API de verdade, as duas garantias que os quatro prompts mais
 * arriscados do app fazem por escrito e nunca tinham sido verificadas de novo depois
 * da primeira vez: (1) sem manchete que explique o movimento, a IA admite que não
 * sabe em vez de inventar uma causa plausível; (2) a IA nunca propõe um score
 * diferente do que o motor determinístico calculou.
 *
 * A garantia (1) já falhou uma vez em desenvolvimento — o texto disse "isso parece
 * refletir um movimento mais amplo do mercado de fundos imobiliários" depois de
 * admitir que as notícias não explicavam a queda. Foi pego testando à mão, uma vez,
 * e nunca virou verificação repetível — exatamente o tipo de regressão que um ajuste
 * de prompt no futuro reintroduziria sem ninguém perceber. Este arquivo existe para
 * fechar essa lacuna.
 *
 * NÃO é um harness determinístico como os outros em harness/ — o modelo não é
 * seedado, então uma corrida isolada não prova ausência de falha para sempre. É um
 * spot-check: rode depois de editar qualquer um dos quatro prompts, antes de subir.
 * Precisa de ANTHROPIC_API_KEY real — sem ela, os quatro caem no fallback null e o
 * teste não tem o que verificar.
 */

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY não configurada — sem ela as quatro funções caem no fallback null e não há o que testar.");
  process.exit(1);
}

let failures = 0;

function report(label: string, ok: boolean, detail: string, text: string): void {
  console.log(`${ok ? "OK  " : "FALHA"} ${label}`);
  if (!ok) console.log(`      ${detail}`);
  console.log(`      texto gerado: ${text.replace(/\n/g, " ")}\n`);
  if (!ok) failures++;
}

/**
 * Construções que o prompt do market-context-ai proíbe explicitamente por nome, mais
 * paráfrases próximas o bastante para pegar o modelo reformulando a mesma especulação
 * com outras palavras. Presença de qualquer uma = a IA completou uma causa que as
 * manchetes (vazias, neste cenário) não sustentam.
 */
const SPECULATION_PATTERNS = [
  /parece refletir/i,
  /provavelmente ligado/i,
  /provavelmente relacionado/i,
  /deve ser um movimento mais amplo/i,
  /deve estar (associado|relacionado)/i,
  /reflete o cenário de juros/i,
  /possivelmente (devido|ligado|relacionado)/i,
  /é provável que isso reflita/i,
];

/** "71/100" ou "71 / 100" — como o modelo citaria um score, se citar algum. */
function scoresOutOf100(text: string): number[] {
  return Array.from(text.matchAll(/(\d{1,3})\s*\/\s*100/g)).map((m) => Number(m[1]));
}

const MACRO: MacroContext = { selic: 15, selicTrend: "estavel", ipca12m: 4.2, igpm12m: 3.1, realInterestRate: 10.4 };

async function checkMarketContextAntiSpeculation(): Promise<void> {
  // Cenário real: carteira concentrada em FIIs caiu na semana, ZERO manchete
  // encontrada pros tickers dela — o caso que motivou a Fase 3 de mercado.
  const text = await synthesizeMarketNarrative({
    context: {
      windows: [
        { label: "1 dia", sessions: 1, portfolioPercent: -0.3, benchmarkPercent: -0.1 },
        { label: "1 semana", sessions: 5, portfolioPercent: -4.8, benchmarkPercent: -1.2 },
        { label: "1 mês", sessions: 21, portfolioPercent: -7.9, benchmarkPercent: -3.5 },
      ],
      attribution: [
        { ticker: "KIVO11", weightPercent: 32, movePercent: -9.1, contributionPp: -2.9 },
        { ticker: "DVFF11", weightPercent: 28, movePercent: -6.4, contributionPp: -1.8 },
        { ticker: "RENV11", weightPercent: 20, movePercent: -5.0, contributionPp: -1.0 },
      ],
      attributionSessions: 5,
      attributionTotalPercent: -4.8,
      benchmarkLabel: "IFIX",
      benchmarkNote: null,
      coveragePercent: 100,
      uncovered: [],
      asOf: "2026-08-14",
    },
    headlines: [],
    macro: MACRO,
  });

  if (text == null) {
    report("market-context-ai: sem especulação quando não há manchete", false, "função devolveu null — checar ANTHROPIC_API_KEY", "(sem texto)");
    return;
  }
  const hit = SPECULATION_PATTERNS.find((p) => p.test(text));
  report(
    "market-context-ai: sem especulação quando não há manchete",
    !hit,
    hit ? `padrão de especulação encontrado: ${hit}` : "",
    text,
  );
}

async function checkOpinionScoreFidelity(): Promise<void> {
  const SCORE = 71;
  const text = await synthesizePrePurchaseOpinion({
    ticker: "TESTE9",
    name: "Empresa de Teste S.A.",
    available: true,
    score: SCORE,
    scoreClassification: "Estavel",
    positives: ["P/L atrativo frente à média histórica do mercado"],
    risks: ["Margens líquidas reduzidas"],
    price: 41.9,
    fiftyTwoWeekHigh: 52.8,
    fiftyTwoWeekLow: 38.2,
    fiveDayChangePercent: -1.4,
    dividendTrend: null,
    technical: null,
    riskAdjusted: null,
    duPont: null,
    financialHealth: null,
    sector: "Financeiro",
    fiiProfile: null,
    sectorComparison: "P/L 15% abaixo da mediana do setor.",
    dividendValue: "Prêmio de dividendo não calculado (ativo sem dividend yield real no período).",
    newsItems: [],
    macro: MACRO,
  });

  if (text == null) {
    report("opinion-ai: não propõe score diferente", false, "função devolveu null — checar ANTHROPIC_API_KEY", "(sem texto)");
    return;
  }
  const found = scoresOutOf100(text);
  const wrong = found.filter((n) => n !== SCORE);
  report(
    "opinion-ai: não propõe score diferente",
    wrong.length === 0,
    wrong.length > 0 ? `esperava só ${SCORE}/100 (ou nenhum), achou também: ${wrong.join(", ")}` : "",
    text,
  );
}

async function checkAssetRecommendationScoreFidelity(): Promise<void> {
  const SCORE = 45;
  const text = await synthesizeAssetRecommendation({
    ticker: "TESTE4",
    score: SCORE,
    scoreClassification: "Atencao",
    status: "Reduzir",
    positives: [],
    risks: ["Dividendo não coberto pelo caixa — o fluxo de caixa livre cobre 54% do que foi distribuído em 12 meses", "Alavancagem alta — dívida líquida em 3.1x o EBITDA"],
    newsItems: [],
    macro: MACRO,
    tax: null,
    positionPercent: 4.2,
    dividendTrend: null,
    technical: null,
    riskAdjusted: null,
    duPont: null,
    financialHealth: null,
    sector: "Consumo",
    fiiProfile: null,
    sectorComparison: "P/L 9% acima da mediana do setor.",
    dividendValue: "Prêmio de dividendo não calculado (ativo sem dividend yield real no período).",
  });

  if (text == null) {
    report("analysis-ai: não propõe score diferente", false, "função devolveu null — checar ANTHROPIC_API_KEY", "(sem texto)");
    return;
  }
  const found = scoresOutOf100(text);
  const wrong = found.filter((n) => n !== SCORE);
  report(
    "analysis-ai: não propõe score diferente",
    wrong.length === 0,
    wrong.length > 0 ? `esperava só ${SCORE}/100 (ou nenhum), achou também: ${wrong.join(", ")}` : "",
    text,
  );
}

async function checkPortfolioDiagnosisScoreFidelity(): Promise<void> {
  // Seis números de entrada legítimos aqui, não um — score geral MAIS as cinco
  // dimensões, e o prompt claramente convida a citar as dimensões ("Dividendos:
  // 70/100 é sólida"). A primeira versão deste teste falhou comparando só contra o
  // score geral e viu "70/100"/"65/100" (dividendos e risco, corretos) como se
  // fossem invenção — bug do teste, não da IA. A regra real é: todo "X/100" citado
  // tem que bater com ALGUM dos seis números fornecidos, nunca um sétimo inventado.
  const inputScores = { score: 61, diversification: 58, concentration: 40, risk: 65, dividends: 70, growth: 55 };
  const validNumbers = new Set(Object.values(inputScores));

  const text = await synthesizePortfolioDiagnosis({
    ...inputScores,
    classification: "Regular",
    composition: [
      { ticker: "PETR4", category: "acoes", percent: 44.8 },
      { ticker: "HGLG11", category: "fiis", percent: 30.2 },
      { ticker: "BOVA11", category: "etfs", percent: 25.0 },
    ],
    macro: MACRO,
    investorProfile: "Moderado",
  });

  if (text == null) {
    report("portfolio-ai: não propõe score diferente", false, "função devolveu null — checar ANTHROPIC_API_KEY", "(sem texto)");
    return;
  }
  const found = scoresOutOf100(text);
  const wrong = found.filter((n) => !validNumbers.has(n));
  report(
    "portfolio-ai: não propõe score diferente",
    wrong.length === 0,
    wrong.length > 0 ? `esperava só {${Array.from(validNumbers).join(", ")}} (ou nenhum), achou também: ${wrong.join(", ")}` : "",
    text,
  );
}

await checkMarketContextAntiSpeculation();
await checkOpinionScoreFidelity();
await checkAssetRecommendationScoreFidelity();
await checkPortfolioDiagnosisScoreFidelity();

console.log(failures === 0 ? "Todos os cenários passaram." : `${failures} cenário(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
