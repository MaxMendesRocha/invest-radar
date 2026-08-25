import { downloadCvmZip, readCvmEntry, CvmDownloadError } from "./cvm-data";
import { logger } from "./logger";

/**
 * Demonstrações padronizadas das companhias abertas (DFP), do portal de dados abertos
 * da CVM.
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
  documentType: string;
  sourceUrl: string | null;
}

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
function indexDocuments(entries: Record<string, Uint8Array>, year: number): Map<string, { publishedAt: string | null; sourceUrl: string | null }> {
  const index = new Map<string, { publishedAt: string | null; sourceUrl: string | null }>();
  // O índice é o CSV cujo nome não tem sufixo de demonstração: dfp_cia_aberta_2024.csv.
  const rows = readCvmEntry(entries, `dfp_cia_aberta_${year}.csv`);
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
 * Fatos de um ano do DFP.
 *
 * Cada arquivo traz DOIS exercícios — `ORDEM_EXERC` diz ÚLTIMO ou PENÚLTIMO —, então uma
 * passada por ano cobre dois. Os dois são lidos: o penúltimo de um arquivo é o mesmo
 * número que o último do arquivo anterior, e a chave única resolve a repetição sem
 * precisar de lógica.
 *
 * **Lança** CvmDownloadError quando o arquivo não vem, para o job saber a diferença
 * entre "ano sem dado" e "não consegui o ano".
 */
export async function fetchAnnualStatements(year: number): Promise<StatementFact[]> {
  const entries = await downloadCvmZip(
    `https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/DFP/DADOS/dfp_cia_aberta_${year}.zip`,
    year,
  );
  const documents = indexDocuments(entries, year);
  const facts: StatementFact[] = [];
  let semEscala = 0;

  for (const { metric, statement, code } of ACCOUNT_MAP) {
    const rows = readCvmEntry(entries, statement);
    if (!rows) {
      // Companhia pode não usar o método direto de fluxo de caixa; o arquivo então nem
      // existe. Só é problema quando NENHUM arquivo veio, e disso o job cuida.
      logger.debug({ year, statement }, "arquivo ausente no ZIP do DFP");
      continue;
    }
    for (const row of rows) {
      if (row.CD_CONTA !== code) continue;
      const value = parseValue(row.VL_CONTA);
      if (value == null) continue;
      const factor = scaleFactor(row.ESCALA_MOEDA ?? "");
      if (factor == null) { semEscala++; continue; }

      const cnpj = normalizeCnpj(row.CNPJ_CIA ?? "");
      const periodEnd = row.DT_FIM_EXERC?.trim() || row.DT_REFER?.trim() || "";
      if (!cnpj || !periodEnd) continue;

      const version = Number(row.VERSAO ?? "1");
      const doc = documents.get(`${cnpj}|${row.DT_REFER ?? ""}|${row.VERSAO ?? ""}`);
      facts.push({
        cnpj,
        cvmCode: (row.CD_CVM ?? "").trim(),
        companyName: (row.DENOM_CIA ?? "").trim(),
        metric,
        periodStart: BALANCE_STATEMENTS.has(statement) ? null : (row.DT_INI_EXERC?.trim() || null),
        periodEnd,
        publishedAt: doc?.publishedAt ?? null,
        version: Number.isFinite(version) ? version : 1,
        value: value * factor,
        documentType: "DFP",
        sourceUrl: doc?.sourceUrl ?? null,
      });
    }
  }

  if (semEscala > 0) logger.warn({ year, semEscala }, "linhas do DFP descartadas por escala de moeda desconhecida");
  if (facts.length === 0) throw new CvmDownloadError(year, "ZIP baixado mas nenhuma conta reconhecida");
  return facts;
}
