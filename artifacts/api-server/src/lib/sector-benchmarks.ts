import { db, sectorBenchmarksTable, type SectorBenchmark } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { Fundamentals } from "./market-data";

/**
 * Leitura barata das medianas setoriais já persistidas por regenerateOpportunities()
 * (opportunities-engine.ts) — nunca refaz o scan do universo aqui, seria caro demais
 * pra cada Parecer de Ativo/Radar. Atualiza no máximo 1x por semana (mesma cadência
 * do job), o que é suficiente pra um número de referência comparativa.
 */
export async function getSectorBenchmark(sector: string | null): Promise<SectorBenchmark | null> {
  if (!sector) return null;
  const [row] = await db.select().from(sectorBenchmarksTable).where(eq(sectorBenchmarksTable.sector, sector));
  return row ?? null;
}

function pctDiff(value: number, benchmark: number): number {
  return ((value - benchmark) / benchmark) * 100;
}

// Só compara os fundamentos que ambos os lados têm reais (ativo e mediana do setor) —
// nunca compara contra null nem estima o que falta. Deliberadamente sem julgamento
// embutido no texto ("mais barato" não vira "melhor") — cabe à IA interpretar se o
// desconto/prêmio é justificado, igual um analista de verdade faria.
export function describeSectorComparison(f: Fundamentals, benchmark: SectorBenchmark | null): string {
  if (!f.sector) return "Comparação com o setor não disponível (setor do ativo não identificado).";
  if (!benchmark) return `Comparação com o setor "${f.sector}" não disponível (amostra insuficiente na última varredura).`;

  const lines: string[] = [];

  const peBenchmark = benchmark.avgPriceEarnings != null ? parseFloat(benchmark.avgPriceEarnings) : null;
  if (f.priceEarnings != null && peBenchmark != null && peBenchmark > 0) {
    const diff = pctDiff(f.priceEarnings, peBenchmark);
    lines.push(`P/L de ${f.priceEarnings.toFixed(1)} vs. mediana do setor de ${peBenchmark.toFixed(1)} (${diff >= 0 ? "+" : ""}${diff.toFixed(0)}%)`);
  }

  const roeBenchmark = benchmark.avgReturnOnEquity != null ? parseFloat(benchmark.avgReturnOnEquity) : null;
  if (f.returnOnEquity != null && roeBenchmark != null) {
    const diff = pctDiff(f.returnOnEquity, roeBenchmark);
    lines.push(`ROE de ${(f.returnOnEquity * 100).toFixed(1)}% vs. mediana do setor de ${(roeBenchmark * 100).toFixed(1)}% (${diff >= 0 ? "+" : ""}${diff.toFixed(0)}%)`);
  }

  const dyBenchmark = benchmark.avgDividendYield != null ? parseFloat(benchmark.avgDividendYield) : null;
  if (f.dividendYield != null && dyBenchmark != null) {
    const diff = pctDiff(f.dividendYield, dyBenchmark);
    lines.push(`DY de ${(f.dividendYield * 100).toFixed(1)}% vs. mediana do setor de ${(dyBenchmark * 100).toFixed(1)}% (${diff >= 0 ? "+" : ""}${diff.toFixed(0)}%)`);
  }

  if (lines.length === 0) return `Comparação com o setor "${f.sector}" não disponível (fundamentos insuficientes pra comparar).`;
  return `Setor "${f.sector}": ${lines.join("; ")} (amostra real de ${benchmark.sampleSize} tickers do setor).`;
}
