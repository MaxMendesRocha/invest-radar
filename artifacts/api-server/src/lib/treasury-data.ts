import { db, treasuryBondsTable } from "@workspace/db";
import { countDistinct, max, sql } from "drizzle-orm";
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
  // Lado da recompra — nulo quando o arquivo não traz (acontece em datas antigas).
  // Ver o comentário no schema: é este lado que vale para marcar posição detida.
  sellRate: number | null;
  sellUnitPrice: number | null;
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
 * Percorre o CSV linha a linha, gravando em lotes as linhas cuja data-base ainda não
 * temos.
 *
 * O arquivo tem ~14 MB e ~175 mil linhas (histórico desde 2002). Acumulá-lo inteiro em
 * objetos JS custaria centenas de MB numa instância pequena do Railway, então as linhas
 * são descarregadas no banco a cada BATCH_SIZE e o array volta a zero — memória
 * constante, independente do tamanho do arquivo.
 *
 * `sinceBaseDate` é a data-base máxima já gravada. Na primeira execução ela é null e
 * tudo entra (o backfill do histórico); nas seguintes, só o que é mais novo. A própria
 * data máxima é reprocessada de propósito: o Tesouro às vezes republica o arquivo do
 * dia, e o upsert corrige a linha em vez de duplicá-la.
 */
const BATCH_SIZE = 2000;

class TreasuryIngester {
  private header: string[] | null = null;
  private buffer: TreasuryRow[] = [];
  private inserted = 0;
  private latestSeen = "";

  constructor(private readonly sinceBaseDate: string | null, private readonly flush: (rows: TreasuryRow[]) => Promise<void>) {}

  async push(line: string): Promise<void> {
    const row = this.parse(line);
    if (!row) return;
    this.buffer.push(row);
    if (this.buffer.length >= BATCH_SIZE) await this.drain();
  }

  async finish(): Promise<{ inserted: number; latestBaseDate: string }> {
    await this.drain();
    return { inserted: this.inserted, latestBaseDate: this.latestSeen };
  }

  private async drain(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    await this.flush(batch);
    this.inserted += batch.length;
  }

  private parse(line: string): TreasuryRow | null {
    if (line.trim() === "") return null;
    const cells = line.split(";");
    if (!this.header) {
      this.header = cells.map((c) => c.trim());
      return null;
    }

    const header = this.header;
    const get = (name: string) => cells[header.indexOf(name)] ?? "";
    const baseDate = parseDate(get("Data Base"));
    const maturityDate = parseDate(get("Data Vencimento"));
    const bondType = get("Tipo Titulo").trim();
    const buyRate = parseNumber(get("Taxa Compra Manha"));
    const buyUnitPrice = parseNumber(get("PU Compra Manha"));
    // Recompra não entra na condição de descarte de propósito: o título é utilizável
    // para sugestão de aporte mesmo sem ela, e exigi-la jogaria fora linha boa. Quem
    // marca posição a mercado é que precisa tratar o nulo.
    const sellRate = parseNumber(get("Taxa Venda Manha"));
    const sellUnitPrice = parseNumber(get("PU Venda Manha"));

    // Linha incompleta é descartada em silêncio: o arquivo tem duas décadas de
    // histórico e nem todo título tinha todas as colunas preenchidas em toda data.
    if (!baseDate || !maturityDate || !bondType || buyRate == null || buyUnitPrice == null) return null;
    if (baseDate > this.latestSeen) this.latestSeen = baseDate;
    if (this.sinceBaseDate && baseDate < this.sinceBaseDate) return null;

    return { bondType, maturityDate, baseDate, buyRate, buyUnitPrice, sellRate, sellUnitPrice };
  }
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

async function persistBatch(rows: TreasuryRow[]): Promise<void> {
  await db
    .insert(treasuryBondsTable)
    .values(
      rows.map((r) => ({
        bondType: r.bondType,
        maturityDate: r.maturityDate,
        baseDate: r.baseDate,
        buyRate: String(r.buyRate),
        buyUnitPrice: String(r.buyUnitPrice),
        sellRate: r.sellRate == null ? null : String(r.sellRate),
        sellUnitPrice: r.sellUnitPrice == null ? null : String(r.sellUnitPrice),
      })),
    )
    // Reexecutar a sincronização é inofensivo, e uma republicação do arquivo do dia
    // corrige a linha em vez de duplicá-la.
    .onConflictDoUpdate({
      target: [treasuryBondsTable.bondType, treasuryBondsTable.maturityDate, treasuryBondsTable.baseDate],
      set: {
        buyRate: sql`excluded.buy_rate`,
        buyUnitPrice: sql`excluded.buy_unit_price`,
        sellRate: sql`excluded.sell_rate`,
        sellUnitPrice: sql`excluded.sell_unit_price`,
      },
    });
}

export async function syncTreasuryBonds(): Promise<{ summary: string }> {
  const url = await resolveCsvUrl();
  if (!url) return { summary: "URL do CSV não resolvida — tabela mantida como estava" };

  // "Tenho histórico?" é medido por QUANTAS datas-base distintas existem, não por
  // haver linhas. Uma instalação que já rodava a versão anterior tem exatamente uma
  // data-base — a foto do dia — e olhar só a data máxima faria o sync concluir que
  // está em dia e nunca baixar as duas décadas anteriores. O recurso inteiro depende
  // desse histórico, então a condição precisa reconhecer esse estado e refazer a
  // varredura completa. Depois do backfill existem milhares de datas e o caminho
  // incremental volta a valer sozinho.
  const [stats] = await db
    .select({ latest: max(treasuryBondsTable.baseDate), distinctDates: countDistinct(treasuryBondsTable.baseDate) })
    .from(treasuryBondsTable);
  const hasHistory = (stats?.distinctDates ?? 0) > 1;
  const sinceBaseDate = hasHistory ? (stats?.latest ?? null) : null;

  // Nada é apagado antes de gravar: o histórico é acumulativo, então arquivo vazio ou
  // ilegível simplesmente não escreve nada, em vez de destruir o que já existe.
  const ingester = new TreasuryIngester(sinceBaseDate, persistBatch);
  for await (const line of streamCsvLines(url)) await ingester.push(line);
  const { inserted, latestBaseDate } = await ingester.finish();

  if (inserted === 0) {
    return { summary: `nenhuma linha nova (data-base mais recente já registrada: ${sinceBaseDate ?? "nenhuma"})` };
  }
  return {
    summary: hasHistory
      // "processadas" e não "novas": a data-base máxima é sempre reprocessada para
      // capturar republicação do arquivo, então parte dessas linhas costuma ser
      // atualização e não inserção.
      ? `${inserted} linhas processadas do Tesouro Direto (até a data-base ${latestBaseDate})`
      : `histórico do Tesouro Direto carregado: ${inserted} linhas, até a data-base ${latestBaseDate}`,
  };
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
