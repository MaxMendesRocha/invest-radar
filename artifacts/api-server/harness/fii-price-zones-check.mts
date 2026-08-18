import { computeFiiPriceZones, describeFiiPriceZones } from "../src/lib/fii-engine";

let failures = 0;
function check(label: string, condition: boolean, detail: string): void {
  console.log(`${condition ? "OK  " : "FALHA"} ${label}`);
  if (!condition) {
    console.log(`      ${detail}`);
    failures++;
  }
}

check("sem preço -> null", computeFiiPriceZones(0, 0.87, 1.3, 14) === null, "esperava null");
check("sem P/VP -> null", computeFiiPriceZones(8.2, 0, 1.3, 14) === null, "esperava null");
check("describe(null) -> vazio", describeFiiPriceZones(null) === "", "esperava string vazia");

{
  // Caso real: CYCR11 medido em 18/08 — preço R$8,20, P/VP 0,866, Selic 14%.
  // VP/cota = 8,20 / 0,866 ≈ 9,47 (bate com o navPerShare real de R$9,469 da brapi).
  const zones = computeFiiPriceZones(8.2, 0.866, null, null);
  check("VP/cota derivado bate com o real (~9,47)", zones != null && Math.abs(zones.navPerShare - 9.4688) < 0.01, JSON.stringify(zones));
  check("zona P/VP baixa = 0,85 x VP/cota", zones != null && Math.abs(zones.pvpZoneLow - 0.85 * zones.navPerShare) < 0.001, JSON.stringify(zones));
  check("zona P/VP alta = 0,95 x VP/cota", zones != null && Math.abs(zones.pvpZoneHigh - 0.95 * zones.navPerShare) < 0.001, JSON.stringify(zones));
  check("sem provento/Selic -> zona de yield null", zones?.yieldZoneLow === null && zones?.yieldZoneHigh === null, JSON.stringify(zones));
}

{
  // Com provento real (R$1,32/ano, igual ao documento) e Selic real de 14%:
  // referência líquida = 14 * 0,85 = 11,9%. Prêmio bom (2 p.p.) -> yield exigido 13,9%,
  // prêmio forte (4 p.p.) -> 15,9%. Preço = dividendo / (yield/100).
  const zones = computeFiiPriceZones(8.2, 0.866, 1.32, 14)!;
  const expectedHigh = 1.32 / (13.9 / 100); // ~9,50
  const expectedLow = 1.32 / (15.9 / 100); // ~8,30
  check("zona de yield alta bate com a conta manual", Math.abs((zones.yieldZoneHigh ?? 0) - expectedHigh) < 0.01, JSON.stringify(zones));
  check("zona de yield baixa bate com a conta manual", Math.abs((zones.yieldZoneLow ?? 0) - expectedLow) < 0.01, JSON.stringify(zones));
  check("zona baixa < zona alta (prêmio maior = preço menor)", (zones.yieldZoneLow ?? 0) < (zones.yieldZoneHigh ?? 0), JSON.stringify(zones));

  const text = describeFiiPriceZones(zones);
  check("texto cita zona de P/VP", text.includes("desconto saudável"), text);
  check("texto cita zona de yield", text.includes("yield exigido"), text);
  check("texto deixa claro que não é recomendação", text.includes("não é previsão nem recomendação"), text);
  console.log(`\n${text}`);
}

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
