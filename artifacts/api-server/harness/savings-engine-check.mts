import { projectSavingsBalance, type SavingsRatePoint } from "../src/lib/savings-engine";
import { fetchSeriesRange, SAVINGS_SGS_CODE } from "../src/lib/macro-data";

let failures = 0;
function check(label: string, condition: boolean, detail: string): void {
  console.log(`${condition ? "OK  " : "FALHA"} ${label}`);
  if (!condition) {
    console.log(`      ${detail}`);
    failures++;
  }
}

// ── Fixtures: um ciclo completo ─────────────────────────────────────────────
{
  const rateSeries: SavingsRatePoint[] = [{ date: "2026-01-01", ratePercent: 0.5 }];
  const p = projectSavingsBalance(1000, "2026-01-01", new Date("2026-02-15T00:00:00Z"), rateSeries);
  check("1 ciclo composto", p.completedCycles === 1, JSON.stringify(p));
  check("saldo = 1000 * 1.005", Math.abs(p.currentBalance - 1005) < 0.001, JSON.stringify(p));
  check("último aniversário = data de crédito (fim do ciclo)", p.lastAnniversary === "2026-02-01", JSON.stringify(p));
  check("próximo aniversário = 1 mês depois do crédito", p.nextAnniversary === "2026-03-01", JSON.stringify(p));
}

// ── Antes do aniversário: nada rendeu ainda ─────────────────────────────────
{
  const rateSeries: SavingsRatePoint[] = [{ date: "2026-01-01", ratePercent: 0.5 }];
  const p = projectSavingsBalance(1000, "2026-01-01", new Date("2026-01-15T00:00:00Z"), rateSeries);
  check("ciclo em andamento -> 0 ciclos completos", p.completedCycles === 0, JSON.stringify(p));
  check("saldo não muda antes do aniversário fechar", p.currentBalance === 1000, JSON.stringify(p));
  check("nenhum aniversário creditado ainda -> null", p.lastAnniversary === null, JSON.stringify(p));
}

// ── Regra do dia 31: aniversário pula fevereiro, vai pro dia 1 de março ─────
{
  const rateSeries: SavingsRatePoint[] = [{ date: "2026-01-31", ratePercent: 0.6 }];
  const before = projectSavingsBalance(1000, "2026-01-31", new Date("2026-02-15T00:00:00Z"), rateSeries);
  check("dia 31: 15/02 ainda não fechou o ciclo (só 1 mês não basta)", before.completedCycles === 0, JSON.stringify(before));
  check("dia 31: aniversário cai em 01/03, não 01/02", before.nextAnniversary === "2026-03-01", JSON.stringify(before));

  const after = projectSavingsBalance(1000, "2026-01-31", new Date("2026-03-02T00:00:00Z"), rateSeries);
  check("dia 31: fecha o ciclo em 01/03", after.completedCycles === 1, JSON.stringify(after));
  check("dia 31: saldo = 1000 * 1.006", Math.abs(after.currentBalance - 1006) < 0.001, JSON.stringify(after));
}

// ── Vários ciclos, taxas diferentes — compara com conta manual ─────────────
{
  const rateSeries: SavingsRatePoint[] = [
    { date: "2026-01-05", ratePercent: 0.60 },
    { date: "2026-02-05", ratePercent: 0.55 },
    { date: "2026-03-05", ratePercent: 0.65 },
  ];
  const p = projectSavingsBalance(5000, "2026-01-05", new Date("2026-04-10T00:00:00Z"), rateSeries);
  const manual = 5000 * 1.006 * 1.0055 * 1.0065;
  check("3 ciclos compostos", p.completedCycles === 3, JSON.stringify(p));
  check("saldo bate com composição manual", Math.abs(p.currentBalance - manual) < 0.0001, JSON.stringify(p));
}

// ── Sem taxa publicada pro ciclo -> pára em vez de chutar ───────────────────
{
  const p = projectSavingsBalance(1000, "2026-01-01", new Date("2026-06-01T00:00:00Z"), []);
  check("sem série nenhuma -> 0 ciclos, saldo intacto", p.completedCycles === 0 && p.currentBalance === 1000, JSON.stringify(p));
  check("nextAnniversary aponta pro fim do ciclo sem dado, não pro início", p.nextAnniversary === "2026-02-01", JSON.stringify(p));
}

// ── Checkpoint no futuro -> nada a projetar (só sanidade do chamador em market-data.ts) ──
{
  const p = projectSavingsBalance(1000, "2026-01-01", new Date("2026-01-01T00:00:00Z"), []);
  check("checkpoint = hoje -> 0 ciclos", p.completedCycles === 0, JSON.stringify(p));
}

// ── Contra o Banco Central de verdade ────────────────────────────────────────
{
  const points = await fetchSeriesRange(SAVINGS_SGS_CODE, 200);
  if (points.length === 0) {
    console.log("SKIP checagem ao vivo — BCB SGS não respondeu neste ambiente.");
  } else {
    const rateSeries: SavingsRatePoint[] = points.map((p) => {
      const [dd, mm, yyyy] = p.data.split("/");
      return { date: `${yyyy}-${mm}-${dd}`, ratePercent: parseFloat(p.valor) };
    });
    const checkpointDate = "2026-03-17";
    const p = projectSavingsBalance(10000, checkpointDate, new Date(), rateSeries);
    check("projeção real tem pelo menos 1 ciclo completo (5 meses de folga)", p.completedCycles >= 1, JSON.stringify(p));
    check("poupança nunca rende negativo", p.currentBalance >= 10000, JSON.stringify(p));
    console.log(`\nReal: R$10.000,00 em ${checkpointDate} -> R$${p.currentBalance.toFixed(2)} hoje (${p.completedCycles} ciclos, último em ${p.lastAnniversary}).`);
  }
}

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
