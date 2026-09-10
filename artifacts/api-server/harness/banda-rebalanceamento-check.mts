import {
  computeAllocation,
  evaluateBand,
  contributionToReachTarget,
  defaultPolicyFor,
  DEFAULT_BAND_PP,
} from "../src/lib/allocation-engine";
import {
  computeContributionPace,
  contributionsUntil,
  type LedgerEntry,
} from "../src/lib/contribution-pace";

/**
 * Banda de tolerância e ritmo de aporte.
 *
 * A carteira de referência é a do vídeo que originou a funcionalidade, e ela serve como
 * âncora externa: 60 mil divididos em 50/30/20, um ano depois com ações +40%, FIIs +5% e
 * caixa +12%. Os percentuais resultantes (44,9 / 35,9 / 19,2) e o aporte de R$ 7.140
 * foram conferidos contra a fonte antes de virarem caso — se a nossa conta divergir
 * deles, é a nossa que está errada.
 *
 *   node harness/banda-rebalanceamento-check.mts
 */

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FALHA"} ${label}\n      obtido   ${a}\n      esperado ${e}`);
}

const arred1 = (v: number) => Math.round(v * 10) / 10;

// ── A carteira do vídeo, um ano depois ──────────────────────────────────────

const alvo = { renda_fixa: 20, acoes: 30, fiis: 50, etfs: 0, bdrs: 0, fundos: 0 };
const carteira = new Map([
  ["fiis", 30_000 * 1.05],   // 31.500
  ["acoes", 18_000 * 1.40],  // 25.200
  ["renda_fixa", 12_000 * 1.12], // 13.440
]);

const aloc = computeAllocation(carteira, alvo);
check("o total bate", aloc.total, 70_140);

const pct = (c: string) => arred1(aloc.items.find((i) => i.category === c)!.currentPercent);
check("FIIs em 44,9%", pct("fiis"), 44.9);
check("ações em 35,9%", pct("acoes"), 35.9);
check("renda fixa em 19,2%", pct("renda_fixa"), 19.2);

// ── A banda transforma desvio em decisão ────────────────────────────────────
//
// Ações estão 5,9 p.p. acima do alvo e FIIs 5,1 abaixo. Com banda de 5, as duas saem;
// com banda de 6, nenhuma. É exatamente o corte que faltava: sem ele, o app tratava
// 0,06 p.p. e 5,9 p.p. como a mesma situação.

check("com banda de 5 p.p., duas classes ficam fora",
  evaluateBand(aloc, 5).outOfBand.map((i) => i.category), ["acoes", "fiis"]);
check("e a carteira não está equilibrada", evaluateBand(aloc, 5).balanced, false);

check("com banda de 6 p.p., nada a fazer",
  [evaluateBand(aloc, 6).balanced, evaluateBand(aloc, 6).outOfBand.length], [true, 0]);

// A ordem é pela distância, não pela ordem das classes — a tela mostra a pior primeiro.
check("a maior distância vem primeiro",
  evaluateBand(aloc, 5).outOfBand[0]?.category, "acoes");

// O padrão existe e é o declarado.
check("a banda padrão é a declarada no motor", evaluateBand(aloc).bandPp, DEFAULT_BAND_PP);

// ── Carteira vazia não tem desvio ───────────────────────────────────────────
//
// Sem isto, quem acaba de se cadastrar veria "renda fixa 60 p.p. abaixo do alvo" antes
// de ter um centavo — `computeAllocation` devolve 0% para tudo numa base zero.

const vazia = evaluateBand(computeAllocation(new Map(), defaultPolicyFor("Moderado")));
check("carteira vazia: equilibrada, sem total",
  [vazia.balanced, vazia.outOfBand.length, vazia.total], [true, 0, null]);

// ── O aporte que devolve UMA classe ao alvo ─────────────────────────────────
//
// A armadilha é responder com o déficit contra o total de hoje (R$ 3.570). O aporte
// aumenta o total, e o alvo é uma fração dele — o número certo é o dobro.

const fiis = aloc.items.find((i) => i.category === "fiis")!;
check("aporte para os FIIs voltarem a 50%", contributionToReachTarget(fiis, aloc.total), 7140);
check("e não é o déficit ingênuo contra o total de hoje",
  contributionToReachTarget(fiis, aloc.total) !== Math.round(fiis.deviationValue), true);

// Classe acima do alvo não recebe aporte — aportar nela afastaria do alvo.
const acoes = aloc.items.find((i) => i.category === "acoes")!;
check("classe acima do alvo não tem aporte que a devolva", contributionToReachTarget(acoes, aloc.total), null);

// Alvo de 100% não tem solução finita.
const tudoEmUma = computeAllocation(new Map([["acoes", 100]]), { ...alvo, fiis: 0, acoes: 100, renda_fixa: 0 });
check("alvo de 100% não produz número",
  contributionToReachTarget(tudoEmUma.items.find((i) => i.category === "acoes")!, tudoEmUma.total), null);

// ── O ritmo, medido do registro ─────────────────────────────────────────────

const HOJE = new Date("2026-09-07T12:00:00Z");
function lanc(data: string, valor: number, inicial = false): LedgerEntry {
  return { tradeDate: data, quantity: 1, unitPrice: valor, isInitialBalance: inicial };
}

const seisMeses = [
  lanc("2026-04-10", 1000), lanc("2026-05-12", 1000), lanc("2026-06-09", 1000),
  lanc("2026-07-14", 1000), lanc("2026-08-11", 1000), lanc("2026-09-03", 1000),
];
check("seis aportes de mil dão ritmo de mil por mês",
  computeContributionPace(seisMeses, HOJE)?.monthlyAverage, 1000);

// O denominador é a janela inteira, não os meses com aporte: quem aportou duas vezes em
// seis meses não tem o ritmo de quem aporta todo mês.
check("mês sem aporte entra no denominador",
  computeContributionPace([lanc("2026-08-11", 3000), lanc("2026-09-03", 3000)], HOJE)?.monthlyAverage, 1000);

// O saldo inicial do backfill representa a carteira inteira num dia só. Somá-lo faria o
// app concluir que qualquer desvio se corrige no mês seguinte.
check("saldo inicial não conta como aporte",
  computeContributionPace([...seisMeses, lanc("2026-04-01", 500_000, true)], HOJE)?.monthlyAverage, 1000);

check("um lançamento só não vira ritmo",
  computeContributionPace([lanc("2026-09-03", 1000)], HOJE), null);
check("sem lançamento nenhum, também não",
  computeContributionPace([], HOJE), null);

// Fora da janela não conta.
check("lançamento antigo fica fora da janela",
  computeContributionPace([lanc("2025-01-10", 5000), lanc("2025-02-10", 5000)], HOJE), null);

// ── Quantos aportes até fechar ──────────────────────────────────────────────

const ritmo = computeContributionPace(seisMeses, HOJE);
check("R$ 7.140 no ritmo de R$ 1.000/mês são 8 aportes", contributionsUntil(7140, ritmo), 8);
check("arredonda para cima — meio aporte não fecha nada", contributionsUntil(1001, ritmo), 2);
check("sem ritmo, não fala em prazo", contributionsUntil(7140, null), null);

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
