import type { ProfileClassification } from "./investor-profile-engine";

/**
 * Alocação-alvo por classe de ativo, desvio da carteira real em relação a ela, e
 * distribuição de um aporte novo para reduzir esse desvio.
 *
 * Duas escolhas de projeto valem ser ditas antes do código:
 *
 * 1. NADA AQUI VENDE. O plano de aporte só compra — rebalancear vendendo custa IR e
 *    corretagem e não é o que a pessoa faz todo mês. Isso tem uma consequência
 *    matemática que o código assume em toda parte: uma classe acima do alvo não pode
 *    ser corrigida, só diluída pelo crescimento do total.
 *
 * 2. NÃO HÁ OTIMIZAÇÃO DE CARTEIRA AQUI, e é deliberado. Média-variância exigiria
 *    retorno esperado por ativo, que não temos de fonte real (o módulo de preço-alvo
 *    de analistas responde 403 no plano atual) e cuja estimativa a partir do passado
 *    é exatamente a fabricação que o projeto recusa — ainda por cima num modelo
 *    notoriamente hipersensível a esse input. O que existe aqui é aritmética sobre
 *    valores reais de posição e um alvo declarado pelo usuário.
 */

export const ALLOCATION_CATEGORIES = ["renda_fixa", "acoes", "fiis", "etfs", "bdrs", "fundos"] as const;
export type AllocationCategory = (typeof ALLOCATION_CATEGORIES)[number];

export type PolicySource = "personalizado" | "perfil" | "generico";

export type PolicyTargets = Record<AllocationCategory, number>;

/**
 * Renda fixa x renda variável por perfil. É o único ponto desta política com respaldo
 * de praxe de mercado — os pontos médios das faixas que já eram usadas como contexto
 * para a IA em portfolio-ai.ts (70-90 / 50-70 / 20-40).
 */
const FIXED_INCOME_TARGET: Record<ProfileClassification, number> = {
  Conservador: 80,
  Moderado: 60,
  Arrojado: 30,
};

/**
 * Divisão da parte variável entre as classes. Ao contrário da linha acima, isto NÃO é
 * praxe consagrada — não existe consenso comparável sobre quanto da renda variável vai
 * para ações x FIIs x ETFs. É um ponto de partida declarado, e é justamente por isso
 * que a política é editável e a origem viaja junto na resposta (`source`): o usuário
 * precisa saber que este número é uma convenção nossa, não um dado.
 *
 * BDRs e fundos começam em zero por serem opcionais na maioria das carteiras: entram
 * quando o usuário decidir que entram, em vez de o app empurrar exposição cambial ou
 * taxa de administração para quem não pediu.
 */
const VARIABLE_SPLIT: Record<Exclude<AllocationCategory, "renda_fixa">, number> = {
  acoes: 0.5,
  fiis: 0.3,
  etfs: 0.2,
  bdrs: 0,
  fundos: 0,
};

function emptyTargets(): PolicyTargets {
  return { renda_fixa: 0, acoes: 0, fiis: 0, etfs: 0, bdrs: 0, fundos: 0 };
}

/**
 * Política padrão derivada do perfil. Sem perfil preenchido cai no Moderado, mas quem
 * chama recebe `source: "generico"` para poder dizer na tela que aquilo é um palpite de
 * partida e não algo calculado a partir das respostas do usuário.
 */
export function defaultPolicyFor(profile: ProfileClassification | null): PolicyTargets {
  const fixedIncome = FIXED_INCOME_TARGET[profile ?? "Moderado"];
  const variable = 100 - fixedIncome;
  const targets = emptyTargets();
  targets.renda_fixa = fixedIncome;
  for (const [category, share] of Object.entries(VARIABLE_SPLIT)) {
    targets[category as keyof typeof VARIABLE_SPLIT] = variable * share;
  }
  return targets;
}

export interface CategoryAllocation {
  category: AllocationCategory;
  targetPercent: number;
  currentPercent: number;
  currentValue: number;
  /** Positivo = falta peso nessa classe; negativo = está acima do alvo. */
  deviationPp: number;
  /** Quanto faltaria (positivo) ou sobraria (negativo) em reais para bater o alvo hoje. */
  deviationValue: number;
}

export function computeAllocation(
  valueByCategory: Map<string, number>,
  targets: PolicyTargets,
): { total: number; items: CategoryAllocation[] } {
  const total = Array.from(valueByCategory.values()).reduce((sum, v) => sum + v, 0);

  const items = ALLOCATION_CATEGORIES.map((category) => {
    const currentValue = valueByCategory.get(category) ?? 0;
    const targetPercent = targets[category];
    // Carteira vazia não tem percentual: 0/0 não é zero por cento, é ausência de
    // resposta. Devolver 0 aqui faria toda classe aparecer "abaixo do alvo" numa
    // carteira que sequer existe — quem consome checa `total` antes de ler desvio.
    const currentPercent = total > 0 ? (currentValue / total) * 100 : 0;
    return {
      category,
      targetPercent,
      currentPercent,
      currentValue,
      deviationPp: targetPercent - currentPercent,
      deviationValue: (targetPercent / 100) * total - currentValue,
    };
  });

  return { total, items };
}

export interface ContributionSlice {
  category: AllocationCategory;
  amount: number;
  /** Fatia deste aporte, em % — não confundir com o alvo da classe na carteira. */
  sharePercent: number;
}

/**
 * Piso por fatia. Sugerir "R$ 3,17 em BDRs" é ruído: não dá para comprar quase nada com
 * isso e o usuário paga corretagem sobre um valor irrelevante. Fatias abaixo do piso são
 * descartadas e o valor volta para o bolo, que é redistribuído entre as classes
 * restantes. O piso acompanha o tamanho do aporte para não engolir aportes pequenos —
 * num aporte de R$ 100 o piso é R$ 10, não R$ 50.
 */
const MIN_SLICE_BRL = 50;
const MIN_SLICE_SHARE = 0.1;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Distribui `amount` entre as classes de forma a minimizar a soma dos quadrados dos
 * desvios em relação ao alvo depois do aporte.
 *
 * Sendo T o patrimônio atual, T' = T + aporte e w a fração-alvo, a carteira ideal pós
 * aporte tem w_c·T' em cada classe, então a falta de cada uma é d_c = w_c·T' − v_c.
 * Como Σw = 1, vale Σd_c = T' − T = aporte exatamente: as faltas e as sobras se
 * cancelam no total do aporte.
 *
 * Minimizar Σ(x_c − d_c)² com x ≥ 0 e Σx = aporte dá x_c = max(0, d_c − λ), com λ ≥ 0
 * ajustado para fechar a soma — o clássico "encher de água": o dinheiro vai primeiro
 * para as classes mais distantes do alvo, e para de encher quando elas se nivelam com a
 * próxima. λ ≥ 0 é garantido porque Σd⁺ ≥ Σd = aporte.
 *
 * Quando alguma classe está acima do alvo mesmo depois da diluição (d_c < 0), o desvio
 * dela não zera — não vendemos. Ela simplesmente não recebe nada, e o aporte inteiro vai
 * para as demais.
 */
export function planContribution(
  amount: number,
  valueByCategory: Map<string, number>,
  targets: PolicyTargets,
  eligible: AllocationCategory[] = [...ALLOCATION_CATEGORIES],
): ContributionSlice[] {
  if (!(amount > 0)) return [];

  const total = Array.from(valueByCategory.values()).reduce((sum, v) => sum + v, 0);
  const projectedTotal = total + amount;

  const deficits = eligible
    .map((category) => ({
      category,
      deficit: (targets[category] / 100) * projectedTotal - (valueByCategory.get(category) ?? 0),
    }))
    .filter((d) => d.deficit > 0)
    .sort((a, b) => b.deficit - a.deficit);

  // Nenhuma classe elegível abaixo do alvo (ou alvos todos zerados): sem base para
  // distribuir, devolve vazio em vez de espalhar o aporte por critério inventado.
  if (deficits.length === 0) return [];

  // Acha o λ da fórmula acima: o maior k tal que as k maiores faltas ainda recebem algo.
  let lambda = 0;
  let prefix = 0;
  for (let k = 1; k <= deficits.length; k++) {
    prefix += deficits[k - 1].deficit;
    const candidate = (prefix - amount) / k;
    const next = k < deficits.length ? deficits[k].deficit : Number.NEGATIVE_INFINITY;
    if (candidate < deficits[k - 1].deficit && candidate >= next) {
      lambda = candidate;
      break;
    }
  }

  const raw = deficits
    .map((d) => ({ category: d.category, amount: Math.max(0, d.deficit - lambda) }))
    .filter((s) => s.amount > 0);

  // Descarta fatias insignificantes e refaz a conta só com as classes que sobraram, para
  // que o valor descartado seja de fato realocado e não simplesmente perdido do aporte.
  const floor = Math.min(MIN_SLICE_BRL, amount * MIN_SLICE_SHARE);
  const viable = raw.filter((s) => s.amount >= floor);
  if (viable.length > 0 && viable.length < raw.length) {
    return planContribution(amount, valueByCategory, targets, viable.map((s) => s.category));
  }

  const slices = raw.map((s) => ({
    category: s.category,
    amount: round2(s.amount),
    sharePercent: (s.amount / amount) * 100,
  }));

  // O arredondamento a centavos pode deixar a soma alguns centavos longe do aporte —
  // o resto vai para a maior fatia, para que o total distribuído seja exatamente o que
  // o usuário digitou.
  const distributed = slices.reduce((sum, s) => sum + s.amount, 0);
  const residual = round2(amount - distributed);
  if (residual !== 0 && slices.length > 0) slices[0].amount = round2(slices[0].amount + residual);

  return slices;
}
