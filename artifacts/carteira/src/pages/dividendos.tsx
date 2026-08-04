import { useState, useMemo, type FormEvent } from "react";
import {
  useListTransactions,
  useCreateTransaction,
  useDeleteTransaction,
  useGetPortfolioSummary,
  useGetPortfolioDividendsUpcoming,
  useGetPortfolioDividendsProjection,
  getListTransactionsQueryKey,
  getGetPortfolioSummaryQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";
import { Plus, Trash2, Coins, ArrowUpRight, CalendarClock, TrendingUp } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const TYPE_MAP: Record<string, string> = {
  dividendo: "Dividendo",
  jcp: "JCP",
  rendimento: "Rendimento",
  amortizacao: "Amortização"
};

const CATEGORY_MAP: Record<string, string> = {
  acoes: "Ações",
  fiis: "FIIs",
  etfs: "ETFs",
  bdrs: "BDRs",
};

function formatProjectionMonth(month: string): string {
  const [y, m] = month.split("-");
  return `${m}/${y.slice(2)}`;
}

export default function Dividendos() {
  const { data: summary } = useGetPortfolioSummary({ query: { queryKey: getGetPortfolioSummaryQueryKey() } });
  const { data: transactions, isLoading } = useListTransactions({ query: { queryKey: getListTransactionsQueryKey() } });
  const { data: upcomingDividends, isLoading: isLoadingUpcoming } = useGetPortfolioDividendsUpcoming();
  const { data: projection, isLoading: isLoadingProjection } = useGetPortfolioDividendsProjection();
  
  const [isOpen, setIsOpen] = useState(false);
  const [ticker, setTicker] = useState("");
  const [amount, setAmount] = useState("");
  const [type, setType] = useState("dividendo");
  const [date, setDate] = useState("");
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const createTx = useCreateTransaction();
  const deleteTx = useDeleteTransaction();

  const resetForm = () => {
    setTicker("");
    setAmount("");
    setType("dividendo");
    setDate("");
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    createTx.mutate({
      data: {
        ticker,
        amount: Number(amount),
        type: type as any,
        date: new Date(date).toISOString(),
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetPortfolioSummaryQueryKey() });
        setIsOpen(false);
        resetForm();
        toast({ title: "Provento registrado." });
      }
    });
  };

  const handleDelete = (id: number) => {
    if (confirm("Remover este registro?")) {
      deleteTx.mutate({ id }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetPortfolioSummaryQueryKey() });
          toast({ title: "Registro removido." });
        }
      });
    }
  };

  // Process data for chart
  const monthlyData = useMemo(() => {
    if (!transactions) return [];
    
    const grouped = transactions.reduce((acc: any, tx) => {
      const d = new Date(tx.date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!acc[key]) acc[key] = { month: key, amount: 0 };
      acc[key].amount += tx.amount;
      return acc;
    }, {});

    return Object.values(grouped).sort((a: any, b: any) => a.month.localeCompare(b.month)).slice(-12);
  }, [transactions]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-bold tracking-tight">Dividendos e Proventos</h1>
          <p className="text-muted-foreground">Histórico de rendimentos da sua carteira.</p>
        </div>
        
        <Dialog open={isOpen} onOpenChange={(open) => {
          setIsOpen(open);
          if(!open) resetForm();
        }}>
          <DialogTrigger asChild>
            <Button><Plus className="w-4 h-4 mr-2" /> Registrar Provento</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Novo Provento</DialogTitle>
              <DialogDescription>Registre um pagamento recebido.</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Ticker</Label>
                  <Input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} required />
                </div>
                <div className="space-y-2">
                  <Label>Valor Total (R$)</Label>
                  <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Tipo</Label>
                  <Select value={type} onValueChange={setType}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(TYPE_MAP).map(([k, v]) => (
                        <SelectItem key={k} value={k}>{v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Data de Pagamento</Label>
                  <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
                </div>
              </div>
              <DialogFooter>
                <Button type="submit" disabled={createTx.isPending}>
                  {createTx.isPending ? "Salvando..." : "Salvar"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="w-4 h-4 text-muted-foreground" />
            Renda Passiva Projetada
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoadingProjection ? (
            <p className="text-sm text-muted-foreground">Carregando...</p>
          ) : !projection || projection.byAsset.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Adicione ativos cotados na carteira para ver a projeção de renda passiva.
            </p>
          ) : (
            <div className="space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="rounded-md border border-border/50 p-4">
                  <div className="text-xs text-muted-foreground">Renda Anual Projetada</div>
                  <div className="text-2xl font-bold font-mono text-primary">{formatCurrency(projection.projectedAnnualIncome)}</div>
                </div>
                <div className="rounded-md border border-border/50 p-4">
                  <div className="text-xs text-muted-foreground">Média Mensal Projetada</div>
                  <div className="text-2xl font-bold font-mono text-primary">{formatCurrency(projection.projectedMonthlyAverage)}</div>
                </div>
              </div>

              {projection.byMonth.length > 0 && (
                <div>
                  <div className="text-sm font-medium mb-2">Distribuição real por mês (últimos 12 meses)</div>
                  <div className="h-[220px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={projection.byMonth} margin={{ top: 5, right: 0, left: 0, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                        <XAxis dataKey="month" tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" tickFormatter={formatProjectionMonth} />
                        <YAxis tick={{ fontSize: 12, fontFamily: "var(--font-mono)" }} stroke="hsl(var(--muted-foreground))" tickFormatter={(val) => `R$${val}`} />
                        <RechartsTooltip
                          formatter={(value: number) => [formatCurrency(value), "Recebido"]}
                          labelFormatter={formatProjectionMonth}
                          contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))", borderRadius: "6px" }}
                          cursor={{ fill: "hsl(var(--muted))" }}
                        />
                        <Bar dataKey="amount" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              <div>
                <div className="text-sm font-medium mb-2">Por ativo</div>
                <div className="hidden md:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Ativo</TableHead>
                        <TableHead>Categoria</TableHead>
                        <TableHead className="text-right">DPS 12m</TableHead>
                        <TableHead className="text-right">DY no Preço</TableHead>
                        <TableHead className="text-right">DY no Custo</TableHead>
                        <TableHead className="text-right">Renda Anual</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {projection.byAsset.map((a) => (
                        <TableRow key={a.ticker}>
                          <TableCell className="font-bold">{a.ticker}</TableCell>
                          <TableCell>{CATEGORY_MAP[a.category] || a.category}</TableCell>
                          <TableCell className="text-right font-mono">
                            {a.dps12m == null ? <span className="text-xs text-muted-foreground">Sem histórico</span> : formatCurrency(a.dps12m)}
                          </TableCell>
                          <TableCell className="text-right font-mono">{a.dyOnPrice == null ? "—" : formatPercent(a.dyOnPrice)}</TableCell>
                          <TableCell className="text-right font-mono">{a.dyOnCost == null ? "—" : formatPercent(a.dyOnCost)}</TableCell>
                          <TableCell className="text-right font-mono">
                            {a.projectedAnnualIncome == null ? "—" : formatCurrency(a.projectedAnnualIncome)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <div className="md:hidden space-y-3">
                  {projection.byAsset.map((a) => (
                    <Card key={a.ticker}>
                      <CardContent className="p-4 space-y-3">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="font-bold">{a.ticker}</div>
                            <div className="text-xs text-muted-foreground">{CATEGORY_MAP[a.category] || a.category}</div>
                          </div>
                          <div className="font-mono font-medium text-right">
                            {a.projectedAnnualIncome == null ? "—" : formatCurrency(a.projectedAnnualIncome)}
                          </div>
                        </div>
                        <div className="grid grid-cols-3 gap-y-2 gap-x-2 text-sm">
                          <div>
                            <div className="text-xs text-muted-foreground">DPS 12m</div>
                            <div className="font-mono">{a.dps12m == null ? "—" : formatCurrency(a.dps12m)}</div>
                          </div>
                          <div>
                            <div className="text-xs text-muted-foreground">DY Preço</div>
                            <div className="font-mono">{a.dyOnPrice == null ? "—" : formatPercent(a.dyOnPrice)}</div>
                          </div>
                          <div>
                            <div className="text-xs text-muted-foreground">DY Custo</div>
                            <div className="font-mono">{a.dyOnCost == null ? "—" : formatPercent(a.dyOnCost)}</div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>

              <p className="text-[10px] text-muted-foreground">
                Projeção baseada em proventos reais pagos nos últimos 12 meses pelos ativos que você tem hoje, aplicados à quantidade atual — não é garantia de pagamento futuro. Ativos sem histórico suficiente aparecem como "Sem histórico" e não entram na soma.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="w-4 h-4 text-muted-foreground" />
            Próximos Pagamentos
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoadingUpcoming ? (
            <p className="text-sm text-muted-foreground">Carregando...</p>
          ) : !upcomingDividends || upcomingDividends.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhum pagamento futuro confirmado pelo provedor de dados no momento para os ativos da sua carteira.
            </p>
          ) : (
            <div className="space-y-2">
              {upcomingDividends.map((d, i) => (
                <div
                  key={`${d.ticker}-${d.paymentDate}-${i}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/50 px-3 py-2 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <span className="font-bold shrink-0">{d.ticker}</span>
                    <span className="text-muted-foreground shrink-0">{d.label}</span>
                    <span className="text-muted-foreground shrink-0">
                      {new Date(d.paymentDate).toLocaleDateString("pt-BR")}
                    </span>
                    <Badge variant={d.confirmed ? "default" : "outline"} className="shrink-0">
                      {d.confirmed ? "Confirmado" : "Previsto"}
                    </Badge>
                  </div>
                  <span className="font-mono font-medium text-primary shrink-0">
                    {formatCurrency(d.expectedAmount)}
                  </span>
                </div>
              ))}
              <p className="text-[10px] text-muted-foreground pt-1">
                Valores estimados com base na quantidade atual do ativo e no provento anunciado pelo provedor de dados — "Previsto" ainda não foi formalizado em ata.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Acumulado</CardTitle>
            <Coins className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono text-primary">
              {formatCurrency(summary?.totalDividends || 0)}
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Yield on Cost (YOC)</CardTitle>
            <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono">
              {formatPercent(summary?.portfolioYield || 0)}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Histórico de Recebimentos (12 meses)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={monthlyData} margin={{ top: 5, right: 0, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis 
                    dataKey="month" 
                    tick={{ fontSize: 12 }} 
                    stroke="hsl(var(--muted-foreground))"
                    tickFormatter={(val) => {
                      const [y, m] = val.split('-');
                      return `${m}/${y.slice(2)}`;
                    }}
                  />
                  <YAxis 
                    tick={{ fontSize: 12, fontFamily: 'var(--font-mono)' }} 
                    stroke="hsl(var(--muted-foreground))"
                    tickFormatter={(val) => `R$${val}`}
                  />
                  <RechartsTooltip 
                    formatter={(value: number) => [formatCurrency(value), "Valor"]}
                    contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', borderRadius: '6px' }}
                    cursor={{ fill: 'hsl(var(--muted))' }}
                  />
                  <Bar dataKey="amount" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-1 flex flex-col">
          <CardHeader>
            <CardTitle>Últimos Registros</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 p-0">
            <div className="h-[300px] overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead>Data</TableHead>
                    <TableHead>Ativo</TableHead>
                    <TableHead className="text-right">Valor</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow><TableCell colSpan={4} className="text-center py-4 text-muted-foreground">Carregando...</TableCell></TableRow>
                  ) : transactions?.length === 0 ? (
                    <TableRow><TableCell colSpan={4} className="text-center py-4 text-muted-foreground">Sem registros</TableCell></TableRow>
                  ) : (
                    transactions?.map((tx) => (
                      <TableRow key={tx.id}>
                        <TableCell className="text-xs">{new Date(tx.date).toLocaleDateString('pt-BR')}</TableCell>
                        <TableCell className="font-bold">{tx.ticker}</TableCell>
                        <TableCell className="text-right font-mono text-primary">{formatCurrency(tx.amount)}</TableCell>
                        <TableCell>
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={() => handleDelete(tx.id)}>
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
