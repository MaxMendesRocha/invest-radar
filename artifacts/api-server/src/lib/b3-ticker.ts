/**
 * O que o próprio ticker da B3 já diz sobre a natureza do papel.
 *
 * Existe porque o app deixava cadastrar PETR4 na categoria FIIs. A validação de ticker
 * que já havia prova que o papel EXISTE (tem cotação), nunca que ele É daquela classe —
 * e classe errada não é detalhe cosmético: ela decide alíquota de IR, isenção de
 * dividendo, limiar de concentração e em qual fatia da alocação-alvo a posição entra.
 *
 * A fonte aqui é a convenção de sufixo da B3, e não um provedor externo. Duas razões:
 * ela é determinística e não depende de rede, e é ela que a própria bolsa usa para
 * classificar a emissão. O que ela NÃO resolve fica sem resposta de propósito — ver o
 * caso do 11 abaixo.
 */

export type TickerKind =
  /** Ação: ON (3), PN (4) e as classes PNA..PNF (5-8). */
  | "acao"
  /** Sufixo 11: FII, ETF ou UNIT de ação. A convenção não separa os três. */
  | "fii_etf_ou_unit"
  /** BDR: 31-35 e 39, patrocinados e não patrocinados. */
  | "bdr"
  /** Fora do padrão de código de negociação da B3 — nada a afirmar. */
  | "desconhecido";

/**
 * Raiz do código de negociação: 4 caracteres começando por letra. Quase toda raiz é só
 * letra (PETR, BOVA), mas BDR não patrocinado usa dígito no meio (A1MD34, C1OP34).
 */
const ROOT = "[A-Z][A-Z0-9]{3}";

/** O sufixo F marca o mercado fracionário do MESMO papel (PETR4F = PETR4). */
const RULES: { pattern: RegExp; kind: TickerKind }[] = [
  // BDR antes de ação: em AAPL34 o "3" também é um dígito de ação, e só a leitura do
  // sufixo inteiro separa os dois. Invertida a ordem, todo BDR viraria ação.
  { pattern: new RegExp(`^${ROOT}(3[1-5]|39)$`), kind: "bdr" },
  { pattern: new RegExp(`^${ROOT}11B?F?$`), kind: "fii_etf_ou_unit" },
  { pattern: new RegExp(`^${ROOT}[3-8]F?$`), kind: "acao" },
];

export function kindFromTicker(ticker: string): TickerKind {
  const upper = ticker.trim().toUpperCase();
  return RULES.find((rule) => rule.pattern.test(upper))?.kind ?? "desconhecido";
}

/** Classes cujo cadastro espera um código de negociação da B3. */
const QUOTED = new Set(["acoes", "fiis", "etfs", "bdrs"]);

/** O que cada natureza admite. Ausente da lista = a convenção não permite. */
const ALLOWED: Record<Exclude<TickerKind, "desconhecido">, Set<string>> = {
  acao: new Set(["acoes"]),
  bdr: new Set(["bdrs"]),
  // O 11 é genuinamente ambíguo: BOVA11 é ETF, MXRF11 é FII e BPAC11 é unit de ação.
  // Afirmar qualquer coisa aqui seria inventar — as três categorias passam.
  fii_etf_ou_unit: new Set(["fiis", "etfs", "acoes"]),
};

const KIND_LABEL: Record<Exclude<TickerKind, "desconhecido">, string> = {
  acao: "ação",
  bdr: "BDR",
  fii_etf_ou_unit: "FII, ETF ou unit",
};

const CATEGORY_LABEL: Record<string, string> = {
  acoes: "Ações",
  fiis: "FIIs",
  etfs: "ETFs",
  bdrs: "BDRs",
};

/**
 * Explicação do conflito entre o ticker e a categoria escolhida, ou null quando não há
 * conflito — o que inclui **todo caso em que a convenção não decide**. Silêncio aqui
 * significa "a regra não prova que está errado", nunca "está certo".
 *
 * Renda fixa e fundos ficam de fora: ali o identificador não é código de bolsa (CDB do
 * banco X, título público, nome de fundo), e aplicar a regra rejeitaria cadastro válido.
 */
export function categoryConflict(ticker: string, category: string): string | null {
  if (!QUOTED.has(category)) return null;

  const kind = kindFromTicker(ticker);
  if (kind === "desconhecido") return null;
  if (ALLOWED[kind].has(category)) return null;

  const upper = ticker.trim().toUpperCase();
  return `${upper} termina em ${upper.replace(/^[A-Z][A-Z0-9]{3}/, "")}, que na B3 identifica ${KIND_LABEL[kind]} — não ${CATEGORY_LABEL[category] ?? category}.`;
}
