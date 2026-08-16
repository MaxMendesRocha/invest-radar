import { computeAssetCorrelations, type CorrelationPosition } from "../src/lib/correlation-engine";
import type { OhlcPoint } from "../src/lib/market-data";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FALHA"} ${label}\n      obtido   ${a}\n      esperado ${e}`);
}

function approx(label: string, actual: number, expected: number, tolerance = 0.02): void {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FALHA"} ${label}\n      obtido   ${actual}\n      esperado ~${expected} (±${tolerance})`);
}

/** `n` fechamentos, um por dia útil corrido a partir de 2026-01-01, seguindo `pattern` (um retorno diário por passo). */
function series(pattern: number[]): OhlcPoint[] {
  const points: OhlcPoint[] = [];
  let price = 100;
  const start = new Date("2026-01-01T00:00:00.000Z");
  for (let i = 0; i <= pattern.length; i++) {
    const date = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    points.push({ date, close: price, adjustedClose: price, volume: 1000 });
    if (i < pattern.length) price *= 1 + pattern[i];
  }
  return points;
}

// 65 passos (66 pontos) — acima do piso de 60 pregões.
const N = 65;
const baseUp = Array.from({ length: N }, (_, i) => (i % 3 === 0 ? 0.02 : i % 3 === 1 ? -0.01 : 0.005));
const baseAlternating = Array.from({ length: N }, (_, i) => (i % 2 === 0 ? 0.015 : -0.008));

function pos(ticker: string, value: number): CorrelationPosition {
  return { ticker, value };
}

// --- Correlação perfeita positiva: dois ativos com retornos diários IDÊNTICOS ---
{
  const seriesByTicker = new Map([
    ["AAAA3", series(baseUp)],
    ["BBBB3", series(baseUp)],
  ]);
  const result = computeAssetCorrelations([pos("AAAA3", 1000), pos("BBBB3", 1000)], seriesByTicker, 2000);
  check("correlação perfeita positiva (retornos idênticos)", result?.pairs[0]?.correlation, 1);
  check("peso combinado do único par = 100% do coberto", result?.pairs[0]?.combinedWeightPercent, 100);
}

// --- Correlação perfeita negativa: B é o espelho de A ---
{
  const inverted = baseUp.map((r) => -r);
  const seriesByTicker = new Map([
    ["CCCC3", series(baseUp)],
    ["DDDD3", series(inverted)],
  ]);
  const result = computeAssetCorrelations([pos("CCCC3", 500), pos("DDDD3", 500)], seriesByTicker, 1000);
  check("correlação perfeita negativa (espelho exato)", result?.pairs[0]?.correlation, -1);
}

// --- Padrões diferentes: nem +1 nem -1 ---
{
  const seriesByTicker = new Map([
    ["EEEE3", series(baseUp)],
    ["FFFF3", series(baseAlternating)],
  ]);
  const result = computeAssetCorrelations([pos("EEEE3", 500), pos("FFFF3", 500)], seriesByTicker, 1000);
  const c = result?.pairs[0]?.correlation ?? 999;
  const ok = Math.abs(c) < 0.99;
  console.log(`${ok ? "OK  " : "FALHA"} padrões diferentes não colam em ±1\n      correlação: ${c}`);
  if (!ok) failures++;
}

// --- Abaixo do piso de pregões: null ---
{
  const shortPattern = Array.from({ length: 30 }, () => 0.01);
  const seriesByTicker = new Map([
    ["GGGG3", series(shortPattern)],
    ["HHHH3", series(shortPattern)],
  ]);
  const result = computeAssetCorrelations([pos("GGGG3", 100), pos("HHHH3", 100)], seriesByTicker, 200);
  check("abaixo do piso de pregões -> null", result, null);
}

// --- Um só ativo cotado: não há par, null ---
{
  const seriesByTicker = new Map([["IIII3", series(baseUp)]]);
  const result = computeAssetCorrelations([pos("IIII3", 100)], seriesByTicker, 100);
  check("um único ativo cotado -> null (sem par a medir)", result, null);
}

// --- Ativo sem série (renda fixa) entra em `uncovered`, não quebra o cálculo dos outros ---
{
  const seriesByTicker = new Map([
    ["JJJJ3", series(baseUp)],
    ["KKKK3", series(baseUp)],
    // "TESOURO SELIC 2027" nunca tem entrada no map — sem série de bolsa.
  ]);
  const result = computeAssetCorrelations(
    [pos("JJJJ3", 400), pos("KKKK3", 400), pos("TESOURO SELIC 2027", 1200)],
    seriesByTicker,
    2000,
  );
  check("ativo sem série vai para uncovered", result?.uncovered, ["TESOURO SELIC 2027"]);
  check("cobertura = só o valor com série, sobre o total", result?.coveragePercent, 40); // 800/2000
}

// --- Três ativos: só os pares com correlação alta entram na contagem, os outros não ---
{
  const seriesByTicker = new Map([
    ["LLLL3", series(baseUp)],
    ["MMMM3", series(baseUp)], // idêntico a LLLL3 -> par de alta correlação
    ["NNNN3", series(baseAlternating)], // diferente dos outros dois
  ]);
  const result = computeAssetCorrelations(
    [pos("LLLL3", 300), pos("MMMM3", 300), pos("NNNN3", 300)],
    seriesByTicker,
    900,
  );
  check("3 pares no total (3 ativos)", result?.totalPairs, 3);
  const highCount = result?.highlyCorrelatedCount ?? -1;
  console.log(`${highCount === 1 ? "OK  " : "FALHA"} exatamente 1 par acima do limiar (LLLL3×MMMM3)\n      obtido: ${highCount}`);
  if (highCount !== 1) failures++;
}

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
