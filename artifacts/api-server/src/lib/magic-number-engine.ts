/**
 * "Número mágico": quantas cotas/ações de UM ativo são necessárias pra que o
 * dividendo médio real pago por ele já compre mais uma cota dele mesmo, no preço
 * atual — o ponto em que aquela posição, isoladamente, se autossustenta.
 *
 *   número mágico = preço atual ÷ dividendo médio real por cota nos últimos 12 meses
 *
 * Não é um alvo fixo: preço e dividendo mudam todo mês, então o número recalcula a
 * cada consulta — é um indicador de progresso, não uma meta estática.
 *
 * O risco de tratar isso como meta isolada é empurrar aporte concentrado num único
 * ativo só pra "bater o número" mais rápido — e a régua de concentração do app
 * (concentrationLimitsFor, analysis-engine.ts) já existe justamente pra evitar isso,
 * só que hoje ela olha só pra TRÁS (alerta depois que já concentrou). As funções
 * abaixo aplicam o mesmo teto pra FRENTE: quanto dá pra comprar agora sem estourar
 * a faixa "Atenção" do perfil, e o que precisa esperar o patrimônio total crescer
 * (aporte em OUTROS ativos) pra abrir espaço — porque concentração é uma razão, e
 * crescer o denominador libera o numerador sem violar o limite.
 */

export interface MagicNumberResult {
  /** Preço atual usado na conta. */
  price: number;
  /** Dividendo médio real por cota, R$/mês (soma real dos últimos 12 meses ÷ 12). */
  avgMonthlyDividendPerUnit: number;
  /** Cotas necessárias pra essa posição se autossustentar — sempre arredondado pra cima: "pelo menos" essa quantidade. */
  magicNumberUnits: number;
  /** Quantidade já possuída. */
  currentUnits: number;
  /** Cotas que ainda faltam pro número mágico. Zero quando já atingiu ou passou. */
  unitsRemaining: number;
}

/**
 * `null` sem preço real ou sem dividendo real pago nos últimos 12 meses — nunca
 * estima um número mágico pra ativo que não distribuiu nada (a maioria das ações de
 * crescimento, por exemplo, onde o conceito simplesmente não se aplica).
 */
export function computeMagicNumber(price: number, avgMonthlyDividendPerUnit: number, currentUnits: number): MagicNumberResult | null {
  if (price <= 0 || avgMonthlyDividendPerUnit <= 0) return null;

  const magicNumberUnits = Math.ceil(price / avgMonthlyDividendPerUnit);
  return {
    price,
    avgMonthlyDividendPerUnit,
    magicNumberUnits,
    currentUnits,
    unitsRemaining: Math.max(0, magicNumberUnits - currentUnits),
  };
}

export interface ConcentrationSafePlan {
  /** Cotas que dá pra comprar AGORA sem estourar o teto "Atenção" do perfil. */
  safeUnitsToAddNow: number;
  /** Cotas que faltam além do que é seguro comprar agora — dependem do patrimônio total crescer (aporte em outros ativos) pra abrir espaço, não de reforçar mais esse ativo. */
  unitsBeyondSafeCeiling: number;
  /** true quando dá pra fechar o número mágico inteiro agora, sem risco de concentração. */
  reachesGoalNow: boolean;
  /** % que a posição já representa da carteira hoje. */
  currentPositionPercent: number;
  /** Teto "Atenção" do perfil do usuário (%) usado como limite de planejamento. */
  concentrationCeilingPercent: number;
  /** true quando a posição já está no teto ou acima — não seguro aportar mais nela agora, mesmo faltando pouco pro número mágico. */
  alreadyAtOrOverCeiling: boolean;
}

/**
 * `null` sem patrimônio total real (carteira vazia) — não dá pra calcular uma razão
 * sobre uma base zero.
 *
 * O teto usado é o "Atenção" (`ConcentrationLimits.high`), não o "Crítico": a ideia é
 * nunca planejar uma compra que empurre a posição pro nível que já dispara alerta,
 * não só evitar o nível mais grave.
 */
export function planSafePurchaseTowardMagicNumber(
  magicNumber: MagicNumberResult,
  totalPatrimony: number,
  concentrationCeilingPercent: number,
): ConcentrationSafePlan | null {
  if (totalPatrimony <= 0) return null;

  const currentPositionValue = magicNumber.currentUnits * magicNumber.price;
  const currentPositionPercent = (currentPositionValue / totalPatrimony) * 100;

  // Patrimônio total já inclui o valor atual desta posição — mesma base usada em
  // todo o resto do app pra medir concentração (positionValue / totalPatrimony), o
  // teto aqui fecha com o mesmo número que dispara o alerta de concentração alhures.
  const maxPositionValue = totalPatrimony * (concentrationCeilingPercent / 100);
  const maxUnitsAtCeiling = Math.floor(maxPositionValue / magicNumber.price);

  const safeUnitsToAddNow = Math.max(0, Math.min(magicNumber.unitsRemaining, maxUnitsAtCeiling - magicNumber.currentUnits));
  const unitsBeyondSafeCeiling = magicNumber.unitsRemaining - safeUnitsToAddNow;

  return {
    safeUnitsToAddNow,
    unitsBeyondSafeCeiling,
    reachesGoalNow: unitsBeyondSafeCeiling === 0,
    currentPositionPercent,
    concentrationCeilingPercent,
    alreadyAtOrOverCeiling: currentPositionPercent >= concentrationCeilingPercent,
  };
}
