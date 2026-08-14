import type { DividendEvent } from "./market-data";

/**
 * Quem tem direito a um provento: quem comprou até a DATA-COM, não quem possui a
 * ação na data de PAGAMENTO. As duas costumam vir separadas por semanas — na PETR4,
 * até 112 dias — e confundi-las é o erro mais comum de quem começa a investir: ver
 * "paga dia X" e comprar antes de X achando que basta, quando o corte real já passou.
 *
 * `lastDatePrior` (data-com) vem da brapi.dev nos dois endpoints, ações e FII, com
 * cobertura de 100% na amostra medida (1.100 eventos). Existia desde sempre; esta
 * lógica nasceu em /portfolio/dividends/pending (proventos JÁ pagos) e é extraída
 * aqui para ser a MESMA regra em três lugares que precisam da resposta: pagamentos
 * passados sem lançamento, pagamentos futuros de quem já tem a posição, e a pergunta
 * hipotética "se eu comprar hoje, pego o próximo?" de quem ainda não tem.
 */

export type EntitlementCertainty = "confirmado" | "incerto";
export type EntitlementUncertaintyKind = "sem_data_compra" | "compra_proxima" | null;

export interface Entitlement {
  entitled: boolean;
  certainty: EntitlementCertainty;
  uncertaintyKind: EntitlementUncertaintyKind;
  uncertaintyReason: string | null;
}

/**
 * Folga usada só quando o evento vem SEM data-com — situação que não apareceu em
 * nenhum dos 1.100 eventos medidos, mas o campo é nullable no contrato e uma compra
 * a poucos dias do pagamento, sem data-com pra decidir, é genuinamente incerta.
 */
const EX_DATE_UNCERTAINTY_MS = 45 * 24 * 60 * 60 * 1000;

/**
 * `purchasedAt` null significa "não sabemos quando foi comprado" (ativo sem data de
 * compra cadastrada) — diferente de "não tem posição", que é decidido por quem chama.
 * Nesse caso o provento não é descartado: aparece como incerto, porque esconder um
 * pagamento real que pode ter sido recebido é pior que pedir para o usuário conferir.
 */
export function classifyEntitlement(purchasedAt: number | null, event: DividendEvent): Entitlement {
  const paidAt = new Date(event.paymentDate).getTime();
  const exDateAt = event.lastDatePrior ? new Date(event.lastDatePrior).getTime() : null;

  // Com data-com E data de compra, o direito é DETERMINADO, não inferido.
  if (purchasedAt != null && exDateAt != null) {
    return purchasedAt > exDateAt
      ? { entitled: false, certainty: "confirmado", uncertaintyKind: null, uncertaintyReason: null }
      : { entitled: true, certainty: "confirmado", uncertaintyKind: null, uncertaintyReason: null };
  }

  // Sem data-com, sobra a checagem grosseira: comprar depois do próprio pagamento é
  // impossível ter direito em qualquer regime.
  if (purchasedAt != null && exDateAt == null && purchasedAt > paidAt) {
    return { entitled: false, certainty: "confirmado", uncertaintyKind: null, uncertaintyReason: null };
  }

  if (purchasedAt == null) {
    return { entitled: true, certainty: "incerto", uncertaintyKind: "sem_data_compra", uncertaintyReason: null };
  }

  // Só resta aqui: evento sem data-com, comprado a menos de 45 dias do pagamento.
  if (exDateAt == null && paidAt - purchasedAt < EX_DATE_UNCERTAINTY_MS) {
    const days = Math.max(0, Math.round((paidAt - purchasedAt) / (24 * 60 * 60 * 1000)));
    return {
      entitled: true,
      certainty: "incerto",
      uncertaintyKind: "compra_proxima",
      uncertaintyReason: `Comprado ${days} ${days === 1 ? "dia" : "dias"} antes do pagamento, e o provedor não informou a data-com deste provento.`,
    };
  }

  return { entitled: true, certainty: "confirmado", uncertaintyKind: null, uncertaintyReason: null };
}

/**
 * "Se eu comprar hoje, recebo o próximo provento anunciado?" — pergunta diferente da
 * que classifyEntitlement resolve para posições já existentes. Aqui `todayAt` é
 * sempre "agora", nunca uma data de compra incerta e distante, então a resposta é
 * determinística sempre que a data-com existe: não há por que herdar a heurística de
 * "compra próxima sem data-com" pensada para quem já tem a posição há tempo. Sem
 * data-com — nunca visto na amostra medida, mas o campo é nullable — a resposta é
 * null: não inventamos um palpite pra pergunta binária que o usuário fez.
 */
export function entitledIfBoughtToday(event: DividendEvent, todayAt: number): boolean | null {
  if (event.lastDatePrior == null) return null;
  return todayAt <= new Date(event.lastDatePrior).getTime();
}

export interface DividendEntitlementPreview {
  paymentDate: string;
  label: string;
  rate: number;
  exDate: string | null;
  entitledIfBoughtToday: boolean | null;
}

function toPreview(event: DividendEvent, todayAt: number): DividendEntitlementPreview {
  return {
    paymentDate: event.paymentDate,
    label: event.label,
    rate: event.rate,
    exDate: event.lastDatePrior,
    entitledIfBoughtToday: entitledIfBoughtToday(event, todayAt),
  };
}

/**
 * O próximo provento anunciado — haja ou não direito comprando hoje — e, separado, o
 * próximo que uma compra hoje de fato alcançaria. O segundo só aparece quando os dois
 * divergem, que é justamente o caso que engana: ver "paga dia X" não quer dizer
 * "comprando até X eu pego". Quando o mais próximo já é o certo, um segundo campo
 * repetindo o mesmo evento seria ruído.
 */
export function previewNextDividends(
  events: DividendEvent[],
  now: number,
  todayAt: number,
): { nextDividend: DividendEntitlementPreview | null; nextEntitledDividend: DividendEntitlementPreview | null } {
  const future = [...events]
    .filter((e) => new Date(e.paymentDate).getTime() > now)
    .sort((a, b) => new Date(a.paymentDate).getTime() - new Date(b.paymentDate).getTime());

  if (future.length === 0) return { nextDividend: null, nextEntitledDividend: null };

  const nextDividend = toPreview(future[0], todayAt);
  if (nextDividend.entitledIfBoughtToday !== false) {
    return { nextDividend, nextEntitledDividend: null };
  }

  const nextEntitledEvent = future.find((e) => entitledIfBoughtToday(e, todayAt) === true);
  return {
    nextDividend,
    nextEntitledDividend: nextEntitledEvent ? toPreview(nextEntitledEvent, todayAt) : null,
  };
}
