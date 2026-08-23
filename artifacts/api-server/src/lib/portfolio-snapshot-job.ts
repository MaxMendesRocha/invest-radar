import { db, assetsTable } from "@workspace/db";
import { getPricesFor } from "./market-data";
import { recordSnapshot } from "./portfolio-history";
import type { JobDefinition } from "./scheduler";
import { logger } from "./logger";

/**
 * Grava o snapshot diário da carteira de todo mundo, sem depender de alguém abrir o app.
 *
 * Até aqui `recordSnapshot` era chamado só de dentro de `/portfolio/summary`, o que
 * amarrava o histórico ao hábito de uso: dia sem acesso não virava ponto. O efeito
 * apareceu inteiro no comparativo de benchmarks — numa janela real de 49 pregões, 16
 * dias não tinham medição, e a linha da carteira ligava trechos distantes enquanto CDI e
 * IBOV mostravam o percurso completo.
 *
 * O buraco não é só estético. O TWR divide a série nas datas de medição e assume o fluxo
 * no início de cada subperíodo; quanto mais longo o subperíodo, maior o erro dessa
 * aproximação (limitação registrada em time-weighted-return.ts). Medir todo dia encurta
 * cada subperíodo para 24h e torna a aproximação quase inócua.
 */
export async function recordDailySnapshots(): Promise<{ summary: string }> {
  const assets = await db.select().from(assetsTable);
  if (assets.length === 0) return { summary: "nenhuma posição cadastrada — nada a fotografar" };

  // Uma busca de preço só para todos os tickers de todos os usuários. getPricesFor já
  // deduplica por ticker internamente, mas passar a lista inteira de uma vez também
  // evita repetir o trabalho de renda fixa (projeção de poupança, PU do Tesouro) uma vez
  // por usuário.
  const prices = await getPricesFor(assets);

  const byUser = new Map<number, typeof assets>();
  for (const a of assets) {
    const list = byUser.get(a.userId) ?? [];
    list.push(a);
    byUser.set(a.userId, list);
  }

  let recorded = 0;
  let failed = 0;
  for (const [userId, userAssets] of byUser) {
    let totalPatrimony = 0;
    let totalCost = 0;
    for (const a of userAssets) {
      const qty = parseFloat(a.quantity);
      const avgPrice = parseFloat(a.averagePrice);
      // Mesmo fallback de /portfolio/summary: sem cotação, a posição vale o que custou.
      // Precisa ser idêntico, senão o snapshot do job e o da visita ao app discordariam
      // no mesmo dia — e o último a rodar sobrescreveria o outro.
      const price = prices.get(a.ticker.toUpperCase())?.price ?? avgPrice;
      totalPatrimony += qty * price;
      totalCost += qty * avgPrice;
    }

    try {
      await recordSnapshot(userId, totalPatrimony, totalCost);
      recorded++;
    } catch (err) {
      // Um usuário que falha não derruba os outros — cada snapshot é independente.
      logger.warn({ err, userId }, "snapshot diário de um usuário falhou");
      failed++;
    }
  }

  const summary = `${recorded} carteira(s) fotografada(s)`
    + (failed > 0 ? `, ${failed} com falha` : "");
  logger.info({ recorded, failed, tickers: prices.size }, "snapshot diário de carteiras concluído");
  return { summary };
}

/**
 * Uma vez por dia. O snapshot é um upsert na chave (usuário, dia): rodar de novo no mesmo
 * dia só reescreve a linha com a cotação mais recente, então repetir é inofensivo — mas
 * também não acrescenta nada, já que a granularidade da série é diária.
 */
export const PORTFOLIO_SNAPSHOT_JOB: JobDefinition = {
  name: "record-daily-portfolio-snapshots",
  minGapMs: 24 * 60 * 60 * 1000,
  run: recordDailySnapshots,
};
