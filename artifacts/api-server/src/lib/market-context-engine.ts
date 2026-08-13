import type { OhlcPoint } from "./market-data";
import type { RiskPosition } from "./portfolio-risk-metrics";

/**
 * "Sou eu ou é o mercado?" — a pergunta que a tela de carteira não respondia.
 *
 * Quatro etiquetas vermelhas dizem que tudo caiu e nada mais. Medido na carteira que
 * motivou isto: em 5 pregões ela caiu 1,59% enquanto o IBOV caiu 4,81%. A carteira
 * defensiva fez exatamente o que se espera dela, e a tela mostrava só prejuízo.
 *
 * O segundo número corrige um viés de leitura pior. As mesmas 4 posições:
 *
 *   KLBN3   caiu 4,53%  -> custou 0,12pp   (pesa  2,6%)
 *   MXRF11  caiu 1,48%  -> custou 1,00pp   (pesa 67,2%)
 *
 * O que mais caiu quase não importou; o que menos caiu explicou 63% da queda. Ordenar
 * por variação — que é o que o olho faz sozinho — leva à conclusão errada. Por isso a
 * atribuição é por CONTRIBUIÇÃO (peso × movimento), não por variação.
 *
 * Mesma fonte e mesmas regras de portfolio-risk-metrics.ts: fechamento ajustado, só
 * datas comuns a todos os ativos cobertos, renda fixa fora da conta e reportada.
 */

/** Janelas em pregões. 21 ≈ um mês de bolsa. */
const WINDOWS = [
  { label: "1 dia", sessions: 1 },
  { label: "1 semana", sessions: 5 },
  { label: "1 mês", sessions: 21 },
] as const;

/** Janela usada na atribuição: curta o bastante para ser "o que houve agora". */
const ATTRIBUTION_SESSIONS = 5;

export interface MarketContextWindow {
  label: string;
  sessions: number;
  portfolioPercent: number;
  benchmarkPercent: number | null;
}

export interface DropAttribution {
  ticker: string;
  weightPercent: number;
  movePercent: number;
  /** Peso × movimento, em pontos percentuais da carteira. Soma ≈ variação total. */
  contributionPp: number;
}

export interface MarketContext {
  windows: MarketContextWindow[];
  attribution: DropAttribution[];
  attributionSessions: number;
  attributionTotalPercent: number;
  benchmarkLabel: string;
  /** Preenchido quando o benchmark exibido não é o mais adequado à carteira. */
  benchmarkNote: string | null;
  coveragePercent: number;
  uncovered: string[];
  /** Último pregão em comum — a data a que TODOS os números se referem. */
  asOf: string;
}

function moveOver(points: { value: number }[], sessions: number): number | null {
  if (points.length <= sessions) return null;
  const from = points[points.length - 1 - sessions].value;
  const to = points[points.length - 1].value;
  return from > 0 ? (to / from - 1) * 100 : null;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export function computeMarketContext(
  positions: RiskPosition[],
  seriesByTicker: Map<string, OhlcPoint[]>,
  benchmark: { label: string; series: OhlcPoint[] | null; note: string | null },
  totalPortfolioValue: number,
): MarketContext | null {
  const covered = positions.filter((p) => (seriesByTicker.get(p.ticker)?.length ?? 0) > 0);
  const uncovered = positions.filter((p) => !covered.includes(p)).map((p) => p.ticker);
  if (covered.length === 0) return null;

  const dateSets = covered.map((p) => new Set(seriesByTicker.get(p.ticker)!.map((d) => d.date)));
  const commonDates = seriesByTicker
    .get(covered[0].ticker)!
    .map((d) => d.date)
    .filter((date) => dateSets.every((s) => s.has(date)))
    .sort();

  // Sem duas datas não há variação nenhuma para medir — nem a de 1 pregão.
  if (commonDates.length < 2) return null;

  const closeByTicker = new Map<string, Map<string, number>>();
  for (const p of covered) {
    closeByTicker.set(p.ticker, new Map(seriesByTicker.get(p.ticker)!.map((d) => [d.date, d.adjustedClose])));
  }

  const portfolioPoints = commonDates.map((date) => ({
    date,
    value: covered.reduce((sum, p) => sum + p.quantity * (closeByTicker.get(p.ticker)!.get(date) ?? 0), 0),
  }));

  // O benchmark é recortado nas MESMAS datas: comparar intervalos diferentes seria
  // repetir o erro que o comparativo já corrigiu com a janela comum.
  const commonSet = new Set(commonDates);
  const benchmarkPoints = (benchmark.series ?? [])
    .filter((d) => commonSet.has(d.date))
    .map((d) => ({ date: d.date, value: d.adjustedClose }));

  const windows: MarketContextWindow[] = [];
  for (const w of WINDOWS) {
    const portfolioPercent = moveOver(portfolioPoints, w.sessions);
    if (portfolioPercent == null) continue; // janela mais longa que o histórico: omitida, não zerada
    windows.push({
      label: w.label,
      sessions: w.sessions,
      portfolioPercent: round2(portfolioPercent),
      benchmarkPercent: benchmarkPoints.length > w.sessions ? round2(moveOver(benchmarkPoints, w.sessions)!) : null,
    });
  }
  if (windows.length === 0) return null;

  // ── atribuição ────────────────────────────────────────────────────────────────
  const sessions = Math.min(ATTRIBUTION_SESSIONS, commonDates.length - 1);
  const idxThen = commonDates.length - 1 - sessions;
  const valueAt = (p: RiskPosition, i: number) => p.quantity * (closeByTicker.get(p.ticker)!.get(commonDates[i]) ?? 0);

  const totalThen = covered.reduce((s, p) => s + valueAt(p, idxThen), 0);
  const totalNow = covered.reduce((s, p) => s + valueAt(p, commonDates.length - 1), 0);

  const attribution: DropAttribution[] = covered
    .map((p) => {
      const then = valueAt(p, idxThen);
      const now = valueAt(p, commonDates.length - 1);
      return {
        ticker: p.ticker,
        weightPercent: totalNow > 0 ? round2((now / totalNow) * 100) : 0,
        movePercent: then > 0 ? round2((now / then - 1) * 100) : 0,
        contributionPp: totalThen > 0 ? round2(((now - then) / totalThen) * 100) : 0,
      };
    })
    // Por CONTRIBUIÇÃO absoluta, não por variação: é o ponto inteiro deste bloco.
    .sort((a, b) => Math.abs(b.contributionPp) - Math.abs(a.contributionPp));

  return {
    windows,
    attribution,
    attributionSessions: sessions,
    attributionTotalPercent: totalThen > 0 ? round2((totalNow / totalThen - 1) * 100) : 0,
    benchmarkLabel: benchmark.label,
    benchmarkNote: benchmark.note,
    coveragePercent:
      totalPortfolioValue > 0
        ? Math.round((covered.reduce((s, p) => s + p.value, 0) / totalPortfolioValue) * 1000) / 10
        : 0,
    uncovered,
    asOf: commonDates[commonDates.length - 1],
  };
}
