import { db, assetsTable, assetPurchasesTable, salesTable, transactionsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { replayPosition } from "../src/lib/purchase-ledger";
import { todayInAppTimezone } from "../src/lib/local-date";

/**
 * Propriedades que a base inteira precisa satisfazer, sempre — independente de qual
 * sequência de operações levou até aqui.
 *
 * Nasceu de três defeitos encontrados no mesmo dia (quantidade negativa, preço zero,
 * data no ano 0001). Nenhum deles era um valor esquisito: −10 é um número perfeitamente
 * válido, e o app aceitou porque ninguém perguntou se ele fazia SENTIDO. Uma trava de
 * entrada só protege a porta em que foi colocada — e a porta esquecida foi justamente a
 * antiga. Uma invariante não tem porta: ela olha o resultado.
 *
 * SOMENTE LEITURA. Nada aqui escreve, e é de propósito — assim dá para apontar este
 * arquivo para a base de produção e perguntar "existe alguma linha impossível hoje?",
 * que é a pergunta que ninguém tinha como fazer.
 *
 *   DATABASE_URL=<producao> node ... harness/invariantes-check.mts
 *
 * Cada violação sai com id e valores, não só com a contagem: uma invariante que diz
 * "3 linhas erradas" sem dizer quais dá trabalho em vez de resposta.
 */

let violations = 0;

function report(nome: string, linhas: unknown[], explicacao: string): void {
  if (linhas.length === 0) {
    console.log(`OK    ${nome}`);
    return;
  }
  violations += linhas.length;
  console.log(`VIOLA ${nome} — ${linhas.length} linha(s)`);
  console.log(`      ${explicacao}`);
  for (const linha of linhas.slice(0, 10)) console.log(`      ${JSON.stringify(linha)}`);
  if (linhas.length > 10) console.log(`      ... e mais ${linhas.length - 10}`);
}

const hoje = todayInAppTimezone();

// --- Posição ---------------------------------------------------------------

report(
  "toda posição tem quantidade positiva",
  await db.select({ id: assetsTable.id, ticker: assetsTable.ticker, quantity: assetsTable.quantity })
    .from(assetsTable).where(sql`${assetsTable.quantity}::numeric <= 0`),
  "Quantidade zero ou negativa produz patrimônio e resultado negativos na carteira inteira.",
);

report(
  "toda posição de bolsa tem preço médio positivo",
  await db.select({ id: assetsTable.id, ticker: assetsTable.ticker, averagePrice: assetsTable.averagePrice })
    .from(assetsTable).where(sql`${assetsTable.averagePrice}::numeric <= 0 and ${assetsTable.isSavingsAccount} = false`),
  "Preço médio zero zera o custo e faz o lucro percentual virar divisão por zero. Poupança é exceção legítima — ali o campo é saldo.",
);

report(
  "nenhuma data de compra fora de 1900..hoje",
  await db.select({ id: assetsTable.id, ticker: assetsTable.ticker, purchaseDate: assetsTable.purchaseDate })
    .from(assetsTable).where(sql`${assetsTable.purchaseDate} is not null and (${assetsTable.purchaseDate} < '1900-01-01' or ${assetsTable.purchaseDate} > ${hoje})`),
  "A data de compra decide direito a provento e ancora a série de rentabilidade.",
);

// --- Lançamentos -----------------------------------------------------------

report(
  "todo lançamento tem quantidade e preço positivos",
  await db.select({ id: assetPurchasesTable.id, assetId: assetPurchasesTable.assetId, quantity: assetPurchasesTable.quantity, unitPrice: assetPurchasesTable.unitPrice })
    .from(assetPurchasesTable).where(sql`${assetPurchasesTable.quantity}::numeric <= 0 or ${assetPurchasesTable.unitPrice}::numeric <= 0`),
  "Lançamento é compra. Quantidade negativa aqui é venda disfarçada, e venda tem tabela própria.",
);

report(
  "nenhuma data de lançamento fora de 1900..hoje",
  await db.select({ id: assetPurchasesTable.id, tradeDate: assetPurchasesTable.tradeDate })
    .from(assetPurchasesTable).where(sql`${assetPurchasesTable.tradeDate} < '1900-01-01' or ${assetPurchasesTable.tradeDate} > ${hoje}`),
  "A ordem dos lançamentos por data é o que o replay usa para calcular o preço médio.",
);

report(
  "todo lançamento aponta para uma posição existente",
  await db.execute(sql`select p.id, p.asset_id from asset_purchases p left join assets a on a.id = p.asset_id where a.id is null`).then((r) => Array.from(r.rows ?? r)),
  "Lançamento órfão não aparece em tela nenhuma e continua contando em consultas agregadas.",
);

report(
  "todo lançamento pertence ao mesmo usuário da posição",
  await db.execute(sql`select p.id, p.user_id as lancamento, a.user_id as posicao from asset_purchases p join assets a on a.id = p.asset_id where p.user_id <> a.user_id`).then((r) => Array.from(r.rows ?? r)),
  "Se divergir, um usuário tem lançamento gravado na carteira de outro.",
);

// --- A invariante central do registro de lançamentos -----------------------
// O cache (assets.quantity/averagePrice) deixou de ser digitado e passou a ser derivado.
// Se ele divergir do replay, a fonte da verdade e o número exibido discordam — e é o
// número exibido que alimenta patrimônio, alocação, IR e todo o resto.

const posicoes = await db.select().from(assetsTable);
const todosLancamentos = await db.select().from(assetPurchasesTable);
const todasVendas = await db.select().from(salesTable);
const divergentes: unknown[] = [];

for (const posicao of posicoes) {
  if (posicao.isSavingsAccount) continue; // poupança não tem lançamento por construção
  const lancamentos = todosLancamentos.filter((l) => l.assetId === posicao.id);
  if (lancamentos.length === 0) continue; // anterior ao backfill — outra invariante cuida

  // Vendas não têm FK para a posição; casam por (usuário, ticker, categoria), igual ao
  // purchase-ledger-sync faz.
  const vendas = todasVendas.filter(
    (v) => v.userId === posicao.userId && v.ticker === posicao.ticker && v.category === posicao.category,
  );
  const esperado = replayPosition(
    lancamentos.map((l) => ({ quantity: parseFloat(l.quantity), unitPrice: parseFloat(l.unitPrice), tradeDate: l.tradeDate })),
    vendas.map((v) => ({ quantity: parseFloat(v.quantity), saleDate: v.saleDate })),
  );
  const qtdCache = parseFloat(posicao.quantity);
  const precoCache = parseFloat(posicao.averagePrice);
  if (Math.abs(qtdCache - esperado.quantity) > 1e-6 || Math.abs(precoCache - esperado.averagePrice) > 1e-6) {
    divergentes.push({
      id: posicao.id, ticker: posicao.ticker,
      cache: { qtd: qtdCache, preco: precoCache },
      replay: { qtd: esperado.quantity, preco: esperado.averagePrice },
    });
  }
}
report(
  "o cache da posição reproduz o replay dos lançamentos",
  divergentes,
  "É a garantia de que o preço médio continua CALCULADO. Divergência aqui significa que alguma escrita mexeu na posição sem passar pelo recálculo.",
);

// --- Vendas e proventos ----------------------------------------------------

report(
  "toda venda tem quantidade e preço positivos",
  await db.select({ id: salesTable.id, ticker: salesTable.ticker, quantity: salesTable.quantity, salePrice: salesTable.salePrice })
    .from(salesTable).where(sql`${salesTable.quantity}::numeric <= 0 or ${salesTable.salePrice}::numeric <= 0`),
  "Venda com preço zero entra na consolidação mensal de IR como prejuízo integral.",
);

report(
  "nenhuma data de venda fora de 1900..hoje",
  await db.select({ id: salesTable.id, saleDate: salesTable.saleDate })
    .from(salesTable).where(sql`${salesTable.saleDate} < '1900-01-01' or ${salesTable.saleDate} > ${hoje}`),
  "Venda no futuro joga imposto para um mês que ainda não fechou.",
);

report(
  "nenhum provento com data no futuro",
  await db.select({ id: transactionsTable.id, ticker: transactionsTable.ticker, date: transactionsTable.date })
    .from(transactionsTable).where(sql`${transactionsTable.date} > ${hoje}`),
  "Provento futuro entra no acumulado de 12 meses e infla o yield da carteira.",
);

console.log(
  violations === 0
    ? `\nNenhuma violação. ${posicoes.length} posição(ões), ${todosLancamentos.length} lançamento(s), ${todasVendas.length} venda(s) conferidos.`
    : `\n${violations} violação(ões) de invariante.`,
);
process.exit(violations === 0 ? 0 : 1);
