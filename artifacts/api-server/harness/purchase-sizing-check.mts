import { sizeWholeUnits, sizeTreasuryFraction } from "../src/lib/purchase-sizing";

/**
 * Casos-limite do dimensionamento de compra. O interessante aqui é o que a conta em
 * ponto flutuante erraria: fatia que fecha redonda em cima da cotação.
 */

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FALHA"} ${label}\n      obtido   ${a}\n      esperado ${e}`);
}

// --- Bolsa -----------------------------------------------------------------
// O caso que motivou os centavos inteiros: 3 x 41,90 = 125,70 exatos.
check("3 ações exatas a R$ 41,90", sizeWholeUnits(125.7, 41.9),
  { unitPrice: 41.9, units: 3, investedAmount: 125.7, leftover: 0 });

check("R$ 110,24 em ação de R$ 41,90", sizeWholeUnits(110.24, 41.9),
  { unitPrice: 41.9, units: 2, investedAmount: 83.8, leftover: 26.44 });

// Fatia menor que uma unidade: zero é a resposta certa, não arredondar para 1.
check("fatia não alcança 1 cota", sizeWholeUnits(68.95, 89.9),
  { unitPrice: 89.9, units: 0, investedAmount: 0, leftover: 68.95 });

check("um centavo a menos que 2 unidades", sizeWholeUnits(83.79, 41.9),
  { unitPrice: 41.9, units: 1, investedAmount: 41.9, leftover: 41.89 });

check("cotação nula", sizeWholeUnits(1000, null), null);
check("cotação zero", sizeWholeUnits(1000, 0), null);
check("fatia zero", sizeWholeUnits(0, 41.9), null);

// --- Tesouro Direto --------------------------------------------------------
// Selic 2027: PU perto de R$ 19.641, mínimo de 1% = R$ 196,41.
check("R$ 682,90 em título de R$ 19.641", sizeTreasuryFraction(682.9, 19641),
  { unitPrice: 19641, units: 0.03, investedAmount: 589.23, leftover: 93.67 });

check("fatia fecha em 0,03 exatos", sizeTreasuryFraction(589.23, 19641),
  { unitPrice: 19641, units: 0.03, investedAmount: 589.23, leftover: 0 });

// Piso de R$ 30: 0,01 de um título barato não é executável.
check("abaixo do piso de R$ 30", sizeTreasuryFraction(29, 2000),
  { unitPrice: 2000, units: 0, investedAmount: 0, leftover: 29 });

check("exatamente no piso de R$ 30", sizeTreasuryFraction(30, 3000),
  { unitPrice: 3000, units: 0.01, investedAmount: 30, leftover: 0 });

// PU com fração de centavo na compra mínima.
check("PU de R$ 196,415", sizeTreasuryFraction(100, 196.42),
  { unitPrice: 196.42, units: 0.5, investedAmount: 98.21, leftover: 1.79 });

check("Tesouro sem PU", sizeTreasuryFraction(1000, null), null);

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
