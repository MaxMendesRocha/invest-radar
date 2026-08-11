/**
 * Comparativo: e se a saúde financeira entrasse no SCORE?
 *
 * Mesmo protocolo da recalibração anterior — congela os fundamentos do universo em
 * disco e roda os dois motores sobre a MESMA entrada. Sem isso, qualquer conclusão
 * sobre "subiu" ou "caiu" estaria misturada com variação de cotação entre execuções.
 *
 * Não altera nada em produção: o motor candidato vive aqui dentro.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { getFundamentals, getDividendEventsForTicker, sumLast12Months, type Fundamentals } from "../src/lib/market-data";
import { analyzeFundamentals } from "../src/lib/analysis-engine";
import { computeFinancialHealth } from "../src/lib/financial-health-engine";
import { fetchTickerUniverse } from "../src/lib/ticker-universe";

const CACHE = "/tmp/health-harness-frozen.json";

interface Frozen { ticker: string; fundamentals: Fundamentals; dps12m: number | null }

async function freeze(): Promise<Frozen[]> {
  if (existsSync(CACHE)) {
    const rows = JSON.parse(readFileSync(CACHE, "utf8")) as Frozen[];
    console.log(`universo congelado reaproveitado: ${rows.length} ativos`);
    return rows;
  }
  const universe = (await fetchTickerUniverse()).filter((u) => u.category === "acoes");
  const tickers = universe.map((u) => u.ticker);
  console.log(`buscando fundamentos de ${tickers.length} ações...`);
  const f = await getFundamentals(tickers);

  const rows: Frozen[] = [];
  for (const t of tickers) {
    const fund = f.get(t);
    if (!fund) continue;
    const dps12m = sumLast12Months(await getDividendEventsForTicker(t), Date.now());
    rows.push({ ticker: t, fundamentals: fund, dps12m });
  }
  writeFileSync(CACHE, JSON.stringify(rows));
  console.log(`congelado: ${rows.length} ativos com fundamentos`);
  return rows;
}

// ── motor CANDIDATO: saúde financeira como quarto componente ────────────────────
function interpolate(value: number, points: readonly (readonly [number, number])[]): number {
  const first = points[0];
  if (value <= first[0]) return first[1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (value <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((value - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return points[points.length - 1][1];
}

const NOT_COMPARABLE = new Set(["Serviços Financeiros", "Seguros"]);

/** Nota 0–100 de saúde financeira, média do que existir. Null quando nada existe. */
function healthScoreFor(f: Fundamentals, dps12m: number | null): number | null {
  if (f.sector != null && NOT_COMPARABLE.has(f.sector)) return null;
  const h = computeFinancialHealth(f, dps12m);
  const parts: number[] = [];
  if (h.dividendCashCoverage != null) {
    parts.push(interpolate(h.dividendCashCoverage, [[-1, 10], [0, 25], [1, 60], [1.5, 80], [3, 92]]));
  }
  if (h.netDebtToEbitda != null) {
    const median = f.sector != null ? leverageMedianBySector.get(f.sector) : undefined;
    if (MODE === "relativo" && median != null && median > 0) {
      // Quantas vezes a mediana do setor. 1,0 = alavancagem típica dos pares.
      parts.push(interpolate(h.netDebtToEbitda / median, [[0.3, 92], [0.7, 80], [1, 65], [1.5, 45], [2.5, 22]]));
    } else {
      parts.push(interpolate(h.netDebtToEbitda, [[-1, 95], [0, 90], [1, 80], [3, 55], [5, 30], [8, 12]]));
    }
  }
  if (h.cashConversion != null) {
    parts.push(interpolate(h.cashConversion, [[-0.5, 10], [0, 25], [0.5, 55], [0.8, 80], [1.2, 92]]));
  }
  if (h.currentRatio != null) {
    parts.push(interpolate(h.currentRatio, [[0.5, 20], [1, 55], [1.5, 80], [2.5, 92]]));
  }
  return parts.length > 0 ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
}

const HEALTH_WEIGHT = Number(process.argv[2] ?? "0.15");
/**
 * `relativo` mede alavancagem contra a MEDIANA DO PRÓPRIO SETOR em vez de uma curva
 * absoluta. É a hipótese a testar: se o problema da versão absoluta é penalizar
 * transmissora por ser transmissora, comparar cada papel com os pares deveria
 * dissolver o viés — ou provar que ele não era viés, e sim o dado.
 */
const MODE = process.argv[3] ?? "absoluto";

/** Mediana de dívida líquida/EBITDA por setor, tirada do próprio universo congelado. */
let leverageMedianBySector = new Map<string, number>();

function buildSectorMedians(rows: Frozen[]): void {
  const bySector = new Map<string, number[]>();
  for (const r of rows) {
    const s = r.fundamentals.sector;
    if (s == null || NOT_COMPARABLE.has(s)) continue;
    const h = computeFinancialHealth(r.fundamentals, r.dps12m);
    if (h.netDebtToEbitda == null) continue;
    if (!bySector.has(s)) bySector.set(s, []);
    bySector.get(s)!.push(h.netDebtToEbitda);
  }
  leverageMedianBySector = new Map(
    [...bySector.entries()]
      // Menos de 4 pares não faz mediana confiável — sem base, cai no absoluto.
      .filter(([, xs]) => xs.length >= 4)
      .map(([s, xs]) => {
        const sorted = [...xs].sort((a, b) => a - b);
        return [s, sorted[Math.floor(sorted.length / 2)]] as const;
      }),
  );
}

function band(score: number): string {
  if (score >= 88) return "Excelente";
  if (score >= 82) return "Forte";
  if (score >= 65) return "Estavel";
  if (score >= 45) return "Atencao";
  return "Critico";
}

const frozen = await freeze();
buildSectorMedians(frozen);
const results: { ticker: string; before: number; after: number; sector: string | null }[] = [];

for (const row of frozen) {
  const base = analyzeFundamentals(row.fundamentals, row.dps12m);
  if (!base.available) continue;

  const hs = healthScoreFor(row.fundamentals, row.dps12m);
  // Reconstrói a média do motor atual a partir do score publicado e acrescenta o novo
  // componente com o peso testado, renormalizando — mesma mecânica de "excluir o que
  // não se sabe" que os pesos já usam.
  const after = hs == null ? base.score : Math.round((base.score * 0.6 + hs * HEALTH_WEIGHT) / (0.6 + HEALTH_WEIGHT));
  results.push({ ticker: row.ticker, before: base.score, after, sector: row.fundamentals.sector });
}

const n = results.length;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const before = results.map((r) => r.before);
const after = results.map((r) => r.after);

console.log(`\n=== peso ${HEALTH_WEIGHT} · modo ${MODE} · ${n} ações ===\n`);
console.log(`média   ${mean(before).toFixed(1)}  ->  ${mean(after).toFixed(1)}`);
console.log(`mínimo  ${Math.min(...before)}  ->  ${Math.min(...after)}`);
console.log(`máximo  ${Math.max(...before)}  ->  ${Math.max(...after)}`);

const bands = ["Excelente", "Forte", "Estavel", "Atencao", "Critico"];
console.log("\nfaixa        antes  depois");
for (const b of bands) {
  const a = results.filter((r) => band(r.before) === b).length;
  const d = results.filter((r) => band(r.after) === b).length;
  console.log(`  ${b.padEnd(10)} ${String(a).padStart(4)}  ${String(d).padStart(5)}`);
}

const changed = results.filter((r) => band(r.before) !== band(r.after));
console.log(`\nmudaram de faixa: ${changed.length} de ${n} (${((changed.length / n) * 100).toFixed(0)}%)`);

const lostBuy = results.filter((r) => r.before >= 82 && r.after < 82);
const gainedBuy = results.filter((r) => r.before < 82 && r.after >= 82);
console.log(`deixam de atender ao corte de compra: ${lostBuy.length} -> ${lostBuy.map((r) => `${r.ticker} (${r.before}->${r.after})`).join(", ") || "nenhum"}`);
console.log(`passam a atender:                     ${gainedBuy.length} -> ${gainedBuy.map((r) => `${r.ticker} (${r.before}->${r.after})`).join(", ") || "nenhum"}`);

const movers = [...results].sort((a, b) => (a.after - a.before) - (b.after - b.before));
console.log("\nmaiores quedas:");
for (const r of movers.slice(0, 6)) console.log(`  ${r.ticker.padEnd(7)} ${r.before} -> ${r.after}  (${r.after - r.before})  ${r.sector ?? "-"}`);
console.log("maiores altas:");
for (const r of movers.slice(-4).reverse()) console.log(`  ${r.ticker.padEnd(7)} ${r.before} -> ${r.after}  (+${r.after - r.before})  ${r.sector ?? "-"}`);

const untouched = results.filter((r) => r.before === r.after).length;
console.log(`\nsem nenhuma mudança (financeiras + sem dado de caixa): ${untouched}`);

// O teste decisivo: a penalidade se distribui pelo mercado ou cai num setor só?
const bySector = new Map<string, number[]>();
for (const r of results) {
  const s = r.sector ?? "(sem setor)";
  if (!bySector.has(s)) bySector.set(s, []);
  bySector.get(s)!.push(r.after - r.before);
}
console.log("\ndelta médio por setor (n >= 3):");
const rows = [...bySector.entries()]
  .filter(([, ds]) => ds.length >= 3)
  .map(([s, ds]) => ({ setor: s, n: ds.length, delta: mean(ds) }))
  .sort((a, b) => a.delta - b.delta);
for (const r of rows) console.log(`  ${r.setor.padEnd(24)} n=${String(r.n).padStart(2)}  ${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(1)}`);
process.exit(0);
