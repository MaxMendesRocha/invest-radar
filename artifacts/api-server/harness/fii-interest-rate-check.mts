import { describeFiiInterestRateSensitivity } from "../src/lib/fii-engine";

let failures = 0;
function check(label: string, condition: boolean, detail: string): void {
  console.log(`${condition ? "OK  " : "FALHA"} ${label}`);
  if (!condition) {
    console.log(`      ${detail}`);
    failures++;
  }
}

// --- Casos ausentes: string vazia, nunca "não disponível" poluindo o prompt -------
check("sem segmento -> vazio", describeFiiInterestRateSensitivity(null, "alta") === "", "esperava string vazia");
check("sem tendência -> vazio", describeFiiInterestRateSensitivity("papel", null) === "", "esperava string vazia");
check("sem os dois -> vazio", describeFiiInterestRateSensitivity(null, null) === "", "esperava string vazia");

// --- Papel: direção de RENDA correta nas 3 tendências ------------------------------
{
  const alta = describeFiiInterestRateSensitivity("papel", "alta");
  check("papel + alta: fala que a renda SOBE", alta.includes("tende a subir"), alta);
  check("papel + alta: não afirma direção de preço", !alta.toLowerCase().includes("preço") && !alta.toLowerCase().includes("cota"), alta);
}
{
  const queda = describeFiiInterestRateSensitivity("papel", "queda");
  check("papel + queda: fala que a renda ENCOLHE", queda.includes("encolher"), queda);
}
{
  const estavel = describeFiiInterestRateSensitivity("papel", "estavel");
  check("papel + estável: sem direção, menciona nível atual", estavel.includes("nível atual"), estavel);
}

// --- Tijolo: direção de PREÇO correta nas 3 tendências ------------------------------
{
  const alta = describeFiiInterestRateSensitivity("tijolo", "alta");
  check("tijolo + alta: fala de compressão de preço/desconto maior", alta.toLowerCase().includes("desconta"), alta);
}
{
  const queda = describeFiiInterestRateSensitivity("tijolo", "queda");
  check("tijolo + queda: fala de benefício no preço", queda.includes("beneficiar") && queda.toLowerCase().includes("preço"), queda);
}
{
  const estavel = describeFiiInterestRateSensitivity("tijolo", "estavel");
  check("tijolo + estável: aponta pro mercado imobiliário, não pro juro", estavel.toLowerCase().includes("vacância"), estavel);
}

// --- Híbrido e FoF: nunca afirmam direção, qualquer que seja a tendência -----------
for (const trend of ["alta", "queda", "estavel"] as const) {
  const hibrido = describeFiiInterestRateSensitivity("hibrido", trend);
  check(`híbrido + ${trend}: diz que não dá pra afirmar direção`, hibrido.includes("não dá para afirmar"), hibrido);

  const fof = describeFiiInterestRateSensitivity("fof", trend);
  check(`fof + ${trend}: diz que não dá pra afirmar direção`, fof.includes("não dá para afirmar"), fof);
}

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
