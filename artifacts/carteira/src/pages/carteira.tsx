import { useState } from "react";
import {
  useListAssets,
  useCreateAsset,
  useUpdateAsset,
  useDeleteAsset,
  useSellAsset,
  useListAssetAnalyses,
  useListTreasuryBonds,
  getListTreasuryBondsQueryKey,
  useGetTreasuryPriceOnDate,
  getGetTreasuryPriceOnDateQueryKey,
  getListAssetsQueryKey,
  getListAssetAnalysesQueryKey,
  getListSalesQueryKey,
  type Asset,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { analysisStatusConfigFor } from "@/lib/analysis-status";
import { formatCurrency, formatPercent, formatShortDateTime, formatShortDate } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Edit2, Trash2, Banknote } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

/**
 * Título público carrega DATA-BASE (um dia), cotação de bolsa carrega um INSTANTE.
 * Formatar os dois com hora fazia o PU do Tesouro aparecer como "07/08 às 00h00" —
 * meia-noite não é quando o Tesouro publicou nada, é só o começo do dia virando hora.
 */
function priceMoment(asset: { priceAsOf?: string | null; treasuryBondType?: string | null }): string {
  if (!asset.priceAsOf) return "";
  return asset.treasuryBondType ? formatShortDate(asset.priceAsOf.slice(0, 10)) : formatShortDateTime(asset.priceAsOf);
}


const CATEGORY_MAP: Record<string, string> = {
  acoes: "Ações",
  fiis: "FIIs",
  etfs: "ETFs",
  bdrs: "BDRs",
  fundos: "Fundos",
  renda_fixa: "Renda Fixa"
};

export default function Carteira() {
  const { data: assets, isLoading } = useListAssets({ query: { queryKey: getListAssetsQueryKey() } });
  const { data: analyses } = useListAssetAnalyses({ query: { queryKey: getListAssetAnalysesQueryKey() } });
  
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [isSellOpen, setIsSellOpen] = useState(false);
  const [sellingAsset, setSellingAsset] = useState<Asset | null>(null);

  // Form State
  const [ticker, setTicker] = useState("");
  const [quantity, setQuantity] = useState("");
  const [averagePrice, setAveragePrice] = useState("");
  const [category, setCategory] = useState("acoes");
  /**
   * "" = nada escolhido ainda, "outro" = renda fixa privada (CDB/LCI/LCA, texto livre,
   * sem fonte pública de preço), qualquer outro valor = chave "família|vencimento" de
   * um título público.
   *
   * O estado começa vazio em vez de já em "outro" de propósito: pré-selecionar o texto
   * livre esconderia a existência dos 60 títulos do Tesouro de quem não abrisse o
   * seletor, e o caminho que o app sabe avaliar de verdade ficaria sendo o menos óbvio.
   */
  const [treasuryKey, setTreasuryKey] = useState("");
  // Depois do useState de `category` de propósito: declarado antes, cairia na zona morta
  // da const e quebraria na renderização. Só busca quando a categoria é renda fixa —
  // não faz sentido carregar a lista do Tesouro para quem cadastra uma ação.
  const { data: treasuryBonds } = useListTreasuryBonds({ query: { queryKey: getListTreasuryBondsQueryKey(), enabled: category === "renda_fixa" } });
  const selectedBond = treasuryBonds?.find((b) => `${b.bondType}|${b.maturityDate}` === treasuryKey) ?? null;
  /** Data da compra e valor investido — só existem no caminho de título público. */
  const [purchaseDate, setPurchaseDate] = useState("");
  const [investedAmount, setInvestedAmount] = useState("");

  /**
   * PU real do título na data da compra, buscado no histórico do Tesouro. É o que
   * dispensa o usuário de descobrir esse número em outro lugar — e o que permite não
   * pré-preencher com o PU de hoje, que gravaria um preço médio errado.
   */
  const priceQuery = useGetTreasuryPriceOnDate(
    { bondType: selectedBond?.bondType ?? "", maturityDate: selectedBond?.maturityDate ?? "", date: purchaseDate },
    { query: {
      queryKey: getGetTreasuryPriceOnDateQueryKey({ bondType: selectedBond?.bondType ?? "", maturityDate: selectedBond?.maturityDate ?? "", date: purchaseDate }),
      enabled: !!selectedBond && !!purchaseDate,
      retry: false,
    } },
  );
  const historicalPrice = priceQuery.data ?? null;

  // PU efetivo: o histórico manda; sem ele (data não informada ainda, ou título sem
  // publicação até ali), o campo continua sendo digitado à mão.
  const effectiveUnitPrice = historicalPrice?.buyUnitPrice ?? (Number(averagePrice) || 0);
  const derivedQuantity = selectedBond && Number(investedAmount) > 0 && effectiveUnitPrice > 0
    ? Number(investedAmount) / effectiveUnitPrice
    : null;

  // Sell Form State
  const [salePrice, setSalePrice] = useState("");
  const [saleDate, setSaleDate] = useState("");
  const [saleQuantity, setSaleQuantity] = useState("");

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const createAsset = useCreateAsset();
  const updateAsset = useUpdateAsset();
  const deleteAsset = useDeleteAsset();
  const sellAsset = useSellAsset();

  const resetForm = () => {
    setTicker("");
    setQuantity("");
    setAveragePrice("");
    setCategory("acoes");
    setTreasuryKey("");
    setPurchaseDate("");
    setInvestedAmount("");
    setEditingId(null);
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (category === "renda_fixa" && !treasuryKey) {
      toast({ title: "Escolha o título, ou \"Outro\" para renda fixa privada.", variant: "destructive" });
      return;
    }
    if (selectedBond && !(derivedQuantity && derivedQuantity > 0)) {
      toast({
        title: priceQuery.isError
          ? "Sem PU publicado para esse título até a data escolhida — confira a data da compra."
          : "Informe a data da compra e o valor investido.",
        variant: "destructive",
      });
      return;
    }
    const enteredQuantity = Number(quantity);
    // Para título público a comparação é pelo par, não pelo ticker: o ticker é derivado
    // no servidor, então o cliente não sabe qual string vai sair e erraria o aviso de
    // consolidação.
    const existing = selectedBond
      ? assets?.find((a) => a.treasuryBondType === selectedBond.bondType && a.treasuryMaturityDate === selectedBond.maturityDate)
      : assets?.find((a) => a.ticker === ticker.toUpperCase() && a.category === category);

    createAsset.mutate({
      data: {
        // Ignorado pelo servidor quando o par vai preenchido, mas o campo é obrigatório
        // no contrato — o rótulo do título serve de valor honesto.
        ticker: selectedBond ? selectedBond.label : ticker,
        // No caminho de título público a quantidade é DERIVADA (valor investido ÷ PU do
        // dia da compra) em vez de digitada: ninguém sabe de cabeça que comprou 0,2083
        // títulos, mas todo mundo sabe quanto investiu.
        quantity: selectedBond ? (derivedQuantity ?? enteredQuantity) : enteredQuantity,
        averagePrice: selectedBond ? effectiveUnitPrice : Number(averagePrice),
        purchaseDate: selectedBond && purchaseDate ? purchaseDate : undefined,
        category: category as any,
        treasuryBondType: selectedBond?.bondType ?? null,
        treasuryMaturityDate: selectedBond?.maturityDate ?? null,
      }
    }, {
      onSuccess: (asset) => {
        queryClient.invalidateQueries({ queryKey: getListAssetsQueryKey() });
        setIsCreateOpen(false);
        resetForm();
        // existing != null é o mesmo critério que o backend usa pra decidir entre
        // consolidar na linha existente ou criar uma posição nova — refletir isso no
        // toast evita o usuário achar que virou uma segunda linha duplicada.
        toast({
          title: existing
            ? `Posição atualizada — ${asset.quantity} unidades a ${formatCurrency(asset.averagePrice)} de preço médio.`
            : "Ativo adicionado com sucesso.",
        });
      },
      onError: () => {
        toast({ title: "Erro ao adicionar ativo.", variant: "destructive" });
      }
    });
  };

  const handleEditOpen = (asset: any) => {
    setEditingId(asset.id);
    setTicker(asset.ticker);
    setQuantity(asset.quantity.toString());
    setAveragePrice(asset.averagePrice.toString());
    setCategory(asset.category);
    setIsEditOpen(true);
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingId) return;
    
    updateAsset.mutate({
      id: editingId,
      data: {
        ticker,
        quantity: Number(quantity),
        averagePrice: Number(averagePrice),
        category: category as any
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAssetsQueryKey() });
        setIsEditOpen(false);
        resetForm();
        toast({ title: "Ativo atualizado com sucesso." });
      },
      onError: () => {
        toast({ title: "Erro ao atualizar ativo.", variant: "destructive" });
      }
    });
  };

  const handleDelete = (id: number) => {
    if (confirm("Tem certeza que deseja remover este ativo da carteira?")) {
      deleteAsset.mutate({ id }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAssetsQueryKey() });
          toast({ title: "Ativo removido." });
        }
      });
    }
  };

  const handleSellOpen = (asset: Asset) => {
    setSellingAsset(asset);
    setSalePrice("");
    setSaleDate(new Date().toISOString().slice(0, 10));
    setSaleQuantity(String(asset.quantity));
    setIsSellOpen(true);
  };

  const handleSellSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!sellingAsset) return;
    const qty = Number(saleQuantity);
    const isFullSale = qty >= sellingAsset.quantity;

    sellAsset.mutate({
      id: sellingAsset.id,
      data: {
        salePrice: Number(salePrice),
        saleDate,
        quantity: isFullSale ? undefined : qty,
      }
    }, {
      onSuccess: (sale) => {
        queryClient.invalidateQueries({ queryKey: getListAssetsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListSalesQueryKey() });
        setIsSellOpen(false);
        const gainLabel = sale.grossGain >= 0
          ? `ganho de ${formatCurrency(sale.grossGain)}`
          : `prejuízo de ${formatCurrency(Math.abs(sale.grossGain))}`;
        const taxLabel = sale.taxOwed ? `, IR de ${formatCurrency(sale.taxOwed)}` : "";
        toast({ title: `Venda registrada — ${gainLabel}${taxLabel}.` });
      },
      onError: () => {
        toast({ title: "Erro ao registrar venda.", variant: "destructive" });
      }
    });
  };

  // Prévia client-side só pra feedback visual imediato no dialog — o valor de
  // verdade (persistido em `sales`) sempre vem da resposta de POST /assets/:id/sell,
  // calculado pelo mesmo tax-engine.ts usado no resto do app.
  const sellPreview = (() => {
    if (!sellingAsset || !salePrice || !saleQuantity) return null;
    const qty = Number(saleQuantity);
    const price = Number(salePrice);
    if (!qty || !price || qty <= 0) return null;

    const grossGain = qty * (price - sellingAsset.averagePrice);
    if (grossGain <= 0) return { grossGain, taxLabel: "Sem IR (prejuízo nessa venda)" };

    const saleValue = qty * price;
    let taxLabel: string;
    if (sellingAsset.category === "acoes") {
      taxLabel = saleValue <= 20000 ? "Isento (venda ≤ R$20 mil no mês)" : "15% de IR sobre o ganho";
    } else if (sellingAsset.category === "fiis") {
      taxLabel = "20% de IR sobre o ganho (FII, sem faixa de isenção)";
    } else if (sellingAsset.category === "etfs" || sellingAsset.category === "bdrs") {
      taxLabel = "15% de IR sobre o ganho (sem faixa de isenção)";
    } else {
      taxLabel = "IR não se aplica a esta categoria";
    }
    return { grossGain, taxLabel };
  })();

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-bold tracking-tight">Minha Carteira</h1>
          <p className="text-muted-foreground">Gerencie seus ativos e posições.</p>
        </div>
        
        <Dialog open={isCreateOpen} onOpenChange={(open) => {
          setIsCreateOpen(open);
          if(!open) resetForm();
        }}>
          <DialogTrigger asChild>
            <Button><Plus className="w-4 h-4 mr-2" /> Adicionar Ativo</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Novo Ativo</DialogTitle>
              <DialogDescription>Adicione uma nova posição à sua carteira.</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleCreateSubmit} className="space-y-4 py-4">
              {/* Categoria primeiro: é ela que decide se o campo seguinte é um seletor
                  de título público ou um ticker de bolsa digitado. */}
              <div className="space-y-2">
                <Label>Categoria</Label>
                <Select value={category} onValueChange={(v) => { setCategory(v); setTreasuryKey(""); }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(CATEGORY_MAP).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {category === "renda_fixa" ? (
                <div className="space-y-2">
                  <Label>Título</Label>
                  <Select value={treasuryKey} onValueChange={setTreasuryKey}>
                    <SelectTrigger><SelectValue placeholder="Selecione o título…" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="outro">Outro (CDB, LCI, LCA…)</SelectItem>
                      {(treasuryBonds ?? []).map((b) => (
                        <SelectItem key={`${b.bondType}|${b.maturityDate}`} value={`${b.bondType}|${b.maturityDate}`}>
                          {b.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {treasuryBonds?.length === 0 && (
                    <p className="text-xs text-muted-foreground text-pretty">
                      A lista do Tesouro Direto ainda não foi sincronizada — ela é atualizada uma vez por dia.
                      Até lá, cadastre como "Outro".
                    </p>
                  )}
                  {selectedBond && (
                    <p className="text-xs text-muted-foreground text-pretty">
                      PU hoje ({formatShortDate(selectedBond.baseDate)}): {formatCurrency(selectedBond.buyUnitPrice)} ·
                      a posição será marcada a mercado pelo PU de recompra.
                    </p>
                  )}
                  {/* Renda fixa privada não tem fonte pública de preço, então continua
                      identificada por texto livre e avaliada pelo preço médio. */}
                  {treasuryKey === "outro" && (
                    <Input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="CDB BANCO X 2028" required />
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <Label>Ticker</Label>
                  <Input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="PETR4" required />
                </div>
              )}

              {selectedBond ? (
                <>
                  {/* Data e valor investido são o que a pessoa realmente sabe. O PU pago
                      e a quantidade saem daí: o PU vem do histórico publicado naquele
                      dia, a quantidade é uma divisão. Nenhum dos dois é digitado, e
                      nenhum dos dois é chutado. */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="purchase-date">Data da compra</Label>
                      <Input
                        id="purchase-date"
                        type="date"
                        value={purchaseDate}
                        max={new Date().toISOString().slice(0, 10)}
                        onChange={(e) => setPurchaseDate(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="invested">Valor investido</Label>
                      <Input
                        id="invested"
                        type="number"
                        step="0.01"
                        min="0.01"
                        placeholder="500,00"
                        value={investedAmount}
                        onChange={(e) => setInvestedAmount(e.target.value)}
                        required
                      />
                    </div>
                  </div>

                  <div className="rounded-md border border-border/60 p-3 text-sm space-y-1">
                    {priceQuery.isFetching ? (
                      <p className="text-muted-foreground">Buscando o PU dessa data…</p>
                    ) : priceQuery.isError ? (
                      <p className="text-destructive text-pretty">
                        Sem PU publicado para esse título até {purchaseDate ? formatShortDate(purchaseDate) : "essa data"}.
                        Confira a data — pode ser anterior à emissão do título.
                      </p>
                    ) : historicalPrice ? (
                      <>
                        <div className="flex justify-between gap-2">
                          <span className="text-muted-foreground">PU pago</span>
                          <span className="font-mono font-medium">{formatCurrency(historicalPrice.buyUnitPrice)}</span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span className="text-muted-foreground">Quantidade</span>
                          <span className="font-mono font-medium">
                            {derivedQuantity ? derivedQuantity.toLocaleString("pt-BR", { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : "—"}
                          </span>
                        </div>
                        {/* Compra em fim de semana ou feriado não tem publicação no dia:
                            o PU usado é o do pregão anterior, e isso precisa aparecer. */}
                        {historicalPrice.baseDate !== purchaseDate && (
                          <p className="text-xs text-muted-foreground text-pretty pt-1">
                            Não houve publicação em {formatShortDate(purchaseDate)} — usando o PU de {formatShortDate(historicalPrice.baseDate)}.
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="text-muted-foreground">Informe a data da compra para buscar o PU daquele dia.</p>
                    )}
                  </div>
                </>
              ) : (
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Quantidade</Label>
                    <Input type="number" step="0.0001" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
                  </div>
                  <div className="space-y-2">
                    <Label>Preço Médio</Label>
                    <Input type="number" step="0.01" value={averagePrice} onChange={(e) => setAveragePrice(e.target.value)} required />
                  </div>
                </div>
              )}
              <DialogFooter>
                <Button type="submit" disabled={createAsset.isPending}>
                  {createAsset.isPending ? "Salvando..." : "Salvar"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Desktop: tabela — cabe as 9 colunas sem rolagem horizontal */}
      <Card className="hidden md:block">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ativo</TableHead>
                <TableHead>Categoria</TableHead>
                <TableHead className="text-right">Quantidade</TableHead>
                <TableHead className="text-right">Preço Médio</TableHead>
                <TableHead className="text-right">Cotação Atual</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">L&P</TableHead>
                <TableHead className="text-center">Status</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                    Carregando carteira...
                  </TableCell>
                </TableRow>
              ) : assets?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                    Sua carteira está vazia. Adicione ativos para começar.
                  </TableCell>
                </TableRow>
              ) : (
                assets?.map((asset) => {
                  const analysis = analyses?.find(a => a.ticker === asset.ticker);
                  const isProfit = asset.profitLoss && asset.profitLoss >= 0;

                  return (
                    <TableRow key={asset.id}>
                      <TableCell className="font-bold">{asset.ticker}</TableCell>
                      <TableCell>
                        <div>{CATEGORY_MAP[asset.category] || asset.category}</div>
                        {asset.dividendFrequency && (
                          <div className="text-xs text-muted-foreground">{asset.dividendFrequency}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono">{asset.quantity}</TableCell>
                      <TableCell className="text-right font-mono">{formatCurrency(asset.averagePrice)}</TableCell>
                      <TableCell className="text-right font-mono">
                        {asset.currentPrice ? formatCurrency(asset.currentPrice) : '-'}
                        {asset.priceAsOf && (
                          // Âmbar sinaliza problema, e título público datado não é
                          // problema: o Tesouro publica o PU com atraso por natureza.
                          <div className={`text-xs font-sans ${asset.treasuryBondType ? "text-muted-foreground" : "text-amber-700 dark:text-amber-500"}`}>
                            {priceMoment(asset)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono">{asset.totalValue ? formatCurrency(asset.totalValue) : '-'}</TableCell>
                      <TableCell className={`text-right font-mono font-medium ${isProfit ? 'text-green-600 dark:text-green-500' : 'text-destructive'}`}>
                        {asset.profitLoss != null && asset.profitLossPercent != null ? (
                          <>
                            <div>{isProfit ? '+' : ''}{formatCurrency(asset.profitLoss)}</div>
                            <div className="text-xs opacity-80">{isProfit ? '+' : ''}{formatPercent(asset.profitLossPercent)}</div>
                          </>
                        ) : '-'}
                      </TableCell>
                      <TableCell className="text-center">
                        {analysis?.available === false ? (
                          <Badge variant="outline">Em breve</Badge>
                        ) : analysis?.status ? (
                          <Badge variant="outline" className={analysisStatusConfigFor(analysis.status, analysis.statusReason).className}>
                            {analysisStatusConfigFor(analysis.status, analysis.statusReason).label}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="icon" onClick={() => handleSellOpen(asset)} title="Vender" className="text-muted-foreground hover:text-foreground">
                            <Banknote className="w-4 h-4" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => handleEditOpen(asset)}>
                            <Edit2 className="w-4 h-4" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => handleDelete(asset.id)} className="text-destructive hover:text-destructive hover:bg-destructive/10">
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Mobile: cards — evita rolagem horizontal das 9 colunas da tabela */}
      <div className="md:hidden space-y-3">
        {isLoading ? (
          <Card><CardContent className="py-8 text-center text-muted-foreground">Carregando carteira...</CardContent></Card>
        ) : assets?.length === 0 ? (
          <Card><CardContent className="py-8 text-center text-muted-foreground">Sua carteira está vazia. Adicione ativos para começar.</CardContent></Card>
        ) : (
          assets?.map((asset) => {
            const analysis = analyses?.find(a => a.ticker === asset.ticker);
            const isProfit = asset.profitLoss && asset.profitLoss >= 0;

            return (
              <Card key={asset.id}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-bold text-lg">{asset.ticker}</div>
                      <div className="text-xs text-muted-foreground">
                        {CATEGORY_MAP[asset.category] || asset.category}
                        {asset.dividendFrequency && ` · ${asset.dividendFrequency}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {analysis?.available === false ? (
                        <Badge variant="outline">Em breve</Badge>
                      ) : analysis?.status ? (
                        <Badge variant="outline" className={analysisStatusConfigFor(analysis.status, analysis.statusReason).className}>{analysisStatusConfigFor(analysis.status, analysis.statusReason).label}</Badge>
                      ) : null}
                      <Button variant="ghost" size="icon" onClick={() => handleSellOpen(asset)} title="Vender" className="text-muted-foreground hover:text-foreground">
                        <Banknote className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => handleEditOpen(asset)}>
                        <Edit2 className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => handleDelete(asset.id)} className="text-destructive hover:text-destructive hover:bg-destructive/10">
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-y-3 gap-x-4 text-sm">
                    <div>
                      <div className="text-xs text-muted-foreground">Quantidade</div>
                      <div className="font-mono">{asset.quantity}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Preço Médio</div>
                      <div className="font-mono">{formatCurrency(asset.averagePrice)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">
                        {asset.treasuryBondType ? 'PU de Recompra' : asset.priceAsOf ? 'Última Cotação' : 'Cotação Atual'}
                      </div>
                      <div className="font-mono">{asset.currentPrice ? formatCurrency(asset.currentPrice) : '-'}</div>
                      {asset.priceAsOf && (
                        <div className={`text-xs ${asset.treasuryBondType ? "text-muted-foreground" : "text-amber-700 dark:text-amber-500"}`}>
                          {priceMoment(asset)}
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Total</div>
                      <div className="font-mono">{asset.totalValue ? formatCurrency(asset.totalValue) : '-'}</div>
                    </div>
                    <div className="col-span-2">
                      <div className="text-xs text-muted-foreground">L&P</div>
                      <div className={`font-mono font-medium ${isProfit ? 'text-green-600 dark:text-green-500' : 'text-destructive'}`}>
                        {asset.profitLoss != null && asset.profitLossPercent != null ? (
                          <>
                            {isProfit ? '+' : ''}{formatCurrency(asset.profitLoss)}{' '}
                            <span className="text-xs opacity-80">({isProfit ? '+' : ''}{formatPercent(asset.profitLossPercent)})</span>
                          </>
                        ) : '-'}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      {/* Edit Dialog */}
      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Editar Ativo</DialogTitle>
            <DialogDescription>Atualize a posição de {ticker}.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleEditSubmit} className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Ticker</Label>
              <Input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} required disabled />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Quantidade</Label>
                <Input type="number" step="0.0001" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label>Preço Médio</Label>
                <Input type="number" step="0.01" value={averagePrice} onChange={(e) => setAveragePrice(e.target.value)} required />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Categoria</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(CATEGORY_MAP).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={updateAsset.isPending}>
                {updateAsset.isPending ? "Salvando..." : "Salvar Alterações"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Sell Dialog */}
      <Dialog open={isSellOpen} onOpenChange={setIsSellOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Vender {sellingAsset?.ticker}</DialogTitle>
            <DialogDescription>
              Encerra a posição (total ou parcialmente) e registra o ganho/perda realizado em "Operações Encerradas".
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSellSubmit} className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Quantidade</Label>
                <Input
                  type="number"
                  step="0.0001"
                  max={sellingAsset?.quantity}
                  value={saleQuantity}
                  onChange={(e) => setSaleQuantity(e.target.value)}
                  required
                />
                <p className="text-xs text-muted-foreground">Você tem {sellingAsset?.quantity} unidades.</p>
              </div>
              <div className="space-y-2">
                <Label>Preço de Venda</Label>
                <Input type="number" step="0.01" value={salePrice} onChange={(e) => setSalePrice(e.target.value)} required />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Data da Venda</Label>
              <Input type="date" value={saleDate} onChange={(e) => setSaleDate(e.target.value)} required />
            </div>
            {sellPreview && (
              <div className="bg-muted/50 p-3 rounded-md text-sm border border-border/50 space-y-1">
                <div className={`font-medium ${sellPreview.grossGain >= 0 ? "text-green-600 dark:text-green-500" : "text-destructive"}`}>
                  {sellPreview.grossGain >= 0 ? "Ganho" : "Prejuízo"} estimado: {formatCurrency(Math.abs(sellPreview.grossGain))}
                </div>
                <div className="text-xs text-muted-foreground">{sellPreview.taxLabel}</div>
              </div>
            )}
            <DialogFooter>
              <Button type="submit" disabled={sellAsset.isPending}>
                {sellAsset.isPending ? "Registrando..." : "Confirmar Venda"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
