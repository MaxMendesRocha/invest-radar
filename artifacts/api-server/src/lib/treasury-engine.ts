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
function rateLabelFor(indexer: TreasuryIndexer, rate: number): string {
  const formatted = rate.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (indexer === "selic") {
    // O sinal importa: deságio (positivo) rende Selic + algo, ágio rende Selic − algo.
    return rate === 0 ? "Selic" : `Selic ${rate > 0 ? "+" : "−"} ${Math.abs(rate).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  }
  if (indexer === "ipca") return `IPCA + ${formatted}% a.a.`;
  return `${formatted}% a.a.`;
}

function yearsUntil(maturityDate: string, now: Date): number {
  return (new Date(`${maturityDate}T00:00:00Z`).getTime() - now.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
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
    const chosen = pool.reduce((best, entry) =>
      Math.abs(yearsUntil(entry.bond.maturityDate, now) - target) < Math.abs(yearsUntil(best.bond.maturityDate, now) - target) ? entry : best,
    );

    suggestions.push({
      bondType: chosen.bond.bondType,
      maturityDate: chosen.bond.maturityDate,
      baseDate: chosen.bond.baseDate,
      rateLabel: rateLabelFor(indexer, parseFloat(chosen.bond.buyRate)),
      unitPrice: parseFloat(chosen.bond.buyUnitPrice),
      minimumInvestment: minimumInvestmentFor(parseFloat(chosen.bond.buyUnitPrice)),
      reason: reasonFor(indexer, profile, suggestions.length === 0),
    });
  }

  return suggestions;
}
