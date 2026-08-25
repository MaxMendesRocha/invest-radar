import { downloadCvmZip, readCvmEntry, CvmDownloadError } from "./cvm-data";
import { logger } from "./logger";

/**
 * Demonstrações padronizadas das companhias abertas — anuais (DFP) e trimestrais (ITR) —
 * do portal de dados abertos da CVM.
 *
 * A CVM publica um ZIP por ano com um CSV por demonstração — DRE, balanço ativo (BPA),
 * balanço passivo (BPP) e fluxo de caixa (DFC) —, no mesmo formato do informe mensal de
 * FII que este app já ingere: latin-1, separado por `;`. O que muda é a forma: em vez de
 * uma coluna por indicador, cada linha é UMA conta do plano padronizado, identificada
 * por `CD_CONTA`.
 *
 * ## Por que o mapeamento é por código e não por rótulo
 *
 * O plano de contas é padronizado, o texto ao lado dele não é. Medido sobre o arquivo de
 * 2024 (467 companhias):
 *
 * - `6.01` (caixa das operações): 3 rótulos distintos, todos sinônimos.
 * - `6.02` (caixa de investimento, total): 1 rótulo.
 * - `6.02.01`, uma subconta: **310 rótulos distintos entre 430 companhias**.
 *
 * Ou seja: as contas de primeiro e segundo nível são comparáveis entre empresas; as
 * subcontas são texto livre que cada companhia ordena como quiser.
 *
 * ## O que isso custa: capex, e portanto FCF
 *
 * Capex vive numa subconta de investimento, e não há código estável para ele — só 179
 * das 430 companhias sequer mencionam "imobilizado" ou "intangível" no rótulo de
 * `6.02.01`. Então **FCF não é derivável desta fonte** pela fórmula usual
 * (FCO − capex): tentar extrair capex por casamento de texto acertaria menos da metade
 * das empresas e erraria em silêncio no resto.
 *
 * O que fica é o caixa das operações (`6.01`), com 100% de cobertura — suficiente para
 * conversão de caixa (FCO ÷ lucro), que é a pergunta que mais importa: o lucro
 * declarado virou dinheiro?
 *
 * ## Escala
 *
 * `VL_CONTA` vem na escala de `ESCALA_MOEDA` (quase sempre MIL). A conversão é feita na
 * ingestão, para o banco guardar reais e ninguém precisar lembrar disso depois.
 *
 * ## O trimestre é publicado duas vezes
 *
 * O ITR traz, para o MESMO `DT_FIM_EXERC`, uma linha com o trimestre isolado e outra com
 * o acumulado do ano. No 2T de 2025 do Banco do Brasil: `2025-04-01 → 2025-06-30`
 * (R$ 78 mi) e `2025-01-01 → 2025-06-30` (R$ 149 mi). Medido no arquivo inteiro, 1.794
 * de 2.706 chaves têm mais de um período.
 *
 * As duas são guardadas: uma é derivável da outra, mas ter as duas permite conferir
 * (Q1 + Q2 tem que fechar com o semestre) e é o que a fonte de fato publica. `periodKind`
 * separa uma da outra na chave única.
 *
 * O 1T não tem acumulado próprio — trimestre e acumulado coincidem, e a CVM publica só
 * uma linha. E o **4T não existe no ITR**: o último trimestre só aparece dentro do DFP
 * anual, e teria de ser derivado (exercício menos o acumulado de 9 meses). Isso fica
 * como limitação declarada, não como buraco silencioso na série.
 */

/** Métricas extraídas, com a cobertura medida no DFP de 2024 (467 companhias). */
export const ACCOUNT_MAP: { metric: string; statement: string; code: string; coverage: string }[] = [
  { metric: "receita", statement: "DRE_con", code: "3.01", coverage: "100%" },
  { metric: "ebit", statement: "DRE_con", code: "3.05", coverage: "100%" },
  { metric: "lucro_liquido", statement: "DRE_con", code: "3.11", coverage: "98,5%" },
  { metric: "ativo_total", statement: "BPA_con", code: "1", coverage: "100%" },
  { metric: "caixa", statement: "BPA_con", code: "1.01.01", coverage: "99,1%" },
  { metric: "divida_curto_prazo", statement: "BPP_con", code: "2.01.04", coverage: "96,6%" },
  { metric: "divida_longo_prazo", statement: "BPP_con", code: "2.02.01", coverage: "98,7%" },
  { metric: "patrimonio_liquido", statement: "BPP_con", code: "2.03", coverage: "100%" },
  // O fluxo de caixa vem em dois arquivos conforme o método da companhia (indireto ou
  // direto). O código da conta é o mesmo nos dois, então basta ler ambos.
  { metric: "caixa_operacional", statement: "DFC_MI_con", code: "6.01", coverage: "95,1%" },
  { metric: "caixa_operacional", statement: "DFC_MD_con", code: "6.01", coverage: "complementa o indireto" },
];

/** Contas de balanço são saldo numa data, não fluxo — não têm período inicial. */
const BALANCE_STATEMENTS = new Set(["BPA_con", "BPP_con"]);

/**
 * Se a métrica é um ESTOQUE (saldo numa data) ou um FLUXO (acúmulo num período).
 *
 * A distinção decide como a série é lida: "ativo total do trimestre" e "ativo total do
 * ano" são a mesma linha do balanço vista em datas diferentes, enquanto "receita do
 * trimestre" e "receita do ano" são números diferentes. Quem pergunta pela série anual de
 * um estoque quer os saldos de 31/12; de um fluxo, quer o exercício inteiro.
 *
 * **Lança** em métrica desconhecida em vez de chutar fluxo: errar aqui devolveria série
 * vazia, e série vazia se parece com "a companhia não publicou" — um erro de digitação
 * viraria uma conclusão sobre a empresa.
 */
export function isBalanceMetric(metric: string): boolean {
  const accounts = ACCOUNT_MAP.filter((a) => a.metric === metric);
  if (accounts.length === 0) throw new Error(`métrica desconhecida: ${metric}`);
  return BALANCE_STATEMENTS.has(accounts[0].statement);
}

/** DFP é o exercício anual; ITR é o informe trimestral. Mesma estrutura, URLs distintas. */
export const DOCUMENT_TYPES = ["DFP", "ITR"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Até quantos meses um período ainda conta como trimestre isolado. */
const QUARTER_MAX_MONTHS = 4;

/**
 * O que o período É — ver o cabeçalho sobre a dupla publicação do ITR.
 *
 * Para o DFP a resposta é `exercicio` independentemente da duração, e não `anual` de
 * propósito: 234 das 25.496 linhas anuais já ingeridas têm menos de 12 meses, porque a
 * companhia mudou a data de fechamento e gerou um exercício curto. Chamar isso de "anual"
 * seria descrever errado o que o documento reporta.
 */
export function periodKindFor(documentType: DocumentType, periodStart: string | null, periodEnd: string): string {
  if (!periodStart) return "saldo";
  if (documentType === "DFP") return "exercicio";
  const meses = (Date.parse(periodEnd) - Date.parse(periodStart)) / (30.44 * 24 * 3600 * 1000);
  return meses <= QUARTER_MAX_MONTHS ? "trimestre" : "acumulado";
}

export interface StatementFact {
  cnpj: string;
  cvmCode: string;
  companyName: string;
  metric: string;
  periodStart: string | null;
  periodEnd: string;
  publishedAt: string | null;
  version: number;
  value: number;
  documentType: DocumentType;
  periodKind: string;
  sourceUrl: string | null;
}

/**
 * Fato ainda carregando a escala que a companhia declarou.
 *
 * `value` já está em reais; `escala` sobrevive só até a conferência de coerência
 * (`dropInconsistentScale`), que precisa comparar o que cada documento declarou. Não vai
 * para o banco: lá o valor já é reais e a escala não significaria mais nada.
 */
export type ScaledFact = StatementFact & { escala: string };

function normalizeCnpj(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * ESCALA_MOEDA multiplica o valor publicado. "MIL" é o caso normal; "UNIDADE" aparece em
 * algumas companhias. Escala desconhecida devolve null para a linha ser descartada em
 * vez de entrar mil vezes maior ou menor do que é.
 */
function scaleFactor(escala: string): number | null {
  const normalized = escala.trim().toUpperCase();
  if (normalized === "MIL") return 1000;
  if (normalized === "UNIDADE" || normalized === "") return 1;
  if (normalized === "MILHAO" || normalized === "MILHÃO") return 1_000_000;
  return null;
}

function parseValue(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
}

/**
 * Data de recebimento e link do documento, por (CNPJ, data de referência, versão).
 *
 * Vivem no CSV índice do ZIP, não nas demonstrações — é preciso juntar. É por causa
 * deste arquivo que a série tem `publishedAt`: sem ele, a tabela saberia a que período o
 * número se refere e não quando ele passou a existir.
 */
function indexDocuments(entries: Record<string, Uint8Array>, year: number, documentType: DocumentType): Map<string, { publishedAt: string | null; sourceUrl: string | null }> {
  const index = new Map<string, { publishedAt: string | null; sourceUrl: string | null }>();
  // O índice é o CSV cujo nome não tem sufixo de demonstração: dfp_cia_aberta_2024.csv.
  const rows = readCvmEntry(entries, `${documentType.toLowerCase()}_cia_aberta_${year}.csv`);
  if (!rows) return index;
  for (const row of rows) {
    const key = `${normalizeCnpj(row.CNPJ_CIA ?? "")}|${row.DT_REFER ?? ""}|${row.VERSAO ?? ""}`;
    index.set(key, {
      publishedAt: row.DT_RECEB?.trim() || null,
      sourceUrl: row.LINK_DOC?.trim() || null,
    });
  }
  return index;
}

/**
 * Fatos de um ano, anual (DFP) ou trimestral (ITR).
 *
 * Os dois conjuntos têm estrutura idêntica — mesmos arquivos, mesmos códigos de conta,
 * mesmo índice com `DT_RECEB` —, então muda só a URL e a classificação do período.
 * Medido no ITR de 2025 (460 companhias), a cobertura por métrica é a mesma do DFP.
 *
 * Cada arquivo traz DOIS exercícios — `ORDEM_EXERC` diz ÚLTIMO ou PENÚLTIMO —, então uma
 * passada por ano cobre dois. Os dois são lidos: o penúltimo de um arquivo é o mesmo
 * número que o último do arquivo anterior, e a chave única resolve a repetição sem
 * precisar de lógica.
 *
 * **Lança** CvmDownloadError quando o arquivo não vem, para o job saber a diferença
 * entre "ano sem dado" e "não consegui o ano".
 */
export async function fetchStatements(year: number, documentType: DocumentType): Promise<ScaledFact[]> {
  const slug = documentType.toLowerCase();
  const entries = await downloadCvmZip(
    `https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/${documentType}/DADOS/${slug}_cia_aberta_${year}.zip`,
    year,
  );
  const documents = indexDocuments(entries, year, documentType);
  const facts: ScaledFact[] = [];
  let semEscala = 0;

  for (const { metric, statement, code } of ACCOUNT_MAP) {
    const rows = readCvmEntry(entries, statement);
    if (!rows) {
      // Companhia pode não usar o método direto de fluxo de caixa; o arquivo então nem
      // existe. Só é problema quando NENHUM arquivo veio, e disso o job cuida.
      logger.debug({ year, statement, documentType }, "arquivo ausente no ZIP da CVM");
      continue;
    }
    for (const row of rows) {
      if (row.CD_CONTA !== code) continue;
      const value = parseValue(row.VL_CONTA);
      if (value == null) continue;
      const escala = (row.ESCALA_MOEDA ?? "").trim().toUpperCase();
      const factor = scaleFactor(escala);
      if (factor == null) { semEscala++; continue; }

      const cnpj = normalizeCnpj(row.CNPJ_CIA ?? "");
      const periodEnd = row.DT_FIM_EXERC?.trim() || row.DT_REFER?.trim() || "";
      if (!cnpj || !periodEnd) continue;

      const periodStart = BALANCE_STATEMENTS.has(statement) ? null : (row.DT_INI_EXERC?.trim() || null);
      const version = Number(row.VERSAO ?? "1");
      const doc = documents.get(`${cnpj}|${row.DT_REFER ?? ""}|${row.VERSAO ?? ""}`);
      facts.push({
        cnpj,
        cvmCode: (row.CD_CVM ?? "").trim(),
        companyName: (row.DENOM_CIA ?? "").trim(),
        metric,
        periodStart,
        periodEnd,
        publishedAt: doc?.publishedAt ?? null,
        version: Number.isFinite(version) ? version : 1,
        value: value * factor,
        documentType,
        periodKind: periodKindFor(documentType, periodStart, periodEnd),
        sourceUrl: doc?.sourceUrl ?? null,
        escala,
      });
    }
  }

  if (semEscala > 0) logger.warn({ year, documentType, semEscala }, "linhas descartadas por escala de moeda desconhecida");
  if (facts.length === 0) throw new CvmDownloadError(year, `ZIP ${documentType} baixado mas nenhuma conta reconhecida`);
  return facts;
}

/**
 * Descarta as linhas cuja escala declarada contradiz a que a própria companhia usou no
 * resto do ano.
 *
 * Não é zelo teórico: no ITR de 2021, a ODONTOPREV declarou MIL no 1T, **UNIDADE no 2T** e
 * MIL no 3T, com valores da mesma ordem de grandeza nos três (451.405, 454.602, 467.067).
 * Aplicando a escala declarada ao pé da letra — que é o que este parser fazia —, o 2T
 * virava R$ 454 mil em vez de R$ 454 milhões. Uma queda de 99,9% seguida de recuperação,
 * inventada sobre uma empresa real, é exatamente o tipo de sinal falso que o motor de
 * decisão leria como deterioração.
 *
 * Medido no DRE consolidado de 2021 (444 companhias): 429 sempre MIL, 9 sempre UNIDADE,
 * **6 misturam as duas**. As 9 constantes ficam intocadas — companhia pequena pode mesmo
 * publicar em unidades, e não há nada no arquivo que contradiga isso. O que se descarta é
 * só o desvio de quem se contradiz.
 *
 * ## A janela é a execução inteira, e não um arquivo
 *
 * Conferir dentro de um ano só não basta, e isso foi medido, não suposto: a SERENA declara
 * MIL no 1T de 2023 e UNIDADE do 2T em diante, e o arquivo de 2024 repete o 2T de 2023
 * como comparativo — em UNIDADE, coerente com todo o resto DAQUELE arquivo. Olhando um
 * arquivo por vez não há contradição nenhuma em 2024, e o trimestre errado entra.
 *
 * Por isso a checagem roda sobre tudo o que a execução baixou, e não por ano.
 *
 * **Limitação declarada:** numa execução de rotina a janela são os dois anos mais
 * recentes. Companhia que declare a escala errada de forma uniforme em todos os arquivos
 * da janela não tem como ser detectada — não há, no dado, nada que a contradiga.
 *
 * ## Por que descartar e não corrigir
 *
 * Corrigir seria afirmar que o declarante quis dizer MIL. É quase certo que quis, mas
 * "quase certo" aplicado em silêncio a um número que vai virar recomendação é o erro que
 * este projeto já pagou caro. Buraco na série o motor enxerga; número errado, não.
 */
export function dropInconsistentScale(
  facts: ScaledFact[],
  documentType: DocumentType,
): StatementFact[] {
  const tally = new Map<string, Map<string, number>>();
  for (const f of facts) {
    const key = `${f.cnpj}|${f.metric}`;
    const scales = tally.get(key) ?? new Map<string, number>();
    scales.set(f.escala, (scales.get(f.escala) ?? 0) + 1);
    tally.set(key, scales);
  }

  const dominant = new Map<string, string>();
  for (const [key, scales] of tally) {
    if (scales.size < 2) continue;
    // MIL vence sempre que aparece, e NÃO a escala mais frequente. A regra da maioria
    // parece mais neutra e erra: o BCO PINE, no ITR de 2024, declarou MIL no 1T e UNIDADE
    // no 2T e no 3T — a minoria é que estava certa (a receita semestral do banco é
    // R$ 1,29 bilhão, não R$ 1,29 milhão), e contar linhas teria descartado justamente a
    // correta. MIL é 97,6% de todas as linhas do arquivo; quando a companhia se
    // contradiz, é o desvio que se descarta, não a norma.
    let winner = "MIL";
    if (!scales.has("MIL")) {
      let best = -1;
      for (const [escala, n] of scales) if (n > best) { winner = escala; best = n; }
    }
    dominant.set(key, winner);
  }

  if (dominant.size === 0) return facts.map(({ escala: _escala, ...f }) => f);

  const kept: StatementFact[] = [];
  let descartados = 0;
  for (const { escala, ...f } of facts) {
    const esperada = dominant.get(`${f.cnpj}|${f.metric}`);
    if (esperada && escala !== esperada) { descartados++; continue; }
    kept.push(f);
  }
  logger.warn(
    { documentType, descartados, companhiasMetricas: dominant.size },
    "linhas descartadas por escala declarada incoerente com o resto da série",
  );
  return kept;
}
