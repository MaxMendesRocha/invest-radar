import {
  fillSliceWithHoldings,
  planContribution,
  defaultPolicyFor,
  type HoldingForFill,
} from "../src/lib/allocation-engine";

/**
 * Preenchimento da fatia do aporte reforçando o que já se tem.
 *
 * O que estes casos protegem é a fronteira entre o que é MEDIDO e o que seria
 * arbitrado. A fila de reforço só existe porque cada quantidade sai de três limites
 * reais — o que falta para o número mágico, o que cabe sob o teto de concentração, e o
 * que o dinheiro compra. No dia em que algum deles virar um número escolhido, é aqui que
 * tem de quebrar.
 *
 *   node harness/aporte-reforco-check.mts
 */

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FALHA"} ${label}\n      obtido   ${a}\n      esperado ${e}`);
}

const TETO = 20; // teto "Atenção" de concentração, em %

function holding(over: Partial<HoldingForFill> & { ticker: string }): HoldingForFill {
  return {
    price: 10,
    currentUnits: 0,
    avgMonthlyDividendPerUnit: 0.1, // número mágico = ceil(10 / 0,1) = 100 cotas
    screening: "atende",
    ...over,
  };
}

// ── A soma fecha ────────────────────────────────────────────────────────────
//
// Mesma exigência que planContribution já cumpre: o total distribuído é exatamente o que
// entrou. Aqui vale para reforços + sobra, porque a tela vai somar os dois na frente do
// usuário.

const patrimonio = 10_000;
const umaPosicao = [holding({ ticker: "AAAA11", currentUnits: 90 })]; // faltam 10 cotas = R$ 100

const r1 = fillSliceWithHoldings(600, umaPosicao, patrimonio, TETO);
check("reforça só o que falta para o número mágico, não a fatia inteira",
  [r1.reinforcements[0]?.units, r1.reinforcements[0]?.amount], [10, 100]);
check("e marca que essa compra fecha", r1.reinforcements[0]?.closesMagicNumber, true);
check("a soma dos reforços mais a sobra é a fatia, ao centavo",
  r1.reinforcements.reduce((s, l) => s + l.amount, 0) + r1.leftover, 600);

// Preço quebrado, para o arredondamento a centavos ter chance de escapar.
const r2 = fillSliceWithHoldings(
  500,
  [holding({ ticker: "BBBB11", price: 9.37, currentUnits: 80, avgMonthlyDividendPerUnit: 0.0937 })],
  patrimonio,
  TETO,
);
check("com preço quebrado a soma continua fechando",
  Math.round((r2.reinforcements.reduce((s, l) => s + l.amount, 0) + r2.leftover) * 100) / 100, 500);

// ── A ordem é distância da meta ─────────────────────────────────────────────

const duas = [
  holding({ ticker: "LONGE11", currentUnits: 20 }), // faltam 80
  holding({ ticker: "PERTO11", currentUnits: 95 }), // faltam 5
];
check("a fila começa por quem está mais perto de fechar",
  fillSliceWithHoldings(300, duas, patrimonio, TETO).reinforcements.map((l) => l.ticker),
  ["PERTO11", "LONGE11"]);

// Ordem estável entre chamadas idênticas — plano que muda de ordem sozinho parece plano
// que mudou de ideia.
const empatadas = [holding({ ticker: "ZZZZ11", currentUnits: 90 }), holding({ ticker: "AAAA11", currentUnits: 90 })];
check("empate na distância desempata pelo ticker, de forma estável",
  fillSliceWithHoldings(1000, empatadas, patrimonio, TETO).reinforcements.map((l) => l.ticker),
  ["AAAA11", "ZZZZ11"]);

// ── O teto de concentração é o que interrompe o reforço ─────────────────────
//
// É ele que faz ticker novo entrar, e é por isso que não existe um "70% reforço, 30%
// novo" em lugar nenhum do código.

// Posição em 20% de um patrimônio de 10 mil (R$ 2.000, no teto exato) e AINDA longe do
// número mágico: com provento de R$ 0,04/cota a meta é 250 cotas, e ela tem 200.
const noTeto = [holding({ ticker: "CHEIO11", currentUnits: 200, avgMonthlyDividendPerUnit: 0.04 })];
const r3 = fillSliceWithHoldings(600, noTeto, patrimonio, TETO);
check("posição no teto recebe zero, mesmo faltando cotas para o número mágico",
  [r3.reinforcements.length, r3.skipped[0]?.reason], [0, "no_teto"]);
check("e a fatia inteira sobra para ticker novo", r3.leftover, 600);

// Metade do teto: faltam 150 cotas para a meta, mas só 100 cabem sob o teto. O corte é
// do teto, não do dinheiro — a fatia de R$ 5.000 compraria 500.
//
// São 100 e não 125, e a diferença é deliberada. Contando a própria compra no
// denominador, 125 cotas parariam exatamente nos 20%; `planSafePurchaseTowardMagicNumber`
// mede contra o patrimônio ANTES da compra, que é a mesma base do alerta de concentração
// em todo o resto do app. A posição termina em 18,2% em vez de 20%. Erra para menos, que
// é o lado certo de um teto — e mudar isso aqui faria esta tela discordar do alerta.
const parcial = [holding({ ticker: "MEIO11", currentUnits: 100, avgMonthlyDividendPerUnit: 0.04 })];
const r4 = fillSliceWithHoldings(5000, parcial, patrimonio, TETO);
check("o teto corta o reforço antes da meta, e a compra não fecha o número mágico",
  [r4.reinforcements[0]?.units, r4.reinforcements[0]?.closesMagicNumber], [100, false]);

// ── Quem não entra na fila, e por quê ───────────────────────────────────────
//
// Os motivos não são intercambiáveis: "não atende" é veredito sobre o ativo, "sem dados"
// é a régua que não pôde ser aplicada. Fundir os dois reprovaria o ativo por falha do
// provedor — o mesmo argumento que screenForPurchase já faz do outro lado.

const variadas = [
  holding({ ticker: "RUIM11", currentUnits: 50, screening: "nao_atende" }),
  holding({ ticker: "OPACO11", currentUnits: 50, screening: "sem_dados" }),
  holding({ ticker: "CRESC3", currentUnits: 50, avgMonthlyDividendPerUnit: null }),
  holding({ ticker: "PRONTO11", currentUnits: 100 }),
];
check("cada exclusão carrega o seu próprio motivo",
  fillSliceWithHoldings(600, variadas, patrimonio, TETO).skipped,
  [
    { ticker: "RUIM11", reason: "nao_atende" },
    { ticker: "OPACO11", reason: "sem_dados" },
    { ticker: "CRESC3", reason: "sem_numero_magico" },
    { ticker: "PRONTO11", reason: "ja_atingido" },
  ]);
check("e com todas fora, a fatia inteira vai para ticker novo",
  fillSliceWithHoldings(600, variadas, patrimonio, TETO).leftover, 600);

// Ação de crescimento nunca vira reforço com meta inventada — é a decisão de projeto que
// mais convidaria a fabricar um substituto para o número mágico.
check("ativo sem provento real não entra na fila",
  fillSliceWithHoldings(600, [holding({ ticker: "CRESC3", avgMonthlyDividendPerUnit: null })], patrimonio, TETO)
    .reinforcements.length, 0);

// ── Carteira vazia: o comportamento de hoje não pode regredir ───────────────

const vazia = fillSliceWithHoldings(600, [], 0, TETO);
check("sem posições, nada é reforçado e tudo sobra para o ranking",
  [vazia.reinforcements.length, vazia.leftover, vazia.skipped.length], [0, 600, 0]);

// ── O dinheiro é um limite como os outros ───────────────────────────────────

const r5 = fillSliceWithHoldings(50, umaPosicao, patrimonio, TETO); // faltam 10 cotas = R$ 100
check("fatia menor que o que falta compra o que cabe e não fecha",
  [r5.reinforcements[0]?.units, r5.reinforcements[0]?.closesMagicNumber, r5.leftover], [5, false, 0]);

// Dinheiro que acaba não é "no teto": são situações diferentes e a tela diz coisas
// diferentes sobre elas.
const r6 = fillSliceWithHoldings(100, duas, patrimonio, TETO);
check("dinheiro esgotado não vira motivo de exclusão",
  r6.skipped.filter((s) => s.reason === "no_teto").length, 0);

// ── A premissa que a fila inteira assume ────────────────────────────────────
//
// planContribution numa carteira vazia distribui exatamente pelos pesos do perfil. Se
// isso mudar, a fatia que chega aqui deixa de significar o que este motor supõe.

const alvo = defaultPolicyFor("Moderado");
const fatias = planContribution(1000, new Map(), alvo);
check("a fatia que chega aqui continua saindo dos pesos do perfil",
  fatias.map((s) => [s.category, s.amount]),
  [["renda_fixa", 600], ["acoes", 200], ["fiis", 120], ["etfs", 80]]);

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
