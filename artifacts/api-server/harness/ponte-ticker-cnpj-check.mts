import { db, companyTickersTable, financialFactsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { cnpjForTicker, cnpjsForTickers } from "../src/lib/company-tickers";
import { collapseToLatest, type TickerMapping } from "../src/lib/cvm-company-tickers";
import { getFinancialSeriesForTicker } from "../src/lib/financial-history";

/**
 * A ponte entre o ticker da carteira e o CNPJ da CVM.
 *
 * O que estes casos protegem é a única coisa que separa "a série existe no banco" de "a
 * série descreve um ativo que a pessoa possui". Dois riscos opostos:
 *
 * - a ponte deixar de resolver uma ação, e a análise perder a série sem avisar;
 * - a ponte resolver o que NÃO devia — um BDR ou um FII apontando para uma companhia
 *   qualquer —, o que seria pior: em vez de faltar dado, o app mostraria o dado de outra
 *   empresa com toda a cara de certeza.
 *
 *   DATABASE_URL=... node harness/ponte-ticker-cnpj-check.mts
 */

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FALHA"} ${label}\n      obtido   ${a}\n      esperado ${e}`);
}

// --- collapseToLatest: função pura, roda sem depender do banco ---------------

const base = { cnpj: "1", companyName: "ANTIGO", securityKind: null, tradingEndedAt: null };
const colapsado = collapseToLatest([
  { ...base, ticker: "TEST3", referenceDate: "2024-12-31", version: 1 },
  { ...base, ticker: "TEST3", referenceDate: "2026-12-31", version: 1, companyName: "NOVO" },
  { ...base, ticker: "TEST3", referenceDate: "2025-12-31", version: 3 },
] as TickerMapping[]);
check("o registro mais recente vence, e não o de maior versão",
  colapsado.map((m) => m.companyName), ["NOVO"]);

const mesmaData = collapseToLatest([
  { ...base, ticker: "TEST4", referenceDate: "2026-12-31", version: 1, companyName: "V1" },
  { ...base, ticker: "TEST4", referenceDate: "2026-12-31", version: 2, companyName: "V2" },
] as TickerMapping[]);
check("empate na data desempata pela versão", mesmaData.map((m) => m.companyName), ["V2"]);

// --- A ponte gravada --------------------------------------------------------

const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(companyTickersTable);
if (total === 0) {
  console.log("\nTabela company_tickers vazia — rode o sync antes (POST /api/internal/financial-facts/sync).");
  process.exit(failures === 0 ? 0 : 1);
}

const [cobertura] = await db
  .select({
    empresas: sql<number>`count(distinct cnpj)::int`,
    semTipo: sql<number>`count(*) filter (where security_kind is null)::int`,
    cnpjMalformado: sql<number>`count(*) filter (where cnpj !~ '^[0-9]{14}$')::int`,
  })
  .from(companyTickersTable);

console.log(`\nponte: ${total} tickers, ${cobertura.empresas} companhias`);

// O CNPJ tem que estar no MESMO formato de financial_facts (14 dígitos, sem pontuação),
// senão o join silenciosamente não casa nada e a série some sem erro nenhum.
check("todo CNPJ tem 14 dígitos e nenhuma pontuação", cobertura.cnpjMalformado, 0);

// --- Tickers reais ----------------------------------------------------------

// Ações brasileiras: têm de resolver. Se pararem de resolver, a análise perde a série.
for (const ticker of ["PETR4", "VALE3", "ITUB4", "WEGE3", "ABEV3"]) {
  check(`${ticker} resolve`, (await cnpjForTicker(ticker)) != null, true);
}

// PETR3 e PETR4 são a MESMA demonstração — é a razão de a tabela ser chaveada por CNPJ.
const petr3 = await cnpjForTicker("PETR3");
const petr4 = await cnpjForTicker("PETR4");
check("PETR3 e PETR4 apontam para o mesmo CNPJ", petr3 === petr4 && petr3 != null, true);

// Mercado fracionário é o MESMO papel; sem a normalização, quem só tem fracionário
// ficaria sem série.
check("PETR4F resolve para o mesmo CNPJ de PETR4", (await cnpjForTicker("PETR4F")), petr4);

// O outro lado, e o mais importante: resolver o que não devia mostraria o dado de outra
// empresa com cara de certeza. Apple e Microsoft não prestam contas à CVM; FII e ETF têm
// registro próprio, fora do FCA.
for (const ticker of ["AAPL34", "MSFT34", "MXRF11", "BOVA11", "HGLG11"]) {
  check(`${ticker} NÃO resolve (não é companhia aberta brasileira)`, await cnpjForTicker(ticker), null);
}

// Lote e unitário têm de concordar — são dois caminhos para a mesma resposta.
const lote = await cnpjsForTickers(["PETR4", "PETR4F", "MXRF11"]);
check("o lote devolve sob o ticker que o chamador pediu",
  [lote.get("PETR4") === petr4, lote.get("PETR4F") === petr4, lote.has("MXRF11")],
  [true, true, false]);

// --- A ponte alcança a série ------------------------------------------------

// O teste que justifica a tabela inteira existir.
const serie = await getFinancialSeriesForTicker("PETR4", "receita");
check("PETR4 alcança a série de demonstrações", serie.length > 5, true);

// Âncora num número público: a receita da Petrobras é da ordem de meia centena de bilhões
// por ano. Se a ponte casar com a companhia errada, o valor sai desta faixa.
const ultimo = serie.at(-1);
const bilhoes = ultimo ? ultimo.value / 1e9 : 0;
console.log(`      último exercício de PETR4: R$ ${bilhoes.toFixed(1)} bi em ${ultimo?.periodEnd}`);
check("e a série é mesmo da Petrobras (receita entre R$ 300 bi e R$ 700 bi)",
  bilhoes > 300 && bilhoes < 700, true);

check("a série trimestral também chega pelo ticker",
  (await getFinancialSeriesForTicker("PETR4", "receita", { frequency: "trimestral" })).length > 5, true);

// Sem ponte devolve série vazia, e não erro: é resposta legítima para BDR, FII e ETF.
check("ticker sem ponte devolve série vazia, não erro",
  (await getFinancialSeriesForTicker("MXRF11", "receita")).length, 0);

// --- Quanto da base ficou alcançável ----------------------------------------

const [alcance] = await db.execute(sql`
  select
    (select count(distinct cnpj)::int from financial_facts) as com_demonstracao,
    (select count(distinct f.cnpj)::int from financial_facts f
       join company_tickers t on t.cnpj = f.cnpj) as alcancavel
`).then((r) => Array.from(r.rows ?? r) as { com_demonstracao: number; alcancavel: number }[]);
const pct = (alcance.alcancavel / alcance.com_demonstracao) * 100;
console.log(`\nalcance: ${alcance.alcancavel} de ${alcance.com_demonstracao} companhias com demonstração agora têm ticker (${pct.toFixed(0)}%)`);

// As que sobram são emissoras registradas na CVM sem ação em bolsa (dívida, capital
// fechado com registro). O piso existe para a ponte não degradar em silêncio.
check("mais da metade das companhias com demonstração ficou alcançável", pct > 50, true);

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
