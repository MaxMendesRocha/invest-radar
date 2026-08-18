import { db, sectorBenchmarksTable, opportunitiesTable, type SectorBenchmark } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getFiiProfiles, type Fundamentals } from "./market-data";

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

export interface FiiPeer {
  ticker: string;
  priceToNav: number | null;
  dividendYield: number | null;
  equity: number | null;
}

/**
 * Pares REAIS do mesmo segmento de FII, nomeados — não só a mediana acima. Existe
 * porque P/VP nem entra em `describeSectorComparison`: `Fundamentals` carrega P/L, ROE
 * e DY (métricas de empresa), e FII não tem P/L nem ROE. A mediana do setor pra FII
 * hoje só compara DY; P/VP contra pares nomeados fecha essa lacuna.
 *
 * Candidatos vêm de `opportunities` (persistida semanalmente por
 * regenerateOpportunities, mesma fonte já usada pra mediana setorial) — nunca refaz o
 * scan do universo aqui, seria caro demais por Parecer de Ativo. P/VP, DY e patrimônio
 * vêm ao vivo de `getFiiProfiles` (cache de 24h), porque `opportunities` não guarda
 * P/VP.
 *
 * Limitação honesta, não escondida: só entram fundos que passaram no piso de
 * elegibilidade da última varredura (`evalFiiEligibility`) — um FII real do segmento
 * pode ficar de fora por não atender liquidez/patrimônio mínimo, não porque não existe.
 */
export async function getFiiPeers(segmentLabel: string, excludeTicker: string, limit = 3): Promise<FiiPeer[]> {
  const rows = await db
    .select({ ticker: opportunitiesTable.ticker })
    .from(opportunitiesTable)
    .where(and(eq(opportunitiesTable.category, "fiis"), eq(opportunitiesTable.sector, segmentLabel)));

  const candidateTickers = rows
    .map((r) => r.ticker.toUpperCase())
    .filter((t) => t !== excludeTicker.toUpperCase());
  if (candidateTickers.length === 0) return [];

  const profiles = await getFiiProfiles(candidateTickers);
  const peers: FiiPeer[] = [];
  for (const ticker of candidateTickers) {
    const p = profiles.get(ticker);
    if (!p) continue;
    peers.push({ ticker, priceToNav: p.priceToNav, dividendYield: p.dividendYield12m, equity: p.equity });
  }

  // Maior patrimônio primeiro — proxy de relevância/liquidez, mesmo critério que o
  // resto do app já usa pra ordenar FII por tamanho.
  peers.sort((a, b) => (b.equity ?? 0) - (a.equity ?? 0));
  return peers.slice(0, limit);
}

export function describeFiiPeers(peers: FiiPeer[]): string {
  if (peers.length === 0) return "";
  const parts = peers.map((p) => {
    const bits: string[] = [];
    if (p.priceToNav != null) bits.push(`P/VP ${p.priceToNav.toFixed(2)}`);
    if (p.dividendYield != null) bits.push(`DY ${(p.dividendYield * 100).toFixed(1)}%`);
    return bits.length > 0 ? `${p.ticker} (${bits.join(", ")})` : p.ticker;
  });
  return `Pares reais do mesmo segmento (última varredura de Oportunidades): ${parts.join("; ")}.`;
}
