import { classifyEntitlement } from "../src/lib/dividend-entitlement";
import type { DividendEvent } from "../src/lib/market-data";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FALHA"} ${label}\n      obtido   ${a}\n      esperado ${e}`);
}

function ev(paymentDate: string, lastDatePrior: string | null): DividendEvent {
  return { paymentDate, rate: 1, label: "JCP", approvedOn: null, lastDatePrior };
}

const day = (s: string) => new Date(s).getTime();

// Comprou antes da data-com: recebe, confirmado.
check(
  "comprou antes da data-com",
  classifyEntitlement(day("2026-06-01"), ev("2026-08-31T03:00:00.000Z", "2026-06-18T03:00:00.000Z")),
  { entitled: true, certainty: "confirmado", uncertaintyKind: null, uncertaintyReason: null },
);

// Comprou exatamente na data-com: convenção do app é "não estritamente depois" -> recebe.
check(
  "comprou no mesmo dia da data-com",
  classifyEntitlement(day("2026-06-18"), ev("2026-08-31T03:00:00.000Z", "2026-06-18T03:00:00.000Z")),
  { entitled: true, certainty: "confirmado", uncertaintyKind: null, uncertaintyReason: null },
);

// Comprou depois da data-com: NÃO recebe, e é certeza, não achismo.
check(
  "comprou depois da data-com (caso VALE3 do relato)",
  classifyEntitlement(day("2026-08-14"), ev("2026-09-02T03:00:00.000Z", "2026-08-11T03:00:00.000Z")),
  { entitled: false, certainty: "confirmado", uncertaintyKind: null, uncertaintyReason: null },
);

// Sem data de compra: entra como incerto, não é descartado (pode ter recebido).
check(
  "sem data de compra cadastrada",
  classifyEntitlement(null, ev("2026-08-31T03:00:00.000Z", "2026-06-18T03:00:00.000Z")),
  { entitled: true, certainty: "incerto", uncertaintyKind: "sem_data_compra", uncertaintyReason: null },
);

// Sem data-com, comprou bem antes do pagamento: nada a discutir, recebeu.
check(
  "sem data-com, compra distante do pagamento",
  classifyEntitlement(day("2026-01-01"), ev("2026-08-31T03:00:00.000Z", null)),
  { entitled: true, certainty: "confirmado", uncertaintyKind: null, uncertaintyReason: null },
);

// Sem data-com, comprou poucos dias antes do pagamento: incerto de verdade.
check(
  "sem data-com, compra a 10 dias do pagamento",
  classifyEntitlement(day("2026-08-21"), ev("2026-08-31T03:00:00.000Z", null)),
  { entitled: true, certainty: "incerto", uncertaintyKind: "compra_proxima", uncertaintyReason: "Comprado 10 dias antes do pagamento, e o provedor não informou a data-com deste provento." },
);

// Sem data-com, comprou DEPOIS do pagamento: impossível ter direito.
check(
  "sem data-com, compra depois do pagamento",
  classifyEntitlement(day("2026-09-01"), ev("2026-08-31T03:00:00.000Z", null)),
  { entitled: false, certainty: "confirmado", uncertaintyKind: null, uncertaintyReason: null },
);

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
