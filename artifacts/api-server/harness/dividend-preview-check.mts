import { previewNextDividends } from "../src/lib/dividend-entitlement";
import type { DividendEvent } from "../src/lib/market-data";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FALHA"} ${label}\n      obtido   ${a}\n      esperado ${e}`);
}

function ev(paymentDate: string, lastDatePrior: string | null, rate = 1, label = "JCP"): DividendEvent {
  return { paymentDate, rate, label, approvedOn: null, lastDatePrior };
}

const today = new Date("2026-08-14").getTime();
const now = Date.now(); // "agora" real só filtra passado x futuro; irrelevante pros eventos abaixo (todos no futuro)

// Caso real medido: VALE3 em 14/08 — próximo pagamento 02/09, data-com 11/08 (passou).
// Comprando hoje, NÃO recebe esse e não há outro anunciado.
check(
  "VALE3: data-com já passou, nada mais anunciado",
  previewNextDividends([ev("2026-09-02T03:00:00.000Z", "2026-08-11T03:00:00.000Z")], now, today),
  {
    nextDividend: { paymentDate: "2026-09-02T03:00:00.000Z", label: "JCP", rate: 1, exDate: "2026-08-11T03:00:00.000Z", entitledIfBoughtToday: false },
    nextEntitledDividend: null,
  },
);

// Caso real medido: ITSA4 — próximo pagamento 31/08 (data-com 18/06, passou), mas o
// seguinte (01/10, data-com 31/08) ainda está por vir. Comprando hoje, perde o
// primeiro e pega o segundo.
check(
  "ITSA4: perde o próximo, pega o seguinte",
  previewNextDividends(
    [
      ev("2026-08-31T03:00:00.000Z", "2026-06-18T03:00:00.000Z", 0.138),
      ev("2026-10-01T03:00:00.000Z", "2026-08-31T03:00:00.000Z", 0.0242425),
    ],
    now,
    today,
  ),
  {
    nextDividend: { paymentDate: "2026-08-31T03:00:00.000Z", label: "JCP", rate: 0.138, exDate: "2026-06-18T03:00:00.000Z", entitledIfBoughtToday: false },
    nextEntitledDividend: { paymentDate: "2026-10-01T03:00:00.000Z", label: "JCP", rate: 0.0242425, exDate: "2026-08-31T03:00:00.000Z", entitledIfBoughtToday: true },
  },
);

// Data-com ainda não chegou: comprando hoje, recebe — nextEntitledDividend some.
check(
  "data-com no futuro: recebe o mais próximo, sem segundo campo",
  previewNextDividends([ev("2026-10-01T03:00:00.000Z", "2026-09-20T03:00:00.000Z")], now, today),
  {
    nextDividend: { paymentDate: "2026-10-01T03:00:00.000Z", label: "JCP", rate: 1, exDate: "2026-09-20T03:00:00.000Z", entitledIfBoughtToday: true },
    nextEntitledDividend: null,
  },
);

// Data-com É hoje: convenção do app (não estritamente depois) é entitled.
check(
  "data-com é hoje: recebe",
  previewNextDividends([ev("2026-08-20T03:00:00.000Z", "2026-08-14T03:00:00.000Z")], now, today),
  {
    nextDividend: { paymentDate: "2026-08-20T03:00:00.000Z", label: "JCP", rate: 1, exDate: "2026-08-14T03:00:00.000Z", entitledIfBoughtToday: true },
    nextEntitledDividend: null,
  },
);

// Sem data-com informada: null, não um chute.
check(
  "sem data-com: null, não inventa",
  previewNextDividends([ev("2026-10-01T03:00:00.000Z", null)], now, today),
  {
    nextDividend: { paymentDate: "2026-10-01T03:00:00.000Z", label: "JCP", rate: 1, exDate: null, entitledIfBoughtToday: null },
    nextEntitledDividend: null,
  },
);

// FII sem nada anunciado no futuro: os dois campos vêm null.
check(
  "nada anunciado no futuro (caso FII)",
  previewNextDividends([ev("2026-07-14T03:00:00.000Z", "2026-06-30T03:00:00.000Z")], now, today),
  { nextDividend: null, nextEntitledDividend: null },
);

// Eventos fora de ordem na entrada: a função ordena por pagamento, não confia na ordem do provider.
check(
  "eventos futuros fora de ordem cronológica na entrada",
  previewNextDividends(
    [ev("2026-12-01T03:00:00.000Z", "2026-11-01T03:00:00.000Z"), ev("2026-09-02T03:00:00.000Z", "2026-08-11T03:00:00.000Z")],
    now,
    today,
  ).nextDividend?.paymentDate,
  "2026-09-02T03:00:00.000Z",
);

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
