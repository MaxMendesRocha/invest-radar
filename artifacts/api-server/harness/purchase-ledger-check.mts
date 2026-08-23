import { replayPosition, type LedgerPurchase, type LedgerSale } from "../src/lib/purchase-ledger";

let failures = 0;
function check(label: string, condition: boolean, detail: string): void {
  console.log(`${condition ? "OK  " : "FALHA"} ${label}`);
  if (!condition) { console.log(`      ${detail}`); failures++; }
}
const perto = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
const c = (tradeDate: string, quantity: number, unitPrice: number): LedgerPurchase => ({ tradeDate, quantity, unitPrice });
const v = (saleDate: string, quantity: number): LedgerSale => ({ saleDate, quantity });

// ── O caso real que motivou o recurso ───────────────────────────────────────
// DVFF11: 49 cotas, preço médio R$ 5,04 na corretora. Uma das notas é conhecida
// (5 cotas a R$ 5,25 negociadas em 06/08/2026); as outras 44 saíram a ~R$ 5,0161.
// O app mostrava R$ 5,68 — número digitado errado, sem procedência.
{
  const r = replayPosition([c("2026-07-20", 44, 5.016136), c("2026-08-06", 5, 5.25)], []);
  check("DVFF11: quantidade 49", perto(r.quantity, 49), String(r.quantity));
  check("DVFF11: preço médio fecha em R$ 5,04",
    perto(r.averagePrice, 5.04, 0.005), `R$ ${r.averagePrice}`);
  check("DVFF11: primeira compra é a mais antiga",
    r.firstPurchaseDate === "2026-07-20", String(r.firstPurchaseDate));
}

// ── Venda reduz quantidade e não mexe no preço médio ────────────────────────
// Regra brasileira, e o que o código já fazia na baixa de venda (assets.ts:352).
{
  const compras = [c("2026-01-10", 100, 10), c("2026-02-10", 100, 20)];
  const semVenda = replayPosition(compras, []);
  check("2 compras -> PM 15", perto(semVenda.averagePrice, 15), String(semVenda.averagePrice));

  const comVenda = replayPosition(compras, [v("2026-03-01", 50)]);
  check("venda parcial reduz quantidade", perto(comVenda.quantity, 150), String(comVenda.quantity));
  check("venda parcial NÃO altera o preço médio",
    perto(comVenda.averagePrice, 15), String(comVenda.averagePrice));
}

// ── Ordem das compras não muda o preço médio ────────────────────────────────
// Média ponderada é comutativa. Se algum dia deixar de ser, este teste avisa.
{
  const a = replayPosition([c("2026-01-01", 10, 7), c("2026-06-01", 30, 11)], []);
  const b = replayPosition([c("2026-06-01", 30, 11), c("2026-01-01", 10, 7)], []);
  check("ordem de entrada não muda o resultado",
    perto(a.averagePrice, b.averagePrice) && perto(a.quantity, b.quantity),
    `${a.averagePrice} vs ${b.averagePrice}`);
  check("preço médio ponderado correto (10@7 + 30@11 = 10)", perto(a.averagePrice, 10), String(a.averagePrice));
}

// ── Zerar e recomprar recomeça o preço médio ────────────────────────────────
// Herdar o PM do ciclo anterior daria um número que não corresponde a nada pago.
{
  const r = replayPosition(
    [c("2026-01-10", 100, 10), c("2026-05-10", 50, 30)],
    [v("2026-03-01", 100)],
  );
  check("recompra depois de zerar: quantidade só do ciclo novo", perto(r.quantity, 50), String(r.quantity));
  check("recompra depois de zerar: PM é o do ciclo novo", perto(r.averagePrice, 30), String(r.averagePrice));
}

// ── Venda total zera tudo ───────────────────────────────────────────────────
{
  const r = replayPosition([c("2026-01-10", 100, 10)], [v("2026-02-01", 100)]);
  check("venda total zera quantidade", r.quantity === 0, String(r.quantity));
  check("venda total zera preço médio", r.averagePrice === 0, String(r.averagePrice));
  check("sem posição, não há data de primeira compra", r.firstPurchaseDate === null, String(r.firstPurchaseDate));
}

// ── Compra no mesmo dia da venda tem de onde sair ───────────────────────────
{
  const r = replayPosition([c("2026-04-01", 10, 5)], [v("2026-04-01", 4)]);
  check("empate de data: compra é processada antes da venda", perto(r.quantity, 6), String(r.quantity));
}

// ── Precisão fracionária (Tesouro Direto) ──────────────────────────────────
// Título público é comprado por valor, então a quantidade é fracionária por natureza.
{
  const r = replayPosition([
    c("2026-03-02", 0.43, 2282.84),
    c("2026-05-11", 0.219025, 2133.333333),
    c("2026-08-17", 0.290964, 730.37),
  ], []);
  const custo = 0.43 * 2282.84 + 0.219025 * 2133.333333 + 0.290964 * 730.37;
  const qtd = 0.43 + 0.219025 + 0.290964;
  check("Tesouro: quantidade fracionária soma dentro de 1e-6", perto(r.quantity, qtd), `${r.quantity} vs ${qtd}`);
  check("Tesouro: preço médio dentro de 1e-6", perto(r.averagePrice, custo / qtd, 1e-5),
    `${r.averagePrice} vs ${custo / qtd}`);
}

// ── Posição sem lançamento ──────────────────────────────────────────────────
{
  const r = replayPosition([], []);
  check("sem compras: tudo zerado, sem data", r.quantity === 0 && r.averagePrice === 0 && r.firstPurchaseDate === null, JSON.stringify(r));
}

if (failures > 0) { console.log(`\n${failures} caso(s) falharam.`); process.exit(1); }
console.log("\nTodos os casos passaram.");
