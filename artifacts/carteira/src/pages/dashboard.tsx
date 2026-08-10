import { 
  useGetPortfolioSummary, 
  useGetPortfolioEvolution, 
  useGetPortfolioDistribution, 
  useGetPortfolioBenchmarks,
  getGetPortfolioSummaryQueryKey,
  getGetPortfolioEvolutionQueryKey,
  getGetPortfolioDistributionQueryKey,
  getGetPortfolioBenchmarksQueryKey,
  useGetPortfolioRiskMetrics,
  getGetPortfolioRiskMetricsQueryKey,
  useGetPortfolioDividendsProjection
} from "@workspace/api-client-react";
import { formatCurrency, formatPercent, formatShortDateTime } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, BarChart, Bar
} from "recharts";
import { ArrowUpRight, Coins, Scale, TrendingUp, type LucideIcon } from "lucide-react";
import { categoryLabel } from "@/lib/categories";

/**
 * Eixo de valor em reais. O formatador anterior era `R$${(val/1000).toFixed(0)}k`, que
 * arredondava os milhares e produzia um eixo com rótulos repetidos: os ticks 750, 1500
 * e 2250 viravam "R$1k", "R$2k" e "R$2k". Dois rótulos iguais em alturas diferentes
 * fazem o eixo mentir sobre a própria escala.
 */
function formatAxisCurrency(value: number): string {
  if (Math.abs(value) >= 1000) {
    return `R$ ${(value / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}k`;
  }
  return `R$ ${value.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}`;
}

/** Placeholder de gráfico que ainda não tem dado real suficiente para desenhar. */
function ChartEmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex h-[300px] w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed px-6 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-md text-xs text-muted-foreground text-pretty">{detail}</p>
    </div>
  );
}

/**
 * Cartão de indicador da fileira do topo.
 *
 * Os quatro eram blocos quase idênticos copiados, o que fazia qualquer ajuste de
 * espaçamento precisar ser repetido quatro vezes. `value` recebe o número já
 * formatado — ou um travessão, quando o indicador não existe: dois dos quatro
 * cartões nasciam zerados para quem ainda não registrou provento, e um "R$ 0,00"
 * ocupa o mesmo espaço visual de uma medição sem ser uma.
 */
function KpiCard({
  title,
  icon: Icon,
  isLoading,
  value,
  valueClassName,
  children,
}: {
  title: string;
  icon: LucideIcon;
  isLoading?: boolean;
  value: string;
  valueClassName?: string;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="h-8 w-24 animate-pulse rounded bg-muted" />
        ) : (
          <div className={`font-mono text-2xl font-bold tracking-tight ${valueClassName ?? ""}`}>{value}</div>
        )}
        {children}
      </CardContent>
    </Card>
  );
}

const EMPTY_VALUE = "—";

export default function Dashboard() {
  const { data: summary, isLoading: isLoadingSummary } = useGetPortfolioSummary({
    query: { queryKey: getGetPortfolioSummaryQueryKey() }
  });
  
  const { data: evolution, isLoading: isLoadingEvo } = useGetPortfolioEvolution({
    query: { queryKey: getGetPortfolioEvolutionQueryKey() }
  });
  
  const { data: distribution, isLoading: isLoadingDist } = useGetPortfolioDistribution({
    query: { queryKey: getGetPortfolioDistributionQueryKey() }
  });
  
  const { data: benchmarks, isLoading: isLoadingBench } = useGetPortfolioBenchmarks({
    query: { queryKey: getGetPortfolioBenchmarksQueryKey() }
  });

  // Risco da composição de HOJE, medido sobre um ano de fechamentos reais. Vem de
  // fonte diferente do gráfico acima de propósito: o comparativo depende do histórico
  // de uso do app (meses), este depende do mercado (existe desde o primeiro dia).
  const { data: risk, isLoading: isLoadingRisk } = useGetPortfolioRiskMetrics({
    query: { queryKey: getGetPortfolioRiskMetricsQueryKey() }
  });

  // Renda projetada a partir do DPS REAL pago pelos ativos nos últimos 12 meses —
  // não é previsão de mercado, é o que a carteira de hoje teria recebido. Serve para
  // os dois cartões de provento não nascerem zerados: `totalDividends` vem da tabela
  // de transações, ou seja, mede o que o usuário REGISTROU, e é estruturalmente zero
  // para quem acabou de chegar mesmo tendo ativos que distribuem.
  const { data: projection, isLoading: isLoadingProjection } = useGetPortfolioDividendsProjection();

  const hasAssets = (summary?.assetCount ?? 0) > 0;
  const isProfit = summary && summary.totalProfitLoss >= 0;

  const receivedDividends = summary?.totalDividends ?? 0;
  const received12m = summary?.dividendsLast12m ?? 0;
  const projectedMonthly = projection?.projectedMonthlyAverage ?? 0;
  const projectedAnnual = projection?.projectedAnnualIncome ?? 0;
  const patrimony = summary?.totalPatrimony ?? 0;
  const projectedYield = patrimony > 0 ? (projectedAnnual / patrimony) * 100 : 0;

  const showProjectedIncome = receivedDividends <= 0 && projectedMonthly > 0;
  const showProjectedYield = received12m <= 0 && projectedYield > 0;
  const isLoadingDividendCards = isLoadingSummary || isLoadingProjection;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Visão Geral</h1>
        <p className="text-muted-foreground">Posição consolidada do seu portfólio.</p>
      </div>

      {/* Indicadores do topo */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          title="Patrimônio Total"
          icon={Scale}
          isLoading={isLoadingSummary}
          value={hasAssets ? formatCurrency(summary?.totalPatrimony ?? 0) : EMPTY_VALUE}
        >
          <p className="mt-1 text-xs text-muted-foreground">
            {hasAssets
              ? `Distribuído em ${summary?.assetCount} ${summary?.assetCount === 1 ? "ativo" : "ativos"}`
              : "Cadastre um ativo para começar a acompanhar"}
          </p>
          {summary?.pricesStale && summary.pricesStale.length > 0 && (
            <p className="mt-1 text-xs text-amber-700 text-pretty dark:text-amber-500">
              Cotação indisponível para {summary.pricesStale.map((s) => s.ticker).join(", ")} — avaliados
              pelo último preço conhecido, o mais antigo deles de{" "}
              {formatShortDateTime(summary.pricesStale.reduce((oldest, s) => (s.asOf < oldest ? s.asOf : oldest), summary.pricesStale[0].asOf))}.
            </p>
          )}
          {summary?.pricesUnavailable && summary.pricesUnavailable.length > 0 && (
            <p className="mt-1 text-xs text-amber-700 text-pretty dark:text-amber-500">
              Sem cotação para {summary.pricesUnavailable.join(", ")} — entram no total pelo preço médio,
              então aparecem sem lucro nem prejuízo.
            </p>
          )}
        </KpiCard>

        {/* "Resultado", não "Rentabilidade": o gráfico de Comparativo logo abaixo também
            é sobre rendimento, e as duas palavras iguais sobre números diferentes liam
            como contradição na tela. Este card mede o total sobre o custo desde a compra;
            o gráfico mede o rendimento dentro da janela comparável. "Resultado" ainda é
            o vocabulário que Minha Carteira já usa nos ativos ("L&P"). */}
        <KpiCard
          title="Resultado"
          icon={TrendingUp}
          isLoading={isLoadingSummary}
          value={
            hasAssets
              ? `${isProfit ? "+" : ""}${formatCurrency(summary?.totalProfitLoss ?? 0)}`
              : EMPTY_VALUE
          }
          valueClassName={hasAssets ? (isProfit ? "text-green-600 dark:text-green-500" : "text-destructive") : ""}
        >
          <p
            className={`mt-1 text-xs font-medium ${
              hasAssets ? (isProfit ? "text-green-600/80 dark:text-green-500/80" : "text-destructive/80") : "text-muted-foreground"
            }`}
          >
            {hasAssets
              ? `${isProfit ? "+" : ""}${formatPercent(summary?.totalProfitLossPercent ?? 0)}`
              : "Sem posição para medir"}
          </p>
          {hasAssets && (
            <p className="mt-0.5 text-[11px] text-muted-foreground text-pretty">
              sobre o custo, desde a compra
            </p>
          )}
        </KpiCard>

        {/* Recebido quando existe registro; projetado a partir do DPS real quando não —
            nunca R$ 0,00, que ocuparia o mesmo peso visual de uma medição. */}
        <KpiCard
          title={showProjectedIncome ? "Renda Projetada" : "Dividendos Acumulados"}
          icon={Coins}
          isLoading={isLoadingDividendCards}
          value={
            receivedDividends > 0
              ? formatCurrency(receivedDividends)
              : showProjectedIncome
                ? formatCurrency(projectedMonthly)
                : EMPTY_VALUE
          }
          valueClassName={receivedDividends > 0 ? "text-primary" : ""}
        >
          {/* Acumulado e projetado convivem. Antes o cartão trocava de "Renda
              Projetada" para "Dividendos Acumulados" assim que o primeiro provento era
              registrado — bastava um lançamento de R$ 5 para a projeção sumir, ou
              seja, o número mais informativo desaparecia justo quando a pessoa
              começava a usar o app direito. */}
          <p className="mt-1 text-xs text-muted-foreground text-pretty">
            {receivedDividends > 0
              ? projectedMonthly > 0
                ? `Rendimento histórico · ${formatCurrency(projectedMonthly)}/mês pelo que seus ativos distribuíram nos últimos 12 meses`
                : "Rendimento histórico"
              : showProjectedIncome
                ? "Por mês, pelo que seus ativos distribuíram nos últimos 12 meses. Nada recebido foi registrado ainda."
                : hasAssets
                  ? "Seus ativos não distribuíram proventos nos últimos 12 meses"
                  : "Sem ativos para distribuir proventos"}
          </p>
        </KpiCard>

        <KpiCard
          title={showProjectedYield ? "Yield Projetado" : "Yield da Carteira"}
          icon={ArrowUpRight}
          isLoading={isLoadingDividendCards}
          value={
            received12m > 0
              ? formatPercent(summary?.portfolioYield ?? 0)
              : showProjectedYield
                ? formatPercent(projectedYield)
                : EMPTY_VALUE
          }
        >
          <p className="mt-1 text-xs text-muted-foreground text-pretty">
            {received12m > 0 ? (
              <>
                Proventos de 12 meses sobre o valor atual
                {summary?.yieldOnCost != null && ` · ${formatPercent(summary.yieldOnCost)} sobre o custo`}
              </>
            ) : showProjectedYield ? (
              "Sobre o valor atual, pelo DPS real dos últimos 12 meses dos seus ativos"
            ) : hasAssets ? (
              "Ainda sem proventos para calcular"
            ) : (
              "Sem posição para calcular"
            )}
          </p>
        </KpiCard>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Evolution Chart */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Evolução Patrimonial</CardTitle>
            {/* Sem ativo não há o que medir. O endpoint ainda devolve um ponto porque
                o snapshot do dia é gravado a cada leitura do resumo, inclusive com
                patrimônio zero — anunciar "1 mês medido" ali seria ruído. */}
            <CardDescription>
              {!hasAssets
                ? "Um ponto por mês com registro real da carteira."
                : evolution && evolution.length > 0
                  ? `${evolution.length} ${evolution.length === 1 ? "mês medido" : "meses medidos"} — um ponto por mês com registro real da carteira.`
                  : "Um ponto por mês com registro real da carteira."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingEvo ? (
              <div className="h-[300px] w-full bg-muted/20 animate-pulse rounded" />
            ) : !evolution || evolution.length < 2 ? (
              <ChartEmptyState
                title="Histórico ainda sendo coletado"
                detail="A curva aparece a partir do segundo mês com registro. Antes disso não há o que traçar — o app registra o valor da carteira conforme você a acompanha, e não estima os meses anteriores ao seu primeiro acesso."
              />
            ) : (
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={evolution} margin={{ top: 5, right: 20, left: 20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 12 }}
                      stroke="hsl(var(--muted-foreground))"
                    />
                    <YAxis
                      tick={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}
                      stroke="hsl(var(--muted-foreground))"
                      /* Enquadra a variação real em vez de ancorar em zero: com o eixo
                         partindo de 0, uma carteira que oscila entre R$2,4k e R$2,8k
                         desenha a variação inteira no sexto superior do gráfico. */
                      domain={["dataMin", "dataMax"]}
                      padding={{ top: 16, bottom: 16 }}
                      tickFormatter={formatAxisCurrency}
                    />
                    <RechartsTooltip
                      formatter={(value: number) => [formatCurrency(value), "Valor"]}
                      contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', borderRadius: '6px' }}
                    />
                    {/* Reta entre pontos medidos, não spline: com um ponto por mês,
                        a curva suave desenhava subidas e quedas dentro do mês que
                        nenhuma medição sustenta — a mesma fabricação, em forma de
                        interpolação visual. */}
                    <Line
                      type="linear"
                      dataKey="value"
                      stroke="hsl(var(--primary))"
                      strokeWidth={3}
                      dot={{ r: 3, fill: "hsl(var(--primary))" }}
                      activeDot={{ r: 6, fill: "hsl(var(--primary))" }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Distribution Pie Chart */}
        <Card>
          <CardHeader>
            <CardTitle>Alocação por Categoria</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoadingDist ? (
              <div className="h-[300px] w-full bg-muted/20 animate-pulse rounded" />
            ) : !distribution || distribution.byCategory.length === 0 ? (
              <ChartEmptyState
                title="Nada para distribuir ainda"
                detail="A rosca mostra como o patrimônio se reparte entre classes de ativo. Cadastre a primeira posição para vê-la."
              />
            ) : (
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      /* A legenda mostrava `acoes`, `etfs`, `fiis` — as chaves cruas
                         do banco vazando para a tela. O rótulo agora vem do mesmo
                         mapa usado nas outras páginas (lib/categories). */
                      data={(distribution?.byCategory || []).map((c) => ({ ...c, label: categoryLabel(c.label) }))}
                      cx="50%"
                      cy="45%"
                      innerRadius={60}
                      outerRadius={90}
                      paddingAngle={2}
                      dataKey="value"
                      nameKey="label"
                    >
                      {(distribution?.byCategory || []).map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={`hsl(var(--chart-${(index % 5) + 1}))`} />
                      ))}
                    </Pie>
                    <RechartsTooltip 
                      formatter={(value: number) => formatCurrency(value)}
                      contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', borderRadius: '6px' }}
                    />
                    <Legend verticalAlign="bottom" height={36} wrapperStyle={{ fontSize: '12px' }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Benchmarks */}
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Comparativo (Benchmarks)</CardTitle>
            {/* A explicação de método só faz sentido quando há gráfico. Sem janela, o
                próprio placeholder já diz o que falta — repetir aqui duplicaria a
                mensagem na mesma tela. */}
            {/* A frase de abertura responde "o que estou vendo" antes de explicar método:
                era o método que vinha primeiro, e o leitor chegava ao número do gráfico
                sem saber que ele mede outro intervalo que o card Resultado. */}
            <CardDescription className="text-pretty">
              {!benchmarks || benchmarks.points.length < 2
                ? "Rendimento da carteira contra CDI e IBOV, no período em que dá para comparar."
                : `Rendimento dentro da janela, com todas as séries partindo de 0% — é isso que as torna comparáveis, e é por isso que a Carteira aqui não bate com o card Resultado, que mede o total desde a compra. Aporte e resgate saem da conta, porque índice não recebe aporte. ${benchmarks.windowNote ? `${benchmarks.windowNote} ` : ""}CDI do Banco Central, IBOV pelo fechamento real do índice.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingBench ? (
              <div className="h-[300px] w-full bg-muted/20 animate-pulse rounded" />
            ) : !benchmarks || benchmarks.points.length < 2 ? (
              <ChartEmptyState
                title="Sem janela comparável ainda"
                detail={
                  benchmarks?.windowNote ??
                  "É preciso ter pelo menos dois meses seguidos com dado real de todas as séries para comparar rentabilidade acumulada."
                }
              />
            ) : (
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={benchmarks?.points || []} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis 
                      dataKey="label" 
                      tick={{ fontSize: 12 }} 
                      stroke="hsl(var(--muted-foreground))"
                    />
                    <YAxis 
                      tick={{ fontSize: 12, fontFamily: 'var(--font-mono)' }} 
                      stroke="hsl(var(--muted-foreground))"
                      tickFormatter={(val) => `${val.toFixed(0)}%`}
                    />
                    {/* O nome da série, não um rótulo fixo: o formatter descartava o
                        segundo argumento e rotulava as TRÊS linhas com a mesma palavra,
                        deixando só a cor para distinguir carteira de CDI e de IBOV. */}
                    <RechartsTooltip
                      formatter={(value: number, name: string) => [`${value.toFixed(2)}%`, name]}
                      contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', borderRadius: '6px' }}
                    />
                    <Legend />
                    {/* "(no período)" na própria legenda: é o único lugar que o olho
                        cruza ao comparar a linha com o card Resultado logo acima. */}
                    <Line type="linear" name="Carteira (no período)" dataKey="portfolio" stroke="hsl(var(--primary))" strokeWidth={3} dot={false} />
                    <Line type="linear" name="CDI" dataKey="cdi" stroke="hsl(var(--chart-3))" strokeWidth={2} dot={false} strokeDasharray="5 5" />
                    <Line type="linear" name="IBOV" dataKey="ibov" stroke="hsl(var(--chart-4))" strokeWidth={2} dot={false} strokeDasharray="5 5" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Card PRÓPRIO, não uma faixa dentro do Comparativo. Os dois falam de
            oscilação, mas medem coisas diferentes: o gráfico acima é o histórico
            da pessoa (depende de meses de uso do app), este é a composição de hoje
            contra um ano de mercado (existe desde o primeiro dia). Encostar um no
            outro recriaria a leitura de contradição que motivou renomear os cards. */}
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Oscilação da carteira atual</CardTitle>
            <CardDescription className="text-pretty">
              {risk?.available && risk.metrics
                ? `Quanto os ativos que você tem HOJE oscilaram no último ano, com as quantidades atuais aplicadas aos preços reais de ${risk.metrics.tradingDays} pregões. Não é o seu histórico — suas posições mudaram no período; é o comportamento do que está na carteira agora.`
                : "Quanto os ativos que você tem hoje oscilaram no último ano."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingRisk ? (
              <div className="h-24 w-full animate-pulse rounded bg-muted/20" />
            ) : !risk?.available || !risk.metrics ? (
              /* Não usa ChartEmptyState aqui: aquele componente reserva a altura de
                 um gráfico, e para três números vira um vazio de 300px na home. */
              <div className="rounded-lg border border-dashed p-4">
                <p className="text-sm font-medium">Sem oscilação medida</p>
                <p className="mt-1 text-xs text-muted-foreground text-pretty">
                  {risk?.reason ?? "Não há pregões suficientes para medir."}
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <RiskStat
                    label="Volatilidade anual"
                    value={`${risk.metrics.volatility.toFixed(1).replace(".", ",")}%`}
                    detail={
                      risk.metrics.benchmarkVolatility != null
                        ? `IBOV no mesmo período: ${risk.metrics.benchmarkVolatility.toFixed(1).replace(".", ",")}%`
                        : "Sem série do IBOV para comparar"
                    }
                  />
                  <RiskStat
                    label="Meses positivos"
                    value={`${risk.metrics.positiveMonths} de ${risk.metrics.monthlyReturns.length}`}
                    detail="Fechamento de mês contra o anterior"
                  />
                  <RiskStat
                    label="Meses acima do IBOV"
                    value={
                      risk.metrics.monthsAboveBenchmark != null
                        ? `${risk.metrics.monthsAboveBenchmark} de ${risk.metrics.monthlyReturns.filter((m) => m.benchmarkPercent != null).length}`
                        : EMPTY_VALUE
                    }
                    detail="Comparado mês a mês, não no acumulado"
                  />
                </div>
                {/* A cobertura só vira aviso quando falta pedaço: dizer "100% medido"
                    a quem só tem ação seria ruído em toda visita. */}
                {risk.metrics.coveragePercent < 99.5 && (
                  <p className="mt-3 text-xs text-amber-700 text-pretty dark:text-amber-500">
                    Medido sobre {risk.metrics.coveragePercent.toFixed(0)}% da carteira.{" "}
                    {risk.metrics.uncovered.join(", ")} {risk.metrics.uncovered.length === 1 ? "ficou" : "ficaram"} de
                    fora por não ter cotação diária de bolsa, então a oscilação real da carteira inteira é menor que a
                    mostrada.
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>

      </div>
    </div>
  );
}

/** Número grande com rótulo e uma linha de contexto — o padrão dos KPIs do topo. */
function RiskStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-2xl font-bold tabular-nums">{value}</p>
      <p className="mt-1 text-[11px] text-muted-foreground text-pretty">{detail}</p>
    </div>
  );
}
