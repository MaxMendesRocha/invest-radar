import { getFiiProfiles } from "../src/lib/market-data";
import { getFiiCvmData } from "../src/lib/cvm-data";
import { describeFiiCvmComposition } from "../src/lib/fii-engine";

/**
 * Fiação real: baixa o Informe Mensal FII real da CVM (dados.cvm.gov.br), cruza pelo
 * CNPJ real vindo da brapi, e confere contra números medidos manualmente em
 * 15-17/08/2026 (ver docs/analises-ia.md e a investigação que motivou esta feature).
 */
const tickers = ["HGLG11", "MXRF11"]; // tijolo (predominantemente imóveis diretos), papel (predominantemente CRI)
const profiles = await getFiiProfiles(tickers);

for (const ticker of tickers) {
  const profile = profiles.get(ticker);
  console.log(`\n=== ${ticker} ===`);
  console.log(`segmento: ${profile?.segmentType}, cnpj: ${profile?.cnpj}`);

  const cvmData = await getFiiCvmData(profile?.cnpj ?? null);
  if (!cvmData) {
    console.log("SEM DADO CVM — falhou ou fundo fora do informe mais recente");
    continue;
  }
  console.log(
    `referência: ${cvmData.dataReferencia} | imóveis diretos: ${(cvmData.imoveisDiretosPct * 100).toFixed(1)}% | ` +
      `recebíveis: ${(cvmData.recebiveisEstruturadosPct * 100).toFixed(1)}% | outros: ${(cvmData.outrosAtivosPct * 100).toFixed(1)}% | ` +
      `taxa adm mensal: ${cvmData.taxaAdministracaoMensalPct != null ? (cvmData.taxaAdministracaoMensalPct * 100).toFixed(3) + "%" : "indisponível"}`,
  );
  console.log(describeFiiCvmComposition(cvmData));
}

process.exit(0);
