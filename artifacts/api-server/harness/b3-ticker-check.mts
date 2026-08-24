import { kindFromTicker, categoryConflict } from "../src/lib/b3-ticker";
import { implausibleTradeDate } from "../src/lib/local-date";

/**
 * A convenção de sufixo da B3 contra papéis reais.
 *
 * O que este harness protege não é a regra em si — é a fronteira dela. Uma regra de
 * classificação boa demais na própria opinião rejeitaria cadastro legítimo, e o dano de
 * bloquear um papel válido é maior que o de deixar passar um duvidoso: o usuário fica
 * sem conseguir registrar o que ele de fato comprou. Por isso metade dos casos abaixo
 * são casos em que a resposta CERTA é silêncio.
 */

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FALHA"} ${label}\n      obtido   ${a}\n      esperado ${e}`);
}
/** Só interessa se houve conflito, não a redação da frase. */
const conflita = (ticker: string, category: string) => categoryConflict(ticker, category) != null;

// --- Natureza pelo sufixo -------------------------------------------------
check("PETR4 é ação (PN)", kindFromTicker("PETR4"), "acao");
check("ITUB3 é ação (ON)", kindFromTicker("ITUB3"), "acao");
check("TIET5 é ação (PNA)", kindFromTicker("TIET5"), "acao");
check("PETR4F (fracionário) ainda é ação", kindFromTicker("PETR4F"), "acao");
check("MXRF11 cai no grupo ambíguo", kindFromTicker("MXRF11"), "fii_etf_ou_unit");
check("BOVA11 cai no grupo ambíguo", kindFromTicker("BOVA11"), "fii_etf_ou_unit");
check("AAPL34 é BDR", kindFromTicker("AAPL34"), "bdr");
check("A1MD34 (BDR não patrocinado, dígito na raiz)", kindFromTicker("A1MD34"), "bdr");
check("minúscula é normalizada", kindFromTicker("petr4"), "acao");

// O caso que mais facilmente quebraria: em AAPL34 o "3" isolado também é sufixo de ação.
// Se a regra de BDR não fosse testada antes da de ação, todo BDR viraria ação.
check("AAPL34 não é confundido com ação ON", kindFromTicker("AAPL34") === "acao", false);

// Fora do padrão: sem opinião. É o que permite CDB, Tesouro e rótulo livre.
check("CDB BANCO X é desconhecido", kindFromTicker("CDB BANCO X"), "desconhecido");
check("Tesouro Selic 2029 é desconhecido", kindFromTicker("Tesouro Selic 2029"), "desconhecido");
check("string vazia é desconhecida", kindFromTicker(""), "desconhecido");

// --- O bug relatado -------------------------------------------------------
check("PETR4 como FII: bloqueia", conflita("PETR4", "fiis"), true);
check("PETR4 como ETF: bloqueia", conflita("PETR4", "etfs"), true);
check("PETR4 como BDR: bloqueia", conflita("PETR4", "bdrs"), true);
check("PETR4 como ação: passa", conflita("PETR4", "acoes"), false);
console.log(`      mensagem: ${categoryConflict("PETR4", "fiis")}`);

// --- O silêncio deliberado ------------------------------------------------
// Sufixo 11 é FII (MXRF11), ETF (BOVA11) E unit de ação (BPAC11). Escolher um dos três
// rejeitaria cadastro correto dos outros dois — a convenção não decide, então nem nós.
check("MXRF11 como FII: passa", conflita("MXRF11", "fiis"), false);
check("BOVA11 como ETF: passa", conflita("BOVA11", "etfs"), false);
check("BPAC11 como ação (unit): passa", conflita("BPAC11", "acoes"), false);
check("MXRF11 como BDR: bloqueia", conflita("MXRF11", "bdrs"), true);

// Renda fixa e fundos não usam código de bolsa — a regra não se aplica, nem mesmo a um
// ticker que por acaso pareça um. Sem esta isenção, CDB e Tesouro parariam de cadastrar.
check("PETR4 em renda fixa: fora do escopo da regra", conflita("PETR4", "renda_fixa"), false);
check("CDB em renda fixa: passa", conflita("CDB BANCO INTER", "renda_fixa"), false);
check("nome de fundo em fundos: passa", conflita("ALASKA BLACK FIC", "fundos"), false);

// --- Datas implausíveis ---------------------------------------------------
// O caso real: ano 0001, digitado sem querer no campo de data e aceito até aqui.
check("ano 0001 é recusado", implausibleTradeDate("0001-01-26") != null, true);
check("1899 é recusado", implausibleTradeDate("1899-12-31") != null, true);
check("1900 passa", implausibleTradeDate("1900-01-01"), null);
check("data antiga plausível passa", implausibleTradeDate("2019-03-15"), null);

const amanha = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
check("amanhã é recusado", implausibleTradeDate(amanha) != null, true);

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
