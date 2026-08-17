import { computeMagicNumber, planSafePurchaseTowardMagicNumber } from "../src/lib/magic-number-engine";

let failures = 0;
function check(label: string, condition: boolean, detail: string): void {
  console.log(`${condition ? "OK  " : "FALHA"} ${label}`);
  if (!condition) {
    console.log(`      ${detail}`);
    failures++;
  }
}

// --- computeMagicNumber ------------------------------------------------------------

check("sem preço -> null", computeMagicNumber(0, 1, 10) === null, "esperava null");
check("sem dividendo -> null", computeMagicNumber(100, 0, 10) === null, "esperava null");

{
  // Cota a R$100, dividendo real de R$1/mês -> precisa de 100 cotas pra render R$100/mês.
  const r = computeMagicNumber(100, 1, 0);
  check("100/1 -> magicNumberUnits = 100", r?.magicNumberUnits === 100, JSON.stringify(r));
  check("0 cotas hoje -> unitsRemaining = 100", r?.unitsRemaining === 100, JSON.stringify(r));
}

{
  // Arredonda pra CIMA: 100/3 = 33.33 -> precisa de 34, não 33 (33 cotas ainda não fecham o preço de uma nova).
  const r = computeMagicNumber(100, 3, 0);
  check("100/3 arredonda pra cima (34, não 33)", r?.magicNumberUnits === 34, JSON.stringify(r));
}

{
  // Já tem mais cotas que o número mágico -> unitsRemaining não fica negativo.
  const r = computeMagicNumber(100, 1, 150);
  check("já passou do número mágico -> unitsRemaining = 0", r?.unitsRemaining === 0, JSON.stringify(r));
}

// --- planSafePurchaseTowardMagicNumber ----------------------------------------------

check(
  "sem patrimônio total -> null",
  planSafePurchaseTowardMagicNumber(computeMagicNumber(100, 1, 0)!, 0, 25) === null,
  "esperava null",
);

{
  // Carteira de R$100.000, teto Atenção 25% -> pode ter até R$25.000 nesse ativo (250 cotas a R$100).
  // Faltam 100 cotas pro número mágico (0 hoje, alvo 100 cotas), e 250 > 100: cabe tudo com folga.
  const mn = computeMagicNumber(100, 1, 0)!;
  const plan = planSafePurchaseTowardMagicNumber(mn, 100_000, 25)!;
  check("cabe dentro do teto -> reachesGoalNow", plan.reachesGoalNow === true, JSON.stringify(plan));
  check("safeUnitsToAddNow cobre as 100 que faltam", plan.safeUnitsToAddNow === 100, JSON.stringify(plan));
  check("unitsBeyondSafeCeiling = 0", plan.unitsBeyondSafeCeiling === 0, JSON.stringify(plan));
}

{
  // Carteira pequena de R$5.000 (só essa posição, hipoteticamente 0 cotas ainda),
  // teto Atenção 25% -> só R$1.250 cabem sem estourar (12 cotas a R$100). Número
  // mágico pede 100 cotas -> plano parcial, resto depende do patrimônio crescer.
  const mn = computeMagicNumber(100, 1, 0)!;
  const plan = planSafePurchaseTowardMagicNumber(mn, 5_000, 25)!;
  check("plano parcial: NÃO reachesGoalNow", plan.reachesGoalNow === false, JSON.stringify(plan));
  check("safeUnitsToAddNow = 12 (R$1.250 / R$100, piso)", plan.safeUnitsToAddNow === 12, JSON.stringify(plan));
  check("unitsBeyondSafeCeiling = 88 (100 - 12)", plan.unitsBeyondSafeCeiling === 88, JSON.stringify(plan));
}

{
  // Posição já ACIMA do teto de concentração hoje (50 cotas a R$100 = R$5.000 numa
  // carteira de R$10.000 = 50%, acima do teto 25%) -> não é seguro comprar mais
  // AGORA, mesmo que o número mágico ainda não tenha sido atingido.
  const mn = computeMagicNumber(100, 1, 50)!; // faltam 50 cotas pro número mágico (100 - 50)
  const plan = planSafePurchaseTowardMagicNumber(mn, 10_000, 25)!;
  check("já acima do teto -> alreadyAtOrOverCeiling", plan.alreadyAtOrOverCeiling === true, JSON.stringify(plan));
  check("já acima do teto -> safeUnitsToAddNow = 0", plan.safeUnitsToAddNow === 0, JSON.stringify(plan));
  check("já acima do teto -> unitsBeyondSafeCeiling = unitsRemaining inteiro (50)", plan.unitsBeyondSafeCeiling === 50, JSON.stringify(plan));
}

{
  // Já atingiu o número mágico (currentUnits >= magicNumberUnits) -> unitsRemaining
  // já é 0 em computeMagicNumber, e o plano precisa refletir "nada a fazer", não
  // "nada cabe".
  const mn = computeMagicNumber(100, 1, 120)!;
  const plan = planSafePurchaseTowardMagicNumber(mn, 100_000, 25)!;
  check("já atingiu -> reachesGoalNow", plan.reachesGoalNow === true, JSON.stringify(plan));
  check("já atingiu -> safeUnitsToAddNow = 0 (nada falta)", plan.safeUnitsToAddNow === 0, JSON.stringify(plan));
}

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
