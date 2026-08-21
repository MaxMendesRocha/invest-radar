/**
 * Detecção de evento corporativo em FII a partir da série mensal do informe da CVM.
 *
 * O app não ajusta posição por evento corporativo — não tem como saber o que a pessoa
 * fez na corretora. O que ele pode fazer é parar de divergir EM SILÊNCIO: quando um
 * fundo da carteira passou por desdobramento, grupamento ou amortização depois da data
 * de compra registrada, o preço médio guardado provavelmente envelheceu, e isso merece
 * um aviso nomeado e datado em vez de um número errado sem nenhuma marca.
 *
 * Só entram aqui eventos que SEMPRE mexem no preço médio de quem já tinha a posição.
 * Emissão nova de cotas, que é de longe a variação mais comum, deliberadamente não
 * entra — ver NÃO_É_EVENTO abaixo.
 */

export interface FiiMonthlyPoint {
  /** "2023-11-01" */
  dataReferencia: string;
  cotasEmitidas: number | null;
  /** Fração, não percentual: 0,018768 é 1,8768% no mês (o campo da CVM se chama "Percentual_" mas é fração). */
  amortizacaoFracao: number | null;
}

export type CorporateEventType = "desdobramento" | "grupamento" | "amortizacao";

export interface CorporateEvent {
  type: CorporateEventType;
  /** Mês em que o evento aparece no informe: "2023-11-01". */
  date: string;
  /** Desdobramento 1:10 → 10. Grupamento 10:1 → 10. Amortização → null. */
  ratio: number | null;
  /** Amortização: fração acumulada desde a data de corte (0,0134 = 1,34%). Outros → null. */
  accumulatedFraction: number | null;
  /** true quando não havia data de compra registrada e não dá pra afirmar que o evento é posterior à posição. */
  purchaseDateUnknown: boolean;
}

/**
 * Razões reconhecidas como desdobramento/grupamento. A lista é explícita em vez de
 * "qualquer inteiro" porque o arquivo da CVM tem lixo — existe fundo com razão de
 * ×262.600 entre dois meses, que é erro de preenchimento, não evento societário.
 */
const KNOWN_RATIOS = [2, 3, 4, 5, 8, 10, 20, 25, 40, 50, 100];
const RATIO_TOLERANCE = 0.02;

/**
 * NÃO_É_EVENTO: variação de cotas que não bate uma razão inteira é emissão nova, e
 * emissão não mexe no preço médio de quem não subscreveu. Medido na base de 2022 a 2026:
 * 64% dos FIIs (1.023 de 1.602) tiveram alguma variação de cotas, 6.049 no total —
 * alertar nisso seria alarme falso em dois terços de qualquer carteira. Filtrando por
 * razão inteira sobram 164 fundos e 198 eventos, todos com efeito real sobre preço médio.
 */
function classifyRatio(ratio: number): { type: CorporateEventType; ratio: number } | null {
  for (const n of KNOWN_RATIOS) {
    if (Math.abs(ratio - n) <= RATIO_TOLERANCE * n) return { type: "desdobramento", ratio: n };
    if (Math.abs(ratio - 1 / n) <= (RATIO_TOLERANCE / n)) return { type: "grupamento", ratio: n };
  }
  return null;
}

/**
 * Amortização mensal é quase sempre pequena (0,0018 = 0,18% num mês típico); avisar a
 * cada mês seria ruído. O aviso só faz sentido quando o acumulado desde a compra chega
 * a distorcer o preço médio de forma perceptível.
 */
const AMORTIZATION_ALERT_THRESHOLD = 0.01; // 1% acumulado

export function detectCorporateEvents(
  series: FiiMonthlyPoint[],
  sinceDate: string | null,
): CorporateEvent[] {
  const purchaseDateUnknown = sinceDate == null;
  const sorted = [...series].sort((a, b) => a.dataReferencia.localeCompare(b.dataReferencia));
  const inWindow = (d: string) => sinceDate == null || d > sinceDate;

  const events: CorporateEvent[] = [];

  // Desdobramento / grupamento: razão entre meses consecutivos.
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].cotasEmitidas;
    const curr = sorted[i].cotasEmitidas;
    if (!prev || !curr || prev <= 0 || curr <= 0) continue;
    if (!inWindow(sorted[i].dataReferencia)) continue;
    const hit = classifyRatio(curr / prev);
    if (!hit) continue;
    events.push({
      type: hit.type,
      date: sorted[i].dataReferencia,
      ratio: hit.ratio,
      accumulatedFraction: null,
      purchaseDateUnknown,
    });
  }

  // Amortização: soma simples das frações no período. Somar em vez de compor é
  // conservador de propósito — a diferença entre os dois é irrelevante nessa ordem de
  // grandeza, e o número menor evita disparar o aviso antes da hora.
  let accumulated = 0;
  let lastAmortizationDate: string | null = null;
  for (const point of sorted) {
    if (!point.amortizacaoFracao || point.amortizacaoFracao <= 0) continue;
    if (!inWindow(point.dataReferencia)) continue;
    accumulated += point.amortizacaoFracao;
    lastAmortizationDate = point.dataReferencia;
  }
  if (lastAmortizationDate && accumulated >= AMORTIZATION_ALERT_THRESHOLD) {
    events.push({
      type: "amortizacao",
      date: lastAmortizationDate,
      ratio: null,
      accumulatedFraction: accumulated,
      purchaseDateUnknown,
    });
  }

  return events.sort((a, b) => b.date.localeCompare(a.date));
}

/** O evento mais recente, que é o que a UI mostra. `null` quando não houve nenhum. */
export function mostRecentEvent(events: CorporateEvent[]): CorporateEvent | null {
  return events.length > 0 ? events[0] : null;
}
