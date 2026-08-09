import { 
  useGetPortfolioSummary, 
  useGetPortfolioEvolution, 
  useGetPortfolioDistribution, 
  useGetPortfolioBenchmarks,
  getGetPortfolioSummaryQueryKey,
  getGetPortfolioEvolutionQueryKey,
  getGetPortfolioDistributionQueryKey,
  getGetPortfolioBenchmarksQueryKey
} from "@workspace/api-client-react";
import { formatCurrency, formatPercent, formatShortDateTime } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, BarChart, Bar
} from "recharts";
import { ArrowUpRight, Coins, Scale, TrendingUp } from "lucide-react";
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

  const isProfit = summary && summary.totalProfitLoss >= 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Visão Geral</h1>
        <p className="text-muted-foreground">Posição consolidada do seu portfólio.</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Patrimônio Total</CardTitle>
            <Scale className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? (
              <div className="h-8 w-24 bg-muted animate-pulse rounded" />
            ) : (
              <div className="text-2xl font-bold font-mono tracking-tight">
                {formatCurrency(summary?.totalPatrimony || 0)}
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              Distribuído em {summary?.assetCount || 0} ativos
            </p>
            {summary?.pricesStale && summary.pricesStale.length > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-500 mt-1 text-pretty">
                Cotação indisponível para {summary.pricesStale.map((s) => s.ticker).join(", ")} — avaliados
                pelo último preço conhecido, o mais antigo deles de{" "}
                {formatShortDateTime(summary.pricesStale.reduce((oldest, s) => (s.asOf < oldest ? s.asOf : oldest), summary.pricesStale[0].asOf))}.
              </p>
            )}
            {summary?.pricesUnavailable && summary.pricesUnavailable.length > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-500 mt-1 text-pretty">
                Sem cotação para {summary.pricesUnavailable.join(", ")} — entram no total pelo preço médio,
                então aparecem sem lucro nem prejuízo.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Rentabilidade</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? (
              <div className="h-8 w-24 bg-muted animate-pulse rounded" />
            ) : (
              <div className={`text-2xl font-bold font-mono tracking-tight ${isProfit ? 'text-green-600 dark:text-green-500' : 'text-destructive'}`}>
                {isProfit ? '+' : ''}{formatCurrency(summary?.totalProfitLoss || 0)}
              </div>
            )}
            <p className={`text-xs mt-1 font-medium ${isProfit ? 'text-green-600/80 dark:text-green-500/80' : 'text-destructive/80'}`}>
              {isProfit ? '+' : ''}{formatPercent(summary?.totalProfitLossPercent || 0)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Dividendos Acumulados</CardTitle>
            <Coins className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? (
              <div className="h-8 w-24 bg-muted animate-pulse rounded" />
            ) : (
              <div className="text-2xl font-bold font-mono tracking-tight text-primary">
                {formatCurrency(summary?.totalDividends || 0)}
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              Rendimento histórico
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Yield da Carteira</CardTitle>
            <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? (
              <div className="h-8 w-24 bg-muted animate-pulse rounded" />
            ) : (
              <div className="text-2xl font-bold font-mono tracking-tight">
                {formatPercent(summary?.portfolioYield || 0)}
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              Proventos de 12 meses sobre o valor atual
              {summary?.yieldOnCost != null && ` · ${formatPercent(summary.yieldOnCost)} sobre o custo`}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Evolution Chart */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Evolução Patrimonial</CardTitle>
            <CardDescription>
              {evolution && evolution.length > 0
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
            <CardDescription className="text-pretty">
              {!benchmarks || benchmarks.points.length < 2
                ? "Rentabilidade acumulada da carteira contra CDI e IBOV."
                : `${benchmarks.windowNote ? `${benchmarks.windowNote} ` : ""}Todas as séries partem de 0% no início da janela, que é o que torna o acumulado comparável entre elas. CDI vem do Banco Central e IBOV do fechamento real do índice.`}
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
                    <RechartsTooltip 
                      formatter={(value: number) => [`${value.toFixed(2)}%`, "Rentabilidade"]}
                      contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', borderRadius: '6px' }}
                    />
                    <Legend />
                    <Line type="linear" name="Carteira" dataKey="portfolio" stroke="hsl(var(--primary))" strokeWidth={3} dot={false} />
                    <Line type="linear" name="CDI" dataKey="cdi" stroke="hsl(var(--chart-3))" strokeWidth={2} dot={false} strokeDasharray="5 5" />
                    <Line type="linear" name="IBOV" dataKey="ibov" stroke="hsl(var(--chart-4))" strokeWidth={2} dot={false} strokeDasharray="5 5" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
