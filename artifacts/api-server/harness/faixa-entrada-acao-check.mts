import { db, financialFactsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  normalizeEarnings,
  normalizedEarningsFor,
  normalizationFactor,
  EXERCICIOS_MINIMOS,
  EXERCICIOS_NORMALIZACAO,
} from "../src/lib/normalized-earnings";
import {
  computeStockPriceZones,
  readPriceZone,
  summarizeStockPriceZones,
  type StockZonesInput,
} from "../src/lib/stock-price-zones";
import type { FinancialPeriod } from "../src/lib/financial-history";

/**
 * Faixa de entrada em reais para ação, por múltiplo normalizado contra o setor.
 *
 * O que estes casos protegem é a recusa de produzir um número quando a base não existe.
 * Uma faixa de preço é a saída mais categórica que o app produz — está em reais, com
 * centavos — e é justamente a que mais convida a ser lida como certeza. Os casos abaixo
 * fixam quando ela NÃO sai.
 *
 *   DATABASE_URL=... node harness/faixa-entrada-acao-check.mts
 */

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FALHA"} ${label}\n      obtido   ${a}\n      esperado ${e}`);
}

const periodo = (ano: number, value: number): FinancialPeriod => ({
  periodEnd: `${ano}-12-31`, value, firstPublishedAt: null, version: 1, restated: false, sourceUrl: null,
});

// --- Lucro normalizado ------------------------------------------------------

console.log("--- lucro normalizado ---");

const estavel = [100, 105, 95, 110, 100].map((v, i) => periodo(2021 + i, v * 1e6));
check("com lucro estável, o normalizado fica junto do último",
  normalizeEarnings(estavel)?.value, 100e6);

// O caso que justifica o módulo: um ano excepcional depois de quatro medianos. Avaliar
// pelo último exercício ancoraria a conta nos 400, que a empresa fez uma vez.
const anoExcepcional = [80, 90, 85, 95, 400].map((v, i) => periodo(2021 + i, v * 1e6));
const n1 = normalizeEarnings(anoExcepcional)!;
check("um ano excepcional não arrasta o normalizado", n1.value, 90e6);
check("e o fator de normalização reflete isso", Number(normalizationFactor(n1)!.toFixed(4)), 0.225);

// Medido: 53% das companhias têm ao menos um ano de prejuízo em cinco. A mediana
// atravessa; a média não — aqui ela daria 4 milhões contra os 60 da mediana.
const comPrejuizo = [60, 70, -200, 65, 75].map((v, i) => periodo(2021 + i, v * 1e6));
const n2 = normalizeEarnings(comPrejuizo)!;
check("um prejuízo grande não derruba a mediana", n2.value, 65e6);
check("e o ano de prejuízo é contado, não escondido", n2.lossYears, 1);

// Prejuízo persistente: não há lucro típico positivo, então não há avaliação por lucro.
// Devolver um preço justo aqui produziria número negativo com cara de faixa de compra.
const semLucro = [-10, -20, 5, -15, -8].map((v, i) => periodo(2021 + i, v * 1e6));
check("sem lucro típico positivo não há fator de normalização",
  normalizationFactor(normalizeEarnings(semLucro)!), null);

// O caso inverso, medido em 27 companhias: último exercício positivo, mediana não.
const umAnoBomDepoisDeQuatroRuins = [-30, -20, -25, -10, 50].map((v, i) => periodo(2021 + i, v * 1e6));
const n3 = normalizeEarnings(umAnoBomDepoisDeQuatroRuins)!;
check("um ano bom depois de quatro ruins não vira base de avaliação",
  [n3.latest > 0, normalizationFactor(n3)], [true, null]);

check(`menos de ${EXERCICIOS_MINIMOS} exercícios não normaliza`,
  normalizeEarnings(estavel.slice(0, EXERCICIOS_MINIMOS - 1)), null);
check(`exatamente ${EXERCICIOS_MINIMOS} normaliza`,
  normalizeEarnings(estavel.slice(0, EXERCICIOS_MINIMOS)) != null, true);

// A janela é dos exercícios MAIS RECENTES: a série chega do mais antigo para o mais novo.
const seisAnos = [10, 10, 10, 10, 10, 999].map((v, i) => periodo(2020 + i, v * 1e6));
const n4 = normalizeEarnings(seisAnos)!;
check(`a janela pega os ${EXERCICIOS_NORMALIZACAO} mais recentes`, [n4.years, n4.latest], [5, 999e6]);

// --- As faixas --------------------------------------------------------------

console.log("\n--- faixas de entrada ---");

const SETOR = {
  medianPriceEarnings: 10, p25PriceEarnings: 6,
  medianPriceToBook: 2, p25PriceToBook: 1.2,
};
const base: StockZonesInput = {
  price: 100, priceEarnings: 20, priceToBook: 4,
  normalized: normalizeEarnings(estavel), sector: SETOR,
};

// Lucro por ação do último exercício = 100/20 = 5. Normalizado ≈ igual (série estável).
// Faixa por lucro = 5 × [6, 10] = [30, 50]. Valor patrimonial por ação = 100/4 = 25.
// Faixa por patrimônio = 25 × [1,2, 2] = [30, 50].
const z = computeStockPriceZones(base)!;
check("faixa por lucro sai do múltiplo do setor sobre o lucro normalizado",
  [z.earnings?.low, z.earnings?.fair], [30, 50]);
check("faixa por patrimônio sai do P/VP do setor sobre o VP por ação",
  [z.book?.low, z.book?.fair], [30, 50]);

// As duas leituras são independentes: uma pode faltar sem derrubar a outra. É o mesmo
// comportamento da zona de yield do FII, que fica nula sem levar junto a de P/VP.
check("sem P/VP, a faixa por lucro sobrevive sozinha",
  (() => { const r = computeStockPriceZones({ ...base, priceToBook: null })!;
           return [r.earnings != null, r.book]; })(), [true, null]);
check("sem histórico, a faixa por patrimônio sobrevive sozinha",
  (() => { const r = computeStockPriceZones({ ...base, normalized: null })!;
           return [r.earnings, r.book != null]; })(), [null, true]);

// Prejuízo no último exercício: `preço ÷ P/L` daria lucro por ação negativo e a faixa
// inteira sairia com o sinal trocado.
check("P/L negativo não produz faixa por lucro",
  computeStockPriceZones({ ...base, priceEarnings: -8 })?.earnings, null);

// Sem referência do setor não há a que comparar. Não existe múltiplo "padrão" para cair.
check("sem quartil do setor não há faixa",
  computeStockPriceZones({ ...base, sector: { ...SETOR, p25PriceEarnings: null, p25PriceToBook: null } }),
  null);

check("sem preço não há nada", computeStockPriceZones({ ...base, price: 0 }), null);

// A base de normalização acompanha a faixa: três anos com dois de prejuízo não vale o
// mesmo que cinco lucrativos, e quem lê precisa ver a diferença.
check("a faixa carrega quantos exercícios a sustentam",
  computeStockPriceZones({ ...base, normalized: normalizeEarnings(comPrejuizo) })!.earningsBasis?.lossYears, 1);

// --- A redução que as duas telas leem ---------------------------------------
//
// A lista de Oportunidades mostra a conclusão e o Parecer mostra a conta; as duas leem
// este mesmo objeto. Os casos abaixo fixam as bordas, que é onde uma segunda
// implementação divergiria: preço exatamente na ponta da faixa, e qual leitura encabeça.

// Faixa dos dois lados = [30, 50], com as bordas incluídas — preço NA ponta está dentro.
check("preço abaixo do p25 é 'abaixo'", readPriceZone({ low: 30, fair: 50 }, 29.99), "abaixo");
check("preço exatamente no p25 já é 'dentro'", readPriceZone({ low: 30, fair: 50 }, 30), "dentro");
check("preço exatamente na mediana ainda é 'dentro'", readPriceZone({ low: 30, fair: 50 }, 50), "dentro");
check("preço acima da mediana é 'acima'", readPriceZone({ low: 30, fair: 50 }, 50.01), "acima");

// Sem faixa não há leitura. "Dentro" por ausência de referência seria afirmar que o preço
// está normal quando não se sabe qual é o normal.
check("sem faixa não há leitura", readPriceZone(null, 100), null);

// A de patrimônio encabeça porque é a mais firme das duas — 0,20 de volatilidade mediana
// contra 0,70 do lucro, medido sobre cinco exercícios da base. NÃO é a mais favorável:
// aqui a de lucro diz "abaixo" (a leitura simpática) e mesmo assim não lidera.
const zonasDiscordantes = computeStockPriceZones({ ...base, priceToBook: 1.5 })!;
const v1 = summarizeStockPriceZones(zonasDiscordantes, 100)!;
check("com as duas faixas, quem encabeça é a de patrimônio", v1.lead, "patrimonio");
check("e a discordância é registrada, não resolvida", v1.disagree, true);

// Com uma leitura só, ela é a linha inteira — não há o que encabeçar.
check("sem faixa por patrimônio, quem encabeça é a de lucro",
  summarizeStockPriceZones(computeStockPriceZones({ ...base, priceToBook: null })!, 100)!.lead, "lucro");
check("e sem a outra não há discordância a declarar",
  summarizeStockPriceZones(computeStockPriceZones({ ...base, priceToBook: null })!, 100)!.disagree, false);

// Concordância entre as duas é o caso comum, e tem de ficar explícito que não é desacordo.
check("duas leituras iguais não discordam",
  summarizeStockPriceZones(computeStockPriceZones(base)!, 100)!.disagree, false);

check("sem zonas não há veredito", summarizeStockPriceZones(null, 100), null);

// --- Contra a base real -----------------------------------------------------

const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(financialFactsTable);
if (total === 0) {
  console.log("\nBase de demonstrações vazia — os casos contra dado real foram pulados.");
} else {
  console.log("\n--- contra a série real da CVM ---");

  const petro = await normalizedEarningsFor("PETR4");
  console.log(`      PETR4: normalizado R$ ${((petro?.value ?? 0) / 1e9).toFixed(1)} bi, `
    + `último R$ ${((petro?.latest ?? 0) / 1e9).toFixed(1)} bi, ${petro?.years} exercícios`);
  check("PETR4 normaliza a partir da série real", petro != null && petro.years >= EXERCICIOS_MINIMOS, true);

  // Âncora num número público: o lucro da Petrobras é dezenas de bilhões por ano, e a
  // mediana de cinco exercícios tem de cair na mesma ordem de grandeza.
  const bilhoes = (petro?.value ?? 0) / 1e9;
  check("e o normalizado da Petrobras fica entre R$ 20 bi e R$ 130 bi",
    bilhoes > 20 && bilhoes < 130, true);

  // Sem ponte não há série, e sem série não há normalização — a resposta certa para FII.
  check("MXRF11 não normaliza (não tem demonstração na CVM)", await normalizedEarningsFor("MXRF11"), null);

  // A distribuição medida que motivou o módulo, reconferida contra o banco: mais da
  // metade das companhias com cinco exercícios teve ano de prejuízo. Se isso cair muito,
  // a premissa do módulo mudou e vale reabrir a conta.
  const [dist] = await db.execute(sql`
    with s as (
      select cnpj, value, row_number() over (partition by cnpj order by period_end desc) rn
        from (select distinct on (cnpj, period_end) cnpj, period_end, value
                from financial_facts
               where document_type='DFP' and period_kind='exercicio' and metric='lucro_liquido'
               order by cnpj, period_end desc, version desc) x)
    select count(*)::int as empresas,
           count(*) filter (where prejuizos > 0)::int as com_prejuizo
      from (select cnpj, count(*) filter (where value < 0) prejuizos
              from s where rn <= 5 group by 1 having count(*) = 5) j
  `).then((r) => Array.from(r.rows ?? r) as { empresas: number; com_prejuizo: number }[]);
  const pct = (dist.com_prejuizo / dist.empresas) * 100;
  console.log(`      ${dist.com_prejuizo} de ${dist.empresas} companhias tiveram ano de prejuízo em 5 (${pct.toFixed(0)}%)`);
  check("a premissa do módulo continua valendo: prejuízo é comum, não exceção", pct > 30, true);
}

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
