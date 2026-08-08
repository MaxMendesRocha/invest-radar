import { db, treasuryBondsTable } from "@workspace/db";
import { logger } from "./logger";
import type { JobDefinition } from "./scheduler";

/**
 * Sincroniza os títulos do Tesouro Direto a partir dos dados abertos do Tesouro
 * Nacional (Tesouro Transparente / CKAN, licença ODbL, sem chave).
 *
 * O endpoint que a maioria dos exemplos na internet cita
 * (tesourodireto.com.br/json/.../treasurybondsinfo.json) responde 410 Gone — está
 * desativado. O caminho vivo é o CSV do CKAN, descoberto via package_show para não
 * fixar a URL do arquivo, que muda quando eles republicam o recurso.
 */

const CKAN_PACKAGE_URL =
  "https://www.tesourotransparente.gov.br/ckan/api/3/action/package_show?id=taxas-dos-titulos-ofertados-pelo-tesouro-direto";

interface CkanResource {
  format: string;
  url: string;
}

async function resolveCsvUrl(): Promise<string | null> {
  const response = await fetch(CKAN_PACKAGE_URL);
  if (!response.ok) {
    logger.warn({ status: response.status }, "Tesouro Transparente package_show falhou");
    return null;
  }
  const body = (await response.json()) as { result?: { resources?: CkanResource[] } };
  const csv = body.result?.resources?.find((r) => r.format?.toUpperCase() === "CSV");
  return csv?.url ?? null;
}

export interface TreasuryRow {
  bondType: string;
  maturityDate: string; // ISO
  baseDate: string; // ISO
  buyRate: number;
  buyUnitPrice: number;
}

/** "1.234,56" -> 1234.56; vazio/inválido -> null. */
function parseNumber(raw: string): number | null {
  const cleaned = raw.trim().replace(/\./g, "").replace(",", ".");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** "15/05/2035" -> "2035-05-15"; formato inesperado -> null. */
function parseDate(raw: string): string | null {
  const match = raw.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

/**
 * Percorre o CSV linha a linha guardando SÓ as linhas da data-base mais recente vista
 * até ali, descartando as anteriores conforme avança.
 *
 * O arquivo tem ~14 MB e ~175 mil linhas (histórico desde 2002) e interessa apenas o
 * último dia. Materializá-lo inteiro em objetos JS custaria centenas de MB numa
 * instância pequena do Railway para jogar 99,9% fora — e não dá para simplesmente ler
 * o fim do arquivo, porque a ordenação das linhas não é garantida pela fonte. Uma
 * passada só, com memória proporcional a um único dia (~60 linhas).
 */
class LatestBaseDateCollector {
  private header: string[] | null = null;
  private latestBaseDate = "";
  private collected: TreasuryRow[] = [];

  push(line: string): void {
    if (line.trim() === "") return;
    const cells = line.split(";");
    if (!this.header) {
      this.header = cells.map((c) => c.trim());
      return;
    }

    const header = this.header;
    const get = (name: string) => cells[header.indexOf(name)] ?? "";
    const baseDate = parseDate(get("Data Base"));
    const maturityDate = parseDate(get("Data Vencimento"));
    const bondType = get("Tipo Titulo").trim();
    const buyRate = parseNumber(get("Taxa Compra Manha"));
    const buyUnitPrice = parseNumber(get("PU Compra Manha"));

    // Linha incompleta é descartada em silêncio: o arquivo tem duas décadas de
    // histórico e nem todo título tinha todas as colunas preenchidas em toda data.
    if (!baseDate || !maturityDate || !bondType || buyRate == null || buyUnitPrice == null) return;
    if (baseDate < this.latestBaseDate) return;
    if (baseDate > this.latestBaseDate) {
      this.latestBaseDate = baseDate;
      this.collected = [];
    }
    this.collected.push({ bondType, maturityDate, baseDate, buyRate, buyUnitPrice });
  }

  rows(): TreasuryRow[] {
    return this.collected;
  }
}

/** Versão síncrona, usada nos testes com um CSV pequeno em memória. */
export function collectLatestBaseDate(lines: Iterable<string>): TreasuryRow[] {
  const collector = new LatestBaseDateCollector();
  for (const line of lines) collector.push(line);
  return collector.rows();
}

/** Baixa o CSV decodificando latin-1 em streaming e entrega linha a linha. */
async function* streamCsvLines(url: string): AsyncGenerator<string> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`download do CSV falhou com status ${response.status}`);
  }
  // latin-1, não UTF-8: o arquivo do Tesouro usa essa codificação e ler como UTF-8
  // corrompe os acentos dos nomes ("Prefixado com Juros Semestrais" passa ileso, mas
  // qualquer título acentuado não).
  const decoder = new TextDecoder("latin1");
  let buffer = "";
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      yield buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim() !== "") yield buffer.replace(/\r$/, "");
}

async function collectFromUrl(url: string): Promise<TreasuryRow[]> {
  const collector = new LatestBaseDateCollector();
  for await (const line of streamCsvLines(url)) collector.push(line);
  return collector.rows();
}

export async function syncTreasuryBonds(): Promise<{ summary: string }> {
  const url = await resolveCsvUrl();
  if (!url) return { summary: "URL do CSV não resolvida — tabela mantida como estava" };

  const rows = await collectFromUrl(url);
  // Arquivo vazio ou ilegível não pode esvaziar a tabela: o mesmo princípio do job de
  // oportunidades, onde universo vazio aborta sem mexer no que já existe. Uma tabela
  // zerada apagaria as sugestões de renda fixa sem nenhum aviso na tela.
  if (rows.length === 0) return { summary: "nenhuma linha válida no CSV — tabela mantida como estava" };

  const baseDate = rows[0].baseDate;
  await db.transaction(async (tx) => {
    await tx.delete(treasuryBondsTable);
    await tx.insert(treasuryBondsTable).values(
      rows.map((r) => ({
        bondType: r.bondType,
        maturityDate: r.maturityDate,
        baseDate: r.baseDate,
        buyRate: String(r.buyRate),
        buyUnitPrice: String(r.buyUnitPrice),
      })),
    );
  });

  return { summary: `${rows.length} títulos do Tesouro Direto sincronizados (data-base ${baseDate})` };
}

/**
 * Uma vez por dia. O Tesouro publica o arquivo com um ou dois dias úteis de atraso, e
 * as taxas mudam no máximo uma vez ao dia — sincronizar mais que isso só gastaria
 * banda em cima do mesmo conteúdo.
 */
export const TREASURY_JOB: JobDefinition = {
  name: "sync-treasury-bonds",
  minGapMs: 24 * 60 * 60 * 1000,
  run: syncTreasuryBonds,
};
