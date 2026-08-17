import { describeFiiCvmComposition } from "../src/lib/fii-engine";

let failures = 0;
function check(label: string, condition: boolean, detail: string): void {
  console.log(`${condition ? "OK  " : "FALHA"} ${label}`);
  if (!condition) {
    console.log(`      ${detail}`);
    failures++;
  }
}

check("sem dado -> vazio", describeFiiCvmComposition(null) === "", "esperava string vazia");

{
  // Composição de um fundo de tijolo real (HGLG11, medido via CVM em 15/08): ~85%
  // imóveis diretos, ~12,7% SPE (cai em "outros" por não podermos afirmar o que a SPE
  // detém), ~0,4% CRI.
  const line = describeFiiCvmComposition({
    dataReferencia: "2026-07-01",
    imoveisDiretosPct: 0.8508,
    recebiveisEstruturadosPct: 0.00375,
    outrosAtivosPct: 0.1454,
    taxaAdministracaoMensalPct: 0.000489,
  });
  check("tijolo: cita referência mm/aaaa", line.includes("07/2026"), line);
  check("tijolo: cita % de imóveis diretos", line.includes("85%"), line);
  check("tijolo: cita % de recebíveis", line.includes("0%") || line.includes("1%"), line); // 0,375% arredonda pra 0%
  check("tijolo: cita taxa de administração mensal e anualizada", line.includes("0.05%") && line.includes("ao ano"), line);
}

{
  // Composição de um fundo de papel real (MXRF11): ~3,5% imóveis diretos, ~73,8% CRI.
  const line = describeFiiCvmComposition({
    dataReferencia: "2026-07-01",
    imoveisDiretosPct: 0.0354,
    recebiveisEstruturadosPct: 0.7379,
    outrosAtivosPct: 0.2267,
    taxaAdministracaoMensalPct: 0.00064,
  });
  check("papel: cita % de recebíveis alto", line.includes("74%"), line);
  check("papel: cita % de imóveis diretos baixo", line.includes("4%") || line.includes("3%"), line);
}

{
  // Sem taxa de administração disponível: a linha não pode afirmar 0% (seria dizer
  // "gestão gratuita", que é falso) — precisa simplesmente omitir a frase de taxa.
  const line = describeFiiCvmComposition({
    dataReferencia: "2026-06-01",
    imoveisDiretosPct: 0.5,
    recebiveisEstruturadosPct: 0.3,
    outrosAtivosPct: 0.2,
    taxaAdministracaoMensalPct: null,
  });
  check("sem taxa: não afirma 0%", !line.includes("Taxa de administração"), line);
}

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
