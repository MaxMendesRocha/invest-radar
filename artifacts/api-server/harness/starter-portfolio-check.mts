import { defaultPolicyFor, planContribution, ALLOCATION_CATEGORIES } from "../src/lib/allocation-engine";
import { indexerFor } from "../src/lib/treasury-engine";
import { orderByRiskProfile, type RankedOpportunity } from "../src/lib/opportunity-ranking";

/**
 * As premissas em que a tela "Carteira de Partida" se apoia.
 *
 * Ela não calcula nada por conta própria — compõe saída de motores que já existiam. O
 * que este harness protege é justamente isso: se algum desses motores mudar de
 * comportamento, a tela passa a afirmar na cara do usuário coisas que deixaram de ser
 * verdade, e nada no código apontaria para cá.
 */

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FALHA"} ${label}\n      obtido   ${a}\n      esperado ${e}`);
}

function sum(targets: Record<string, number>): number {
  return Math.round(ALLOCATION_CATEGORIES.reduce((acc, c) => acc + targets[c], 0) * 1e6) / 1e6;
}

// --- Os alvos por perfil ---------------------------------------------------
// O número de destaque de cada coluna. É o único ponto da política com respaldo de
// praxe de mercado, e é o que muda de fato entre os três perfis.
check("renda fixa Conservador", defaultPolicyFor("Conservador").renda_fixa, 80);
check("renda fixa Moderado", defaultPolicyFor("Moderado").renda_fixa, 60);
check("renda fixa Arrojado", defaultPolicyFor("Arrojado").renda_fixa, 30);

for (const profile of ["Conservador", "Moderado", "Arrojado"] as const) {
  check(`alvos de ${profile} somam 100`, sum(defaultPolicyFor(profile)), 100);
}

// BDRs e fundos ficam em zero de propósito — a tela não pode listar classe que a
// política não pede, ou empurraria exposição cambial e taxa a quem não pediu.
check("Moderado não aloca BDR nem fundo", [defaultPolicyFor("Moderado").bdrs, defaultPolicyFor("Moderado").fundos], [0, 0]);

// --- Carteira vazia: a premissa central da tela ----------------------------
// Com nenhuma posição, o plano de aporte tem de distribuir EXATAMENTE pelos pesos do
// perfil. A tela apresenta esses valores como "a carteira-alvo em reais"; se o motor
// desviar disso, os R$ deixam de corresponder aos percentuais exibidos ao lado.
const moderado = defaultPolicyFor("Moderado");
check(
  "R$ 1.000 numa carteira vazia (Moderado)",
  planContribution(1000, new Map(), moderado).map((s) => [s.category, s.amount]),
  [["renda_fixa", 600], ["acoes", 200], ["fiis", 120], ["etfs", 80]],
);

const conservador = planContribution(10000, new Map(), defaultPolicyFor("Conservador"));
check("R$ 10.000 Conservador põe 8.000 em renda fixa", conservador.find((s) => s.category === "renda_fixa")?.amount, 8000);

// --- Valor pequeno: o piso por fatia protege a tela ------------------------
// Sem o piso, a tela de primeiro acesso mandaria comprar R$ 24 de ETF. Com ele, a
// classe some do plano e o valor vai para as outras — mas o total tem de continuar
// fechando no centavo, ou o usuário vê a soma não bater.
const pequeno = planContribution(300, new Map(), moderado);
check(
  "R$ 300 derruba a fatia de ETF",
  pequeno.map((s) => s.category).sort(),
  ["acoes", "fiis", "renda_fixa"],
);
check("R$ 300 continua somando 300", Math.round(pequeno.reduce((acc, s) => acc + s.amount, 0) * 100) / 100, 300);

// Sem valor de partida não há fatia nenhuma: a tela mostra só percentual.
check("sem valor não há plano", planContribution(0, new Map(), moderado), []);

// --- O título do Tesouro é o mesmo nas três colunas ------------------------
// A tela afirma isso ao usuário, e a afirmação depende INTEIRAMENTE deste retorno: sem
// questionário respondido, o motor cai no Tesouro Selic porque é o único cujo resgate
// antecipado não sofre marcação a mercado. Se isto mudar, o texto da tela vira mentira.
check(
  "sem questionário respondido, o indexador é selic",
  indexerFor({ liquidityNeed: null, emergencyFund: null, horizonYears: null, objective: null }),
  "selic",
);

// --- Ordenação por perfil de risco -----------------------------------------
function opp(ticker: string, riskLevel: string, score: number): RankedOpportunity {
  return {
    id: 0, sector: null, dividendSustainability: null, persistedFrequency: null,
    ticker, name: ticker, category: "acoes", score, potentialReturn: 0, dividendYield: 0,
    riskLevel, reason: "", positives: [], risks: [], horizon: "",
  };
}
const pool = () => [opp("MED", "Medio", 70), opp("ALT", "Alto", 60), opp("BAI", "Baixo", 50)];

check("Conservador põe risco Baixo na frente", orderByRiskProfile(pool(), "Conservador").map((i) => i.ticker), ["BAI", "MED", "ALT"]);
check("Moderado põe risco Médio na frente", orderByRiskProfile(pool(), "Moderado").map((i) => i.ticker), ["MED", "BAI", "ALT"]);
check("Arrojado põe risco Alto na frente", orderByRiskProfile(pool(), "Arrojado").map((i) => i.ticker), ["ALT", "MED", "BAI"]);

// Empate de risco cai no score, que é a regra que a tela de Oportunidades já aplicava
// antes desta função existir — o refactor não pode ter mudado isso.
check(
  "empate de risco desempata por score",
  orderByRiskProfile([opp("BAIXO", "Baixo", 40), opp("ALTO", "Baixo", 90)], "Conservador").map((i) => i.ticker),
  ["ALTO", "BAIXO"],
);

// Nível de risco desconhecido cai no meio em vez de sumir da lista.
check(
  "risco desconhecido fica entre os conhecidos",
  orderByRiskProfile([opp("ALT", "Alto", 90), opp("SEI", "Sei la", 80), opp("BAI", "Baixo", 70)], "Arrojado").map((i) => i.ticker),
  ["ALT", "SEI", "BAI"],
);

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
