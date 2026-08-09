import { useListSales, getListSalesQueryKey, useGetMonthlySalesTax, getGetMonthlySalesTaxQueryKey } from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow
} from "@/components/ui/table";
import { Banknote, Receipt } from "lucide-react";
import { categoryLabel } from "@/lib/categories";


function formatMonth(month: string): string {
  const [year, m] = month.split("-");
  return new Date(Number(year), Number(m) - 1, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
}

export default function Vendas() {
  const { data: sales, isLoading } = useListSales({ query: { queryKey: getListSalesQueryKey() } });
  const { data: monthlyTax, isLoading: isLoadingMonthlyTax } = useGetMonthlySalesTax({ query: { queryKey: getGetMonthlySalesTaxQueryKey() } });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Operações Encerradas</h1>
        <p className="text-muted-foreground">Histórico de vendas registradas, com ganho/perda realizado e IR.</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-prose text-pretty">
          A coluna <strong className="font-medium text-foreground">IR isolado</strong> considera cada venda sozinha.
          O valor que a Receita cobra é o do <strong className="font-medium text-foreground">Resumo de IR Mensal</strong> abaixo,
          que soma todas as vendas do mês — a isenção de R$ 20 mil em ações vale para o total do mês, não por operação,
          e prejuízos anteriores abatem o ganho.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Receipt className="w-4 h-4 text-muted-foreground" />
            Resumo de IR Mensal
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoadingMonthlyTax ? (
            <p className="text-center py-8 text-muted-foreground">Carregando...</p>
          ) : monthlyTax?.length === 0 ? (
            <p className="text-center py-8 text-muted-foreground">Nenhuma venda registrada ainda.</p>
          ) : (
            <>
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mês</TableHead>
                      <TableHead>Categoria</TableHead>
                      <TableHead className="text-right">Valor Vendido</TableHead>
                      <TableHead className="text-right">Resultado</TableHead>
                      <TableHead className="text-right">Prejuízo Compensado</TableHead>
                      <TableHead className="text-right">Base Tributável</TableHead>
                      <TableHead className="text-right">IR</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {monthlyTax?.map((m, i) => {
                      const isProfit = m.totalGrossGain >= 0;
                      return (
                        <TableRow key={`${m.month}-${m.category}-${i}`}>
                          <TableCell className="capitalize">{formatMonth(m.month)}</TableCell>
                          <TableCell>{categoryLabel(m.category)}</TableCell>
                          <TableCell className="text-right font-mono">{formatCurrency(m.totalSaleValue)}</TableCell>
                          <TableCell className={`text-right font-mono ${isProfit ? "text-green-600 dark:text-green-500" : "text-destructive"}`}>
                            {isProfit ? "+" : "-"}{formatCurrency(Math.abs(m.totalGrossGain))}
                          </TableCell>
                          <TableCell className="text-right font-mono text-muted-foreground">
                            {m.lossOffset > 0 ? `-${formatCurrency(m.lossOffset)}` : "-"}
                          </TableCell>
                          <TableCell className="text-right font-mono">{formatCurrency(m.taxableGain)}</TableCell>
                          <TableCell className="text-right">
                            {m.exempt ? (
                              <Badge variant="outline" className="bg-green-500/10 border-green-500/20 text-green-700 dark:text-green-400">Isento</Badge>
                            ) : (
                              <span className="font-mono text-sm">{formatCurrency(m.taxOwed)}</span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              <div className="md:hidden space-y-3 p-4">
                {monthlyTax?.map((m, i) => {
                  const isProfit = m.totalGrossGain >= 0;
                  return (
                    <Card key={`${m.month}-${m.category}-${i}`}>
                      <CardContent className="p-4 space-y-3">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="font-bold capitalize">{formatMonth(m.month)}</div>
                            <div className="text-xs text-muted-foreground">{categoryLabel(m.category)}</div>
                          </div>
                          {m.exempt ? (
                            <Badge variant="outline" className="bg-green-500/10 border-green-500/20 text-green-700 dark:text-green-400">Isento</Badge>
                          ) : (
                            <div className="font-mono font-medium">{formatCurrency(m.taxOwed)}</div>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-sm">
                          <div>
                            <div className="text-xs text-muted-foreground">Valor Vendido</div>
                            <div className="font-mono">{formatCurrency(m.totalSaleValue)}</div>
                          </div>
                          <div>
                            <div className="text-xs text-muted-foreground">Resultado</div>
                            <div className={`font-mono ${isProfit ? "text-green-600 dark:text-green-500" : "text-destructive"}`}>
                              {isProfit ? "+" : "-"}{formatCurrency(Math.abs(m.totalGrossGain))}
                            </div>
                          </div>
                          {m.lossOffset > 0 && (
                            <div>
                              <div className="text-xs text-muted-foreground">Prejuízo Compensado</div>
                              <div className="font-mono text-muted-foreground">-{formatCurrency(m.lossOffset)}</div>
                            </div>
                          )}
                          <div>
                            <div className="text-xs text-muted-foreground">Base Tributável</div>
                            <div className="font-mono">{formatCurrency(m.taxableGain)}</div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              <p className="text-[10px] text-muted-foreground p-4 pt-0">
                Considera só vendas registradas neste app ("Vender" em Minha Carteira) — vendas feitas fora daqui não entram nessa apuração.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Banknote className="w-4 h-4 text-muted-foreground" />
            Vendas
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {/* Desktop: tabela */}
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ativo</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead className="text-right">Quantidade</TableHead>
                  <TableHead className="text-right">Preço Compra</TableHead>
                  <TableHead className="text-right">Preço Venda</TableHead>
                  <TableHead>Data</TableHead>
                  <TableHead className="text-right">Ganho/Perda</TableHead>
                  <TableHead className="text-right">IR isolado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Carregando...</TableCell>
                  </TableRow>
                ) : sales?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Nenhuma venda registrada ainda.</TableCell>
                  </TableRow>
                ) : (
                  sales?.map((sale) => {
                    const isProfit = sale.grossGain >= 0;
                    return (
                      <TableRow key={sale.id}>
                        <TableCell className="font-bold">{sale.ticker}</TableCell>
                        <TableCell>{categoryLabel(sale.category)}</TableCell>
                        <TableCell className="text-right font-mono">{sale.quantity}</TableCell>
                        <TableCell className="text-right font-mono">{formatCurrency(sale.averagePrice)}</TableCell>
                        <TableCell className="text-right font-mono">{formatCurrency(sale.salePrice)}</TableCell>
                        <TableCell className="text-xs">{new Date(sale.saleDate).toLocaleDateString("pt-BR", { timeZone: "UTC" })}</TableCell>
                        <TableCell className={`text-right font-mono font-medium ${isProfit ? "text-green-600 dark:text-green-500" : "text-destructive"}`}>
                          {isProfit ? "+" : "-"}{formatCurrency(Math.abs(sale.grossGain))}
                        </TableCell>
                        <TableCell className="text-right">
                          {sale.taxOwed == null ? (
                            <span className="text-xs text-muted-foreground">N/A</span>
                          ) : sale.taxOwed === 0 ? (
                            <Badge variant="outline" className="bg-muted/40 border-border/50 text-muted-foreground">Isento sozinha</Badge>
                          ) : (
                            <span className="font-mono text-sm">{formatCurrency(sale.taxOwed)}</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>

          {/* Mobile: cards */}
          <div className="md:hidden space-y-3 p-4">
            {isLoading ? (
              <p className="text-center py-8 text-muted-foreground">Carregando...</p>
            ) : sales?.length === 0 ? (
              <p className="text-center py-8 text-muted-foreground">Nenhuma venda registrada ainda.</p>
            ) : (
              sales?.map((sale) => {
                const isProfit = sale.grossGain >= 0;
                return (
                  <Card key={sale.id}>
                    <CardContent className="p-4 space-y-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-bold">{sale.ticker}</div>
                          <div className="text-xs text-muted-foreground">{categoryLabel(sale.category)}</div>
                        </div>
                        <div className={`font-mono font-medium text-right ${isProfit ? "text-green-600 dark:text-green-500" : "text-destructive"}`}>
                          {isProfit ? "+" : "-"}{formatCurrency(Math.abs(sale.grossGain))}
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-sm">
                        <div>
                          <div className="text-xs text-muted-foreground">Quantidade</div>
                          <div className="font-mono">{sale.quantity}</div>
                        </div>
                        <div>
                          <div className="text-xs text-muted-foreground">Data</div>
                          <div>{new Date(sale.saleDate).toLocaleDateString("pt-BR", { timeZone: "UTC" })}</div>
                        </div>
                        <div>
                          <div className="text-xs text-muted-foreground">Compra x Venda</div>
                          <div className="font-mono">{formatCurrency(sale.averagePrice)} → {formatCurrency(sale.salePrice)}</div>
                        </div>
                        <div>
                          <div className="text-xs text-muted-foreground">IR</div>
                          <div>
                            {sale.taxOwed == null ? (
                              <span className="text-xs text-muted-foreground">N/A</span>
                            ) : sale.taxOwed === 0 ? (
                              <Badge variant="outline" className="bg-green-500/10 border-green-500/20 text-green-700 dark:text-green-400">Isento</Badge>
                            ) : (
                              <span className="font-mono">{formatCurrency(sale.taxOwed)}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
