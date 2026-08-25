import { db, financialFactsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getFinancialSeries, consecutiveDeclines } from "../src/lib/financial-history";
import { ACCOUNT_MAP } from "../src/lib/cvm-statements";

/**
 * A série de demonstrações da CVM, conferida contra a base já ingerida.
 *
 * O que este harness protege não é o parser em si — é a leitura. A tabela guarda mais de
 * uma linha por período de propósito (o mesmo exercício aparece em dois documentos, e a
 * retificação convive com a publicação original), e ler ela cru produz duas conclusões
 * erradas em silêncio. Os casos abaixo fixam a regra: valor da maior versão, publicação
 * da menor data.
 */

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FALHA"} ${label}\n      obtido   ${a}\n      esperado ${e}`);
}

const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(financialFactsTable);
if (total === 0) {
  console.log("Tabela vazia — rode o sync antes:");
  console.log("  POST /api/internal/financial-facts/sync");
  process.exit(0);
}

// --- Integridade da ingestão ----------------------------------------------

const [cobertura] = await db
  .select({
    empresas: sql<number>`count(distinct cnpj)::int`,
    metricas: sql<number>`count(distinct metric)::int`,
    semPublicacao: sql<number>`count(*) filter (where published_at is null)::int`,
    semValor: sql<number>`count(*) filter (where value is null)::int`,
  })
  .from(financialFactsTable);

console.log(`base: ${total} fatos, ${cobertura.empresas} companhias, ${cobertura.metricas} métricas\n`);

check("todas as métricas do mapa foram ingeridas",
  cobertura.metricas, new Set(ACCOUNT_MAP.map((a) => a.metric)).size);

// publishedAt é o que separa esta tabela de um cache de indicadores. Sem ele não há como
// responder "o que se sabia naquela data", e o estudo retrospectivo vira ficção.
check("nenhum fato sem data de publicação", cobertura.semPublicacao, 0);

check("nenhum fato sem valor", cobertura.semValor, 0);

// Escala: o arquivo publica em MIL e a ingestão converte para reais. A primeira versão
// deste teste procurava valores "pequenos demais" na base inteira e acusava 7 linhas —
// mas eram reais: holding recém-constituída e empresa-casca têm mesmo R$ 67 de ativo.
// A asserção estava errada, não o dado. Âncora num número grande e público resolve sem
// falso positivo: o lucro da Petrobras em 2024 foi de ~R$ 37 bilhões, e uma conversão de
// escala esquecida o deixaria em R$ 37 milhões — três ordens de grandeza abaixo da faixa.
const [ancora] = await db
  .select({ value: financialFactsTable.value })
  .from(financialFactsTable)
  .where(sql`company_name ilike 'PETROLEO BRASILEIRO%' and metric = 'lucro_liquido' and period_end = '2024-12-31'`)
  .limit(1);
const bilhoes = ancora ? parseFloat(ancora.value) / 1e9 : null;
check("escala convertida: lucro da Petrobras em 2024 entre R$ 30 bi e R$ 45 bi",
  bilhoes != null && bilhoes > 30 && bilhoes < 45, true);
console.log(`      medido: R$ ${bilhoes?.toFixed(1)} bilhões`);

// --- A regra de leitura ---------------------------------------------------

const [petro] = await db
  .select({ cnpj: financialFactsTable.cnpj })
  .from(financialFactsTable)
  .where(sql`company_name ilike 'PETROLEO BRASILEIRO%'`)
  .limit(1);

if (petro) {
  const serie = await getFinancialSeries(petro.cnpj, "lucro_liquido");
  check("a série não repete período", serie.length, new Set(serie.map((p) => p.periodEnd)).size);
  check("a série vem em ordem cronológica",
    serie.map((p) => p.periodEnd), [...serie.map((p) => p.periodEnd)].sort());

  // O caso concreto que motivou o leitor: o exercício de 2023 está publicado em
  // 25/03/2024 (DFP de 2023) e de novo em 26/02/2025 (penúltimo do DFP de 2024). Vale a
  // data mais antiga — a outra descartaria 11 meses de informação que existia.
  const p2023 = serie.find((p) => p.periodEnd === "2023-12-31");
  check("período repetido em dois documentos mantém a PRIMEIRA publicação",
    p2023?.firstPublishedAt, "2024-03-25");

  // Toda demonstração leva semanas para sair. Se algum período aparecer publicado ANTES
  // do fim do próprio período, a junção com o índice de documentos está errada.
  const antesDoFim = serie.filter((p) => p.firstPublishedAt != null && p.firstPublishedAt < p.periodEnd);
  check("nenhum período publicado antes de terminar", antesDoFim.length, 0);

  // asOf é o que permite perguntar o que se sabia numa data. Um dia antes da publicação
  // do resultado de 2023, ele não podia estar na resposta.
  const vespera = await getFinancialSeries(petro.cnpj, "lucro_liquido", "2024-03-24");
  check("asOf exclui o que ainda não tinha sido publicado",
    vespera.some((p) => p.periodEnd === "2023-12-31"), false);
  const dia = await getFinancialSeries(petro.cnpj, "lucro_liquido", "2024-03-25");
  check("asOf inclui o que foi publicado naquele dia",
    dia.some((p) => p.periodEnd === "2023-12-31"), true);
}

// --- Tendência: a pergunta que não tinha resposta antes --------------------

check("queda de 3 anos seguidos é contada",
  consecutiveDeclines([
    { periodEnd: "2021-12-31", value: 100, firstPublishedAt: null, version: 1, restated: false, sourceUrl: null },
    { periodEnd: "2022-12-31", value: 90, firstPublishedAt: null, version: 1, restated: false, sourceUrl: null },
    { periodEnd: "2023-12-31", value: 80, firstPublishedAt: null, version: 1, restated: false, sourceUrl: null },
    { periodEnd: "2024-12-31", value: 70, firstPublishedAt: null, version: 1, restated: false, sourceUrl: null },
  ]), 3);

check("um ano de alta interrompe a contagem",
  consecutiveDeclines([
    { periodEnd: "2022-12-31", value: 100, firstPublishedAt: null, version: 1, restated: false, sourceUrl: null },
    { periodEnd: "2023-12-31", value: 80, firstPublishedAt: null, version: 1, restated: false, sourceUrl: null },
    { periodEnd: "2024-12-31", value: 95, firstPublishedAt: null, version: 1, restated: false, sourceUrl: null },
  ]), 0);

check("série de um período não inventa tendência",
  consecutiveDeclines([{ periodEnd: "2024-12-31", value: 10, firstPublishedAt: null, version: 1, restated: false, sourceUrl: null }]), 0);

// A base inteira responde à pergunta que antes era impossível.
const [tendencia] = await db.execute(sql`
  with s as (
    select cnpj, period_end, value,
           lag(value) over (partition by cnpj order by period_end) as anterior
    from financial_facts where metric = 'lucro_liquido')
  select count(*) filter (where value < anterior)::int as caindo, count(*)::int as pares
  from s where anterior is not null
`).then((r) => Array.from(r.rows ?? r) as { caindo: number; pares: number }[]);
console.log(`\ntendência mensurável: ${tendencia.caindo} de ${tendencia.pares} pares empresa-ano com lucro menor que o anterior`);
check("há pares suficientes para medir tendência", tendencia.pares > 1000, true);

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
