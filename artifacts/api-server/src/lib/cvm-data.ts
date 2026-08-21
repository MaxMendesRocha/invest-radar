import { unzipSync } from "fflate";
import { logger } from "./logger";

/**
 * Composição real da carteira de um FII e taxa de administração real, a partir do
 * Informe Mensal Estruturado da CVM (dados.cvm.gov.br, dado público, sem chave e sem
 * restrição de uso — diferente do investidor10.com.br, cujos Termos de Uso proíbem
 * reprodução).
 *
 * Por que a CVM e não a brapi: o endpoint de indicadores de FII da brapi entrega
 * `segmentType` (papel/tijolo/híbrido/FoF) como rótulo, mas não a proporção real da
 * carteira nem o custo de administração. A CVM tem os dois, quantificados, porque é
 * o próprio administrador do fundo que presta essa informação por obrigação
 * regulatória todo mês.
 *
 * O arquivo é um ZIP com 3 CSVs (geral, complemento, ativo_passivo), latin-1,
 * delimitado por `;`, um por ano. ativo_passivo dá a composição, complemento dá a taxa
 * de administração e a amortização, e geral dá o ISIN (que resolve ticker → CNPJ sem
 * depender do plano pago da brapi) e a quantidade de cotas emitidas.
 */

const CVM_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // a CVM publica o informe uma vez por mês, mas retificações (Versao maior) podem aparecer a qualquer hora — 24h é seguro e barato

export interface FiiCvmData {
  /** "2026-07-01" — mês de referência do informe usado. */
  dataReferencia: string;
  /** Fração (0–1) do total investido em imóveis e direitos reais diretos. */
  imoveisDiretosPct: number;
  /** Fração (0–1) em CRI e instrumentos de crédito estruturado equivalentes (papel). */
  recebiveisEstruturadosPct: number;
  /** Fração (0–1) no restante: cotas de outros fundos, ações, SPEs, CEPAC etc. */
  outrosAtivosPct: number;
  /** Fração (0–1) do patrimônio líquido cobrada de taxa de administração NO MÊS — null quando o informe não traz o campo preenchido. */
  taxaAdministracaoMensalPct: number | null;
}

type CvmRow = Record<string, string>;

function normalizeCnpj(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * A coluna do CNPJ mudou de nome no arquivo: até 2022 é `CNPJ_Fundo`, de 2023 em diante
 * `CNPJ_Fundo_Classe` (veio junto da regulação de classes de cota). Ler só o nome novo
 * faz o arquivo antigo ser descartado inteiro em silêncio — o backfill voltava zero
 * linha pra 2019 e 2020 sem erro nenhum antes disso ser tratado.
 */
function rowCnpj(row: CvmRow): string {
  return normalizeCnpj(row.CNPJ_Fundo_Classe || row.CNPJ_Fundo || "");
}

function parseNumber(raw: string | undefined): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed); // a CVM usa ponto decimal aqui, diferente do CSV do Tesouro (que usa vírgula)
  return Number.isFinite(value) ? value : null;
}

function parseCsv(text: string): CvmRow[] {
  const lines = text.split("\n");
  if (lines.length === 0) return [];
  const header = lines[0].replace(/\r$/, "").split(";");
  const rows: CvmRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (line.trim() === "") continue;
    const cells = line.split(";");
    const row: CvmRow = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = cells[j] ?? "";
    rows.push(row);
  }
  return rows;
}

/**
 * Um fundo aparece uma vez por mês no arquivo do ano inteiro, e pode ser retificado
 * (Versao 2, 3...) depois de publicado. Fica só a linha mais recente por CNPJ —
 * maior Data_Referencia e, empatado, maior Versao.
 */
function keepLatestPerCnpj(rows: CvmRow[]): Map<string, CvmRow> {
  const latest = new Map<string, CvmRow>();
  for (const row of rows) {
    const cnpj = rowCnpj(row);
    if (!cnpj) continue;
    const key = `${row.Data_Referencia}:${(row.Versao ?? "0").padStart(4, "0")}`;
    const current = latest.get(cnpj);
    if (!current) {
      latest.set(cnpj, row);
      continue;
    }
    const currentKey = `${current.Data_Referencia}:${(current.Versao ?? "0").padStart(4, "0")}`;
    if (key > currentKey) latest.set(cnpj, row);
  }
  return latest;
}

/**
 * Baixa e descompacta o ZIP de um ano. `null` quando a CVM está fora do ar ou o ano
 * não existe — quem chama decide o que fazer, ninguém inventa dado pra cobrir a falha.
 */
async function downloadYear(year: number): Promise<Record<string, Uint8Array> | null> {
  const url = `https://dados.cvm.gov.br/dados/FII/DOC/INF_MENSAL/DADOS/inf_mensal_fii_${year}.zip`;
  const response = await fetch(url);
  if (!response.ok) {
    logger.warn({ status: response.status, url }, "download do informe mensal FII da CVM falhou");
    return null;
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  try {
    return unzipSync(buffer);
  } catch (err) {
    logger.warn({ err, year }, "ZIP do informe mensal FII da CVM não pôde ser lido");
    return null;
  }
}

function readEntry(entries: Record<string, Uint8Array>, needle: string): CvmRow[] | null {
  const name = Object.keys(entries).find((n) => n.includes(needle));
  if (!name) return null;
  return parseCsv(Buffer.from(entries[name]).toString("latin1"));
}

async function downloadAndParse(): Promise<Map<string, FiiCvmData>> {
  const year = new Date().getUTCFullYear();
  const entries = await downloadYear(year);
  if (!entries) return new Map();

  const ativoPassivoRows = readEntry(entries, "ativo_passivo");
  const complementoRows = readEntry(entries, "complemento");
  if (!ativoPassivoRows || !complementoRows) {
    logger.warn({ entries: Object.keys(entries) }, "ZIP da CVM sem os arquivos esperados (ativo_passivo/complemento)");
    return new Map();
  }

  const latestAtivoPassivo = keepLatestPerCnpj(ativoPassivoRows);
  const latestComplemento = keepLatestPerCnpj(complementoRows);

  const byCnpj = new Map<string, FiiCvmData>();
  for (const [cnpj, row] of latestAtivoPassivo) {
    const totalInvestido = parseNumber(row.Total_Investido);
    // Sem base real pra calcular fração, o fundo simplesmente não entra no mapa —
    // nunca divide por algo indefinido nem finge uma composição.
    if (totalInvestido == null || totalInvestido <= 0) continue;

    // Imóveis e direitos reais diretos: já vem consolidado no próprio campo (soma
    // terrenos + imóveis prontos/em construção/renda/venda + outros direitos reais).
    const imoveisDiretos = parseNumber(row.Direitos_Bens_Imoveis) ?? 0;

    // Recebíveis estruturados (papel): CRI e instrumentos de crédito equivalentes.
    // Deliberadamente NÃO inclui Acoes_Sociedades_Atividades_FII/Cotas_Sociedades_Atividades_FII
    // (cotas de SPE) em nenhum dos dois lados — uma SPE pode deter imóvel ou papel, e
    // o arquivo não diz qual; forçar numa categoria seria inventar uma composição que
    // a CVM não afirma. Cai em "outros ativos financeiros" por diferença, abaixo.
    const recebiveis =
      (parseNumber(row.CRI) ?? 0) +
      (parseNumber(row.CRI_CRA) ?? 0) +
      (parseNumber(row.Letras_Hipotecarias) ?? 0) +
      (parseNumber(row.LCI) ?? 0) +
      (parseNumber(row.LCI_LCA) ?? 0) +
      (parseNumber(row.LIG) ?? 0) +
      (parseNumber(row.Debentures) ?? 0) +
      (parseNumber(row.Cedulas_Debentures) ?? 0) +
      (parseNumber(row.Notas_Promissorias) ?? 0);

    // Resto por diferença (cotas de outros fundos, ações, SPEs, CEPAC, demais valores
    // mobiliários) — soma por diferença do total real reportado, não por lista própria
    // de campos, pra nunca desalinhar se a CVM adicionar uma coluna nova no arquivo.
    const outros = Math.max(0, totalInvestido - imoveisDiretos - recebiveis);

    const complementoRow = latestComplemento.get(cnpj);
    const taxaAdministracao = complementoRow ? parseNumber(complementoRow.Percentual_Despesas_Taxa_Administracao) : null;

    byCnpj.set(cnpj, {
      dataReferencia: row.Data_Referencia,
      imoveisDiretosPct: imoveisDiretos / totalInvestido,
      recebiveisEstruturadosPct: recebiveis / totalInvestido,
      outrosAtivosPct: outros / totalInvestido,
      taxaAdministracaoMensalPct: taxaAdministracao,
    });
  }

  logger.info({ funds: byCnpj.size, year }, "snapshot CVM de FII atualizado");
  return byCnpj;
}

let cache: { byCnpj: Map<string, FiiCvmData>; fetchedAt: number } | null = null;
let inFlight: Promise<Map<string, FiiCvmData>> | null = null;

async function getSnapshot(): Promise<Map<string, FiiCvmData>> {
  if (cache && Date.now() - cache.fetchedAt < CVM_CACHE_TTL_MS) return cache.byCnpj;
  if (inFlight) return inFlight; // duas chamadas simultâneas não baixam o ZIP de ~1MB duas vezes

  inFlight = downloadAndParse()
    .then((byCnpj) => {
      cache = { byCnpj, fetchedAt: Date.now() };
      return byCnpj;
    })
    .catch((err) => {
      logger.warn({ err }, "snapshot CVM de FII falhou — mantendo cache anterior, se houver");
      return cache?.byCnpj ?? new Map<string, FiiCvmData>();
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Composição real + taxa de administração real de um FII pelo CNPJ (formato livre —
 * a normalização acontece aqui). `null` sem CNPJ, sem o fundo no informe mais recente,
 * ou com a CVM fora do ar — nunca inventa um valor pra preencher a lacuna.
 */
export async function getFiiCvmData(cnpj: string | null): Promise<FiiCvmData | null> {
  if (!cnpj) return null;
  const snapshot = await getSnapshot();
  return snapshot.get(normalizeCnpj(cnpj)) ?? null;
}

// ---------------------------------------------------------------------------
// Série mensal — usada pelo detector de evento corporativo
//
// getFiiCvmData acima colapsa tudo numa linha por CNPJ, porque composição de carteira
// só precisa do mês mais recente. Detectar desdobramento exige o oposto: a série ao
// longo do tempo, comparando um mês com o seguinte. Daí um caminho separado em vez de
// mexer no que já funciona.
// ---------------------------------------------------------------------------

export interface FiiMonthlyRow {
  cnpj: string;
  /** "2023-11-01" — mês de referência do informe. */
  dataReferencia: string;
  cotasEmitidas: number | null;
  /**
   * Percentual_Amortizacao_Cotas_Mes COMO VEM da CVM. Apesar do nome, é FRAÇÃO:
   * 0,018768 é 1,8768% no mês. Ver comentário na tabela fii_monthly_reports.
   */
  amortizacaoFracao: number | null;
  valorPatrimonialCota: number | null;
  isin: string | null;
}

/**
 * Toda a série mensal de um ano, uma linha por fundo por mês de referência (retificações
 * colapsadas na maior Versao). Devolve vazio quando a CVM está fora do ar — nunca
 * parcial silencioso: quem chama compara o tamanho com o esperado se quiser.
 */
export async function fetchFiiMonthlyRows(year: number): Promise<FiiMonthlyRow[]> {
  const entries = await downloadYear(year);
  if (!entries) return [];

  const geralRows = readEntry(entries, "geral");
  const complementoRows = readEntry(entries, "complemento");
  if (!geralRows || !complementoRows) {
    logger.warn({ year, entries: Object.keys(entries) }, "ZIP da CVM sem geral/complemento");
    return [];
  }

  // Chave é (CNPJ, mês) e não só CNPJ — é justamente a série que interessa aqui.
  const pick = (rows: CvmRow[]): Map<string, CvmRow> => {
    const best = new Map<string, CvmRow>();
    for (const row of rows) {
      const cnpj = rowCnpj(row);
      const ref = row.Data_Referencia ?? "";
      if (!cnpj || !ref) continue;
      const key = `${cnpj}|${ref}`;
      const current = best.get(key);
      if (!current || Number(row.Versao ?? 0) > Number(current.Versao ?? 0)) best.set(key, row);
    }
    return best;
  };

  const geral = pick(geralRows);
  const complemento = pick(complementoRows);

  const out: FiiMonthlyRow[] = [];
  for (const [key, row] of geral) {
    const [cnpj, dataReferencia] = key.split("|");
    const comp = complemento.get(key);
    const isin = (row.Codigo_ISIN ?? "").trim();
    out.push({
      cnpj,
      dataReferencia,
      cotasEmitidas: parseNumber(row.Quantidade_Cotas_Emitidas),
      amortizacaoFracao: comp ? parseNumber(comp.Percentual_Amortizacao_Cotas_Mes) : null,
      valorPatrimonialCota: comp ? parseNumber(comp.Valor_Patrimonial_Cotas) : null,
      isin: ISIN_FII_PATTERN.test(isin) ? isin : null,
    });
  }
  logger.info({ year, rows: out.length }, "série mensal de FII da CVM lida");
  return out;
}

/**
 * ISIN de cota de FII: BR + 4 caracteres do código de negociação + CTF + dígitos.
 * BRDVFFCTF006 é o DVFF11. Vale pra 92% dos fundos do arquivo; o resto vem com lixo
 * ("0", "000000000000") ou é cota de classe/série que não é o papel negociado.
 */
const ISIN_FII_PATTERN = /^BR[A-Z0-9]{4}CTF\d+$/;

/**
 * Prefixo de ISIN que corresponde a um ticker de FII: DVFF11 → "BRDVFFCTF". A busca
 * reversa por esse prefixo é exata (um fundo só) e resolve ticker → CNPJ sem depender
 * do plano pago da brapi, que é o que o outro caminho do app usa (getFiiProfiles em
 * market-data.ts) e que cai em silêncio sem token. Quem consulta é corporate-events.ts,
 * pelo banco — o ISIN já fica gravado junto da série mensal.
 * `null` quando o ticker não tem a forma de código de FII.
 */
export function isinPrefixForTicker(ticker: string): string | null {
  const code = ticker.trim().toUpperCase().replace(/\d+$/, "");
  if (!/^[A-Z0-9]{4}$/.test(code)) return null;
  return `BR${code}CTF`;
}
