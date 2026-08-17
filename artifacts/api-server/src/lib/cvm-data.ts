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
 * delimitado por `;`, um por ano. Usamos só ativo_passivo (composição) e complemento
 * (taxa de administração). O geral não tem nada que já não venha da brapi.
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
    const cnpj = normalizeCnpj(row.CNPJ_Fundo_Classe ?? "");
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

async function downloadAndParse(): Promise<Map<string, FiiCvmData>> {
  const year = new Date().getUTCFullYear();
  const url = `https://dados.cvm.gov.br/dados/FII/DOC/INF_MENSAL/DADOS/inf_mensal_fii_${year}.zip`;
  const response = await fetch(url);
  if (!response.ok) {
    logger.warn({ status: response.status, url }, "download do informe mensal FII da CVM falhou");
    return new Map();
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(buffer);
  } catch (err) {
    logger.warn({ err }, "ZIP do informe mensal FII da CVM não pôde ser lido");
    return new Map();
  }

  const ativoPassivoName = Object.keys(entries).find((name) => name.includes("ativo_passivo"));
  const complementoName = Object.keys(entries).find((name) => name.includes("complemento"));
  if (!ativoPassivoName || !complementoName) {
    logger.warn({ entries: Object.keys(entries) }, "ZIP da CVM sem os arquivos esperados (ativo_passivo/complemento)");
    return new Map();
  }

  const ativoPassivoRows = parseCsv(Buffer.from(entries[ativoPassivoName]).toString("latin1"));
  const complementoRows = parseCsv(Buffer.from(entries[complementoName]).toString("latin1"));
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
