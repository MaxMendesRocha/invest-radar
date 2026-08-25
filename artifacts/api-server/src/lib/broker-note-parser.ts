/**
 * Leitura de nota de corretagem e de extrato de custódia em PDF.
 *
 * Existe porque digitar lançamento a lançamento é onde o histórico da carteira morre: são
 * cinco campos por operação, e quem tem aporte mensal desiste. A nota de corretagem já
 * traz tudo — data, quantidade, preço e custos —, e é o documento que a corretora emite
 * justamente para ser o registro fiel da operação.
 *
 * ## Dois documentos, dois papéis, e um completa o outro
 *
 * **A nota** tem data, quantidade, preço e custos, mas **não tem o ticker**: ela
 * identifica o papel pela especificação do título ("FII DEVA FOF CI", "TAESA ON EDJ N2").
 *
 * **O extrato de custódia** tem o ticker e a quantidade em carteira, mas **não tem preço
 * de compra nem data**: é uma foto do saldo, não um histórico.
 *
 * Sozinha, nenhuma das duas basta. Juntas se resolvem: o extrato dá o mapa que falta à
 * nota, e a soma dos lançamentos tem de fechar com a quantidade em custódia — o que
 * transforma a conferência num cálculo em vez de uma leitura no olho. Ver
 * `broker-import-engine.ts`.
 *
 * ## Por que adivinhar o ticker seria inaceitável
 *
 * Medido no caso real que originou este módulo: "FII DEVA FOF CI" **não é DEVA11**, é
 * **DVFF11** — "Deva" é o nome da gestora (Devant), não o código de negociação. Gravar
 * por semelhança de nome teria posto 49 cotas num fundo que a pessoa não tem, com preço
 * médio, patrimônio e análise saindo do ativo errado.
 *
 * Por isso este módulo **nunca infere ticker**. Ele devolve a especificação como está no
 * papel, e quem resolve é o cruzamento com o extrato ou a confirmação de quem leu.
 */

/** Uma operação de compra ou venda, como a nota registra. */
export interface BrokerTrade {
  /** Número da nota — é a chave de idempotência: reimportar o mesmo PDF não duplica. */
  noteNumber: string;
  /** Data do pregão, ISO. Não é a data de liquidação. */
  tradeDate: string;
  side: "compra" | "venda";
  /** "VISTA", "FRACIONARIO"... — o fracionário é o MESMO papel, só o lote muda. */
  market: string;
  /** Especificação do título como está no papel. Nunca um ticker inferido. */
  specification: string;
  quantity: number;
  price: number;
  /** Quantidade × preço, como a nota informa — conferido contra o produto. */
  total: number;
}

/** Custos rateados da nota inteira. Ficam por nota, não por operação. */
export interface BrokerNote {
  noteNumber: string;
  tradeDate: string;
  trades: BrokerTrade[];
  /** Soma de taxas, emolumentos e corretagem. Zero é comum em corretora sem taxa. */
  costs: number;
}

/** Uma posição do extrato de custódia — aqui o ticker existe. */
export interface CustodyPosition {
  ticker: string;
  /**
   * O texto inteiro que precede o ticker ("Fundo Imobiliário (FII) Devant").
   *
   * NÃO é separado em classe e nome de propósito. O extrato classifica em português
   * ("Ação brasileira", "Fundo Imobiliário (FII)"), e o app já tem régua própria para
   * isso em `kindFromTicker`, derivada da convenção de sufixo da B3. Ler a classe daqui
   * criaria uma segunda fonte que pode discordar da primeira — e discordar em silêncio,
   * porque as duas parecem igualmente autoritativas.
   */
  description: string;
  quantity: number;
  grossValue: number;
}

export interface CustodyStatement {
  /** Data da posição, ISO — o extrato é uma foto, e a data dela importa. */
  referenceDate: string | null;
  positions: CustodyPosition[];
}

/** "1.234,56" -> 1234.56. Devolve null em vez de NaN para o chamador decidir. */
function parseBrl(raw: string): number | null {
  const n = Number(raw.trim().replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** "17/08/2026" -> "2026-08-17". */
function parseBrDate(raw: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/**
 * Linha de negócio da nota.
 *
 * O formato é `{praça} {C|V} {mercado} {especificação} [obs] {qtd} {preço} {valor} {D|C}`,
 * e a especificação tem número variável de palavras — "FII DEVA FOF CI ER" tem cinco,
 * "KLABIN S/A ON N2" tem quatro.
 *
 * Por isso a leitura é **da direita para a esquerda**: os quatro últimos campos são
 * sempre quantidade, preço, valor e o indicador D/C. Contar posições a partir da esquerda
 * quebraria no primeiro papel com nome mais longo, e quebraria em silêncio — com a última
 * palavra do nome virando quantidade.
 */
const TRADE_LINE = new RegExp(
  "^B3 RV LISTADO\\s+([CV])\\s+(\\S+)\\s+(.+?)\\s+" +
  "(\\d+(?:[.,]\\d+)?)\\s+([\\d.,]+)\\s+([\\d.,]+)\\s+([DC])\\s*$",
);

/** Marcas da coluna "Obs" que grudam no fim da especificação e não fazem parte dela. */
const OBS_FLAGS = /\s+[@#*]+$/;

/**
 * Rubricas de custo da nota. A lista é explícita, e não "tudo que parece taxa", porque
 * somar rubrica desconhecida inflaria o custo em silêncio — e custo entra no preço médio.
 */
const COST_LABELS = [
  "Taxa de liquidação/CCP",
  "Taxa de Registro",
  "Taxa de termo/opções",
  "Taxa A.N.A.",
  "Emolumentos",
  "Taxa de Transferência de Ativos",
  "Clearing",
  "Execução",
  "Execução casa",
  "ISS",
  "Outras",
];

/**
 * Notas de corretagem contidas no texto de um PDF, uma por página.
 *
 * Um PDF pode conter várias notas — o extrato do Nubank exporta o período inteiro num
 * arquivo só. Cada página tem seu número de nota e sua data de pregão.
 */
export function parseBrokerNotes(pages: string[]): BrokerNote[] {
  const notes: BrokerNote[] = [];

  for (const page of pages) {
    const lines = page.split("\n").map((l) => l.trim());

    // O cabeçalho é "Nr. Nota Folha Data pregão" e os valores vêm na linha seguinte.
    const headerIndex = lines.findIndex((l) => l.startsWith("Nr. Nota"));
    if (headerIndex === -1) continue;
    const header = (lines[headerIndex + 1] ?? "").split(/\s+/);
    const noteNumber = header[0] ?? "";
    const tradeDate = parseBrDate(header[2] ?? "");
    if (!noteNumber || !tradeDate) continue;

    const trades: BrokerTrade[] = [];
    for (const line of lines) {
      const m = TRADE_LINE.exec(line);
      if (!m) continue;
      const [, side, market, rawSpec, rawQty, rawPrice, rawTotal] = m;
      const quantity = parseBrl(rawQty);
      const price = parseBrl(rawPrice);
      const total = parseBrl(rawTotal);
      if (quantity == null || price == null || total == null) continue;
      if (!(quantity > 0) || !(price > 0)) continue;

      trades.push({
        noteNumber,
        tradeDate,
        side: side === "C" ? "compra" : "venda",
        market,
        specification: rawSpec.replace(OBS_FLAGS, "").trim(),
        quantity,
        price,
        total,
      });
    }

    if (trades.length === 0) continue;
    notes.push({ noteNumber, tradeDate, trades, costs: sumCosts(lines) });
  }

  return notes;
}

function sumCosts(lines: string[]): number {
  let total = 0;
  for (const label of COST_LABELS) {
    for (const line of lines) {
      if (!line.startsWith(`${label} `)) continue;
      const m = /([\d.]+,\d\d)\s*[DC]?$/.exec(line);
      const value = m ? parseBrl(m[1]) : null;
      if (value) total += value;
    }
  }
  return Math.round(total * 100) / 100;
}

/**
 * Posições do extrato de custódia — a seção "Custódia em Bolsa de Valores".
 *
 * O formato é `{classe} {Nome} ({TICKER}) {qtd} {valor} {disponibilidade}`, e o ticker
 * vem entre parênteses. É a única fonte de ticker nos dois documentos, e por isso o
 * extrato não é acessório: sem ele a nota não vira lançamento.
 *
 * As outras seções (Tesouro Direto, Caixinhas) ficam de fora aqui de propósito — são
 * outra natureza de ativo, com régua própria no app, e misturá-las nesta lista faria a
 * conciliação por quantidade não significar nada.
 */
// O ticker é o grupo entre parênteses que segue a convenção da B3 — o que também exclui
// o "(FII)" que aparece no meio da própria classificação, e é por isso que a expressão
// não pode simplesmente pegar "o que está entre parênteses".
const CUSTODY_LINE = /^(.+?)\s*\(([A-Z][A-Z0-9]{3}\d{1,2})\)\s+([\d.,]+)\s+([\d.,]+)\s/;

export function parseCustodyStatement(pages: string[]): CustodyStatement {
  const positions: CustodyPosition[] = [];
  let referenceDate: string | null = null;

  for (const page of pages) {
    for (const raw of page.split("\n")) {
      const line = raw.trim();

      if (!referenceDate) {
        const d = /Custódia em:\s*(\d{2}\/\d{2}\/\d{4})/.exec(line);
        if (d) referenceDate = parseBrDate(d[1]);
      }

      const m = CUSTODY_LINE.exec(line);
      if (!m) continue;
      const [, description, ticker, rawQty, rawValue] = m;
      const quantity = parseBrl(rawQty);
      const grossValue = parseBrl(rawValue);
      if (quantity == null || grossValue == null || !(quantity > 0)) continue;

      positions.push({ ticker, description: description.trim(), quantity, grossValue });
    }
  }

  return { referenceDate, positions };
}
