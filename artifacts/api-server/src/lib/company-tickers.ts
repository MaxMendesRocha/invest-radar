import { db, companyTickersTable } from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { fetchTickerMappings, collapseToLatest, FCA_START_YEAR, type TickerMapping } from "./cvm-company-tickers";
import { logger } from "./logger";

/**
 * Manutenção e leitura da ponte ticker → CNPJ.
 *
 * É o que faz a série de demonstrações da CVM alcançar um ativo da carteira. Sem ela,
 * `financial_facts` (chaveada por CNPJ) e `assets` (chaveada por ticker) são duas tabelas
 * que nunca se encontram.
 */

/** Um ano do FCA rende ~500 códigos; o Postgres tem teto de parâmetros por statement. */
const CHUNK = 500;

/**
 * Sufixo do mercado fracionário: PETR4F é o MESMO papel que PETR4, e a CVM cadastra só o
 * código cheio. Sem isto, quem tem posição em fracionário não encontraria a companhia.
 *
 * O B só aparece em código de FII (MXRF11B), que não está neste mapa, então não é
 * removido aqui — tirá-lo poderia colidir dois códigos distintos por engano.
 */
function normalizeTicker(ticker: string): string {
  const upper = ticker.trim().toUpperCase();
  return /^[A-Z][A-Z0-9]{3}\d{1,2}F$/.test(upper) ? upper.slice(0, -1) : upper;
}

/**
 * O CNPJ da companhia por trás de um ticker, ou null quando não há ponte.
 *
 * Null é resposta legítima e frequente: BDR (a companhia não presta contas à CVM), FII e
 * ETF (registro próprio, fora do FCA — o CNPJ de FII o app já tem pela brapi). Quem
 * chama precisa tratar null como "esta análise não tem série da CVM", nunca como erro.
 */
export async function cnpjForTicker(ticker: string): Promise<string | null> {
  const [row] = await db
    .select({ cnpj: companyTickersTable.cnpj })
    .from(companyTickersTable)
    .where(eq(companyTickersTable.ticker, normalizeTicker(ticker)))
    .limit(1);
  return row?.cnpj ?? null;
}

/** Versão em lote — uma consulta para a carteira inteira, em vez de uma por ativo. */
export async function cnpjsForTickers(tickers: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (tickers.length === 0) return result;

  const normalized = new Map<string, string[]>();
  for (const original of tickers) {
    const key = normalizeTicker(original);
    normalized.set(key, [...(normalized.get(key) ?? []), original]);
  }

  const rows = await db
    .select({ ticker: companyTickersTable.ticker, cnpj: companyTickersTable.cnpj })
    .from(companyTickersTable)
    .where(inArray(companyTickersTable.ticker, Array.from(normalized.keys())));

  for (const row of rows) {
    // Devolve sob o ticker que o CHAMADOR pediu (PETR4F e não PETR4), para ele conseguir
    // casar com a própria lista sem refazer a normalização.
    for (const original of normalized.get(row.ticker) ?? []) result.set(original, row.cnpj);
  }
  return result;
}

/**
 * Rebaixa o FCA inteiro e regrava o mapa.
 *
 * `doUpdate` e não `doNothing`, ao contrário da ingestão de demonstrações: aqui a linha
 * nova é a MESMA verdade atualizada — companhia mudou de nome, papel parou de negociar —,
 * e não uma versão nova convivendo com a anterior. Guardar histórico de nome de papel não
 * responde nenhuma pergunta que o app faça.
 */
export async function syncCompanyTickers(): Promise<{ written: number; anos: number; falhas: string[] }> {
  const currentYear = new Date().getUTCFullYear();
  const baixados: TickerMapping[] = [];
  const falhas: string[] = [];
  let anos = 0;

  for (let year = FCA_START_YEAR; year <= currentYear; year++) {
    try {
      const mappings = await fetchTickerMappings(year);
      baixados.push(...mappings);
      anos++;
    } catch (err) {
      // Um ano que falha encurta a cobertura, não a quebra: o ticker de quem entregou o
      // formulário em qualquer outro ano continua no mapa.
      logger.warn({ err, year }, "ano do FCA da CVM falhou");
      falhas.push(err instanceof Error ? err.message : String(err));
    }
  }

  const latest = collapseToLatest(baixados);
  let written = 0;
  for (let i = 0; i < latest.length; i += CHUNK) {
    const chunk = latest.slice(i, i + CHUNK).map((m) => ({
      ticker: m.ticker,
      cnpj: m.cnpj,
      companyName: m.companyName,
      securityKind: m.securityKind,
      tradingEndedAt: m.tradingEndedAt,
      updatedAt: new Date(),
    }));
    const gravados = await db
      .insert(companyTickersTable)
      .values(chunk)
      .onConflictDoUpdate({
        target: companyTickersTable.ticker,
        set: {
          cnpj: sql`excluded.cnpj`,
          companyName: sql`excluded.company_name`,
          securityKind: sql`excluded.security_kind`,
          tradingEndedAt: sql`excluded.trading_ended_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning({ ticker: companyTickersTable.ticker });
    written += gravados.length;
  }

  logger.info({ written, anos, falhas }, "mapa ticker→CNPJ atualizado");
  return { written, anos, falhas };
}
