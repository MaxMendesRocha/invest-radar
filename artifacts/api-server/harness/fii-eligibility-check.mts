import { averageDailyVolumeValue, evalFiiEligibility, MIN_FII_DAILY_VOLUME_BRL, MIN_FII_EQUITY_BRL } from "../src/lib/fii-engine";
import type { OhlcPoint } from "../src/lib/market-data";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FALHA"} ${label}\n      obtido   ${a}\n      esperado ${e}`);
}

function series(days: number, volume: number, price: number): OhlcPoint[] {
  return Array.from({ length: days }, (_, i) => ({
    date: `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, "0")}`,
    close: price,
    adjustedClose: price,
    volume,
  }));
}

// --- averageDailyVolumeValue ---------------------------------------------

check(
  "21 pregões, volume e preço constantes: média = volume × preço",
  averageDailyVolumeValue(series(21, 10000, 100)),
  10000 * 100,
);

check(
  "menos de 21 pregões disponíveis -> null (nunca calcula sobre janela menor)",
  averageDailyVolumeValue(series(20, 10000, 100)),
  null,
);

check(
  "série vazia -> null",
  averageDailyVolumeValue([]),
  null,
);

{
  // 21 dias, só o dia mais recente com volume muito maior — confirma que pega os
  // ÚLTIMOS 21, não os primeiros, e que a média dilui o pico.
  const base = series(30, 1000, 50); // 30 dias, volume baixo
  base[base.length - 1] = { ...base[base.length - 1], volume: 1_000_000 };
  const avg = averageDailyVolumeValue(base, 21);
  // 20 dias a 1000×50=50000 + 1 dia a 1_000_000×50=50_000_000, média de 21
  const expected = (20 * 50000 + 50_000_000) / 21;
  check("usa os ÚLTIMOS 21 pregões, não os primeiros 21", avg, expected);
}

// --- evalFiiEligibility ----------------------------------------------------

check(
  "acima dos dois pisos: elegível",
  evalFiiEligibility(MIN_FII_DAILY_VOLUME_BRL + 1, MIN_FII_EQUITY_BRL + 1),
  { eligible: true, reason: null },
);

check(
  "exatamente no piso de volume: elegível (>=, não >)",
  evalFiiEligibility(MIN_FII_DAILY_VOLUME_BRL, MIN_FII_EQUITY_BRL),
  { eligible: true, reason: null },
);

{
  const r = evalFiiEligibility(MIN_FII_DAILY_VOLUME_BRL - 1, MIN_FII_EQUITY_BRL + 1);
  console.log(`${!r.eligible ? "OK  " : "FALHA"} volume um real abaixo do piso: reprova\n      obtido: ${JSON.stringify(r)}`);
  if (r.eligible) failures++;
}

{
  const r = evalFiiEligibility(MIN_FII_DAILY_VOLUME_BRL + 1, MIN_FII_EQUITY_BRL - 1);
  console.log(`${!r.eligible ? "OK  " : "FALHA"} patrimônio um real abaixo do piso: reprova\n      obtido: ${JSON.stringify(r)}`);
  if (r.eligible) failures++;
}

check(
  "volume null (sem série suficiente) -> reprova, não aprova por omissão",
  evalFiiEligibility(null, MIN_FII_EQUITY_BRL + 1).eligible,
  false,
);

check(
  "patrimônio null (sem fii-indicators) -> reprova, não aprova por omissão",
  evalFiiEligibility(MIN_FII_DAILY_VOLUME_BRL + 1, null).eligible,
  false,
);

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
