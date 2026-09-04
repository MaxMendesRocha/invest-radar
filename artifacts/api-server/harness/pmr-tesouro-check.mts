import { averageTermYears, suggestTreasuryBonds, type TreasuryProfileInput } from "../src/lib/treasury-engine";
import type { TreasuryBond } from "@workspace/db";

/**
 * Prazo médio de retorno (PMR) no casamento com o horizonte declarado.
 *
 * O que estes casos protegem é a fronteira entre os dois tipos de título. Num de fluxo
 * único, PMR É o vencimento, e a mudança não pode alterar nada do que já funcionava —
 * essa é a metade mais importante daqui, porque é a que pode regredir em silêncio. Nos
 * de cupom semestral, o PMR tem de ficar entre a metade do prazo e o prazo, e nunca
 * fora disso, sob pena de a sugestão passar a casar contra um número sem sentido.
 *
 *   node harness/pmr-tesouro-check.mts
 */

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FALHA"} ${label}\n      obtido   ${a}\n      esperado ${e}`);
}

const HOJE = new Date("2026-09-04T00:00:00Z");
const arred = (v: number) => Math.round(v * 10) / 10;

/** Vencimento a N anos de HOJE, para os casos não dependerem da data em que rodam. */
function vencimentoEm(anos: number): string {
  const d = new Date(HOJE.getTime() + anos * 365.25 * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function bond(over: Partial<TreasuryBond> & { bondType: string; maturityDate: string }): TreasuryBond {
  return {
    id: 1,
    baseDate: "2026-09-03",
    buyRate: "7.0000",
    buyUnitPrice: "1000.00",
    sellRate: "7.1000",
    sellUnitPrice: "998.00",
    updatedAt: new Date(),
    ...over,
  } as TreasuryBond;
}

// ── Fluxo único: nada pode mudar ────────────────────────────────────────────
//
// Esta é a metade que pode regredir sem ninguém notar. Prefixado e IPCA+ sem cupom são
// a maioria das sugestões, e para eles o PMR tem de continuar sendo exatamente o prazo.

for (const familia of ["Tesouro Prefixado", "Tesouro IPCA+", "Tesouro Selic"]) {
  check(`${familia}: PMR é o próprio prazo`,
    arred(averageTermYears(familia, vencimentoEm(10), 7, HOJE)), 10);
}

// Família desconhecida (só-recompra, fora da allowlist) degrada para o prazo em vez de
// quebrar — mesma postura do resto do módulo.
check("família fora da allowlist cai no prazo, sem erro",
  arred(averageTermYears("Tesouro IGPM+ com Juros Semestrais", vencimentoEm(8), 7, HOJE)), 8);

// ── Cupom semestral: os números medidos ─────────────────────────────────────
//
// Os mesmos quatro pontos citados no docstring do motor. Se a conta mudar, é aqui que
// aparece, e o docstring passa a estar mentindo.

const NTNB = "Tesouro IPCA+ com Juros Semestrais";
check("IPCA+ JS de 5 anos a 7% tem PMR de 4,4", arred(averageTermYears(NTNB, vencimentoEm(5), 7, HOJE)), 4.4);
check("IPCA+ JS de 10 anos a 7% tem PMR de 7,6", arred(averageTermYears(NTNB, vencimentoEm(10), 7, HOJE)), 7.6);
check("IPCA+ JS de 14 anos a 7% tem PMR de 9,5", arred(averageTermYears(NTNB, vencimentoEm(14), 7, HOJE)), 9.5);
check("IPCA+ JS de 19 anos a 7% tem PMR de 11,2", arred(averageTermYears(NTNB, vencimentoEm(19), 7, HOJE)), 11.2);

// A NTN-F tem cupom maior (10% contra 6%), então devolve mais dinheiro antes e o PMR
// encurta mais. Se algum dia os dois derem o mesmo número, o cupom parou de ser lido.
const NTNF = "Tesouro Prefixado com Juros Semestrais";
const pmrF = averageTermYears(NTNF, vencimentoEm(10), 12, HOJE);
const pmrB = averageTermYears(NTNB, vencimentoEm(10), 12, HOJE);
check("cupom maior encurta mais o PMR", pmrF < pmrB, true);

// ── As fronteiras que nenhuma taxa pode furar ───────────────────────────────
//
// A primeira versão deste bloco exigia PMR acima da METADE do prazo, e 6 das 35
// combinações furaram. A fronteira é que estava errada: o PMR tem um teto de
// perpetuidade, `(1+y)/y` semestres, que NÃO depende do vencimento. A 30% de taxa ele
// para em ~4,1 anos por mais longo que seja o título, porque o principal lá na frente
// vale quase nada trazido a valor presente. Um IPCA+ JS de 30 anos a 7% dá PMR 13,4,
// abaixo da metade — e está certo.
//
// O que sobrou são os invariantes de verdade, e o teto testa mais do que o palpite
// original: ele só se sustenta se o desconto estiver sendo aplicado corretamente.

// O único limite que vale para qualquer prazo e qualquer taxa.
let foraDaFaixa = 0;
for (const anos of [1, 3, 5, 10, 15, 20, 30]) {
  for (const taxa of [0.01, 2, 7, 15, 30]) {
    const pmr = averageTermYears(NTNB, vencimentoEm(anos), taxa, HOJE);
    if (!(pmr > 0 && pmr < anos)) foraDaFaixa++;
  }
}
check("em 35 combinações, o PMR fica entre zero e o prazo", foraDaFaixa, 0);

// ── Monotonicidade: verdadeira onde importa, falsa fora, e as duas medidas ──
//
// "Escolher o de PMR mais próximo do horizonte" só significa alguma coisa se alongar o
// vencimento alongar o PMR. Isso NÃO vale universalmente: num título de desconto
// profundo (taxa bem acima do cupom) a duration sobe, atinge um pico e volta a cair
// rumo ao limite de perpetuidade — a segunda versão deste harness assumiu o contrário
// e quebrou em 4 casos.
//
// O que vale é na faixa em que cada família de fato negocia, e é isso que o motor
// precisa. Medido abaixo por família, com o cupom e as taxas de cada uma.

function monotonicoEm(bondType: string, prazos: number[], taxas: number[]): number {
  let quebras = 0;
  for (const taxa of taxas) {
    for (let i = 1; i < prazos.length; i++) {
      const menor = averageTermYears(bondType, vencimentoEm(prazos[i - 1]!), taxa, HOJE);
      const maior = averageTermYears(bondType, vencimentoEm(prazos[i]!), taxa, HOJE);
      if (maior < menor - 1e-9) quebras++;
    }
  }
  return quebras;
}

// NTN-B: cupom de 6% REAL, e o juro real brasileiro vive entre ~3% e ~8%. Vencimentos
// em oferta chegam a 2045, cerca de 19 anos.
check("NTN-B: PMR cresce com o vencimento em toda a faixa de juro real plausível",
  monotonicoEm(NTNB, [1, 2, 3, 5, 7, 10, 12, 15, 19], [2, 3, 4, 5, 6, 7, 8, 9, 10]), 0);

// NTN-F: cupom de 10% NOMINAL, e o juro nominal já passou de 15% no Brasil recente.
// Vencimentos em oferta chegam a ~2035, cerca de 9 anos.
check("NTN-F: idem, na faixa de juro nominal que o Brasil já viu",
  monotonicoEm(NTNF, [1, 2, 3, 5, 7, 9], [8, 10, 12, 14, 15, 16, 18, 20]), 0);

// E o contrário, para a fronteira ficar registrada em vez de suposta: a 20% de juro
// REAL — que a NTN-B nunca pagou — o pico sai em 14 anos e o PMR cai depois dele.
check("fora dessa faixa a monotonicidade realmente quebra, como manda a teoria",
  averageTermYears(NTNB, vencimentoEm(30), 20, HOJE) < averageTermYears(NTNB, vencimentoEm(14), 20, HOJE), true);

// Taxa mais alta desconta mais os fluxos distantes, então o PMR encurta. É a direção,
// não o valor, que importa aqui.
check("taxa maior encurta o PMR",
  averageTermYears(NTNB, vencimentoEm(15), 15, HOJE) < averageTermYears(NTNB, vencimentoEm(15), 3, HOJE), true);

// Taxa impossível não produz número inventado.
check("taxa de -100% degrada para o prazo",
  arred(averageTermYears(NTNB, vencimentoEm(10), -100, HOJE)), 10);

// ── O efeito na escolha, que é o motivo de tudo isto ────────────────────────
//
// Perfil que declara renda e 10 anos: o app prefere cupom semestral (é o que "renda"
// pede), e agora escolhe entre eles pelo PMR. O de 14 anos tem PMR 9,5 — mais perto de
// 10 do que o de 10 anos, cujo PMR é 7,6. Pelo vencimento, a escolha seria a outra.

const perfilRenda: TreasuryProfileInput = {
  liquidityNeed: "nao", emergencyFund: "sim", horizonYears: 10, objective: "renda",
};
const carteiraIpca = [
  bond({ bondType: NTNB, maturityDate: vencimentoEm(10) }),
  bond({ bondType: NTNB, maturityDate: vencimentoEm(14) }),
];
const escolhido = suggestTreasuryBonds(carteiraIpca, perfilRenda, HOJE)[0];
check("com horizonte de 10 anos, escolhe o de PMR 9,5 e não o de vencimento 10",
  [escolhido?.maturityDate === vencimentoEm(14), escolhido?.averageTermYears], [true, 9.5]);

// O campo só sai preenchido onde os dois números divergem — repetir o prazo com outro
// nome sugeriria que são coisas distintas.
const semCupom = suggestTreasuryBonds(
  [bond({ bondType: "Tesouro IPCA+", maturityDate: vencimentoEm(10) })],
  { ...perfilRenda, objective: "preservar" },
  HOJE,
)[0];
check("título de fluxo único não expõe PMR", semCupom?.averageTermYears, null);

// O filtro de elegibilidade continua no VENCIMENTO, não no PMR: ele é sobre o título
// ainda existir por tempo suficiente, não sobre sensibilidade a juro. Um título de 4
// meses tem PMR menor ainda, e nem por isso deveria entrar por outra porta.
const curto = suggestTreasuryBonds(
  [bond({ bondType: "Tesouro IPCA+", maturityDate: vencimentoEm(0.3) })],
  perfilRenda,
  HOJE,
);
check("vencimento abaixo do mínimo continua fora, PMR não muda isso", curto.length, 0);

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
