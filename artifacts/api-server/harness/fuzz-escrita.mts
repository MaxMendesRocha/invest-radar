/**
 * Entradas sem nexo contra todos os endpoints de escrita.
 *
 * O que este arquivo NÃO é: fuzz aleatório. Jogar bytes malucos numa API validada por
 * zod prova que o zod funciona, e mais nada. Os três defeitos que motivaram este harness
 * não eram valores esquisitos — `-10`, `0` e `0001-01-26` são todos números e datas
 * perfeitamente válidos. Passaram porque ninguém perguntou se faziam SENTIDO.
 *
 * Então o que se varre aqui são fronteiras semânticas: zero, negativo, magnitude
 * absurda, precisão abaixo da escala da coluna, data no limite, campos que se
 * contradizem, e recurso de outro usuário. Cada caso declara o que ESPERA — a saída é um
 * placar, não um relatório para alguém interpretar depois.
 *
 * Roda contra o servidor local, e recusa qualquer URL que não seja localhost: os casos
 * abaixo criam e apagam dados de propósito.
 *
 *   PORT=3001 node dist/index.mjs &
 *   node ... harness/fuzz-escrita.mts
 */

const BASE = process.env.FUZZ_API_URL ?? "http://localhost:3001/api";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(BASE)) {
  console.error(`Recusando rodar contra ${BASE} — este harness escreve e apaga dados. Só localhost.`);
  process.exit(2);
}

let falhas = 0;
let casos = 0;

interface Sessao { cookie: string; id: number }

async function chamar(sessao: Sessao | null, metodo: string, caminho: string, corpo?: unknown) {
  const res = await fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers: { "Content-Type": "application/json", ...(sessao ? { Cookie: sessao.cookie } : {}) },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const texto = await res.text();
  let json: any = null;
  try { json = JSON.parse(texto); } catch { /* resposta não-JSON é em si um achado */ }
  return { status: res.status, json, texto };
}

async function criarSessao(sufixo: string): Promise<Sessao> {
  const email = `fuzz-${sufixo}-${Date.now()}@teste.local`;
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "senha12345", name: `Fuzz ${sufixo}` }),
  });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const body = await res.json();
  if (!cookie) throw new Error(`registro não devolveu cookie: ${JSON.stringify(body)}`);
  return { cookie, id: body.user.id };
}

/**
 * `esperado` é a família de resposta, não o código exato: 400 e 409 significam ambos
 * "recusado com critério", e prender o teste ao número exato faria uma melhora de
 * mensagem quebrar o harness.
 */
type Esperado = "recusa" | "aceita";

async function caso(nome: string, esperado: Esperado, executar: () => Promise<{ status: number; json: any; texto: string }>) {
  casos++;
  const { status, json, texto } = await executar();
  const recusou = status >= 400 && status < 500;
  const quebrou = status >= 500;
  const ok = quebrou ? false : esperado === "recusa" ? recusou : !recusou;

  if (ok) {
    console.log(`OK    ${nome}  [${status}]`);
    return { status, json };
  }
  falhas++;
  const motivo = quebrou
    ? "QUEBROU o servidor (5xx) — recusar é resposta, estourar não é"
    : esperado === "recusa"
      ? "ACEITOU o que deveria recusar"
      : "RECUSOU o que deveria aceitar";
  console.log(`FALHA ${nome}  [${status}] ${motivo}`);
  console.log(`      ${(json ? JSON.stringify(json) : texto).slice(0, 220)}`);
  return { status, json };
}

// ---------------------------------------------------------------------------

const a = await criarSessao("a");
const b = await criarSessao("b");
console.log(`sessões: usuário A=${a.id}, usuário B=${b.id}\n`);

const valido = { ticker: "PETR4", quantity: 10, averagePrice: 30, category: "acoes" };
const post = (s: Sessao, corpo: unknown) => () => chamar(s, "POST", "/assets", corpo);

console.log("── POST /assets: magnitude e sinal ──");
await caso("quantidade negativa", "recusa", post(a, { ...valido, quantity: -10 }));
await caso("quantidade zero", "recusa", post(a, { ...valido, quantity: 0 }));
await caso("preço negativo", "recusa", post(a, { ...valido, averagePrice: -30 }));
await caso("preço zero", "recusa", post(a, { ...valido, averagePrice: 0 }));
// numeric(18,6) comporta 12 dígitos inteiros. Acima disso o Postgres estoura, e estourar
// é 500 — o servidor tem de recusar com critério antes de chegar lá.
await caso("quantidade astronômica (1e20)", "recusa", post(a, { ...valido, quantity: 1e20 }));
await caso("preço astronômico (1e20)", "recusa", post(a, { ...valido, averagePrice: 1e20 }));
// Abaixo da escala 6 da coluna, o Postgres arredonda para zero — e uma posição de
// quantidade zero é exatamente o que a trava de sinal existe para impedir.
await caso("quantidade abaixo da escala da coluna (1e-9)", "recusa", post(a, { ...valido, quantity: 1e-9 }));

console.log("\n── POST /assets: datas ──");
await caso("data no ano 0001", "recusa", post(a, { ...valido, purchaseDate: "0001-01-26" }));
await caso("data no futuro", "recusa", post(a, { ...valido, purchaseDate: "2099-01-01" }));
await caso("30 de fevereiro", "recusa", post(a, { ...valido, purchaseDate: "2026-02-30" }));
await caso("data que não é data", "recusa", post(a, { ...valido, purchaseDate: "ontem" }));

console.log("\n── POST /assets: ticker e categoria ──");
await caso("ticker vazio", "recusa", post(a, { ...valido, ticker: "" }));
await caso("ticker só de espaços", "recusa", post(a, { ...valido, ticker: "   " }));
await caso("ticker de 500 caracteres", "recusa", post(a, { ...valido, ticker: "A".repeat(500) }));
await caso("categoria inexistente", "recusa", post(a, { ...valido, category: "cripto" }));
await caso("ação cadastrada como FII", "recusa", post(a, { ...valido, category: "fiis" }));
await caso("poupança fora de renda fixa", "recusa", post(a, { ...valido, isSavingsAccount: true }));
await caso("metade do par do Tesouro", "recusa", post(a, { ...valido, category: "renda_fixa", treasuryBondType: "Tesouro Selic" }));

console.log("\n── POST /assets: tipos trocados ──");
await caso("quantidade como texto", "recusa", post(a, { ...valido, quantity: "dez" }));
await caso("corpo que não é objeto", "recusa", () => chamar(a, "POST", "/assets", "isto é uma string"));
await caso("corpo vazio", "recusa", post(a, {}));
// SQL em campo de texto tem de ser gravado como texto e nada mais. O drizzle
// parametriza, mas quem afirma isso sem testar está torcendo, não sabendo.
const sqlzinho = await caso("SQL no campo de observações", "aceita",
  post(a, { ...valido, ticker: "VALE3", notes: "'; DROP TABLE assets; --" }));
await caso("a tabela assets sobreviveu ao SQL acima", "aceita", () => chamar(a, "GET", "/assets"));

console.log("\n── Venda ──");
const base = await caso("cria posição válida para os testes de venda", "aceita",
  post(a, { ticker: "ITUB4", quantity: 100, averagePrice: 30, category: "acoes" }));
const idA = base.json?.id;
const vender = (corpo: unknown) => () => chamar(a, "POST", `/assets/${idA}/sell`, corpo);
await caso("preço de venda zero", "recusa", vender({ salePrice: 0, saleDate: "2026-08-01" }));
await caso("preço de venda negativo", "recusa", vender({ salePrice: -10, saleDate: "2026-08-01" }));
await caso("quantidade de venda negativa", "recusa", vender({ salePrice: 40, saleDate: "2026-08-01", quantity: -5 }));
await caso("vender mais do que se tem", "recusa", vender({ salePrice: 40, saleDate: "2026-08-01", quantity: 999999 }));
await caso("venda com data no futuro", "recusa", vender({ salePrice: 40, saleDate: "2099-01-01" }));

console.log("\n── Lançamentos ──");
const lancar = (corpo: unknown) => () => chamar(a, "POST", `/assets/${idA}/purchases`, corpo);
await caso("lançamento com quantidade negativa", "recusa", lancar({ quantity: -1, unitPrice: 10, tradeDate: "2026-08-01" }));
await caso("lançamento com preço zero", "recusa", lancar({ quantity: 1, unitPrice: 0, tradeDate: "2026-08-01" }));
await caso("lançamento no ano 0001", "recusa", lancar({ quantity: 1, unitPrice: 10, tradeDate: "0001-01-01" }));
await caso("lançamento no futuro", "recusa", lancar({ quantity: 1, unitPrice: 10, tradeDate: "2099-01-01" }));

console.log("\n── Proventos, meta, alocação e preço-alvo ──");
await caso("provento negativo", "recusa", () => chamar(a, "POST", "/transactions", { ticker: "ITUB4", amount: -100, type: "dividendo", date: "2026-08-01" }));
await caso("provento zero", "recusa", () => chamar(a, "POST", "/transactions", { ticker: "ITUB4", amount: 0, type: "dividendo", date: "2026-08-01" }));
await caso("provento com data no futuro", "recusa", () => chamar(a, "POST", "/transactions", { ticker: "ITUB4", amount: 10, type: "dividendo", date: "2099-01-01" }));
await caso("meta de renda negativa", "recusa", () => chamar(a, "PUT", "/portfolio/income-goal", { targetMonthlyIncome: -1000, targetYear: 2030 }));
await caso("meta para um ano já passado", "recusa", () => chamar(a, "PUT", "/portfolio/income-goal", { targetMonthlyIncome: 1000, targetYear: 1999 }));
await caso("alocação somando 500%", "recusa", () => chamar(a, "PUT", "/portfolio/allocation", {
  targets: [{ category: "acoes", targetPercent: 500 }, { category: "renda_fixa", targetPercent: 0 }],
}));
await caso("alocação com alvo negativo", "recusa", () => chamar(a, "PUT", "/portfolio/allocation", {
  targets: [{ category: "acoes", targetPercent: -50 }, { category: "renda_fixa", targetPercent: 150 }],
}));
await caso("preço-alvo negativo", "recusa", () => chamar(a, "PUT", "/price-targets/ITUB4", { targetPrice: -10 }));

console.log("\n── Autorização: A mexendo no que é de B ──");
const doB = await caso("B cria a própria posição", "aceita",
  () => chamar(b, "POST", "/assets", { ticker: "VALE3", quantity: 5, averagePrice: 60, category: "acoes" }));
const idB = doB.json?.id;
await caso("A lê a posição de B", "recusa", () => chamar(a, "GET", `/assets/${idB}`));
await caso("A edita a posição de B", "recusa", () => chamar(a, "PATCH", `/assets/${idB}`, { quantity: 1 }));
await caso("A vende a posição de B", "recusa", () => chamar(a, "POST", `/assets/${idB}/sell`, { salePrice: 10, saleDate: "2026-08-01" }));
await caso("A lança compra na posição de B", "recusa", () => chamar(a, "POST", `/assets/${idB}/purchases`, { quantity: 1, unitPrice: 10, tradeDate: "2026-08-01" }));
// Este caso julga pelo EFEITO e não pelo código, e a diferença importa: o DELETE filtra
// por usuário no próprio WHERE, então não apaga nada de terceiro — mas responde 204 do
// mesmo jeito, como se tivesse apagado. Uma primeira versão deste harness cravou
// "brecha de autorização" olhando só o status, e estava errada. O que prova que a
// posição está a salvo é ela continuar na carteira de B depois da tentativa.
await chamar(a, "DELETE", `/assets/${idB}`);
await caso("a posição de B sobrevive ao DELETE de A", "aceita", async () => {
  const r = await chamar(b, "GET", "/assets");
  const viva = Array.isArray(r.json) && r.json.some((x: any) => x.id === idB);
  return { status: viva ? 200 : 500, json: r.json, texto: viva ? "" : "a posição sumiu — brecha real de autorização" };
});
await caso("sem sessão nenhuma", "recusa", () => chamar(null, "GET", "/assets"));

console.log("\n── Identificadores absurdos ──");
await caso("id inexistente", "recusa", () => chamar(a, "PATCH", "/assets/99999999", { quantity: 1 }));
await caso("id negativo", "recusa", () => chamar(a, "PATCH", "/assets/-1", { quantity: 1 }));
await caso("id que não é número", "recusa", () => chamar(a, "PATCH", "/assets/abc", { quantity: 1 }));

console.log(
  falhas === 0
    ? `\n${casos} casos, nenhuma brecha.`
    : `\n${casos} casos, ${falhas} brecha(s) — ver as linhas FALHA acima.`,
);
process.exit(falhas === 0 ? 0 : 1);
