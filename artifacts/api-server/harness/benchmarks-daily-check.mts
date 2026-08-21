import { computeDailyTwr, computeMonthlyTwr } from "../src/lib/time-weighted-return";
import { getCdiDailyReturns, getCdiMonthlyReturns } from "../src/lib/benchmark-data";
import type { PortfolioSnapshot, Sale } from "@workspace/db";

let failures = 0;
function check(label: string, condition: boolean, detail: string): void {
  console.log(`${condition ? "OK  " : "FALHA"} ${label}`);
  if (!condition) {
    console.log(`      ${detail}`);
    failures++;
  }
}

const snap = (date: string, value: number, cost: number): PortfolioSnapshot =>
  ({ id: 0, userId: 1, date, totalValue: String(value), totalCost: String(cost), createdAt: new Date() }) as PortfolioSnapshot;
const noSales: Sale[] = [];

// ── Diário e mensal têm que contar a mesma história ─────────────────────────
// O mensal é o comportamento que já estava em produção. Se o acumulado final divergir,
// a reescrita mexeu na matemática em vez de só na granularidade da chave.
{
  const snaps = [
    snap("2026-06-01", 1000, 1000),
    snap("2026-06-15", 1050, 1000),
    snap("2026-06-30", 1100, 1000),
    snap("2026-07-10", 1080, 1000),
    snap("2026-07-31", 1200, 1000),
  ];
  const daily = computeDailyTwr(snaps, noSales, null);
  const monthly = computeMonthlyTwr(snaps, noSales, null);

  const dailyLast = daily.get("2026-07-31")!.factor;
  const monthlyLast = monthly.get("2026-07")!.factor;
  check("acumulado final diário == mensal",
    Math.abs(dailyLast - monthlyLast) < 1e-12,
    `diário ${dailyLast} vs mensal ${monthlyLast}`);

  // O mensal guarda só o fechamento do mês; o diário guarda todas as medições.
  check("diário preserva os pontos intermediários que o mensal descartava",
    daily.size === 5 && monthly.size === 2,
    `diário ${daily.size} pontos, mensal ${monthly.size}`);

  check("fechamento de junho bate entre as duas granularidades",
    Math.abs(daily.get("2026-06-30")!.factor - monthly.get("2026-06")!.factor) < 1e-12,
    `${daily.get("2026-06-30")!.factor} vs ${monthly.get("2026-06")!.factor}`);
}

// ── Carteira esparsa: dia sem medição some, não vira zero ───────────────────
// É o caso que motivou o desenho. recordSnapshot só grava quando a pessoa abre o app,
// então buraco na série é o normal, não a exceção.
{
  const snaps = [
    snap("2026-08-03", 1000, 1000),
    snap("2026-08-04", 1010, 1000),
    // 05 a 09 sem acesso ao app
    snap("2026-08-10", 1040, 1000),
  ];
  const daily = computeDailyTwr(snaps, noSales, null);
  check("dia sem medição não aparece no mapa", !daily.has("2026-08-06"), "2026-08-06 apareceu");
  check("dias medidos aparecem todos", daily.size === 3, `${daily.size} pontos`);
  check("o salto por cima do buraco compõe certo (1040/1000)",
    Math.abs(daily.get("2026-08-10")!.factor - 1.04) < 1e-12,
    String(daily.get("2026-08-10")!.factor));
}

// ── Aporte não vira rendimento ──────────────────────────────────────────────
// A razão de o comparativo usar TWR: dinheiro novo entra na carteira mas não no índice.
{
  const snaps = [
    snap("2026-08-03", 1000, 1000),
    snap("2026-08-04", 2000, 2000), // aportou 1000, preço parado
  ];
  const daily = computeDailyTwr(snaps, noSales, null);
  check("aporte a preço de mercado não move o TWR",
    Math.abs(daily.get("2026-08-04")!.factor - 1) < 1e-12,
    String(daily.get("2026-08-04")!.factor));
}

// ── Quebra de cadeia: carteira zerada reinicia a série ──────────────────────
{
  const snaps = [
    snap("2026-08-03", 1000, 1000),
    snap("2026-08-04", 1100, 1000),
    snap("2026-08-05", 0, 0),       // vendeu tudo
    snap("2026-08-06", 500, 500),   // carteira nova
    snap("2026-08-07", 550, 500),
  ];
  const daily = computeDailyTwr(snaps, noSales, null);
  check("cadeia reinicia depois de carteira zerada",
    !daily.has("2026-08-03") && !daily.has("2026-08-04"),
    `sobraram ${[...daily.keys()].join(", ")}`);
  check("carteira nova conta a partir dela mesma (550/500)",
    Math.abs(daily.get("2026-08-07")!.factor - 1.1) < 1e-12,
    String(daily.get("2026-08-07")!.factor));
}

// ── Ao vivo: CDI diário composto tem que bater com o mensal ─────────────────
// Este é o teste que ancora a troca da série 4390 pela 12. Se divergirem por mais que
// arredondamento, a escala do campo está errada e o gráfico inteiro sai deslocado.
if (process.env.SKIP_LIVE_CHECKS !== "1") {
  console.log("\n--- ao vivo: CDI do Banco Central ---");
  const [daily, monthly] = await Promise.all([getCdiDailyReturns(), getCdiMonthlyReturns()]);
  check("série diária (12) tem pontos", daily.size > 100, `${daily.size} dias`);
  check("série mensal (4390) tem pontos", monthly.size > 6, `${monthly.size} meses`);

  // Compara meses inteiros já fechados: o mês corrente ainda está acumulando.
  const monthsToCheck = [...new Set([...daily.keys()].map((d) => d.slice(0, 7)))]
    .sort()
    .slice(0, -1)
    .slice(-3);

  for (const month of monthsToCheck) {
    const published = monthly.get(month);
    if (published == null) continue;
    let factor = 1;
    let days = 0;
    for (const [d, r] of daily) {
      if (d.slice(0, 7) === month) { factor *= 1 + r / 100; days++; }
    }
    const compounded = (factor - 1) * 100;
    check(`CDI diário composto bate com o mensal em ${month} (${days} pregões)`,
      Math.abs(compounded - published) < 0.01,
      `composto ${compounded.toFixed(4)}% vs publicado ${published}%`);
  }

  // A banda de plausibilidade diária tem que aceitar o dado real. Reusar a banda mensal
  // (0,1% a 4%) rejeitaria TODOS os dias — o CDI diário roda na casa de 0,05%.
  const values = [...daily.values()];
  const max = Math.max(...values);
  check("CDI diário real está abaixo do piso da banda MENSAL (por isso ela não serve)",
    max < 0.1,
    `maior valor diário observado: ${max}%`);
}

if (failures > 0) {
  console.log(`\n${failures} caso(s) falharam.`);
  process.exit(1);
}
console.log("\nTodos os casos passaram.");
