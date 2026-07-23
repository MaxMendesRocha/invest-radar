import { useState } from "react";
import { 
  useListAssets, 
  useCreateAsset, 
  useUpdateAsset, 
  useDeleteAsset,
  useListAssetAnalyses,
  getListAssetsQueryKey,
  getListAssetAnalysesQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatCurrency, formatPercent } from "@/lib/utils";
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
import { Plus, Edit2, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const CATEGORY_MAP: Record<string, string> = {
  acoes: "Ações",
  fiis: "FIIs",
  etfs: "ETFs",
  bdrs: "BDRs",
  fundos: "Fundos",
  renda_fixa: "Renda Fixa"
};

const STATUS_COLOR_MAP: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  MANTER: "default",
  ATENCAO: "secondary",
  REAVALIAR: "outline",
  POSSIVEL_SAIDA: "destructive"
};

export default function Carteira() {
  const { data: assets, isLoading } = useListAssets({ query: { queryKey: getListAssetsQueryKey() } });
  const { data: analyses } = useListAssetAnalyses({ query: { queryKey: getListAssetAnalysesQueryKey() } });
  
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  
  // Form State
  const [ticker, setTicker] = useState("");
  const [quantity, setQuantity] = useState("");
  const [averagePrice, setAveragePrice] = useState("");
  const [category, setCategory] = useState("acoes");
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const createAsset = useCreateAsset();
  const updateAsset = useUpdateAsset();
  const deleteAsset = useDeleteAsset();

  const resetForm = () => {
    setTicker("");
    setQuantity("");
    setAveragePrice("");
    setCategory("acoes");
    setEditingId(null);
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createAsset.mutate({
      data: {
        ticker,
        quantity: Number(quantity),
        averagePrice: Number(averagePrice),
        category: category as any
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAssetsQueryKey() });
        setIsCreateOpen(false);
        resetForm();
        toast({ title: "Ativo adicionado com sucesso." });
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
              <div className="space-y-2">
                <Label>Ticker</Label>
                <Input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="PETR4" required />
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
                <Button type="submit" disabled={createAsset.isPending}>
                  {createAsset.isPending ? "Salvando..." : "Salvar"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
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
                <TableHead className="text-center">Status (IA)</TableHead>
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
                      <TableCell>{CATEGORY_MAP[asset.category] || asset.category}</TableCell>
                      <TableCell className="text-right font-mono">{asset.quantity}</TableCell>
                      <TableCell className="text-right font-mono">{formatCurrency(asset.averagePrice)}</TableCell>
                      <TableCell className="text-right font-mono">{asset.currentPrice ? formatCurrency(asset.currentPrice) : '-'}</TableCell>
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
                        {analysis?.status ? (
                          <Badge variant={STATUS_COLOR_MAP[analysis.status] || "default"}>
                            {analysis.status}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
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
    </div>
  );
}
