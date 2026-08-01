import { db, opportunitiesTable, type InsertOpportunity } from "@workspace/db";
import { getFundamentals, type Fundamentals } from "./market-data";
import { analyzeFundamentals, evalVolatility } from "./analysis-engine";
import { TICKER_UNIVERSE } from "./ticker-universe";
import { describeOpportunity } from "./opportunities-ai";
import { logger } from "./logger";
import type { JobDefinition } from "./scheduler";

// Fundamentos ruins não entram na lista de "sugestões" — mesmo limiar informal do
// "Estavel" pra cima na classificação do Radar (analysis-engine.ts).
const MIN_OPPORTUNITY_SCORE = 60;

// Nível de risco determinístico a partir do beta real (mesmos buckets de
// evalVolatility) — a IA nunca decide esse enum, só escreve o texto em volta.
function riskLevelFor(f: Fundamentals): "Baixo" | "Medio" | "Alto" {
  const volatility = evalVolatility(f.beta);
  if (!volatility) return "Medio"; // sem beta disponível (comum em FII/ETF/BDR): neutro, não chutado pra baixo/alto
  if (volatility.score >= 85) return "Baixo";
  if (volatility.score >= 65) return "Medio";
  return "Alto";
}

// Não existe fonte de dado real para "retorno potencial futuro" no plano atual —
// o módulo que traria preço-alvo de analistas (financial-data) retorna 403. Em vez
// de inventar um número, usamos uma heurística DOCUMENTADA e transparente:
// combina o score do Radar (0-100, já baseado em fundamentos reais) com o dividend
// yield real, num intervalo plausível (0% a 35%). Isso é uma estimativa interna do
// Radar, não uma previsão de mercado — se a brapi.dev algum dia expuser
// targetMeanPrice de verdade, trocar por (targetMeanPrice - price) / price aqui.
function computePotentialReturn(score: number, f: Fundamentals): number {
  const scoreComponent = Math.max(0, score - 50) * 0.5; // 0 a 25
  const dividendComponent = (f.dividendYield ?? 0) * 100 * 0.8; // dividend yield já é decimal
  return Math.round(Math.min(35, scoreComponent + dividendComponent) * 100) / 100;
}

/**
 * Reescaneia TICKER_UNIVERSE com fundamentos reais, recalcula o score determinístico
 * de cada um (mesmo analyzeFundamentals do Radar por ativo) e substitui inteiramente
 * a tabela `opportunities` pelos que batem o score mínimo — tickers sem fundamentos
 * disponíveis simplesmente não entram, nunca com dado inventado. Chamada pelo
 * scheduler a cada 2 dias (ver lib/scheduler.ts) e pelo endpoint interno de disparo
 * manual (routes/internal.ts).
 */
export async function regenerateOpportunities(): Promise<{ summary: string }> {
  const fundamentalsByTicker = await getFundamentals(TICKER_UNIVERSE.map((u) => u.ticker));

  // Em paralelo — sequencial levava ~90s pra varrer o universo inteiro (uma
  // chamada real à Anthropic por ativo qualificado).
  const candidates = TICKER_UNIVERSE.map((entry) => {
    const fundamentals = fundamentalsByTicker.get(entry.ticker);
    if (!fundamentals) return null;
    const analysis = analyzeFundamentals(fundamentals);
    if (!analysis.available || analysis.score < MIN_OPPORTUNITY_SCORE) return null;
    return { entry, fundamentals, analysis };
  }).filter((c): c is { entry: (typeof TICKER_UNIVERSE)[number]; fundamentals: Fundamentals; analysis: ReturnType<typeof analyzeFundamentals> } => c != null);

  const rows: InsertOpportunity[] = await Promise.all(
    candidates.map(async ({ entry, fundamentals, analysis }) => {
      const name = fundamentals.name ?? entry.fallbackName;
      const ai = await describeOpportunity(entry, name, fundamentals, analysis);

      return {
        ticker: entry.ticker,
        name,
        category: entry.category,
        score: String(analysis.score),
        potentialReturn: String(computePotentialReturn(analysis.score, fundamentals)),
        dividendYield: String((fundamentals.dividendYield ?? 0) * 100),
        riskLevel: riskLevelFor(fundamentals),
        reason: ai?.reason ?? analysis.positives[0] ?? analysis.risks[0] ?? "Ativo dentro dos critérios de triagem do Radar.",
        positives: JSON.stringify(ai?.positives ?? analysis.positives.slice(0, 3)),
        risks: JSON.stringify(ai?.risks ?? analysis.risks.slice(0, 3)),
        horizon: ai?.horizon ?? "Médio prazo",
      };
    })
  );

  // Transação — diferente do delete+insert simples de scripts/src/seed-opportunities.ts,
  // que roda manual e offline. Este job roda em produção com usuários lendo
  // /opportunities ao mesmo tempo; sem transação haveria uma janela real com a
  // tabela vazia entre o delete e o insert.
  await db.transaction(async (tx) => {
    await tx.delete(opportunitiesTable);
    if (rows.length > 0) await tx.insert(opportunitiesTable).values(rows);
  });

  const summary = `${rows.length} oportunidades geradas de ${TICKER_UNIVERSE.length} tickers varridos`;
  logger.info({ generated: rows.length, universeSize: TICKER_UNIVERSE.length }, "regenerateOpportunities concluído");
  return { summary };
}

// Definição compartilhada entre o scheduler (index.ts) e o disparo manual
// (routes/internal.ts), pra manter nome e intervalo alvo num único lugar.
export const OPPORTUNITIES_JOB: JobDefinition = {
  name: "regenerate-opportunities",
  minGapMs: 48 * 60 * 60 * 1000, // 2 dias
  run: regenerateOpportunities,
};
