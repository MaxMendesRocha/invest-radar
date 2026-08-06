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
import { formatCurrency, formatPercent } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, BarChart, Bar
} from "recharts";
import { Activity, ArrowUpRight, Coins, Scale, TrendingUp } from "lucide-react";

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
          </CardHeader>
          <CardContent>
            {isLoadingEvo ? (
              <div className="h-[300px] w-full bg-muted/20 animate-pulse rounded" />
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
                      tickFormatter={(val) => `R$${(val/1000).toFixed(0)}k`}
                    />
                    <RechartsTooltip
                      formatter={(value: number) => [formatCurrency(value), "Valor"]}
                      contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', borderRadius: '6px' }}
                    />
                    <Line 
                      type="monotone" 
                      dataKey="value" 
                      stroke="hsl(var(--primary))" 
                      strokeWidth={3}
                      dot={false}
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
                      data={distribution?.byCategory || []}
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
            <CardDescription>Carteira reflete sua rentabilidade real atual. CDI é real (Banco Central); IBOV usa dados reais dos meses recentes; IFIX ainda está sendo acumulado e usa aproximação simulada até ter histórico suficiente.</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingBench ? (
              <div className="h-[300px] w-full bg-muted/20 animate-pulse rounded" />
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
                    <Line type="monotone" name="Carteira" dataKey="portfolio" stroke="hsl(var(--primary))" strokeWidth={3} dot={false} />
                    <Line type="monotone" name="CDI" dataKey="cdi" stroke="hsl(var(--chart-3))" strokeWidth={2} dot={false} strokeDasharray="5 5" />
                    <Line type="monotone" name="IBOV" dataKey="ibov" stroke="hsl(var(--chart-4))" strokeWidth={2} dot={false} strokeDasharray="5 5" />
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
