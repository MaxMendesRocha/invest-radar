import { parseBrokerNotes, parseCustodyStatement } from "../src/lib/broker-note-parser";
import { buildImportPreview, specificationRoot } from "../src/lib/broker-import-engine";

/**
 * Leitura de nota de corretagem e conciliação com o extrato de custódia.
 *
 * Os textos abaixo reproduzem o layout dos PDFs reais que originaram o módulo — as linhas
 * de negócio, os rótulos de custo e a tabela de custódia estão como a corretora emite. O
 * que foi trocado é só o que identifica pessoa: nome, CPF, endereço, e-mail e conta. Os
 * valores de investimento são os medidos, porque são eles que provam o casamento.
 *
 * O caso que este harness existe para travar é o oposto do óbvio. Não é "casou certo" —
 * é **não casar quando não dá**: MAGAZ LUIZA foi vendida e sumiu da custódia, e está a 2%
 * de preço do DVFF11. Uma conciliação por preço a lançaria como cotas de um fundo que a
 * pessoa não tem.
 */

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FALHA"} ${label}\n      obtido   ${a}\n      esperado ${e}`);
}

// --- Fixtures --------------------------------------------------------------

/**
 * Uma página de nota, no layout real. As linhas de custo entram todas, inclusive as
 * zeradas: é assim que o PDF vem, e somar só as diferentes de zero seria testar um
 * documento mais fácil que o verdadeiro.
 */
function notePage(
  noteNumber: string,
  tradeDate: string,
  tradeLines: string[],
  custos: Record<string, string> = {},
): string {
  const custo = (label: string) => `${label} ${custos[label] ?? "0,00"} D`;
  return [
    "NOTA DE CORRETAGEM",
    "Nr. Nota Folha Data pregão",
    `${noteNumber} 1 ${tradeDate}`,
    "NU INVESTIMENTOS S.A - CTVM",
    "Cliente",
    "1234567 - 8 FULANO DE TAL",
    "C.P.F./C.N.P.J./C.V.M./C.O.B.",
    "000.000.000-00",
    "Negocios realizados",
    "Q Negociação C/V Tipo mercado Prazo Especificação do título Obs. (*) Quantidade Preço / Ajuste Valor Operação / Ajuste D/C",
    ...tradeLines,
    "Resumo dos Negócios Resumo Financeiro D/C",
    "Clearing",
    custo("Taxa de liquidação/CCP"),
    custo("Taxa de Registro"),
    "Bolsa",
    custo("Taxa de termo/opções"),
    custo("Taxa A.N.A."),
    custo("Emolumentos"),
    "Depositária",
    custo("Taxa de Transferência de Ativos"),
    "Corretagem / Despesas",
    custo("Clearing"),
    custo("Execução"),
    custo("Execução casa"),
    "ISS ( SÃO PAULO ) 0,00",
    custo("Outras"),
    "(*) - Observações: A - Posição Futuro T - Liquidação pelo Bruto",
  ].join("\n");
}

const NOTAS = [
  notePage("21967", "03/08/2026", ["B3 RV LISTADO V FRACIONARIO MAGAZ LUIZA ON NM @ 1 5,05 5,05 C"]),
  notePage("15320", "05/08/2026", ["B3 RV LISTADO C VISTA FII GUARDIAN CI ER @ 2 8,17 16,34 D"]),
  notePage("16925", "06/08/2026", [
    "B3 RV LISTADO C FRACIONARIO KLABIN S/A ON N2 @ 1 3,74 3,74 D",
    "B3 RV LISTADO C VISTA FII DEVA FOF CI @ 5 5,25 26,25 D",
  ]),
  notePage(
    "26896",
    "17/08/2026",
    [
      "B3 RV LISTADO C FRACIONARIO TAESA ON EDJ N2 @ 8 12,33 98,64 D",
      "B3 RV LISTADO C VISTA FII DEVA FOF CI ER @ 41 5,01 205,41 D",
    ],
    { "Taxa de liquidação/CCP": "0,06", Emolumentos: "0,01" },
  ),
  notePage("17102", "21/08/2026", [
    "B3 RV LISTADO C FRACIONARIO TAESA ON EDJ N2 @ 1 12,43 12,43 D",
    "B3 RV LISTADO C VISTA FII DEVA FOF CI @ 3 5,18 15,54 D",
  ]),
];

/** A seção "Custódia em Bolsa de Valores", como o extrato a emite. */
function custodyPage(linhas: string[], data = "25/08/2026"): string {
  return [
    `Extrato de Custódia Custódia em: ${data}`,
    "Pessoa física titular",
    "Fulano de Tal",
    "Custódia em Bolsa de Valores",
    "Tipo de Ativo Emissor Quantidade Saldo bruto (R$) Disponível em",
    ...linhas,
    "Total 520,55",
  ].join("\n");
}

const CUSTODIA_REAL = [
  "Fundo Imobiliário (FII) Devant (DVFF11) 50,00 257,50 Até 2 dias úteis",
  "Fundo Imobiliário (FII) Maxi Renda (MXRF11) 10,00 92,30 Até 2 dias úteis",
  "Fundo Imobiliário (FII) Guardian Real Estate (GARE11) 5,00 41,25 Até 2 dias úteis",
  "Ação brasileira Taesa (TAEE3) 10,00 125,70 Até 2 dias úteis",
  "Ação brasileira Klabin (KLBN3) 1,00 3,80 Até 2 dias úteis",
];

// --- O parser da nota ------------------------------------------------------

const notes = parseBrokerNotes(NOTAS);
check("cinco notas lidas", notes.length, 5);
check("oito operações no total", notes.reduce((s, n) => s + n.trades.length, 0), 8);
check("números das notas", notes.map((n) => n.noteNumber), ["21967", "15320", "16925", "26896", "17102"]);
check("data do pregão em ISO", notes[0].tradeDate, "2026-08-03");

// A leitura é da direita para a esquerda porque a especificação tem número variável de
// palavras. "FII DEVA FOF CI ER" tem cinco e "TAESA ON EDJ N2" tem quatro — contar da
// esquerda faria a última palavra do nome virar quantidade, e em silêncio.
const deva41 = notes[3].trades[1];
check("especificação longa não invade a quantidade", deva41.specification, "FII DEVA FOF CI ER");
check("quantidade da especificação longa", deva41.quantity, 41);
check("preço da especificação longa", deva41.price, 5.01);

// A marca "@" da coluna Obs. gruda no fim da especificação e não faz parte do nome.
check("marca de observação removida", notes[0].trades[0].specification, "MAGAZ LUIZA ON NM");
check("venda é lida como venda", notes[0].trades[0].side, "venda");
check("compra é lida como compra", notes[1].trades[0].side, "compra");
check("mercado fracionário preservado", notes[0].trades[0].market, "FRACIONARIO");

// Quantidade × preço tem de fechar com o valor que a própria nota informa. É a única
// conferência interna disponível, e ela pega deslocamento de coluna.
const desencontro = notes.flatMap((n) => n.trades).filter((t) => Math.abs(t.quantity * t.price - t.total) > 0.01);
check("toda operação fecha qtd × preço = total", desencontro.length, 0);

// Custo zero é o normal em corretora sem taxa — e é justamente por isso que o único
// diferente de zero precisa aparecer: um parser que somasse errado devolveria zero em
// tudo e pareceria certo.
check("nota sem custo soma zero", notes[0].costs, 0);
check("nota 26896 soma os dois custos", notes[3].costs, 0.07);

// --- O parser do extrato ---------------------------------------------------

const custody = parseCustodyStatement([custodyPage(CUSTODIA_REAL)]);
check("data da foto", custody.referenceDate, "2026-08-25");
check("cinco posições", custody.positions.map((p) => p.ticker), ["DVFF11", "MXRF11", "GARE11", "TAEE3", "KLBN3"]);
check("quantidade em custódia", custody.positions[0].quantity, 50);
check("valor bruto em custódia", custody.positions[0].grossValue, 257.5);

// O "(FII)" no meio da classificação também está entre parênteses. Pegar "o que está
// entre parênteses" leria FII como ticker de todo fundo do extrato.
check("o (FII) da classificação não vira ticker", custody.positions[0].description, "Fundo Imobiliário (FII) Devant");

// --- A conciliação ---------------------------------------------------------

const preview = buildImportPreview(notes, custody);
const porRaiz = new Map(preview.positions.map((p) => [p.specificationRoot, p]));

check("raízes agrupadas", Array.from(porRaiz.keys()).sort(), [
  "FII DEVA FOF CI", "FII GUARDIAN CI", "KLABIN S/A ON", "MAGAZ LUIZA ON", "TAESA ON",
]);

// "FII DEVA FOF CI" e "FII DEVA FOF CI ER" são o mesmo fundo em pregões diferentes. Sem
// agrupar, a posição apareceria duas vezes e nenhuma fecharia com a custódia.
check("as duas grafias do DEVA viram uma posição", porRaiz.get("FII DEVA FOF CI")!.specifications.length, 2);
check("líquido do DEVA soma os três pregões", porRaiz.get("FII DEVA FOF CI")!.netQuantity, 49);
check("três operações no DEVA", porRaiz.get("FII DEVA FOF CI")!.trades.length, 3);

check("DEVA casa com DVFF11, não com DEVA11", porRaiz.get("FII DEVA FOF CI")!.ticker, "DVFF11");
check("GUARDIAN casa com GARE11", porRaiz.get("FII GUARDIAN CI")!.ticker, "GARE11");
check("KLABIN casa com KLBN3", porRaiz.get("KLABIN S/A ON")!.ticker, "KLBN3");
check("TAESA casa com TAEE3", porRaiz.get("TAESA ON")!.ticker, "TAEE3");

// A sobra é informação, não erro: 50 em custódia contra 49 comprados na janela significa
// que 1 cota já existia antes das notas.
check("sobra do DEVA é a posição anterior", porRaiz.get("FII DEVA FOF CI")!.quantityBefore, 1);
check("KLABIN não tinha posição anterior", porRaiz.get("KLABIN S/A ON")!.quantityBefore, 0);

// A categoria vem do TICKER pela convenção da B3, nunca do rótulo em português do PDF —
// duas fontes para a mesma coisa acabariam discordando em silêncio.
check("TAEE3 é ação pela convenção", porRaiz.get("TAESA ON")!.category, "acoes");
check("o sufixo 11 não decide categoria", porRaiz.get("FII DEVA FOF CI")!.category, null);

// O caso central: vendida, some da custódia, e a 2% de preço do DVFF11.
const magalu = porRaiz.get("MAGAZ LUIZA ON")!;
check("MAGAZ LUIZA não casa com nada", magalu.status, "sem_correspondencia");
check("MAGAZ LUIZA não recebe ticker", magalu.ticker, null);
check("MAGAZ LUIZA não oferece candidata", magalu.candidates, []);
check("líquido vendedor", magalu.netQuantity, -1);
console.log(`      motivo: ${magalu.reason}`);

// O que a nota não explica fica de fora, nomeado. É a posição comprada antes da janela.
check("MXRF11 sobra como posição anterior", preview.custodyOnly.map((p) => p.ticker), ["MXRF11"]);
check("custos somados de todas as notas", preview.totalCosts, 0.07);
check("data da foto vai junto", preview.custodyDate, "2026-08-25");

// --- As fronteiras da regra ------------------------------------------------

/** Reconcilia um cenário sintético contra uma custódia sintética. */
function cenario(tradeLines: string[], custodyLines: string[], data?: string) {
  const n = parseBrokerNotes([notePage("99999", "20/08/2026", tradeLines)]);
  const c = parseCustodyStatement([custodyPage(custodyLines, data)]);
  return buildImportPreview(n, c).positions[0];
}

// Preço sozinho: GUARDIAN a 8,17 tem MXRF11 a 9,23 a 12% de distância — dentro de
// qualquer tolerância que precise absorver a variação entre o pregão e a foto. É o nome
// que separa os dois, e é por isso que o nome não pode ser removido "porque o preço basta".
const soFiis = cenario(
  ["B3 RV LISTADO C VISTA FII GUARDIAN CI @ 2 8,17 16,34 D"],
  ["Fundo Imobiliário (FII) Maxi Renda (MXRF11) 10,00 92,30 Até 2 dias úteis"],
);
check("nome descarta o FII de preço parecido", soFiis.status, "sem_correspondencia");

// Duas especificações apontando para a mesma posição: as duas ficam ambíguas. A
// alternativa — a primeira do laço leva — faria o resultado depender da ordem do Map.
const disputa = buildImportPreview(
  parseBrokerNotes([
    notePage("99999", "20/08/2026", [
      "B3 RV LISTADO C VISTA BANCO INTER ON @ 2 8,00 16,00 D",
      "B3 RV LISTADO C VISTA BANCO INTER PN @ 2 8,10 16,20 D",
    ]),
  ]),
  parseCustodyStatement([custodyPage(["Ação brasileira Banco Inter (INBR3) 10,00 81,00 Até 2 dias úteis"])]),
);
check("disputa deixa as duas ambíguas", disputa.positions.map((p) => p.status), ["ambiguo", "ambiguo"]);
check("nenhuma das duas recebe ticker", disputa.positions.map((p) => p.ticker), [null, null]);
check("mas a tela recebe a candidata", disputa.positions[0].candidates, ["INBR3"]);
console.log(`      motivo: ${disputa.positions[0].reason}`);

// Comprou 60 e a custódia tem 50: não pode ser a mesma posição. O filtro só vale para
// líquido comprador — em venda a posição pode ter ido a zero e sumido, e isso é esperado.
const demais = cenario(
  ["B3 RV LISTADO C VISTA FII DEVA FOF CI @ 60 5,10 306,00 D"],
  ["Fundo Imobiliário (FII) Devant (DVFF11) 50,00 257,50 Até 2 dias úteis"],
);
check("custódia menor que a compra não casa", demais.status, "sem_correspondencia");

// Preço absurdo com nota recente: a conferência reprova mesmo com o nome batendo. É o
// que pega grupamento e desdobramento entre o pregão e a foto.
const precoAbsurdo = cenario(
  ["B3 RV LISTADO C VISTA FII DEVA FOF CI @ 5 1,00 5,00 D"],
  ["Fundo Imobiliário (FII) Devant (DVFF11) 50,00 257,50 Até 2 dias úteis"],
);
check("preço fora da folga reprova", precoAbsurdo.status, "sem_correspondencia");

// A mesma distância de preço, com a foto quatro meses depois: aí a diferença é variação
// de mercado e não diz nada sobre identidade. Reprovar seria tratar silêncio como prova.
const notaAntiga = cenario(
  ["B3 RV LISTADO C VISTA FII DEVA FOF CI @ 5 1,00 5,00 D"],
  ["Fundo Imobiliário (FII) Devant (DVFF11) 50,00 257,50 Até 2 dias úteis"],
  "20/12/2026",
);
check("nota velha: preço não reprova", notaAntiga.status, "casado");

// Grafia diferente entre os dois documentos erra para o lado de perguntar.
check("raiz limpa a anotação de pregão", specificationRoot("TAESA ON EDJ N2"), "TAESA ON");
check("raiz preserva o nome composto", specificationRoot("FII DEVA FOF CI ER"), "FII DEVA FOF CI");
// A classe é o que separa PETR3 de PETR4 — fundir as duas apagaria a diferença.
check("ON e PN não viram a mesma raiz",
  specificationRoot("PETROBRAS ON N2") === specificationRoot("PETROBRAS PN N2"), false);

// A compactação é o que faz a nota alcançar o extrato quando só a pontuação difere.
const pontuacao = cenario(
  ["B3 RV LISTADO C VISTA M.DIASBRANCO ON NM @ 2 30,00 60,00 D"],
  ["Ação brasileira M. Dias Branco (MDIA3) 10,00 300,00 Até 2 dias úteis"],
);
check("pontuação diferente ainda casa", pontuacao.ticker, "MDIA3");

// Sem extrato não há ticker em lugar nenhum — e o resultado é pergunta, não chute.
const semExtrato = buildImportPreview(notes, { referenceDate: null, positions: [] });
check("sem custódia, nada casa", semExtrato.positions.every((p) => p.ticker === null), true);
check("sem custódia, nada sobra", semExtrato.custodyOnly, []);

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
