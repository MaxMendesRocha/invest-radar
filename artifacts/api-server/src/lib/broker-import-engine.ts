import { kindFromTicker } from "./b3-ticker";
import type { BrokerNote, BrokerTrade, CustodyPosition, CustodyStatement } from "./broker-note-parser";

/**
 * Conciliação entre a nota de corretagem e o extrato de custódia.
 *
 * A nota tem data, quantidade e preço mas não tem ticker; o extrato tem ticker mas não
 * tem preço nem data. Este módulo cruza os dois e produz o que a tela de conferência
 * mostra — **sem gravar nada**. A gravação é um segundo passo, depois de alguém olhar.
 *
 * ## Escolher dentro de uma lista fechada não é o mesmo que adivinhar
 *
 * O parser se recusa a inferir ticker a partir do nome, e por bom motivo: "FII DEVA FOF"
 * parece DEVA11 e é DVFF11. Aqui a operação é outra. O extrato entrega **a lista dos
 * papéis que a pessoa de fato tem** — cinco, no caso real —, e o nome só serve para
 * escolher dentro dela. A semelhança nunca cria um código de negociação; no máximo aponta
 * para um que o documento já trouxe. Por isso "DEVA" casar com "Devant" é correto aqui e
 * seria errado lá.
 *
 * ## O nome separa; o preço confere
 *
 * Medido nos documentos reais, o nome resolve sozinho os cinco casos — inclusive o único
 * que **não** devia casar:
 *
 * | Especificação | Candidatas por nome | Candidatas por preço (1ª e 2ª) |
 * |---|---|---|
 * | TAESA | TAEE3 | TAEE3 1,1% · MXRF11 29,8% |
 * | KLABIN S/A | KLBN3 | KLBN3 1,6% · DVFF11 32,0% |
 * | FII DEVA FOF | DVFF11 | DVFF11 0,6% · KLBN3 31,0% |
 * | FII GUARDIAN | GARE11 | GARE11 1,0% · **MXRF11 12,2%** |
 * | MAGAZ LUIZA | *nenhuma* | DVFF11 **2,0%** |
 *
 * As duas células em negrito são a razão de o preço não poder ser o critério principal.
 * MXRF11 a 9,23 fica a 12% do GUARDIAN a 8,17 — dentro de qualquer tolerância que precise
 * absorver a variação entre o pregão e a foto da custódia; FII em faixa de R$ 8 a 10 é
 * lugar-comum, e preço não distingue dois deles. E MAGAZ LUIZA, vendida a 5,05, some da
 * custódia mas fica a 2% do DVFF11 a 5,15 — preço sozinho casaria com o papel errado.
 *
 * O preço entra depois, como **conferência**: nas quatro que casaram a distância foi de
 * 0,6% a 1,6%, então exigir folga de 25% não escolhe nada — só barra disparate, que é o
 * que se quer de uma conferência.
 *
 * ## O preço só vale enquanto é do mesmo instante
 *
 * A foto da custódia é de um dia; a nota é de outro. Quanto mais velha a nota, menos a
 * distância de preço significa — em papel volátil, meses de diferença passam de 25% sem
 * nada de errado. Por isso a conferência só roda quando a nota está a menos de
 * {@link DIAS_PRECO_CONFIAVEL} dias da foto; fora disso ela é omitida em vez de reprovar,
 * porque reprovar por dado que não fala seria transformar silêncio em evidência.
 *
 * ## Empate é pergunta, não desempate
 *
 * `casado`, `ambiguo` e `sem_correspondencia`. As duas últimas vão para a tela pedindo
 * decisão humana, nunca para o banco. Todo afrouxamento de regra aqui erra para o lado de
 * perguntar: se o nome da nota não se parecer com o do extrato (uma "M.DIASBRANCO" contra
 * uma "M. Dias Branco" escrita de outro jeito), o resultado é uma pergunta na tela — não
 * um lançamento errado.
 *
 * A disputa também é resolvida sem depender de ordem: se duas especificações apontarem
 * para a mesma posição em custódia, **as duas** ficam ambíguas. A alternativa — a primeira
 * a ser processada leva — faria o resultado depender da ordem do `Map`, e daria uma
 * resposta confiante a um caso que ninguém conferiu.
 */

/** Quantidade líquida (compras menos vendas) de uma especificação nas notas. */
function netQuantityBySpec(notes: BrokerNote[]): Map<string, number> {
  const net = new Map<string, number>();
  for (const note of notes) {
    for (const t of note.trades) {
      const sign = t.side === "compra" ? 1 : -1;
      net.set(t.specification, (net.get(t.specification) ?? 0) + sign * t.quantity);
    }
  }
  return net;
}

/**
 * A raiz do nome, para agrupar especificações que são o MESMO papel.
 *
 * "FII DEVA FOF CI" e "FII DEVA FOF CI ER" são o mesmo fundo — o "ER" é anotação do
 * pregão, como "EDJ" (ex-dividendo/juros) em "TAESA ON EDJ N2". Sem agrupar, a mesma
 * posição apareceria duas vezes e nenhuma das duas fecharia com a custódia.
 *
 * O que sai são anotações de evento e de nível de governança: ER, EDJ, EJ, ED, EB, NM,
 * N1, N2, MA, MB, DIREITO. Nenhuma delas muda qual papel é.
 *
 * **A classe fica.** ON, PN, PNA..PNF, UNT e CI parecem ruído do mesmo tipo e não são:
 * "PETROBRAS ON" é PETR3 e "PETROBRAS PN" é PETR4, dois ativos com preço, liquidez e
 * direito de voto diferentes. Limpar a classe fundiria os dois numa posição só — e aí
 * nem existiria como dizer que metade é de um ticker e metade do outro. Como toda classe
 * tem no máximo três letras, ela é curta demais para virar palavra identificadora e não
 * atrapalha o casamento por nome.
 */
const ANOTACOES = /\b(ER|EDJ|EJ|ED|EB|NM|N1|N2|MA|MB|DIREITO)\b/g;

export function specificationRoot(spec: string): string {
  return spec.toUpperCase().replace(ANOTACOES, " ").replace(/\s+/g, " ").trim();
}

/**
 * Texto comparável: sem acento, sem pontuação, sem espaço, em maiúscula.
 *
 * A compactação é o que faz "M.DIASBRANCO" da nota alcançar "M. Dias Branco" do extrato —
 * os dois viram "MDIASBRANCO". Comparar palavra a palavra falharia aí, e falharia num
 * caso em que os dois documentos concordam.
 */
function flatten(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Palavras da especificação com força para identificar o papel.
 *
 * O corte em 4 caracteres não é arbitrário: é exatamente o que descarta os marcadores de
 * classe e de forma jurídica que sobrevivem à limpeza da raiz — FII, S/A, SA, FDO, ETF —,
 * e que casariam com metade do extrato sem dizer nada. "DEVA" tem 4 e fica; era o menor
 * nome real nos documentos medidos.
 */
const TAMANHO_MINIMO_TOKEN = 4;

function identifyingTokens(root: string): string[] {
  return root.split(/\s+/).map(flatten).filter((t) => t.length >= TAMANHO_MINIMO_TOKEN);
}

/** Folga de preço da conferência. Larga de propósito: barra disparate, não escolhe. */
const TETO_PRECO = Math.log(1.25);

/** Além disso a distância de preço é variação de mercado, não evidência de identidade. */
const DIAS_PRECO_CONFIAVEL = 30;

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Number.isFinite(ms) ? ms / 86_400_000 : Number.POSITIVE_INFINITY;
}

export type MatchStatus = "casado" | "ambiguo" | "sem_correspondencia";

export interface ImportedPosition {
  /** Raiz da especificação, como aparece nas notas. */
  specificationRoot: string;
  /** Especificações originais que caíram nesta raiz — vão para a tela como evidência. */
  specifications: string[];
  /** Ticker resolvido pelo cruzamento, ou null quando não determinado. */
  ticker: string | null;
  /** Categoria derivada do TICKER pela convenção da B3, nunca do rótulo do PDF. */
  category: string | null;
  status: MatchStatus;
  /** Quantidade líquida vinda das notas (compras menos vendas). */
  netQuantity: number;
  /** Quantidade em custódia, quando há posição casada. */
  custodyQuantity: number | null;
  /**
   * Diferença entre a custódia e o líquido das notas. Positiva significa que a posição
   * já existia antes da janela das notas — é informação, não erro.
   */
  quantityBefore: number | null;
  /**
   * Por que o status é esse, em uma frase, para a tela repetir sem reinterpretar.
   *
   * Existe porque "ambíguo" sozinho não dá a quem confere nada com que decidir: saber que
   * a dúvida é entre DVFF11 e MXRF11 é o que transforma a pergunta em um clique.
   */
  reason: string;
  /** Tickers em custódia que o nome não descartou — a lista que a tela oferece. */
  candidates: string[];
  trades: BrokerTrade[];
}

export interface ImportPreview {
  positions: ImportedPosition[];
  /** Posições em custódia que nenhuma nota explica — provavelmente compradas antes. */
  custodyOnly: { ticker: string; quantity: number; description: string }[];
  custodyDate: string | null;
  noteNumbers: string[];
  totalCosts: number;
}

/** Categoria do app a partir do ticker. Null quando a convenção não decide. */
function categoryFor(ticker: string): string | null {
  switch (kindFromTicker(ticker)) {
    case "acao": return "acoes";
    case "bdr": return "bdrs";
    // O sufixo 11 é ambíguo entre FII, ETF e unit — a convenção não resolve, e o app não
    // inventa. A tela pergunta. Ver b3-ticker.ts.
    case "fii_etf_ou_unit": return null;
    default: return null;
  }
}

/**
 * Posições em custódia que podem ser esta especificação — em ordem de proximidade de preço.
 *
 * Três filtros, e cada um só sabe REPROVAR:
 *
 * 1. **Nome.** Alguma palavra identificadora da especificação tem de aparecer na descrição
 *    da custódia. É o que separa dois FIIs de preço parecido, e o que faz uma venda total
 *    não casar com o papel alheio que calhou de custar o mesmo.
 * 2. **Quantidade.** Com líquido comprador, a custódia não pode ter menos do que se
 *    comprou na janela — quem comprou 49 não aparece com 5. Em líquido vendedor o filtro
 *    não se aplica: a posição pode ter ido a zero e sumido do extrato, e isso é o esperado.
 * 3. **Preço.** Conferência larga, e só quando a nota é recente o bastante para o preço
 *    ainda significar identidade em vez de variação de mercado.
 */
function candidatesFor(
  root: string,
  net: number,
  trades: BrokerTrade[],
  custody: CustodyStatement,
): CustodyPosition[] {
  const tokens = identifyingTokens(root);
  if (tokens.length === 0) return [];

  // A operação mais recente é a referência de preço: é a mais perto da foto da custódia.
  const recente = trades.reduce<BrokerTrade | null>(
    (a, t) => (a == null || t.tradeDate > a.tradeDate ? t : a),
    null,
  );
  const compara =
    recente != null &&
    custody.referenceDate != null &&
    daysBetween(recente.tradeDate, custody.referenceDate) <= DIAS_PRECO_CONFIAVEL;

  return custody.positions
    .filter((p) => {
      const descricao = flatten(p.description);
      if (!tokens.some((t) => descricao.includes(t))) return false;
      if (net > 0 && p.quantity < net) return false;
      if (compara && recente) {
        const unitario = p.grossValue / p.quantity;
        if (!(unitario > 0)) return false;
        if (Math.abs(Math.log(unitario / recente.price)) > TETO_PRECO) return false;
      }
      return true;
    })
    .sort((a, b) => priceDistance(a, recente) - priceDistance(b, recente));
}

function priceDistance(p: CustodyPosition, trade: BrokerTrade | null): number {
  if (!trade || !(p.quantity > 0) || !(p.grossValue > 0)) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.log(p.grossValue / p.quantity / trade.price));
}

/** A frase que a tela repete. Nunca "erro": as três situações são legítimas. */
function reasonFor(
  status: MatchStatus,
  net: number,
  candidatas: CustodyPosition[],
  contestada: boolean,
): string {
  if (status === "casado") return `Nome e preço batem com ${candidatas[0].ticker}, e só com ele.`;
  if (status === "ambiguo") {
    const lista = candidatas.map((p) => p.ticker).join(", ");
    return contestada
      ? `Outra especificação da nota aponta para ${lista} também — só quem leu o papel resolve.`
      : `Mais de uma posição em custódia serve: ${lista}.`;
  }
  if (net <= 0) return "Saída total: nada em custódia, o que é o esperado depois de vender tudo.";
  return "Nenhuma posição em custódia corresponde — o papel pode ter sido vendido depois da foto.";
}

/**
 * O que a importação entendeu, para conferência.
 *
 * Determinística e sem efeito colateral: não toca no banco, não busca cotação, não decide
 * nada que não esteja nos dois papéis.
 */
export function buildImportPreview(notes: BrokerNote[], custody: CustodyStatement): ImportPreview {
  const net = netQuantityBySpec(notes);

  // Agrupa por raiz: "FII DEVA FOF CI" e "FII DEVA FOF CI ER" são o mesmo papel.
  const byRoot = new Map<string, { specs: Set<string>; net: number; trades: BrokerTrade[] }>();
  for (const [spec, quantity] of net) {
    const root = specificationRoot(spec);
    const entry = byRoot.get(root) ?? { specs: new Set<string>(), net: 0, trades: [] };
    entry.specs.add(spec);
    entry.net += quantity;
    byRoot.set(root, entry);
  }
  for (const note of notes) {
    for (const t of note.trades) byRoot.get(specificationRoot(t.specification))?.trades.push(t);
  }

  // Primeiro as candidatas de cada raiz, e SÓ DEPOIS a decisão. Separar os dois passos é
  // o que permite ver disputa entre raízes antes de casar qualquer uma — decidir em uma
  // passada só faria a primeira do laço levar a posição e a segunda parecer órfã.
  const candidatasPorRaiz = new Map<string, CustodyPosition[]>();
  for (const [root, entry] of byRoot) {
    candidatasPorRaiz.set(root, candidatesFor(root, entry.net, entry.trades, custody));
  }

  // Quantas raízes têm ESTA posição como única candidata. Duas é disputa: ninguém casa.
  const disputa = new Map<string, number>();
  for (const candidatas of candidatasPorRaiz.values()) {
    if (candidatas.length === 1) disputa.set(candidatas[0].ticker, (disputa.get(candidatas[0].ticker) ?? 0) + 1);
  }

  const usadas = new Set<string>();
  const positions: ImportedPosition[] = [];

  for (const [root, entry] of byRoot) {
    const candidatas = candidatasPorRaiz.get(root) ?? [];
    const unica = candidatas.length === 1 ? candidatas[0] : null;
    const contestada = unica != null && (disputa.get(unica.ticker) ?? 0) > 1;

    const escolhida = unica && !contestada ? unica : null;
    const status: MatchStatus = escolhida
      ? "casado"
      : candidatas.length === 0
        ? "sem_correspondencia"
        : "ambiguo";
    if (escolhida) usadas.add(escolhida.ticker);

    positions.push({
      specificationRoot: root,
      specifications: Array.from(entry.specs),
      ticker: escolhida?.ticker ?? null,
      category: escolhida ? categoryFor(escolhida.ticker) : null,
      status,
      netQuantity: entry.net,
      custodyQuantity: escolhida?.quantity ?? null,
      quantityBefore: escolhida ? escolhida.quantity - entry.net : null,
      reason: reasonFor(status, entry.net, candidatas, contestada),
      candidates: candidatas.map((p) => p.ticker),
      trades: entry.trades,
    });
  }

  return {
    positions,
    custodyOnly: custody.positions
      .filter((p) => !usadas.has(p.ticker))
      .map((p) => ({ ticker: p.ticker, quantity: p.quantity, description: p.description })),
    custodyDate: custody.referenceDate,
    noteNumbers: notes.map((n) => n.noteNumber),
    totalCosts: Math.round(notes.reduce((s, n) => s + n.costs, 0) * 100) / 100,
  };
}
