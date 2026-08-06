import { db, opportunitiesTable, sectorBenchmarksTable, type InsertOpportunity, type InsertSectorBenchmark } from "@workspace/db";
import { getFundamentals, getDividendEvents, getFiiProfiles, sumLast12Months, classifyDividendFrequency, type Fundamentals, type FiiProfile } from "./market-data";
import { analyzeFundamentals, evalVolatility } from "./analysis-engine";
import { computeFinancialHealth } from "./financial-health-engine";
import { classifySustainabilityOf } from "./dividend-value-engine";
import { fetchTickerUniverse, type UniverseEntry } from "./ticker-universe";
import { describeOpportunity } from "./opportunities-ai";
import { benchmarkGroupFor } from "./fii-engine";
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

// Abaixo disso, "média do setor" seria estatisticamente pouco confiável (2 empresas
// não representam um setor) — o setor inteiro fica de fora da tabela nesse caso,
// nunca publica uma média de amostra pequena demais.
const MIN_SECTOR_SAMPLE = 3;

/**
 * MEDIANA, não média. O nome das colunas em sector_benchmarks continua `avg_*` por
 * compatibilidade, mas o que elas guardam é a mediana — trocar isso exigiria uma
 * migração só para renomear.
 *
 * A diferença é material com amostra pequena: o MFII11, com DY declarado de 38% num
 * grupo de 4 fundos híbridos, puxava a MÉDIA do grupo para 21,75% e assim deixava de
 * parecer atípico contra uma referência que ele mesmo havia distorcido. A mediana
 * não se move com um extremo.
 *
 * Também alinha o número ao texto: a interface e os prompts sempre disseram
 * "mediana do setor".
 */
function median(values: (number | null)[]): number | null {
  const real = values.filter((v): v is number => v != null).sort((a, b) => a - b);
  if (real.length === 0) return null;
  const mid = Math.floor(real.length / 2);
  return real.length % 2 === 0 ? (real[mid - 1] + real[mid]) / 2 : real[mid];
}

// Médias setoriais reais a partir de TODO o universo com fundamentos disponíveis
// (não só os candidatos que passaram no score mínimo) — usar só os "aprovados" pra
// calcular a média enviesaria pra cima, fazendo qualquer ativo parecer caro por
// comparação. Setor vem de Fundamentals.sector (summaryProfile real da brapi.dev),
// mesma fonte já usada em sectorFor().
function computeSectorBenchmarks(
  fundamentalsByTicker: Map<string, Fundamentals>,
  fiiProfileByTicker: Map<string, FiiProfile>,
): InsertSectorBenchmark[] {
  const bySector = new Map<string, Fundamentals[]>();
  for (const [ticker, f] of fundamentalsByTicker) {
    const group = benchmarkGroupFor(f, fiiProfileByTicker.get(ticker));
    if (!group) continue;
    if (!bySector.has(group)) bySector.set(group, []);
    bySector.get(group)!.push(f);
  }

  const rows: InsertSectorBenchmark[] = [];
  for (const [sector, list] of bySector) {
    if (list.length < MIN_SECTOR_SAMPLE) continue;
    const avgPriceEarnings = median(list.map((f) => f.priceEarnings));
    const avgPriceToBook = median(list.map((f) => f.priceToBook));
    const avgReturnOnEquity = median(list.map((f) => f.returnOnEquity));
    const avgDividendYield = median(list.map((f) => f.dividendYield));
    const avgProfitMargins = median(list.map((f) => f.profitMargins));
    rows.push({
      sector,
      avgPriceEarnings: avgPriceEarnings != null ? String(avgPriceEarnings) : null,
      avgPriceToBook: avgPriceToBook != null ? String(avgPriceToBook) : null,
      avgReturnOnEquity: avgReturnOnEquity != null ? String(avgReturnOnEquity) : null,
      avgDividendYield: avgDividendYield != null ? String(avgDividendYield) : null,
      avgProfitMargins: avgProfitMargins != null ? String(avgProfitMargins) : null,
      sampleSize: list.length,
    });
  }
  return rows;
}

/**
 * Reescaneia TICKER_UNIVERSE com fundamentos reais, recalcula o score determinístico
 * de cada um (mesmo analyzeFundamentals do Radar por ativo) e substitui inteiramente
 * a tabela `opportunities` pelos que batem o score mínimo — tickers sem fundamentos
 * disponíveis simplesmente não entram, nunca com dado inventado. Chamada pelo
 * scheduler a cada semana (ver lib/scheduler.ts) e pelo endpoint interno de disparo
 * manual (routes/internal.ts).
 */
export async function regenerateOpportunities(): Promise<{ summary: string }> {
  const universe = await fetchTickerUniverse();

  // Universo vazio quase sempre significa que a brapi.dev está fora do ar ou o
  // token expirou — nesse caso não mexe na tabela existente (fica com os dados da
  // última rodada bem-sucedida) em vez de esvaziá-la sem ter nada real pra colocar.
  if (universe.length === 0) {
    logger.warn("regenerateOpportunities abortado: fetchTickerUniverse devolveu universo vazio");
    return { summary: "0 oportunidades geradas — universo de tickers indisponível, tabela não foi alterada" };
  }

  // dividendEvents em paralelo com fundamentals — o payout ratio avaliado dentro de
  // analyzeFundamentals precisa do DPS real dos últimos 12 meses, mesma fonte já usada
  // pra dividendTrend no Parecer de Ativo e em POST /analysis/generate.
  const [fundamentalsByTicker, dividendEventsByTicker, fiiProfileByTicker] = await Promise.all([
    getFundamentals(universe.map((u) => u.ticker)),
    getDividendEvents(universe.map((u) => ({ ticker: u.ticker, category: u.category }))),
    // Em lote (?symbols=A,B,C), uma chamada só — o segmento é o que permite comparar
    // FII contra os pares certos em vez de contra todos os FIIs juntos.
    getFiiProfiles(universe.filter((u) => u.category === "fiis").map((u) => u.ticker)),
  ]);
  const now = Date.now();

  // Em paralelo — sequencial levava ~90s pra varrer o universo inteiro (uma
  // chamada real à Anthropic por ativo qualificado).
  const candidates = universe.map((entry) => {
    const fundamentals = fundamentalsByTicker.get(entry.ticker);
    if (!fundamentals) return null;
    const dps12m = sumLast12Months(dividendEventsByTicker.get(entry.ticker) ?? [], now);
    const analysis = analyzeFundamentals(fundamentals, dps12m);
    if (!analysis.available || analysis.score < MIN_OPPORTUNITY_SCORE) return null;
    return { entry, fundamentals, analysis };
  }).filter((c): c is { entry: UniverseEntry; fundamentals: Fundamentals; analysis: ReturnType<typeof analyzeFundamentals> } => c != null);

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
        sector: benchmarkGroupFor(fundamentals, fiiProfileByTicker.get(entry.ticker)),
        dividendFrequency: classifyDividendFrequency(dividendEventsByTicker.get(entry.ticker) ?? [], now)?.label ?? null,
        dividendSustainability: classifySustainabilityOf(
          computeFinancialHealth(fundamentals, sumLast12Months(dividendEventsByTicker.get(entry.ticker) ?? [], now)),
        ),
        reason: ai?.reason ?? analysis.positives[0] ?? analysis.risks[0] ?? "Ativo dentro dos critérios de triagem do Radar.",
        positives: JSON.stringify(ai?.positives ?? analysis.positives.slice(0, 3)),
        risks: JSON.stringify(ai?.risks ?? analysis.risks.slice(0, 3)),
        horizon: ai?.horizon ?? "Médio prazo",
      };
    })
  );

  // Subproduto do mesmo scan — médias setoriais reais a partir do universo inteiro
  // (fundamentalsByTicker), não só dos candidatos aprovados. Usado por
  // analysis-ai.ts/opinion-ai.ts pra comparação com pares (routes/analysis.ts busca
  // via getSectorBenchmark, leitura barata, sem refazer o scan a cada Parecer de Ativo).
  const sectorBenchmarkRows = computeSectorBenchmarks(fundamentalsByTicker, fiiProfileByTicker);

  // Transação — diferente do delete+insert simples de scripts/src/seed-opportunities.ts,
  // que roda manual e offline. Este job roda em produção com usuários lendo
  // /opportunities ao mesmo tempo; sem transação haveria uma janela real com a
  // tabela vazia entre o delete e o insert. sector_benchmarks entra na mesma transação
  // por conveniência (mesmo job, mesmo scan), não por precisar de atomicidade com
  // opportunities especificamente.
  await db.transaction(async (tx) => {
    await tx.delete(opportunitiesTable);
    if (rows.length > 0) await tx.insert(opportunitiesTable).values(rows);

    await tx.delete(sectorBenchmarksTable);
    if (sectorBenchmarkRows.length > 0) await tx.insert(sectorBenchmarksTable).values(sectorBenchmarkRows);
  });

  const summary = `${rows.length} oportunidades geradas de ${universe.length} tickers varridos, ${sectorBenchmarkRows.length} setores com amostra suficiente pra média`;
  logger.info({ generated: rows.length, universeSize: universe.length }, "regenerateOpportunities concluído");
  return { summary };
}

// Definição compartilhada entre o scheduler (index.ts) e o disparo manual
// (routes/internal.ts), pra manter nome e intervalo alvo num único lugar.
export const OPPORTUNITIES_JOB: JobDefinition = {
  name: "regenerate-opportunities",
  minGapMs: 7 * 24 * 60 * 60 * 1000, // 1 semana
  run: regenerateOpportunities,
};
