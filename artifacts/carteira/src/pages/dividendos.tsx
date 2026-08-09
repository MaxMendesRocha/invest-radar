import { useState, useMemo, type FormEvent } from "react";
import {
  useListTransactions,
  useCreateTransaction,
  useDeleteTransaction,
  useGetPortfolioSummary,
  useGetPortfolioDividendsUpcoming,
  useGetPortfolioDividendsProjection,
  useGetPortfolioDividendsPending,
  getGetPortfolioDividendsPendingQueryKey,
  getListTransactionsQueryKey,
  getGetPortfolioSummaryQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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
import { Plus, Trash2, Coins, ArrowUpRight, CalendarClock, TrendingUp, Inbox, ChevronRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { IncomeGoalCard } from "@/components/income-goal-card";
import { categoryLabel } from "@/lib/categories";
import { Link } from "wouter";

const TYPE_MAP: Record<string, string> = {
  dividendo: "Dividendo",
  jcp: "JCP",
  rendimento: "Rendimento",
  amortizacao: "Amortização"
};


function formatProjectionMonth(month: string): string {
  const [y, m] = month.split("-");
  return `${m}/${y.slice(2)}`;
}


/**
 * Rótulo e cor do veredito de qualidade da distribuição. A classificação vem pronta do
 * servidor (distribution-quality-engine) — aqui só se decide como mostrar, para a tela
 * não reconstruir a regra e as duas versões divergirem com o tempo.
 */
const AUTO_EXPAND_LIMIT = 5;

const QUALITY_PRESENTATION: Record<string, { label: string; className: string }> = {
  Consistente: { label: "Consistente", className: "border-emerald-600/60 text-emerald-700 dark:text-emerald-500" },
  Atencao: { label: "Atenção", className: "border-amber-500/60 text-amber-700 dark:text-amber-500" },
  Irregular: { label: "Irregular", className: "border-destructive/60 text-destructive" },
  SemHistorico: { label: "Sem histórico", className: "text-muted-foreground" },
};

function QualityBadge({ quality }: { quality: { classification: string; cadence: string } | null }) {
  if (!quality) return <span className="text-xs text-muted-foreground">—</span>;
  const p = QUALITY_PRESENTATION[quality.classification] ?? QUALITY_PRESENTATION.SemHistorico;
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <Badge variant="outline" className={`${p.className} shrink-0`}>{p.label}</Badge>
      <span className="text-[10px] text-muted-foreground">{quality.cadence}</span>
    </span>
  );
}

export default function Dividendos() {
  const { data: summary } = useGetPortfolioSummary({ query: { queryKey: getGetPortfolioSummaryQueryKey() } });
  const { data: transactions, isLoading } = useListTransactions({ query: { queryKey: getListTransactionsQueryKey() } });
  const { data: upcomingDividends, isLoading: isLoadingUpcoming } = useGetPortfolioDividendsUpcoming();
  const { data: projection, isLoading: isLoadingProjection } = useGetPortfolioDividendsProjection();
  const { data: pendingDividends, isLoading: isLoadingPending } = useGetPortfolioDividendsPending();
  // Qual linha está sendo gravada, para desabilitar só o botão dela e não a lista toda.
  const [registeringKey, setRegisteringKey] = useState<string | null>(null);

  // Tickers sem data de compra cadastrada. A ressalva é do ATIVO, não do pagamento —
  // repeti-la em cada linha enchia o card com a mesma frase dezenas de vezes.
  /**
   * Proventos pendentes agrupados por ativo, do mais recente para o mais antigo dentro
   * de cada grupo, e os grupos ordenados pelo total — quem tem mais dinheiro parado
   * aparece primeiro.
   */
  const pendingByTicker = useMemo(() => {
    type PendingItem = NonNullable<typeof pendingDividends>[number];
    const groups = new Map<string, { ticker: string; items: PendingItem[]; total: number; hasUncertain: boolean }>();
    for (const d of pendingDividends ?? []) {
      let g = groups.get(d.ticker);
      if (!g) {
        g = { ticker: d.ticker, items: [], total: 0, hasUncertain: false };
        groups.set(d.ticker, g);
      }
      g.items.push(d);
      g.total += d.suggestedAmount;
      if (d.certainty === "incerto") g.hasUncertain = true;
    }
    return Array.from(groups.values()).sort((a, b) => b.total - a.total);
  }, [pendingDividends]);

  const totalPending = pendingDividends?.length ?? 0;
  const totalPendingAmount = (pendingDividends ?? []).reduce((sum, d) => sum + d.suggestedAmount, 0);

  /**
   * Com poucos itens, colapsar só acrescenta um clique — o normal do dia a dia é ter
   * um ou dois proventos do mês. Com um acúmulo de meses, o mesmo layout aberto vira
   * uma rolagem sem fim. Por isso o padrão segue o tamanho da lista.
   */
  const [expandedTickers, setExpandedTickers] = useState<Set<string> | null>(null);
  const effectiveExpanded = expandedTickers ??
    (totalPending <= AUTO_EXPAND_LIMIT ? new Set(pendingByTicker.map((g) => g.ticker)) : new Set<string>());
  const toggleTicker = (ticker: string) => {
    const next = new Set(effectiveExpanded);
    if (next.has(ticker)) next.delete(ticker);
    else next.add(ticker);
    setExpandedTickers(next);
  };

  const tickersSemDataCompra = useMemo(() => {
    const set = new Set<string>();
    for (const d of pendingDividends ?? []) {
      if (d.uncertaintyKind === "sem_data_compra") set.add(d.ticker);
    }
    return Array.from(set).sort();
  }, [pendingDividends]);
  
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

  /**
   * Registra um provento que o app já sabe que foi pago. O valor sugerido é
   * `rate * quantidade ATUAL` — se a posição mudou desde o pagamento, ou se houve
   * retenção, o usuário corrige pelo formulário manual, que continua existindo.
   */
  const handleRegisterPending = async (item: {
    ticker: string; paymentDate: string; label: string; suggestedAmount: number;
  }) => {
    const key = `${item.ticker}-${item.paymentDate}`;
    setRegisteringKey(key);
    try {
      await createTx.mutateAsync({
        data: {
          ticker: item.ticker,
          amount: item.suggestedAmount,
          type: "dividendo",
          date: new Date(item.paymentDate).toISOString(),
        },
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetPortfolioDividendsPendingQueryKey() }),
      ]);
      toast({ title: "Provento registrado", description: `${item.ticker} · ${formatCurrency(item.suggestedAmount)}` });
    } catch {
      toast({ title: "Não foi possível registrar", description: "Tente de novo em instantes.", variant: "destructive" });
    } finally {
      setRegisteringKey(null);
    }
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

      <IncomeGoalCard />

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
                        <TableHead>Distribuição</TableHead>
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
                          <TableCell>{categoryLabel(a.category)}</TableCell>
                          <TableCell><QualityBadge quality={a.quality} /></TableCell>
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
                          <div className="space-y-1">
                            <div className="font-bold">{a.ticker}</div>
                            <div className="text-xs text-muted-foreground">{categoryLabel(a.category)}</div>
                            <QualityBadge quality={a.quality} />
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

      {/* Vem ANTES de "Próximos Pagamentos" de propósito: o que já foi pago e não está
          lançado é acionável agora; o que vem depois é só informação. */}
      {!isLoadingPending && pendingDividends && pendingDividends.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Inbox className="w-4 h-4 text-muted-foreground" />
              Proventos a registrar
            </CardTitle>
            <CardDescription className="text-pretty">
              <strong className="font-mono text-foreground">{formatCurrency(totalPendingAmount)}</strong> em{" "}
              {totalPending} {totalPending === 1 ? "provento já pago" : "proventos já pagos"} pelos seus
              ativos, ainda sem lançamento. Registrar é o que faz o total acumulado e o histórico
              saírem do zero — o app não lança nada sozinho porque isso entra no seu cálculo de IR.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* Agrupado por ATIVO, não linha a linha. A lista cresce com meses de
                histórico, não com número de ativos: uma carteira de 4 ativos com 12
                meses de proventos nunca lançados vira ~23 linhas de largura inteira,
                uma rolagem que não termina. Agrupado são 4 blocos, e o número de
                blocos é o número de ativos — que é o que o usuário tem na cabeça. */}
            <div className="space-y-2">
              {pendingByTicker.map((group) => {
                const isOpen = effectiveExpanded.has(group.ticker);
                return (
                  <div key={group.ticker} className="rounded-md border border-border/50">
                    <button
                      type="button"
                      onClick={() => toggleTicker(group.ticker)}
                      aria-expanded={isOpen}
                      className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-left text-sm hover:bg-muted/40"
                    >
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <ChevronRight className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`} />
                        <span className="font-bold">{group.ticker}</span>
                        <span className="text-muted-foreground">
                          {group.items.length} {group.items.length === 1 ? "provento" : "proventos"}
                        </span>
                        {group.hasUncertain && (
                          <Badge variant="outline" className="shrink-0 border-amber-500/60 text-amber-700 dark:text-amber-500">
                            Confira
                          </Badge>
                        )}
                      </span>
                      <span className="shrink-0 font-mono font-medium text-primary">
                        {formatCurrency(group.total)}
                      </span>
                    </button>

                    {isOpen && (
                      <div className="space-y-1 border-t border-border/50 px-3 py-2">
                        {group.items.map((d) => {
                          const key = `${d.ticker}-${d.paymentDate}-${d.label}`;
                          return (
                            <div key={key} className="flex flex-wrap items-center justify-between gap-2 py-1 text-sm">
                              <span className="flex min-w-0 flex-wrap items-center gap-2">
                                <span className="text-muted-foreground">
                                  {new Date(d.paymentDate).toLocaleDateString("pt-BR")}
                                </span>
                                <span className="text-xs text-muted-foreground">{d.label}</span>
                                {/* A data-com é o que decide o direito ao provento — quem
                                    comprou até ela recebe. Mostrar ajuda a conferir os
                                    casos marcados, e é o dado que faltava antes. */}
                                {d.exDate && (
                                  <span className="text-[11px] text-muted-foreground">
                                    data-com {new Date(d.exDate).toLocaleDateString("pt-BR")}
                                  </span>
                                )}
                              </span>
                              <span className="flex shrink-0 items-center gap-3">
                                <span className="font-mono">{formatCurrency(d.suggestedAmount)}</span>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={registeringKey === key}
                                  onClick={() => handleRegisterPending(d)}
                                >
                                  {registeringKey === key ? "..." : "Registrar"}
                                </Button>
                              </span>
                              {d.uncertaintyKind === "compra_proxima" && d.uncertaintyReason && (
                                <p className="w-full text-[11px] text-amber-700 text-pretty dark:text-amber-500">
                                  {d.uncertaintyReason}
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              {tickersSemDataCompra.length > 0 && (
                <p className="pt-1 text-[11px] text-amber-700 text-pretty dark:text-amber-500">
                  {tickersSemDataCompra.join(", ")} {tickersSemDataCompra.length === 1 ? "está" : "estão"} sem
                  data de compra cadastrada, então o app não consegue confirmar se você já tinha a
                  posição nesses pagamentos.{" "}
                  {/* Link, e não instrução: a ação fica a um clique em vez de exigir que a
                      pessoa lembre onde é e volte depois. */}
                  <Link href="/carteira" className="underline underline-offset-2 hover:no-underline">
                    Preencher em Minha Carteira
                  </Link>{" "}
                  resolve para todos de uma vez.
                </p>
              )}
              <p className="pt-1 text-[10px] text-muted-foreground text-pretty">
                Valor sugerido = provento por cota × sua quantidade atual. Se a posição mudou
                desde o pagamento, ou se houve retenção, ajuste pelo lançamento manual.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

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
