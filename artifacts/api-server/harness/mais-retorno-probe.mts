/**
 * Sonda a API da Mais Retorno e IMPRIME O CONTRATO REAL.
 *
 * Existe porque a documentação deles não especifica o cabeçalho de autenticação nem os
 * nomes dos campos, e escrever o parser contra a documentação já deu errado duas vezes
 * nesta base (proventos de FII e units na brapi). Rode uma vez com o token no ambiente
 * e a saída diz exatamente o que o código precisa saber.
 *
 *   MAIS_RETORNO_TOKEN=... node <tsx> artifacts/api-server/harness/mais-retorno-probe.mts
 *
 * NÃO imprime o token, e trunca os valores — a saída pode ser colada com segurança.
 */
const BASE = "https://data.maisretorno.com/mr-data/v4/api";
const TOKEN = process.env.MAIS_RETORNO_TOKEN;

if (!TOKEN) {
  console.error("MAIS_RETORNO_TOKEN não está no ambiente. Nada a sondar.");
  process.exit(1);
}

const AUTHS: { name: string; headers: Record<string, string> }[] = [
  { name: "Authorization: Bearer", headers: { Authorization: `Bearer ${TOKEN}` } },
  { name: "x-api-key", headers: { "x-api-key": TOKEN } },
  { name: "api-key", headers: { "api-key": TOKEN } },
  { name: "Authorization (cru)", headers: { Authorization: TOKEN } },
];

async function probe(path: string, headers: Record<string, string>) {
  try {
    const r = await fetch(`${BASE}${path}`, { headers });
    const text = await r.text();
    return { status: r.status, text };
  } catch (err) {
    return { status: 0, text: String(err) };
  }
}

// ── 1. qual autenticação funciona ───────────────────────────────────────────────
console.log("=== descobrindo a forma de autenticação ===");
let working: Record<string, string> | null = null;
for (const a of AUTHS) {
  const { status } = await probe("/search/IFIX", a.headers);
  console.log(`  ${a.name.padEnd(22)} -> HTTP ${status}`);
  if (status >= 200 && status < 300 && working == null) working = a.headers;
}
if (!working) {
  console.error("\nNenhuma forma de autenticação funcionou. Confira se o token está correto e ativo.");
  process.exit(1);
}
console.log("\nautenticação OK.\n");

// ── 2. forma da resposta de cada endpoint que nos interessa ─────────────────────
const hoje = new Date().toISOString().slice(0, 10);
const umAnoAtras = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);

const ALVOS = [
  { rotulo: "IFIX (histórico — hoje temos ZERO)", path: `/quotes/IFIX?start_date=${umAnoAtras}&end_date=${hoje}` },
  { rotulo: "CDI (reserva para quando o BCB cai)", path: `/quotes/CDI?start_date=${umAnoAtras}&end_date=${hoje}` },
  { rotulo: "IBOV (controle — já temos via brapi)", path: `/quotes/IBOV?start_date=${umAnoAtras}&end_date=${hoje}` },
  { rotulo: "MXRF11 info (FII da carteira)", path: `/asset-info/MXRF11` },
];

for (const alvo of ALVOS) {
  console.log(`=== ${alvo.rotulo} ===`);
  const { status, text } = await probe(alvo.path, working);
  console.log(`  HTTP ${status}`);
  if (status < 200 || status >= 300) {
    console.log(`  corpo: ${text.slice(0, 200)}\n`);
    continue;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    console.log(`  resposta não é JSON: ${text.slice(0, 160)}\n`);
    continue;
  }

  const topo = Array.isArray(body) ? "(array na raiz)" : Object.keys(body as object).join(", ");
  console.log(`  chaves do topo: ${topo}`);

  const arr = Array.isArray(body)
    ? body
    : (["data", "quotes", "results", "values", "items", "series"]
        .map((k) => (body as Record<string, unknown>)[k])
        .find(Array.isArray) as unknown[] | undefined);

  if (!arr) {
    console.log(`  amostra: ${JSON.stringify(body).slice(0, 300)}\n`);
    continue;
  }

  console.log(`  pontos: ${arr.length}`);
  if (arr.length > 0) {
    console.log(`  chaves de um item: ${Object.keys(arr[0] as object).join(", ")}`);
    console.log(`  primeiro: ${JSON.stringify(arr[0])}`);
    console.log(`  último:   ${JSON.stringify(arr[arr.length - 1])}`);
    // Ordem e cobertura importam: o comparativo encadeia fechamentos de fim de mês.
    const datas = (arr as Record<string, unknown>[])
      .map((i) => ["date", "data", "dt", "reference_date", "referenceDate", "quote_date"].map((k) => i[k]).find((v) => typeof v === "string"))
      .filter((d): d is string => typeof d === "string")
      .map((d) => d.slice(0, 10));
    if (datas.length > 1) {
      const crescente = datas.every((d, i) => i === 0 || datas[i - 1] <= d);
      console.log(`  ordem: ${crescente ? "crescente" : "NÃO crescente"} | de ${datas[0]} a ${datas[datas.length - 1]}`);
      const meses = new Set(datas.map((d) => d.slice(0, 7)));
      console.log(`  meses distintos: ${meses.size}`);
    }
  }
  console.log();
}

console.log("Créditos consumidos: ~3 (as buscas de /search são gratuitas; cada /quotes custa 1).");
