import type { TreasuryBond } from "@workspace/db";

/**
 * Escolhe títulos do Tesouro Direto para a fatia de renda fixa do plano de aporte.
 *
 * A escolha é determinística e baseada em CARACTERÍSTICA do título contra o que o
 * usuário já declarou no perfil — nunca em previsão de mercado. Dizer "prefixado vai
 * render mais que IPCA+" seria apostar na trajetória dos juros, coisa que este projeto
 * não faz em nenhum outro lugar; dizer "prefixado trava a taxa nominal e te expõe à
 * inflação surpresa" é descrever o produto. Só a segunda forma aparece aqui.
 */

export type TreasuryIndexer = "selic" | "ipca" | "prefixado";

/**
 * Famílias que podem ser sugeridas, por nome exato publicado pelo Tesouro.
 *
 * É allowlist e não inferência porque o arquivo de dados abertos NÃO diz quais títulos
 * estão em oferta: ele publica taxa de compra para tudo que tem preço no dia, inclusive
 * o "Tesouro IGPM+ com Juros Semestrais", que não é emitido há anos e só existe para
 * recompra. Sugerir um título fora de oferta mandaria o usuário procurar algo que não
 * está à venda.
 *
 * Educa+ e Renda+ ficam de fora por outro motivo: são produtos amarrados a um objetivo
 * de vida específico (custear estudos, complementar aposentadoria) com fase de
 * recebimento programada, e escolher entre eles depende de um plano que não modelamos.
 */
const SUGGESTABLE: Record<string, { indexer: TreasuryIndexer; paysCoupon: boolean }> = {
  "Tesouro Selic": { indexer: "selic", paysCoupon: false },
  "Tesouro Prefixado": { indexer: "prefixado", paysCoupon: false },
  "Tesouro Prefixado com Juros Semestrais": { indexer: "prefixado", paysCoupon: true },
  "Tesouro IPCA+": { indexer: "ipca", paysCoupon: false },
  "Tesouro IPCA+ com Juros Semestrais": { indexer: "ipca", paysCoupon: true },
};

/**
 * Horizonte a partir do qual o indexado à inflação passa a ser o padrão. Abaixo disso o
 * prefixado é preferido porque a incerteza inflacionária acumulada é menor no curto
 * prazo e o investidor sabe exatamente quanto recebe no vencimento.
 */
const LONG_HORIZON_YEARS = 5;

/** Vencimento mínimo para uma sugestão de aporte, em anos. */
const MIN_YEARS_TO_MATURITY = 0.5;

export interface TreasuryProfileInput {
  liquidityNeed: string | null; // "sim" | "nao"
  emergencyFund: string | null; // "sim" | "nao"
  horizonYears: number | null;
  objective: string | null; // "preservar" | "renda" | "crescimento"
}

export interface TreasurySuggestion {
  bondType: string;
  maturityDate: string;
  baseDate: string;
  /** Já formatada com o significado certo por família — ver rateLabelFor. */
  rateLabel: string;
  /** Preço do título INTEIRO. Sozinho na tela ele engana — ver minimumInvestment. */
  unitPrice: number;
  minimumInvestment: number;
  reason: string;
  /**
   * Prazo médio de retorno em anos — o que governa a sensibilidade do preço a juro, e o
   * que o motor usa para casar com o horizonte declarado.
   *
   * Null nos títulos de fluxo único, onde ele seria idêntico ao vencimento: repetir o
   * mesmo número com outro nome não informa nada e sugeriria que são coisas distintas.
   * Sai preenchido só nos de cupom semestral, que é onde os dois divergem.
   */
  averageTermYears: number | null;
}

/**
 * Compra mínima: 1% do título, respeitando o piso de R$ 30 do Tesouro Direto.
 *
 * Sem isso a tela ficaria absurda. O Tesouro Selic tem PU de quase R$ 20 mil, e exibir
 * esse número ao lado de uma fatia de aporte de R$ 400 sugeriria que o título está fora
 * do alcance — quando na prática dá para comprar 2% dele. A regra da fração e o piso
 * são normas publicadas pelo Tesouro, não vêm no arquivo de dados abertos; por isso
 * estão aqui como constante documentada e não como campo lido da fonte.
 */
const MIN_FRACTION = 0.01;
const MIN_PURCHASE_BRL = 30;

function minimumInvestmentFor(unitPrice: number): number {
  return Math.max(MIN_PURCHASE_BRL, Math.round(unitPrice * MIN_FRACTION * 100) / 100);
}

/**
 * A taxa publicada quer dizer coisas diferentes em cada família, e exibi-la crua
 * produziria absurdos: o Tesouro Selic aparece com 0,02 no arquivo, que é o ágio sobre
 * a Selic e não o rendimento — mostrado sem rótulo, o título mais conservador da praça
 * pareceria render zero.
 */
export function rateLabelFor(indexer: TreasuryIndexer, rate: number): string {
  const formatted = rate.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (indexer === "selic") {
    // O sinal importa: deságio (positivo) rende Selic + algo, ágio rende Selic − algo.
    return rate === 0 ? "Selic" : `Selic ${rate > 0 ? "+" : "−"} ${Math.abs(rate).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  }
  if (indexer === "ipca") return `IPCA + ${formatted}% a.a.`;
  return `${formatted}% a.a.`;
}

/** Família (nome publicado pelo Tesouro) -> indexador, pela mesma allowlist de SUGGESTABLE.
 *  null para família fora dela (ex. só-recompra, sem oferta ativa) — degrada, não quebra. */
export function indexerForBondType(bondType: string): TreasuryIndexer | null {
  return SUGGESTABLE[bondType]?.indexer ?? null;
}

/**
 * Nota de liquidez sobre resgate antecipado — mesma lógica já usada como alternativa em
 * reasonFor(), extraída porque o Parecer de Título Público precisa dela sozinha, sem o
 * resto do contexto de sugestão de aporte.
 */
export function liquidityNoteFor(indexer: TreasuryIndexer): string {
  if (indexer === "selic") {
    return "Este é o único título do Tesouro cujo resgate antecipado não sofre marcação a mercado — dá para vender a qualquer momento sem risco de prejuízo por oscilação de taxa.";
  }
  return "Diferente do Tesouro Selic, este título tem marcação a mercado no resgate antecipado — vender antes do vencimento pode dar prejuízo se a taxa de mercado subir depois da compra.";
}

function yearsUntil(maturityDate: string, now: Date): number {
  return (new Date(`${maturityDate}T00:00:00Z`).getTime() - now.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
}

/**
 * Cupom anual de cada família com juros semestrais.
 *
 * Não é parâmetro escolhido por nós: são as taxas que o próprio Tesouro fixa na emissão
 * — 10% a.a. na NTN-F (Prefixado com Juros Semestrais) e 6% a.a. na NTN-B (IPCA+ com
 * Juros Semestrais) — e não mudam de título para título dentro da família. O arquivo de
 * dados abertos não publica o cupom, só taxa e preço, por isso ele vive aqui.
 */
const COUPON_RATE: Record<string, number> = {
  "Tesouro Prefixado com Juros Semestrais": 0.1,
  "Tesouro IPCA+ com Juros Semestrais": 0.06,
};

/**
 * Prazo médio de retorno (duration de Macaulay), em anos.
 *
 * ## Por que não basta o vencimento
 *
 * Num título de fluxo único o dinheiro volta todo no fim, e prazo é a mesma coisa que
 * PMR. Com cupom semestral parte volta a cada seis meses, e o prazo passa a superestimar
 * quanto tempo o dinheiro fica exposto. Medido com o cupom real, a 7% de taxa:
 *
 *   IPCA+ JS de  5 anos → PMR 4,4    (0,6 de diferença)
 *   IPCA+ JS de 10 anos → PMR 7,6    (2,4)
 *   IPCA+ JS de 14 anos → PMR 9,5    (4,5)
 *   IPCA+ JS de 19 anos → PMR 11,2   (7,8)
 *
 * É o PMR, e não o vencimento, que governa a sensibilidade do preço a juro — ou seja, o
 * que a pessoa sente se precisar vender antes. Casar o horizonte declarado contra o
 * vencimento entregava a quem pediu 10 anos um título que se comporta como de 7,6.
 *
 * ## Cupom e taxa estão sempre na mesma moeda
 *
 * No IPCA+ os dois são reais (cupom de 6% real, `buyRate` é o juro real); no Prefixado
 * os dois são nominais. Então descontar um pelo outro é coerente sem nenhuma conversão —
 * e o PMR sai em anos nos dois casos.
 *
 * ## O que esta conta aproxima, declarado
 *
 * Os cupons são tratados como igualmente espaçados a partir do vencimento, e não nas
 * datas fixas que o Tesouro publica (15/02 e 15/08 na NTN-B, 01/01 e 01/07 na NTN-F). O
 * erro é o do primeiro período quebrado, sempre menor que um semestre, contra uma
 * diferença de anos que a conta existe para corrigir. Também usa ano civil em vez dos
 * 252 dias úteis da convenção brasileira, pelo mesmo motivo: a ordem de grandeza do
 * ajuste não depende disso.
 *
 * `annualRate` vem em PONTOS PERCENTUAIS, como está na tabela (7.5 e não 0.075).
 */
export function averageTermYears(
  bondType: string,
  maturityDate: string,
  annualRate: number,
  now: Date = new Date(),
): number {
  const anos = yearsUntil(maturityDate, now);
  const cupomAnual = COUPON_RATE[bondType];

  // Fluxo único: o PMR É o prazo. Sem cupom não há o que antecipar.
  if (cupomAnual == null || anos <= 0) return anos;
  // Taxa impossível de descontar — devolve o prazo em vez de um número inventado.
  if (!(annualRate > -100)) return anos;

  const periodos = Math.max(1, Math.round(anos * 2));
  const c = Math.pow(1 + cupomAnual, 0.5) - 1;
  const y = Math.pow(1 + annualRate / 100, 0.5) - 1;

  let valorPresente = 0;
  let ponderado = 0;
  for (let t = 1; t <= periodos; t++) {
    const fluxo = t === periodos ? c + 1 : c;
    const vp = fluxo / Math.pow(1 + y, t);
    valorPresente += vp;
    ponderado += t * vp;
  }
  if (valorPresente <= 0) return anos;

  return ponderado / valorPresente / 2;
}

/**
 * Indexador adequado ao perfil.
 *
 * Precisar de liquidez ou não ter reserva de emergência formada manda no resto: o
 * Tesouro Selic é o único cujo resgate antecipado não sofre marcação a mercado, então
 * é o único em que sacar antes do vencimento não vira prejuízo. Isso vale
 * independentemente do horizonte declarado — quem pode precisar do dinheiro a qualquer
 * momento não deveria estar num título que pune a saída.
 */
export function indexerFor(profile: TreasuryProfileInput): TreasuryIndexer {
  if (profile.liquidityNeed === "sim" || profile.emergencyFund === "nao") return "selic";
  if (profile.horizonYears == null) return "selic";
  return profile.horizonYears >= LONG_HORIZON_YEARS ? "ipca" : "prefixado";
}

function reasonFor(indexer: TreasuryIndexer, profile: TreasuryProfileInput, primary: boolean): string {
  if (!primary) {
    if (indexer === "selic") return "Alternativa de liquidez: é o único cujo resgate antecipado não sofre marcação a mercado.";
    if (indexer === "ipca") return "Alternativa que protege o poder de compra — o rendimento acompanha a inflação.";
    return "Alternativa que trava a taxa nominal até o vencimento, sem proteção contra inflação surpresa.";
  }
  if (indexer === "selic") {
    if (profile.liquidityNeed === "sim") return "Você declarou que pode precisar do dinheiro: é o único título cujo resgate antecipado não sofre marcação a mercado.";
    if (profile.emergencyFund === "nao") return "Sua reserva de emergência ainda não está formada, e este é o único título que permite sacar a qualquer momento sem risco de prejuízo na saída.";
    return "Sem horizonte declarado no perfil, o título sem marcação a mercado no resgate é o que menos depende de acertar o prazo.";
  }
  if (indexer === "ipca") return `Seu horizonte de ${profile.horizonYears} anos é longo o bastante para a inflação acumulada pesar — este título protege o poder de compra do que você aportar.`;
  return `Para um horizonte de ${profile.horizonYears} anos, este título trava a taxa e você sabe hoje quanto recebe no vencimento; em troca, inflação acima do esperado corrói o ganho real.`;
}

/**
 * Até 3 sugestões: a que casa com o perfil primeiro, depois uma de cada outro
 * indexador, para o usuário enxergar a alternativa em vez de receber uma escolha
 * fechada sem contraponto.
 *
 * Dentro de cada indexador, o vencimento escolhido é o mais próximo do horizonte
 * declarado — ou o mais curto disponível quando não há horizonte, caso em que casar
 * prazo é impossível e o prazo curto é o que menos compromete.
 */
export function suggestTreasuryBonds(
  bonds: TreasuryBond[],
  profile: TreasuryProfileInput,
  now: Date = new Date(),
): TreasurySuggestion[] {
  const wantsCoupon = profile.objective === "renda";
  const primaryIndexer = indexerFor(profile);
  const order: TreasuryIndexer[] = [primaryIndexer, ...(["selic", "ipca", "prefixado"] as const).filter((i) => i !== primaryIndexer)];

  const eligible = bonds
    .map((bond) => ({ bond, meta: SUGGESTABLE[bond.bondType] }))
    .filter((entry): entry is { bond: TreasuryBond; meta: (typeof SUGGESTABLE)[string] } => entry.meta != null)
    .filter((entry) => yearsUntil(entry.bond.maturityDate, now) >= MIN_YEARS_TO_MATURITY);

  const suggestions: TreasurySuggestion[] = [];
  for (const indexer of order) {
    const candidates = eligible.filter((e) => e.meta.indexer === indexer);
    if (candidates.length === 0) continue;

    // Título com pagamento semestral só entra quando o objetivo declarado é renda; e
    // mesmo assim, só se existir na família — senão vale o de fluxo único.
    const preferred = candidates.filter((e) => e.meta.paysCoupon === wantsCoupon);
    const pool = preferred.length > 0 ? preferred : candidates;

    // Selic não tem "casar prazo": não há marcação a mercado no resgate, então o
    // vencimento é quase indiferente e o mais curto é o de menor oscilação de preço.
    const target = indexer === "selic" ? 0 : (profile.horizonYears ?? 0);

    // Casa contra o PMR, não contra o vencimento. Num título de fluxo único os dois são
    // o mesmo número e nada muda; com cupom semestral o vencimento superestima o tempo
    // de exposição em anos — e é justamente esse o título que o app passa a preferir
    // quando o objetivo declarado é renda, logo acima.
    const termo = (entry: typeof pool[number]) =>
      averageTermYears(entry.bond.bondType, entry.bond.maturityDate, parseFloat(entry.bond.buyRate), now);
    const chosen = pool.reduce((best, entry) =>
      Math.abs(termo(entry) - target) < Math.abs(termo(best) - target) ? entry : best,
    );

    suggestions.push({
      bondType: chosen.bond.bondType,
      maturityDate: chosen.bond.maturityDate,
      baseDate: chosen.bond.baseDate,
      rateLabel: rateLabelFor(indexer, parseFloat(chosen.bond.buyRate)),
      unitPrice: parseFloat(chosen.bond.buyUnitPrice),
      minimumInvestment: minimumInvestmentFor(parseFloat(chosen.bond.buyUnitPrice)),
      reason: reasonFor(indexer, profile, suggestions.length === 0),
      averageTermYears: chosen.meta.paysCoupon
        ? Math.round(termo(chosen) * 10) / 10
        : null,
    });
  }

  return suggestions;
}
