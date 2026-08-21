import { db, fiiMonthlyReportsTable } from "@workspace/db";
import { inArray, like, sql } from "drizzle-orm";
import { isinPrefixForTicker } from "./cvm-data";
import { detectCorporateEvents, mostRecentEvent, type CorporateEvent, type FiiMonthlyPoint } from "./corporate-events-engine";
import { logger } from "./logger";

/**
 * Caminho de leitura do detector de evento corporativo: da carteira até o aviso.
 *
 * Lê a série já persistida por fii-events-sync.ts em vez de baixar o arquivo da CVM na
 * hora — GET /assets é caminho de requisição, não pode carregar um ZIP de 1 MB. Se o job
 * ainda não rodou, a tabela está vazia e ninguém recebe aviso: silêncio honesto, nunca
 * um palpite.
 */

export interface CorporateEventWarning {
  type: CorporateEvent["type"];
  /** "2023-11-01" */
  date: string;
  /** Desdobramento 1:10 → 10. Amortização → null. */
  ratio: number | null;
  /** Amortização: fração acumulada desde a compra (0,0134 = 1,34%). Outros → null. */
  accumulatedFraction: number | null;
  /** true quando a posição não tem data de compra e não dá pra saber se o evento é posterior a ela. */
  purchaseDateUnknown: boolean;
}

interface AssetRef {
  ticker: string;
  category: string;
  purchaseDate: string | null;
}

/**
 * Avisos por ticker, só para FII. Tickers sem correspondência no informe da CVM (ou sem
 * evento posterior à compra) simplesmente não entram no mapa.
 */
export async function getCorporateEventWarnings(assets: AssetRef[]): Promise<Map<string, CorporateEventWarning>> {
  const out = new Map<string, CorporateEventWarning>();

  const fiis = assets.filter((a) => a.category === "fiis");
  if (fiis.length === 0) return out;

  const prefixByTicker = new Map<string, string>();
  for (const a of fiis) {
    const prefix = isinPrefixForTicker(a.ticker);
    if (prefix) prefixByTicker.set(a.ticker.toUpperCase(), prefix);
  }
  if (prefixByTicker.size === 0) return out;

  try {
    // Resolve todos os CNPJs de uma vez: um OR de prefixos de ISIN em vez de uma
    // consulta por ticker.
    //
    // A busca varre a tabela inteira de propósito, sem recortar por ano. A CVM preenche
    // o ISIN de forma inconsistente — o DVFF11, por exemplo, vem com o campo vazio em
    // todos os meses de 2023 e preenchido em 2026. Basta um mês qualquer trazer o ISIN
    // pra que a série inteira do fundo fique alcançável; filtrar por ano perderia
    // justamente os fundos cujo ISIN só aparece fora da janela olhada.
    const prefixes = [...new Set(prefixByTicker.values())];
    const matches = await db
      .selectDistinct({ cnpj: fiiMonthlyReportsTable.cnpj, isin: fiiMonthlyReportsTable.isin })
      .from(fiiMonthlyReportsTable)
      .where(sql`${fiiMonthlyReportsTable.isin} IS NOT NULL AND (${sql.join(
        prefixes.map((p) => like(fiiMonthlyReportsTable.isin, `${p}%`)),
        sql` OR `,
      )})`);

    const cnpjByPrefix = new Map<string, string>();
    for (const m of matches) {
      if (!m.isin) continue;
      cnpjByPrefix.set(m.isin.slice(0, 9), m.cnpj);
    }
    if (cnpjByPrefix.size === 0) return out;

    const cnpjs = [...new Set(cnpjByPrefix.values())];
    const rows = await db
      .select({
        cnpj: fiiMonthlyReportsTable.cnpj,
        dataReferencia: fiiMonthlyReportsTable.dataReferencia,
        cotasEmitidas: fiiMonthlyReportsTable.cotasEmitidas,
        amortizacaoFracao: fiiMonthlyReportsTable.amortizacaoFracao,
      })
      .from(fiiMonthlyReportsTable)
      .where(inArray(fiiMonthlyReportsTable.cnpj, cnpjs));

    const seriesByCnpj = new Map<string, FiiMonthlyPoint[]>();
    for (const r of rows) {
      const list = seriesByCnpj.get(r.cnpj) ?? [];
      list.push({
        dataReferencia: r.dataReferencia,
        cotasEmitidas: r.cotasEmitidas != null ? Number(r.cotasEmitidas) : null,
        amortizacaoFracao: r.amortizacaoFracao != null ? Number(r.amortizacaoFracao) : null,
      });
      seriesByCnpj.set(r.cnpj, list);
    }

    for (const asset of fiis) {
      const prefix = prefixByTicker.get(asset.ticker.toUpperCase());
      if (!prefix) continue;
      const cnpj = cnpjByPrefix.get(prefix);
      if (!cnpj) continue;
      const series = seriesByCnpj.get(cnpj);
      if (!series || series.length < 2) continue;
      const event = mostRecentEvent(detectCorporateEvents(series, asset.purchaseDate));
      if (!event) continue;
      out.set(asset.ticker.toUpperCase(), {
        type: event.type,
        date: event.date,
        ratio: event.ratio,
        accumulatedFraction: event.accumulatedFraction,
        purchaseDateUnknown: event.purchaseDateUnknown,
      });
    }
  } catch (err) {
    // Um aviso que falha nunca pode derrubar a listagem da carteira — o resto da tela
    // vale mais que este campo.
    logger.warn({ err }, "detecção de evento corporativo falhou — seguindo sem aviso");
    return out;
  }

  return out;
}
