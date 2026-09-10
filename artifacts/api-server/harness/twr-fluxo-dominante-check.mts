import { computeDailyTwr, type TwrPeriod } from "../src/lib/time-weighted-return";
import type { PortfolioSnapshot, Sale } from "@workspace/db";

/**
 * Elos da cadeia do TWR e o diagnóstico de fluxo dominante.
 *
 * A âncora é uma carteira real em acumulação: R$ 100,83 no fim de julho, um aporte de
 * R$ 686,54 em agosto e outros dois pequenos depois. Nela o primeiro aporte responde por
 * 87% do denominador do próprio subperíodo — o número que a ressalva da tela mostra.
 *
 * O que estes casos travam é a AFIRMAÇÃO da tela, não a aritmética: "um desvio de 1% neste
 * lançamento move o resultado em X p.p." só pode ser dito se `share` for de fato a
 * derivada. O último bloco confere isso perturbando o fluxo e medindo o deslocamento.
 *
 *   node harness/twr-fluxo-dominante-check.mts
 */

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FALHA"} ${label}\n      obtido   ${a}\n      esperado ${e}`);
}

const arred = (v: number, casas = 4) => Math.round(v * 10 ** casas) / 10 ** casas;

function snap(date: string, value: number, cost: number): PortfolioSnapshot {
  return { date, totalValue: String(value), totalCost: String(cost) } as PortfolioSnapshot;
}

const SEM_VENDA: Sale[] = [];

// ── A carteira em acumulação ────────────────────────────────────────────────
//
// Custo e valor andam juntos nos dias de aporte porque a compra entra a preço de mercado;
// o que separa os dois é a oscilação entre as medições.

const carteira = [
  snap("2026-07-27", 100.83, 100.0),
  snap("2026-08-17", 101.5, 100.0),   // só mercado, sem aporte
  snap("2026-08-18", 788.04, 786.54), // + R$ 686,54
  snap("2026-08-24", 826.0, 823.2),   // + R$ 36,66
  snap("2026-08-26", 878.5, 874.66),  // + R$ 51,46
];

const elos: TwrPeriod[] = [];
computeDailyTwr(carteira, SEM_VENDA, null, elos);

check("um elo por medição encadeada, menos a primeira", elos.length, carteira.length - 1);
check("as datas dos elos são as das medições",
  elos.map((e) => e.date), ["2026-08-17", "2026-08-18", "2026-08-24", "2026-08-26"]);

// O elo do aporte grande: fluxo = Δcusto = 786,54 − 100 = 686,54.
const grande = elos.find((e) => e.date === "2026-08-18")!;
check("o fluxo do elo é o Δcusto", arred(grande.netFlow, 2), 686.54);
check("a abertura é o valor anterior mais o fluxo", arred(grande.opening, 2), arred(101.5 + 686.54, 2));
check("o saldo anterior é o do dia anterior", arred(grande.priorValue, 2), 101.5);

check("o aporte responde por 87% da base", arred(grande.netFlow / grande.opening, 3), 0.871);
check("e foi 6,8x o saldo daquele dia", arred(grande.netFlow / grande.priorValue, 1), 6.8);

// Os aportes seguintes são pequenos diante da carteira — é o estado normal, e a ressalva
// não deve aparecer neles.
const pequeno = elos.find((e) => e.date === "2026-08-24")!;
check("aporte pequeno não domina", arred(pequeno.netFlow / pequeno.opening, 3) < 0.5, true);

// ── A afirmação da tela, verificada ─────────────────────────────────────────
//
// "Um desvio de 1% no valor ou no dia dele desloca o resultado em cerca de `share` p.p."
// Isso só vale se `share` for a derivada do log do fator em relação ao fluxo. Confere-se
// perturbando o lançamento e medindo o TWR inteiro, sem usar a fórmula.

function twrFinal(snapshots: PortfolioSnapshot[]): number {
  const mapa = computeDailyTwr(snapshots, SEM_VENDA, null);
  const ultimo = [...mapa.keys()].sort().at(-1)!;
  return mapa.get(ultimo)!.factor;
}

const base = twrFinal(carteira);
// Mesma carteira com o aporte de 18/08 registrado 1% maior. O valor final NÃO muda: o
// erro é de registro do custo, não de mercado — é exatamente o caso que o limite do
// módulo descreve ("edição manual de preço médio vira aporte").
const perturbada = carteira.map((s) =>
  s.date >= "2026-08-18" ? snap(s.date, parseFloat(s.totalValue), parseFloat(s.totalCost) + 6.8654) : s,
);
const deslocamentoPp = (twrFinal(perturbada) / base - 1) * 100;

check("1% a mais no aporte desloca o TWR em ~share p.p.",
  arred(Math.abs(deslocamentoPp), 1), arred((grande.netFlow / grande.opening) * 1, 1));

// ── A cadeia rompida descarta os elos junto ─────────────────────────────────
//
// Sem isto, a tela citaria um aporte de uma carteira que foi zerada e recomeçada — um dia
// que não participa do número exibido.

const comZeragem = [
  snap("2026-07-27", 100.83, 100.0),
  snap("2026-08-10", 0, 0),          // carteira zerada: fronteira
  snap("2026-08-18", 700.0, 700.0),
  snap("2026-08-26", 710.0, 700.0),
];
const elosDepois: TwrPeriod[] = [];
computeDailyTwr(comZeragem, SEM_VENDA, null, elosDepois);
check("elos anteriores à zeragem são descartados",
  elosDepois.map((e) => e.date), ["2026-08-26"]);

// ── Carteira madura não produz aviso ────────────────────────────────────────

const madura = [
  snap("2026-07-27", 50_000, 48_000),
  snap("2026-08-18", 51_000, 49_000), // aporte de mil sobre cinquenta mil
];
const elosMadura: TwrPeriod[] = [];
computeDailyTwr(madura, SEM_VENDA, null, elosMadura);
check("aporte de 1k sobre 50k não chega perto do limiar",
  arred(elosMadura[0].netFlow / elosMadura[0].opening, 3) < 0.5, true);

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
