import { db, financialFactsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getFinancialSeries, consecutiveDeclines } from "../src/lib/financial-history";
import { ACCOUNT_MAP } from "../src/lib/cvm-statements";

/**
 * A série de demonstrações da CVM, conferida contra a base já ingerida.
 *
 * O que este harness protege não é o parser em si — é a leitura. A tabela guarda mais de
 * uma linha por período de propósito (o mesmo exercício aparece em dois documentos, a
 * retificação convive com a publicação original, e o trimestral publica o mesmo fim de
 * período como trimestre e como acumulado), e ler ela cru produz conclusões erradas em
 * silêncio. Os casos abaixo fixam a regra: valor da maior versão, publicação da menor
 * data, uma frequência por série.
 *
 * A última seção protege outra coisa: a fonte às vezes declara a escala errada, e o
 * parser não pode repassar isso para o motor de decisão.
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
  const vespera = await getFinancialSeries(petro.cnpj, "lucro_liquido", { asOf: "2024-03-24" });
  check("asOf exclui o que ainda não tinha sido publicado",
    vespera.some((p) => p.periodEnd === "2023-12-31"), false);
  const dia = await getFinancialSeries(petro.cnpj, "lucro_liquido", { asOf: "2024-03-25" });
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
//
// O filtro por period_kind não é detalhe: sem ele o `lag` compararia o exercício de um ano
// com o trimestre do seguinte e contaria como queda toda vez que o ITR entrasse na janela.
const [tendencia] = await db.execute(sql`
  with s as (
    select cnpj, period_end, value,
           lag(value) over (partition by cnpj order by period_end) as anterior
    from financial_facts
    where metric = 'lucro_liquido' and document_type = 'DFP' and period_kind = 'exercicio')
  select count(*) filter (where value < anterior)::int as caindo, count(*)::int as pares
  from s where anterior is not null
`).then((r) => Array.from(r.rows ?? r) as { caindo: number; pares: number }[]);
console.log(`\ntendência mensurável: ${tendencia.caindo} de ${tendencia.pares} pares empresa-ano com lucro menor que o anterior`);
check("há pares suficientes para medir tendência", tendencia.pares > 1000, true);

// --- O trimestral (ITR) ---------------------------------------------------

const [kinds] = await db
  .select({
    trimestre: sql<number>`count(*) filter (where document_type='ITR' and period_kind='trimestre')::int`,
    acumulado: sql<number>`count(*) filter (where document_type='ITR' and period_kind='acumulado')::int`,
    exercicio: sql<number>`count(*) filter (where document_type='DFP' and period_kind='exercicio')::int`,
    dfpNaoAnual: sql<number>`count(*) filter (where document_type='DFP' and period_kind in ('trimestre','acumulado'))::int`,
    itrExercicio: sql<number>`count(*) filter (where document_type='ITR' and period_kind='exercicio')::int`,
  })
  .from(financialFactsTable);

if (kinds.trimestre === 0) {
  console.log("\nSem dado de ITR — os casos do trimestral foram pulados.");
} else {
  console.log(`\nITR: ${kinds.trimestre} trimestres, ${kinds.acumulado} acumulados`);

  // A classificação não pode vazar de um documento para o outro: DFP nunca produz
  // trimestre, ITR nunca produz exercício. Se vazar, periodKindFor quebrou.
  check("DFP não gera período trimestral", kinds.dfpNaoAnual, 0);
  check("ITR não gera exercício", kinds.itrExercicio, 0);

  // O último trimestre do exercício praticamente não existe no ITR — ele só aparece
  // completo dentro do DFP, e quem quiser o 4T precisa derivá-lo (exercício menos o
  // acumulado de 9 meses).
  //
  // "Praticamente" é medido, não suposto. A primeira versão deste caso exigia ZERO
  // trimestre terminando em dezembro e acusou 266 — e a asserção é que estava errada, não
  // o dado: companhia que fecha exercício em março tem um trimestre terminando em
  // dezembro, e ele é o 3T dela, perfeitamente normal. Prendendo a comparação ao mês de
  // fechamento de CADA companhia sobram 42 linhas em 39 mil (0,1%): existem, e são poucas
  // demais para qualquer consumidor contar com elas.
  const [ultimo] = await db.execute(sql`
    with fim as (
      select cnpj, extract(month from period_end)::int mes,
             row_number() over (partition by cnpj order by count(*) desc) rk
        from financial_facts
       where document_type='DFP' and period_kind='exercicio'
       group by 1, 2)
    select count(*)::int as "noFim",
           (select count(*)::int from financial_facts
             where document_type='ITR' and period_kind='trimestre') as total
      from financial_facts f
      join fim on fim.cnpj = f.cnpj and fim.rk = 1
     where f.document_type='ITR' and f.period_kind='trimestre'
       and extract(month from f.period_end)::int = fim.mes
  `).then((r) => Array.from(r.rows ?? r) as { noFim: number; total: number }[]);
  const fracao = ultimo.total > 0 ? ultimo.noFim / ultimo.total : 0;
  console.log(`      último trimestre do exercício no ITR: ${ultimo.noFim} de ${ultimo.total} (${(fracao * 100).toFixed(2)}%)`);
  check("o ITR não é fonte para o último trimestre do exercício", fracao < 0.01, true);

  // A identidade que a própria fonte oferece para conferência: o 1T mais o 2T tem que
  // fechar com o semestre acumulado. Não fecha em 100% porque companhia retifica o 1T ao
  // publicar o 2T — e é exatamente por isso que `version` e `publishedAt` existem aqui.
  // Medido: 3.167 de 3.285 pares fecham dentro de 1%; o resto erra em unidades de
  // porcento, não em ordem de grandeza.
  const [recon] = await db.execute(sql`
    with q as (
      select cnpj, metric, period_end, version, value from financial_facts
       where document_type='ITR' and period_kind='trimestre' and metric='receita'),
     acc as (
      select cnpj, metric, period_end, version, value,
             extract(year from period_end)::int ano
        from financial_facts
       where document_type='ITR' and period_kind='acumulado' and metric='receita'
         and extract(month from period_end)=6 and value <> 0)
    select count(*)::int pares,
           count(*) filter (
             where abs((q1.value+q2.value)-acc.value) <= 0.01*abs(acc.value))::int fecham
      from acc
      join q q1 on q1.cnpj=acc.cnpj and q1.version=acc.version
           and q1.period_end = make_date(acc.ano,3,31)
      join q q2 on q2.cnpj=acc.cnpj and q2.version=acc.version
           and q2.period_end = acc.period_end
  `).then((r) => Array.from(r.rows ?? r) as { pares: number; fecham: number }[]);
  const taxa = recon.pares > 0 ? recon.fecham / recon.pares : 0;
  console.log(`      1T+2T fecham com o semestre em ${recon.fecham}/${recon.pares} (${(taxa * 100).toFixed(1)}%)`);
  check("1T + 2T reconciliam com o semestre em pelo menos 95% dos casos", taxa >= 0.95, true);
}

// --- Escala: o defeito que a fonte comete e o parser não pode repassar ------

// A ODONTOPREV declarou MIL no 1T de 2021, UNIDADE no 2T e MIL no 3T, com valores da
// mesma ordem nos três. Aplicar a escala ao pé da letra punha o 2T mil vezes menor — uma
// queda de 99,9% inventada sobre uma empresa real. `dropInconsistentScale` descarta o
// desvio; este caso é a trava para ele não voltar.
//
// A assinatura procurada é a MESMA versão do mesmo período com valores em escalas
// diferentes. Entre versões DIFERENTES a razão de mil é retificação legítima — a YBYRÁ
// CAPITAL corrigiu o caixa de 2023 de R$ 888 para R$ 942 mil entre a versão 1 e a 4 —, e
// por isso a comparação é presa à mesma versão.
const [{ escalaConflitante }] = await db.execute(sql`
  select count(*)::int as "escalaConflitante"
    from financial_facts a
    join financial_facts b
      on a.cnpj=b.cnpj and a.metric=b.metric and a.period_end=b.period_end
     and a.period_kind=b.period_kind and a.document_type=b.document_type
     and a.version=b.version and a.id < b.id
   where a.value <> 0 and b.value <> 0
     and (abs(b.value/a.value) between 900 and 1100
       or abs(a.value/b.value) between 900 and 1100)
`).then((r) => Array.from(r.rows ?? r) as { escalaConflitante: number }[]);
check("nenhum período tem o mesmo número em duas escalas", escalaConflitante, 0);

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
