import { getFiiProfiles, getTechnicalSeries } from "../src/lib/market-data";
import { averageDailyVolumeValue, evalFiiEligibility } from "../src/lib/fii-engine";

/**
 * Mesma validação de fiação que fii-eligibility-live-check.mts, mas chamando só o
 * pedaço de FII (não o scan do universo inteiro) — o scan completo em paralelo está
 * estourando o limite de conexões concorrentes do sandbox agora. Ainda é a função
 * real (getFiiProfiles, getTechnicalSeries, evalFiiEligibility), contra a API real,
 * só sequencial em vez de ~170 tickers de uma vez.
 */
const TICKERS = ["LSOP11", "PMIS11", "MIDW11", "VINO11", "KCRE11", "HGLG11", "MXRF11", "KNCR11", "XPLG11"];

const profiles = await getFiiProfiles(TICKERS);
const series = await getTechnicalSeries(TICKERS);

console.log("ticker    equity(mi)   volMedio21d   elegível  motivo");
for (const ticker of TICKERS) {
  const profile = profiles.get(ticker);
  const avgVolume = averageDailyVolumeValue(series.get(ticker) ?? []);
  const eligibility = evalFiiEligibility(avgVolume, profile?.equity ?? null);
  const equityMi = profile?.equity != null ? (profile.equity / 1_000_000).toFixed(0) : "null";
  const volFmt = avgVolume != null ? Math.round(avgVolume).toLocaleString("pt-BR") : "null";
  console.log(
    `${ticker.padEnd(9)} ${equityMi.padStart(10)}   ${volFmt.padStart(12)}   ${String(eligibility.eligible).padEnd(8)}  ${eligibility.reason ?? ""}`,
  );
}

process.exit(0);
