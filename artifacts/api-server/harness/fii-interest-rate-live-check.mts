import { getMacroSnapshot } from "../src/lib/macro-data";
import { getFiiProfiles } from "../src/lib/market-data";
import { describeFiiInterestRateSensitivity } from "../src/lib/fii-engine";

/**
 * Fiação real: Selic/tendência de verdade (BCB) cruzada com segmento real (brapi)
 * de FIIs conhecidos, um de cada segmento presente na amostra.
 */
const macro = await getMacroSnapshot();
console.log(`Selic real: ${macro.selic}% (tendência: ${macro.selicTrend})\n`);

const tickers = ["MXRF11", "HGLG11", "GARE11", "CPTS11"]; // papel, tijolo, fof, fof (conferindo dois fof)
const profiles = await getFiiProfiles(tickers);

for (const ticker of tickers) {
  const segment = profiles.get(ticker)?.segmentType ?? null;
  const line = describeFiiInterestRateSensitivity(segment, macro.selicTrend);
  console.log(`${ticker} (${segment}): ${line}`);
}

process.exit(0);
