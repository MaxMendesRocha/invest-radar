import { computeDupont, describeDupont, dupontFor } from "../src/lib/dupont";
import { getFinancialSeriesForTicker } from "../src/lib/financial-history";

/**
 * A decomposição do ROE contra a série real da CVM.
 *
 * O caso central não é "a conta está certa" — a conta é uma identidade algébrica e não
 * pode estar errada. É **quando a decomposição se recusa a existir**: sem os quatro
 * números, com eles em exercícios diferentes, ou com denominador não positivo. Um DuPont
 * montado com margem de um ano e alavancagem de outro produz um número que não é o ROE de
 * ano nenhum, e não tem nada na cara dele que denuncie isso.
 */

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FALHA"} ${label}\n      obtido   ${a}\n      esperado ${e}`);
}

const round = (v: number, casas = 4) => Number(v.toFixed(casas));

// --- A identidade ----------------------------------------------------------

// Um banco: margem fina, giro baixíssimo, alavancagem alta. É o formato que o número
// agregado esconde, e a razão de a decomposição existir.
const banco = computeDupont({
  periodEnd: "2025-12-31",
  lucro: 35_000,
  receita: 200_000,
  ativo: 2_500_000,
  patrimonio: 164_474,
})!;
check("margem = lucro / receita", round(banco.netMargin), 0.175);
check("giro = receita / ativo", round(banco.assetTurnover), 0.08);
check("alavancagem = ativo / PL", round(banco.leverage, 2), 15.2);

// O ROE do produto tem de bater com lucro/PL calculado direto. Se divergir, a
// decomposição está mostrando um número que não é o ROE — que é o defeito que ela existe
// para tornar impossível.
check(
  "produto das três = lucro / PL",
  round(banco.roe, 6),
  round(35_000 / 164_474, 6),
);
console.log(`      identidade: ${describeDupont(banco)}`);

// Uma indústria de margem alta e pouca dívida: mesmo ROE, origem oposta à do banco.
const industria = computeDupont({
  periodEnd: "2025-12-31",
  lucro: 300,
  receita: 1_000,
  ativo: 1_200,
  patrimonio: 900,
})!;
check("mesmo ROE não significa mesma origem", round(industria.roe, 4), round(300 / 900, 4));
console.log(`      identidade: ${describeDupont(industria)}`);

// --- Quando a decomposição se recusa ---------------------------------------

// Patrimônio negativo existe de verdade (empresa com passivo a descoberto). A
// alavancagem sairia negativa e não significaria nada como "alavanca".
check(
  "patrimônio negativo recusa",
  computeDupont({ periodEnd: "2025-12-31", lucro: 10, receita: 100, ativo: 500, patrimonio: -50 }),
  null,
);
check(
  "receita zero recusa",
  computeDupont({ periodEnd: "2025-12-31", lucro: 10, receita: 0, ativo: 500, patrimonio: 100 }),
  null,
);
check(
  "ativo zero recusa",
  computeDupont({ periodEnd: "2025-12-31", lucro: 10, receita: 100, ativo: 0, patrimonio: 100 }),
  null,
);

// Prejuízo NÃO recusa: margem negativa × giro × alavancagem = ROE negativo, e isso é
// informação legítima. Recusar aqui esconderia o ano ruim.
const prejuizo = computeDupont({
  periodEnd: "2025-12-31",
  lucro: -50,
  receita: 1_000,
  ativo: 2_000,
  patrimonio: 500,
});
check("prejuízo é decomposto, não recusado", prejuizo != null, true);
check("ROE sai negativo", prejuizo!.roe < 0, true);

// --- Contra a série real da CVM --------------------------------------------

const TICKERS = ["PETR4", "BBAS3", "WEGE3", "ITUB4", "VALE3"];
console.log("\n--- decomposição real (série da CVM em produção local) ---");

let comDados = 0;
for (const ticker of TICKERS) {
  const d = await dupontFor(ticker);
  if (!d) {
    console.log(`     ${ticker.padEnd(7)} sem decomposição (série incompleta) — resposta válida`);
    continue;
  }
  comDados++;
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  console.log(
    `     ${ticker.padEnd(7)} ${d.periodEnd}  margem ${pct(d.netMargin).padStart(7)}` +
    ` × giro ${d.assetTurnover.toFixed(2)} × alav ${d.leverage.toFixed(2)} = ROE ${pct(d.roe)}`,
  );

  // A identidade tem de fechar com o lucro/PL da própria série, lido de novo.
  const [lucro, pl] = await Promise.all([
    getFinancialSeriesForTicker(ticker, "lucro_liquido"),
    getFinancialSeriesForTicker(ticker, "patrimonio_liquido"),
  ]);
  const direto = lucro[lucro.length - 1].value / pl[pl.length - 1].value;
  const erro = Math.abs(d.roe - direto);
  if (erro > 1e-9) {
    failures++;
    console.log(`FALHA ${ticker}: produto ${d.roe} != lucro/PL ${direto} (erro ${erro})`);
  }
}
check("ao menos uma companhia real decompôs", comDados > 0, true);

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
