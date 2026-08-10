import type { PortfolioSnapshot, Sale } from "@workspace/db";

/**
 * Retorno time-weighted (TWR) — o rendimento da carteira com aportes e resgates
 * NEUTRALIZADOS.
 *
 * Existe porque retorno sobre custo, que é o que o KPI "Rentabilidade" mostra, se move
 * quando entra dinheiro novo mesmo sem nada ter acontecido com os preços. Uma carteira
 * de R$ 100 valendo R$ 110 está +10%; aporte R$ 100 ao preço de mercado e ela passa a
 * R$ 210 sobre custo R$ 200, ou +5%. Metade da rentabilidade evaporou num movimento que
 * não foi desempenho. Colocar esse número no mesmo eixo do CDI e do IBOV — que não
 * recebem aporte — compara coisas diferentes.
 *
 * A correção padrão do mercado é quebrar a série em subperíodos nas datas de fluxo e
 * multiplicar os fatores, e é o que este módulo faz:
 *
 *     fator_do_periodo = valor_final / (valor_inicial + fluxo_liquido)
 *     TWR              = Π fatores − 1
 *
 * TWR responde "como foram os ativos que escolhi", que é a pergunta do comparativo.
 * NÃO responde "quanto eu ganhei" — para isso o número certo continua sendo o lucro em
 * reais, e é por isso que o KPI não muda.
 *
 * ## De onde sai o fluxo líquido
 *
 * `total_cost` do snapshot é Σ quantidade × preço médio, então sua variação já é o
 * aporte líquido A CUSTO. Isso serve direto para compra (comprou por R$ X, o custo sobe
 * R$ X), mas erra na venda: vender uma posição de custo R$ 100 por R$ 120 derruba o
 * custo em 100 e o valor em 120, e tratar a saída como 100 inventaria um prejuízo de 20.
 *
 * Por isso a venda entra pelo valor de mercado, com dado real da tabela `sales`
 * (`quantity`, `averagePrice` = custo da posição vendida, `salePrice` = o que entrou):
 *
 *     fluxo = (Δcusto + custo_das_vendas) − valor_recebido_nas_vendas
 *
 * O termo `+ custo_das_vendas` desfaz a queda de custo provocada pela venda, deixando
 * o Δcusto representar só compras; a subtração do valor recebido registra a saída pelo
 * que ela de fato foi.
 *
 * ## Limites, explícitos
 *
 * - **Fluxo posicionado no início do subperíodo.** Não há hora do aporte no dado, só o
 *   dia. Ponderar pelo tempo dentro do período (Dietz modificado) exigiria isso. Com
 *   snapshot quase diário — um por dia em que o app é aberto — o subperíodo é curto e
 *   o erro é pequeno; entre snapshots distantes, cresce.
 * - **Edição manual de quantidade ou preço médio vira aporte.** Corrigir um preço médio
 *   digitado errado mexe em `total_cost` sem ter havido dinheiro entrando, e daqui isso
 *   é indistinguível de um aporte. É o preço de derivar fluxo do custo em vez de ter um
 *   extrato de movimentações.
 * - **Cadeia interrompida não é remendada.** Carteira zerada, ou valor inicial de
 *   subperíodo não-positivo, quebram a série: o que veio antes não é comparável com o
 *   que vem depois. Em vez de emendar por cima do buraco, a cadeia recomeça e os meses
 *   anteriores somem do resultado — quem chama vê a ausência, não um número inventado.
 */

/** Um ponto medido da carteira: quanto ela valia e quanto havia custado, naquele dia. */
export interface PortfolioPoint {
  /** "YYYY-MM-DD" */
  date: string;
  value: number;
  cost: number;
}

interface SaleFlow {
  date: string;
  /** quantidade × preço médio — o custo que saiu da carteira com a venda. */
  basis: number;
  /** quantidade × preço de venda — o dinheiro que de fato entrou. */
  proceeds: number;
}

function toSaleFlows(sales: Sale[]): SaleFlow[] {
  return sales
    .map((s) => {
      const qty = parseFloat(s.quantity);
      return {
        date: s.saleDate,
        basis: qty * parseFloat(s.averagePrice),
        proceeds: qty * parseFloat(s.salePrice),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Junta snapshots e a posição de agora numa série ordenada e sem datas repetidas.
 *
 * O ponto ao vivo substitui o snapshot do mesmo dia em vez de somar-se a ele: os dois
 * medem a mesma carteira, e o ao vivo tem a cotação mais recente.
 */
function buildSeries(snapshots: PortfolioSnapshot[], live: PortfolioPoint | null): PortfolioPoint[] {
  const byDate = new Map<string, PortfolioPoint>();
  for (const s of snapshots) {
    byDate.set(s.date, { date: s.date, value: parseFloat(s.totalValue), cost: parseFloat(s.totalCost) });
  }
  if (live != null) byDate.set(live.date, live);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export interface MonthlyTwr {
  /** Crescimento acumulado de R$ 1 desde o início da cadeia. 1,05 = +5%. */
  factor: number;
  /** Patrimônio no fechamento do mês — o que a tela mostra como ponto de partida. */
  value: number;
}

/**
 * Fator acumulado e patrimônio ao fim de cada mês com medição.
 *
 * A chave é "YYYY-MM". O fator vai em razão, não em percentual, porque quem chama
 * rebaseia dividindo pelo fator do mês que abre a janela — mesma forma como as séries
 * de índice ao lado são rebaseadas.
 *
 * O `value` acompanha para a tela poder dizer QUANTO a carteira valia no mês-base. Sem
 * isso, o gráfico mostra um percentual medido a partir de um ponto que o usuário não
 * enxerga, e a diferença para o card Resultado (que mede contra o custo) vira mistério.
 *
 * Mês sem medição simplesmente não aparece no mapa — ausência é ausência, não zero.
 */
export function computeMonthlyTwr(
  snapshots: PortfolioSnapshot[],
  sales: Sale[],
  live: PortfolioPoint | null,
): Map<string, MonthlyTwr> {
  const series = buildSeries(snapshots, live);
  const flows = toSaleFlows(sales);

  let byMonth = new Map<string, MonthlyTwr>();
  let running = 1;
  let previous: PortfolioPoint | null = null;
  let flowIdx = 0;

  for (const point of series) {
    // Custo não-positivo é carteira vazia, não retorno zero. Serve de fronteira: o que
    // vier depois é uma carteira nova, incomparável com a anterior.
    if (point.cost <= 0) {
      byMonth = new Map();
      running = 1;
      previous = null;
      // As vendas até aqui já não interessam — a cadeia recomeça adiante.
      while (flowIdx < flows.length && flows[flowIdx].date <= point.date) flowIdx++;
      continue;
    }

    if (previous == null) {
      running = 1;
      byMonth.set(point.date.slice(0, 7), { factor: running, value: point.value });
      previous = point;
      while (flowIdx < flows.length && flows[flowIdx].date <= point.date) flowIdx++;
      continue;
    }

    // Vendas em (data_anterior, data_atual]. A venda no dia do próprio snapshot conta
    // para o período que ali termina, porque o snapshot é reescrito a cada leitura do
    // dia e portanto já reflete a carteira depois da venda.
    let basis = 0;
    let proceeds = 0;
    while (flowIdx < flows.length && flows[flowIdx].date <= point.date) {
      basis += flows[flowIdx].basis;
      proceeds += flows[flowIdx].proceeds;
      flowIdx++;
    }

    const netFlow = point.cost - previous.cost + basis - proceeds;
    const opening = previous.value + netFlow;

    if (opening <= 0) {
      // Sem base positiva não há retorno definido para o período. Quebra a cadeia em
      // vez de produzir um fator que pareceria medido.
      byMonth = new Map();
      running = 1;
      byMonth.set(point.date.slice(0, 7), { factor: running, value: point.value });
      previous = point;
      continue;
    }

    running *= point.value / opening;
    // Sobrescreve o mês a cada medição: sobra a última do mês, que é o fechamento.
    byMonth.set(point.date.slice(0, 7), { factor: running, value: point.value });
    previous = point;
  }

  return byMonth;
}
