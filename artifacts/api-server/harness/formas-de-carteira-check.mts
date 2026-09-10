import {
  ALLOCATION_CATEGORIES,
  computeAllocation,
  planContribution,
  evaluateBand,
  contributionToReachTarget,
  defaultPolicyFor,
  DEFAULT_BAND_PP,
  type AllocationCategory,
  type PolicyTargets,
} from "../src/lib/allocation-engine";
import { computeContributionPace, contributionsUntil, type LedgerEntry } from "../src/lib/contribution-pace";
import { computeDailyTwr, type TwrPeriod } from "../src/lib/time-weighted-return";
import type { PortfolioSnapshot, Sale } from "@workspace/db";

/**
 * As telas funcionam para uma carteira que NÃO é a de quem desenvolveu?
 *
 * Todo o resto do harness ancora em números escolhidos — a carteira do vídeo, um caso do
 * Tesouro, uma carteira real medida. Isso trava o cálculo, mas não responde a pergunta de
 * quem vai abrir o portal hoje: a minha carteira tem seis ativos, FIIs e Tesouro, um
 * histórico curto e um perfil preenchido. Um cadastro novo tem zero de tudo isso.
 *
 * Aqui a unidade de teste é a FORMA da carteira, não o valor. Cada forma atravessa os
 * motores que alimentam Visão Geral e Saúde do Portfólio, e o que se afirma são
 * propriedades que precisam valer em TODAS elas — nunca um número específico, que
 * dependeria da forma e viraria um caso escolhido a dedo outra vez.
 *
 * A propriedade mais valiosa é a mais boba: nenhum campo numérico pode sair NaN ou
 * Infinity. É exatamente o que muda entre carteiras — divisão por patrimônio zero, por
 * alvo 100%, por saldo anterior nulo — e é o que a tela exibiria como "R$ NaN" sem que
 * nada tivesse lançado exceção.
 *
 *   node harness/formas-de-carteira-check.mts
 */

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FALHA"} ${label}\n      obtido   ${a}\n      esperado ${e}`);
}

/** Falha nomeando o caminho até o campo — "NaN em algum lugar" não diz onde consertar. */
function finitosEm(valor: unknown, caminho = "raiz", achados: string[] = []): string[] {
  if (typeof valor === "number") {
    if (!Number.isFinite(valor)) achados.push(`${caminho} = ${valor}`);
  } else if (Array.isArray(valor)) {
    valor.forEach((v, i) => finitosEm(v, `${caminho}[${i}]`, achados));
  } else if (valor && typeof valor === "object") {
    for (const [k, v] of Object.entries(valor)) finitosEm(v, `${caminho}.${k}`, achados);
  }
  return achados;
}

const alvos = (parcial: Partial<Record<AllocationCategory, number>>): PolicyTargets =>
  Object.fromEntries(ALLOCATION_CATEGORIES.map((c) => [c, parcial[c] ?? 0])) as PolicyTargets;

const carteira = (parcial: Partial<Record<AllocationCategory, number>>) =>
  new Map<string, number>(Object.entries(parcial) as [string, number][]);

// ── As formas ───────────────────────────────────────────────────────────────
//
// Cada uma existe por um usuário plausível, não por curiosidade combinatória.

interface Forma {
  nome: string;
  valores: Map<string, number>;
  alvos: PolicyTargets;
  lancamentos: LedgerEntry[];
}

const HOJE = new Date("2026-09-10T12:00:00Z");
const lanc = (data: string, valor: number, inicial = false): LedgerEntry =>
  ({ tradeDate: data, quantity: 1, unitPrice: valor, isInitialBalance: inicial });

const SEIS_APORTES = [
  lanc("2026-04-10", 1000), lanc("2026-05-12", 1000), lanc("2026-06-09", 1000),
  lanc("2026-07-14", 1000), lanc("2026-08-11", 1000), lanc("2026-09-03", 1000),
];

const formas: Forma[] = [
  // Quem se cadastrou agora e ainda não lançou nada. É a primeira tela que ele vê.
  { nome: "carteira vazia, perfil em branco", valores: carteira({}), alvos: defaultPolicyFor(null), lancamentos: [] },

  // Quem comprou um ativo só. Sem segundo ativo não há distribuição a comparar.
  { nome: "um ativo só", valores: carteira({ acoes: 500 }), alvos: defaultPolicyFor("Moderado"), lancamentos: [lanc("2026-09-03", 500)] },

  // Conservador de verdade: Tesouro e CDB, nada em bolsa. Nenhum ticker para cotar,
  // nenhum número mágico, nenhuma triagem — muita coisa do app não se aplica.
  { nome: "só renda fixa", valores: carteira({ renda_fixa: 50_000 }), alvos: defaultPolicyFor("Conservador"), lancamentos: SEIS_APORTES },

  // O oposto: tudo em bolsa, nada em renda fixa. A classe do alvo fica vazia.
  { nome: "só ações, alvo pede renda fixa", valores: carteira({ acoes: 30_000 }), alvos: defaultPolicyFor("Conservador"), lancamentos: SEIS_APORTES },

  // Classes que existem no alvo e que eu nunca testei com posição de verdade.
  { nome: "ETFs, BDRs e fundos", valores: carteira({ etfs: 4000, bdrs: 3000, fundos: 2000 }), alvos: defaultPolicyFor("Arrojado"), lancamentos: SEIS_APORTES },

  // Alvo de 100% numa classe: legítimo, e é onde `contributionToReachTarget` não tem
  // solução finita.
  { nome: "alvo de 100% em uma classe", valores: carteira({ acoes: 900, fiis: 100 }), alvos: alvos({ acoes: 100 }), lancamentos: SEIS_APORTES },

  // Política antiga somando menos de 100 — dado que pode existir de versões anteriores.
  { nome: "alvos somando 60%", valores: carteira({ acoes: 1000, fiis: 1000 }), alvos: alvos({ acoes: 30, fiis: 30 }), lancamentos: SEIS_APORTES },

  // Todos os alvos zerados. Nada é "abaixo do alvo", então não há para onde aportar.
  { nome: "todos os alvos zerados", valores: carteira({ acoes: 1000 }), alvos: alvos({}), lancamentos: SEIS_APORTES },

  // Centavos: a carteira de quem está testando o app.
  { nome: "patrimônio de centavos", valores: carteira({ fiis: 0.03 }), alvos: defaultPolicyFor("Moderado"), lancamentos: [lanc("2026-09-01", 0.01), lanc("2026-09-02", 0.02)] },

  // Patrimônio grande: onde erro de ponto flutuante e estouro de coluna apareceriam.
  { nome: "patrimônio de oito dígitos", valores: carteira({ acoes: 12_000_000, renda_fixa: 30_000_000 }), alvos: defaultPolicyFor("Moderado"), lancamentos: SEIS_APORTES },

  // Exatamente no alvo. O caso em que a banda precisa dizer "não faça nada".
  { nome: "exatamente no alvo", valores: carteira({ renda_fixa: 6000, acoes: 2000, fiis: 1200, etfs: 800 }), alvos: defaultPolicyFor("Moderado"), lancamentos: SEIS_APORTES },

  // Só o backfill lançou: o saldo inicial não pode virar ritmo de aporte.
  { nome: "só saldo inicial no registro", valores: carteira({ acoes: 20_000 }), alvos: defaultPolicyFor("Moderado"), lancamentos: [lanc("2026-05-01", 20_000, true)] },

  // A minha, para ela não deixar de ser coberta ao deixar de ser a referência.
  { nome: "a carteira do desenvolvedor", valores: carteira({ renda_fixa: 780, fiis: 400, acoes: 145.81 }), alvos: defaultPolicyFor("Moderado"), lancamentos: [lanc("2026-08-18", 686.54), lanc("2026-08-24", 36.66), lanc("2026-08-26", 51.46)] },
];

// ── As propriedades, aplicadas a todas as formas ────────────────────────────

const APORTES = [0, 0.01, 30, 100, 1000, 250_000];

for (const forma of formas) {
  const aloc = computeAllocation(forma.valores, forma.alvos);
  const banda = evaluateBand(aloc, DEFAULT_BAND_PP);
  const ritmo = computeContributionPace(forma.lancamentos, HOJE);
  const pior = banda.outOfBand.find((i) => i.deviationPp > 0) ?? null;
  const aFechar = pior && banda.total != null ? contributionToReachTarget(pior, banda.total) : null;

  const planos = APORTES.map((v) => planContribution(v, forma.valores, forma.alvos));

  const pacote = { aloc, banda, ritmo, aFechar, planos, aportes: contributionsUntil(aFechar ?? 0, ritmo) };
  check(`[${forma.nome}] nenhum número infinito ou NaN`, finitosEm(pacote), []);

  // O total é a soma das posições, sempre — é o denominador de tudo o mais.
  const somaPosicoes = Math.round([...forma.valores.values()].reduce((s, v) => s + v, 0) * 100) / 100;
  check(`[${forma.nome}] o total é a soma das posições`, Math.round(aloc.total * 100) / 100, somaPosicoes);

  // Com patrimônio, os percentuais fecham em 100. Sem patrimônio, ninguém tem percentual.
  const somaPct = aloc.items.reduce((s, i) => s + i.currentPercent, 0);
  check(`[${forma.nome}] percentuais fecham 100 (ou 0 sem patrimônio)`,
    Math.round(somaPct * 100) / 100, aloc.total > 0 ? 100 : 0);

  // "Equilibrada" e "lista vazia" são a mesma afirmação. Se divergirem, a Visão Geral
  // diz "nada a fazer" listando classes fora, ou o contrário.
  check(`[${forma.nome}] balanced concorda com outOfBand`, banda.balanced, banda.outOfBand.length === 0);

  // Carteira sem patrimônio não tem desvio: 0/0 não é zero por cento.
  check(`[${forma.nome}] sem patrimônio não há desvio`,
    aloc.total > 0 ? "n/a" : [banda.balanced, banda.total],
    aloc.total > 0 ? "n/a" : [true, null]);

  // O valor a aportar só existe quando há classe abaixo do alvo para receber.
  check(`[${forma.nome}] aFechar exige classe abaixo do alvo`, aFechar != null && pior == null, false);

  // E o prazo só existe quando há valor e ritmo. Sem um dos dois, a tela não fala em prazo.
  check(`[${forma.nome}] prazo exige valor e ritmo`,
    pacote.aportes != null, aFechar != null && aFechar > 0 && ritmo != null);

  // Saldo inicial nunca vira ritmo — senão qualquer desvio "se corrige mês que vem".
  if (forma.lancamentos.every((l) => l.isInitialBalance)) {
    check(`[${forma.nome}] saldo inicial não produz ritmo`, ritmo, null);
  }

  for (let i = 0; i < APORTES.length; i++) {
    const plano = planos[i];
    const aporte = APORTES[i];
    const gasto = plano.reduce((s, p) => s + p.amount, 0);
    // Gastar mais do que a pessoa disse ter é o pior erro possível desta tela.
    check(`[${forma.nome}] plano de ${aporte} não gasta mais que o aporte`, gasto <= aporte + 0.01, true);
    check(`[${forma.nome}] plano de ${aporte} não tem fatia negativa`, plano.every((p) => p.amount >= 0), true);
    // A régua é o total PROJETADO, não o de hoje — e isto já derrubou uma invariante
    // minha. Uma classe acima do alvo hoje pode ficar muito abaixo depois que o aporte
    // aumenta o total: ações sozinhas em R$ 500 estão a 100% da carteira, mas com um
    // aporte de R$ 250 mil o alvo delas passa a valer R$ 50.100. Não aportar nelas
    // afastaria a carteira do alvo em vez de aproximar.
    const projetado = aloc.total + aporte;
    check(`[${forma.nome}] plano de ${aporte} só aporta em quem falta contra o total projetado`,
      plano.every((p) => {
        if (p.amount === 0) return true;
        const item = aloc.items.find((it) => it.category === p.category)!;
        return (item.targetPercent / 100) * projetado - item.currentValue > -0.01;
      }), true);

    // "O aporte sempre aproxima do alvo" é falso, e medi por quê: o piso de fatia
    // descarta a classe cujo pedaço não alcança o mínimo e redistribui o valor entre as
    // outras. Numa carteira exatamente no alvo (60/20/12/8) com aporte de R$ 500, a
    // fatia de ETFs seria R$ 40 contra piso de R$ 50 — ela cai fora, e o desvio total
    // sai de 0 para 0,76 p.p. Com R$ 1.000 a fatia passa do piso e o desvio volta a zero.
    //
    // Isso é o piso funcionando: sugerir R$ 40 numa classe cujo mínimo é R$ 50 seria
    // contradizer a própria regra. O que precisa ser verdade é o LIMITE do estrago —
    // pequeno o bastante para nunca virar chamado de rebalanceamento.
    if (aloc.total > 0 && aporte > 0) {
      const depois = new Map(forma.valores);
      for (const p of plano) depois.set(p.category, (depois.get(p.category) ?? 0) + p.amount);
      const posterior = computeAllocation(depois, forma.alvos);
      const desvioDe = (a: { items: { deviationPp: number }[] }) =>
        a.items.reduce((s, i) => s + Math.abs(i.deviationPp), 0);
      const piora = desvioDe(posterior) - desvioDe(aloc);
      check(`[${forma.nome}] aporte de ${aporte}: piora do desvio fica abaixo de 1 p.p.`, piora < 1, true);

      // A que mais importa depois da banda: um aporte não pode transformar uma carteira
      // equilibrada numa que pede ação. Se pudesse, a Visão Geral mandaria rebalancear
      // por causa do próprio aporte que ela sugeriu.
      if (banda.balanced) {
        check(`[${forma.nome}] aporte de ${aporte} não tira a carteira da banda`,
          evaluateBand(posterior, DEFAULT_BAND_PP).balanced, true);
      }
    }
  }
}

// ── O comparativo, para quem não tem histórico ──────────────────────────────
//
// `benchmarks` depende de snapshots, que só existem depois de dias de uso. Um cadastro
// de hoje tem zero, um, ou dois — e é aí que a cadeia do TWR não tem o que encadear.

function snap(date: string, value: number, cost: number): PortfolioSnapshot {
  return { date, totalValue: String(value), totalCost: String(cost) } as PortfolioSnapshot;
}
const SEM_VENDA: Sale[] = [];

const historicos: [string, PortfolioSnapshot[]][] = [
  ["sem nenhum snapshot", []],
  ["um snapshot só", [snap("2026-09-10", 1000, 1000)]],
  ["dois snapshots", [snap("2026-09-09", 1000, 1000), snap("2026-09-10", 1010, 1000)]],
  ["carteira zerada no meio", [snap("2026-09-01", 500, 500), snap("2026-09-05", 0, 0), snap("2026-09-10", 800, 800)]],
  ["custo zero desde o início", [snap("2026-09-09", 0, 0), snap("2026-09-10", 0, 0)]],
];

for (const [nome, snaps] of historicos) {
  const elos: TwrPeriod[] = [];
  const mapa = computeDailyTwr(snaps, SEM_VENDA, null, elos);
  const valores = [...mapa.values()];
  check(`[TWR: ${nome}] nenhum fator infinito ou NaN`, finitosEm(valores), []);
  check(`[TWR: ${nome}] nenhum elo infinito ou NaN`, finitosEm(elos), []);
  // Fator não-positivo não é retorno, é cadeia rompida mal tratada.
  check(`[TWR: ${nome}] todo fator é positivo`, valores.every((v) => v.factor > 0), true);
  // Nunca mais elos que medições — cada elo liga duas.
  check(`[TWR: ${nome}] elos não excedem as medições`, elos.length <= Math.max(0, snaps.length - 1), true);
}

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
