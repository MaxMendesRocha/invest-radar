import { useState, useEffect } from "react";
import { Link } from "wouter";
import {
  useListAssets,
  useCreateAsset,
  useUpdateAsset,
  useDeleteAsset,
  useSellAsset,
  useListAssetAnalyses,
  useListAssetPurchases,
  getListAssetPurchasesQueryKey,
  useCreateAssetPurchase,
  useDeleteAssetPurchase,
  useListTreasuryBonds,
  getListTreasuryBondsQueryKey,
  useGetTreasuryPriceOnDate,
  getGetTreasuryPriceOnDateQueryKey,
  useValidateTicker,
  type ValidateTickerCategory,
  getValidateTickerQueryKey,
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Plus, Edit2, Trash2, Banknote, CircleCheck, TriangleAlert, Loader2, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { categoryLabel, CATEGORY_LABELS } from "@/lib/categories";
import { PriceTargetControl } from "@/components/price-target-control";

/**
 * Preço-alvo só faz sentido onde existe cotação que possa divergir dele. Um título
 * público tem valor de resgate definido em contrato, não alvo de analista — oferecer
 * o campo ali convidaria a preencher um número que não significa nada.
 */
/**
 * Piso dos campos de data, espelhando a trava do servidor (local-date.ts).
 *
 * Sem `min`, o `<input type="date">` aceita ano 0001 — basta digitar "1" no campo de ano,
 * que foi como uma posição real acabou gravada com data de compra em 26/01/0001. O `max`
 * já existia na maioria dos campos; o piso faltava em todos.
 */
const EARLIEST_TRADE_DATE_INPUT = "1900-01-01";

/**
 * Teto dos campos numéricos, espelhando a coluna numeric(18,6) do banco. Sem ele, um
 * número grande demais só é barrado no servidor — e a mensagem que volta é o erro cru do
 * zod, um bloco de JSON dentro do toast.
 */
const MAX_VALOR_INPUT = "999999999999";

function acceptsPriceTarget(category: string): boolean {
  return category !== "renda_fixa";
}

/**
 * Título público carrega DATA-BASE (um dia), cotação de bolsa carrega um INSTANTE.
 * Formatar os dois com hora fazia o PU do Tesouro aparecer como "07/08 às 00h00" —
 * meia-noite não é quando o Tesouro publicou nada, é só o começo do dia virando hora.
 */
function priceMoment(asset: { priceAsOf?: string | null; treasuryBondType?: string | null }): string {
  if (!asset.priceAsOf) return "";
  return asset.treasuryBondType ? formatShortDate(asset.priceAsOf.slice(0, 10)) : formatShortDateTime(asset.priceAsOf);
}

/**
 * Variação do dia — direto do provedor (brapi), não calculada. Só existe pra ativo
 * cotado com cotação ao vivo: null pra título público (PU diário, sem "fechou em alta
 * hoje" real) e pra preço datado (provedor fora do ar), casos em que não renderiza nada.
 */
function ChangeBadge({ changePercent }: { changePercent: number | null | undefined }) {
  if (changePercent == null) return null;
  const isUp = changePercent >= 0;
  const Icon = isUp ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-mono font-medium ${isUp ? "text-green-600 dark:text-green-500" : "text-destructive"}`}>
      <Icon className="w-3 h-3" />
      {isUp ? "+" : ""}{formatPercent(changePercent)}
    </span>
  );
}

/**
 * Aviso de evento corporativo (desdobramento, grupamento, amortização) que o FII sofreu
 * depois da data de compra registrada, detectado no informe mensal da CVM.
 *
 * Só avisa — não corrige. O app não tem como saber o que a pessoa fez na corretora, e
 * chutar um preço médio "ajustado" seria pior que apontar a dúvida. Sem esse aviso o
 * número simplesmente envelhece em silêncio, que é como uma divergência real passou
 * despercebida até aparecer no extrato da corretora.
 */
function CorporateEventBadge({ warning }: { warning: Asset["corporateEventWarning"] }) {
  if (!warning) return null;

  const monthLabel = (() => {
    const [year, month] = warning.date.split("-");
    const names = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
    return `${names[Number(month) - 1] ?? month}/${year}`;
  })();

  const headline = warning.type === "amortizacao"
    ? `Amortização de ${formatPercent((warning.accumulatedFraction ?? 0) * 100)} desde a sua compra`
    : warning.type === "desdobramento"
      ? `Desdobramento 1:${warning.ratio} em ${monthLabel}`
      : `Grupamento ${warning.ratio}:1 em ${monthLabel}`;

  const detail = warning.type === "amortizacao"
    ? "Amortização devolve capital e a corretora abate o valor direto do preço médio."
    : "A corretora ajusta quantidade e preço médio automaticamente nesses casos; o app não.";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Evento corporativo detectado"
          className="inline-flex items-center text-amber-700 dark:text-amber-500 hover:opacity-80"
        >
          <TriangleAlert className="w-3.5 h-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 text-sm space-y-2">
        <div className="font-medium">{headline}</div>
        <p className="text-muted-foreground text-xs text-pretty">{detail}</p>
        <p className="text-muted-foreground text-xs text-pretty">
          {warning.purchaseDateUnknown
            ? "Esta posição não tem data de compra registrada, então não dá pra saber se o evento é anterior a ela. Confira o preço médio na corretora."
            : "Seu preço médio pode não refletir o evento — confira na corretora e ajuste pelo botão de editar."}
        </p>
        <p className="text-[11px] text-muted-foreground">Fonte: Informe Mensal de FII (CVM).</p>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Feedback do ticker digitado no cadastro — pega erro de digitação ANTES de virar
 * posição fantasma sem cotação (ver GET /assets/validate-ticker). `result` só chega
 * não-nulo quando a checagem já terminou pro ticker atual; enquanto isso,
 * `isChecking` cobre tanto o debounce quanto a busca em si, pra não piscar "não
 * encontrado" no meio da digitação.
 */
function TickerValidationFeedback({ isChecking, result }: { isChecking: boolean; result: { valid: boolean; name: string | null; categoryConflict?: string | null } | null }) {
  if (isChecking) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="w-3 h-3 animate-spin" /> Conferindo ticker…
      </p>
    );
  }
  if (!result) return null;

  // O conflito de categoria vem antes de tudo, e some a existência de cotação: um papel
  // pode ter preço perfeitamente e ainda assim estar na classe errada — que é o caso
  // que motivou a checagem (PETR4 cadastrado como FII). É também o único aviso aqui que
  // o servidor de fato bloqueia; os outros dois são orientação.
  if (result.categoryConflict) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-destructive">
        <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-px" />
        <span className="text-pretty">{result.categoryConflict} Escolha a categoria certa para salvar.</span>
      </p>
    );
  }

  if (result.valid) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-500">
        <CircleCheck className="w-3.5 h-3.5 shrink-0" /> {result.name ?? "Ticker encontrado"}
      </p>
    );
  }
  return (
    <p className="flex items-center gap-1.5 text-xs text-destructive">
      <TriangleAlert className="w-3.5 h-3.5 shrink-0" /> Nenhuma cotação encontrada — confira a digitação.
    </p>
  );
}

/**
 * Carteira vazia. A mensagem antiga mandava adicionar ativos sem dizer QUAIS — e quem
 * acabou de se cadastrar está travado exatamente nessa pergunta. O app tem a resposta
 * numa tela própria; a função aqui é não deixar essa tela escondida no menu.
 */
function EmptyPortfolioMessage() {
  return (
    <div className="space-y-2">
      <p>Sua carteira está vazia. Adicione ativos para começar.</p>
      <p className="text-sm">
        Não sabe por onde começar?{" "}
        <Link href="/carteira-de-partida" className="underline underline-offset-4 hover:text-foreground">
          Veja a Carteira de Partida
        </Link>{" "}
        — como um investidor de cada perfil montaria a sua do zero.
      </p>
      {/*
        Quem JÁ investe cai neste mesmo vazio, e para essa pessoa a resposta não é uma
        carteira sugerida: é trazer o que ela já tem. Digitar posição a posição é onde o
        histórico morre, e a importação existe justamente para pular isso.
      */}
      <p className="text-sm">
        Já investe e quer trazer o que tem?{" "}
        <Link href="/importar" className="underline underline-offset-4 hover:text-foreground">
          Importe sua nota de corretagem
        </Link>{" "}
        — o PDF da corretora vira lançamento, com preço médio calculado.
      </p>
    </div>
  );
}

export default function Carteira() {
  const { data: assets, isLoading } = useListAssets({ query: { queryKey: getListAssetsQueryKey() } });
  const { data: analyses } = useListAssetAnalyses({ query: { queryKey: getListAssetAnalysesQueryKey() } });
  
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [isSellOpen, setIsSellOpen] = useState(false);
  const [sellingAsset, setSellingAsset] = useState<Asset | null>(null);

  // "Movimentar Poupança" — depósito/saque calculado a partir do saldo estimado de
  // hoje, pra não obrigar a pessoa a fazer a conta de cabeça antes de editar a posição.
  // Lançamentos da posição em edição. A lista só é buscada com o diálogo aberto e fora de
  // poupança — ali "preço médio" é saldo, não preço de compra, e não há o que listar.
  const [purchaseQty, setPurchaseQty] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [purchaseDateNew, setPurchaseDateNew] = useState("");

  const [movingSavingsAsset, setMovingSavingsAsset] = useState<Asset | null>(null);
  const [moveType, setMoveType] = useState<"deposito" | "saque">("deposito");
  const [moveAmount, setMoveAmount] = useState("");
  const [moveDate, setMoveDate] = useState("");

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

  /**
   * Checagem de ticker real, só no cadastro (no formulário de edição o ticker vem
   * travado — não digitável, sem risco de erro de digitação ali). Existe porque um
   * ticker digitado errado ("DVF11" em vez de "DVFF11") não dá erro nenhum: vira uma
   * posição de verdade, só que sem cotação, sem provento, sem nada — e o app só
   * consolida compras de um mesmo ativo quando ticker E categoria batem
   * exatamente, então o erro também nunca se junta com a posição certa.
   *
   * Debounced pra não bater a brapi a cada tecla — só depois de 500ms sem digitar. Só
   * roda pra categoria cotada: renda fixa não tem ticker de mercado pra validar
   * (título público já é validado por outro caminho, via findTreasuryBond).
   */
  const [debouncedTicker, setDebouncedTicker] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedTicker(ticker.trim()), 500);
    return () => clearTimeout(timer);
  }, [ticker]);

  // A categoria viaja junto: o servidor responde no mesmo lugar se o sufixo do ticker
  // contradiz a classe escolhida (PETR4 como FII). A regra fica só lá — ver
  // lib/b3-ticker.ts — para não existirem duas convenções da B3 no repositório.
  const tickerValidation = useValidateTicker(
    { ticker: debouncedTicker, category: category as ValidateTickerCategory },
    { query: {
      queryKey: getValidateTickerQueryKey({ ticker: debouncedTicker, category: category as ValidateTickerCategory }),
      enabled: isCreateOpen && category !== "renda_fixa" && debouncedTicker.length > 0,
      retry: false,
    } },
  );
  // Só considera o resultado quando ele é da versão mais recente do campo — sem isso,
  // o resultado da busca anterior (ainda em cache) piscaria como válido/inválido do
  // ticker atual por uma fração de segundo enquanto a nova busca carrega.
  const tickerIsChecked = debouncedTicker === ticker.trim() && debouncedTicker.length > 0 && category !== "renda_fixa";
  const tickerCheckDone = tickerIsChecked && !tickerValidation.isFetching && tickerValidation.data != null;

  // Segunda confirmação pra salvar mesmo com ticker não encontrado — nunca bloqueia
  // pra sempre (o ticker pode ser real e só ainda não coberto pela brapi), mas exige
  // uma ação a mais em vez de deixar passar em silêncio. Reseta a cada mudança no
  // campo pra não valer pra um ticker diferente do que foi confirmado.
  const [pendingInvalidTickerConfirm, setPendingInvalidTickerConfirm] = useState(false);
  useEffect(() => setPendingInvalidTickerConfirm(false), [ticker, category]);

  /** Data da compra e valor investido — só existem no caminho de título público. */
  const [purchaseDate, setPurchaseDate] = useState("");
  const [investedAmount, setInvestedAmount] = useState("");
  /**
   * Override opcional do PU, pro caso em que a pessoa tem o comprovante real da
   * corretora em mãos. O Tesouro Direto negocia continuamente durante o pregão; o
   * arquivo que sincronizamos é uma referência única por dia (a "manhã"), então o PU de
   * execução real quase sempre difere um pouco do nosso. Vazio = comportamento de
   * sempre (PU vem do nosso histórico, nunca digitado); preenchido = a pessoa está
   * informando um número que ELA já confirmou, não chutando um — mesmo princípio de só
   * aceitar dado real, só que a fonte agora é o comprovante dela em vez do nosso sync.
   */
  const [manualUnitPrice, setManualUnitPrice] = useState("");

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

  // PU efetivo: override do comprovante manda quando preenchido; senão o histórico;
  // sem nenhum dos dois (data não informada ainda, ou título sem publicação até ali), o
  // campo continua sendo digitado à mão.
  const manualUnitPriceValue = Number(manualUnitPrice) > 0 ? Number(manualUnitPrice) : null;
  const effectiveUnitPrice = manualUnitPriceValue ?? historicalPrice?.buyUnitPrice ?? (Number(averagePrice) || 0);
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
    setManualUnitPrice("");
    setEditingId(null);
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (category === "renda_fixa" && !treasuryKey) {
      toast({ title: "Escolha o título, ou \"Outro\" para renda fixa privada.", variant: "destructive" });
      return;
    }
    // Ticker sem cotação real: pede confirmação em vez de bloquear pra sempre — pode
    // ser erro de digitação (o caso mais comum) ou um ticker real que a brapi ainda
    // não cobre. Primeiro clique avisa e não salva; segundo clique, com o mesmo
    // ticker, prossegue.
    // Conflito de categoria bloqueia de vez, sem segunda confirmação: ao contrário do
    // ticker sem cotação (que pode ser um papel real ainda não coberto pela brapi), aqui
    // a própria convenção da B3 prova que a classe está errada. O servidor recusa de
    // qualquer forma — avisar antes só evita a viagem.
    if (tickerCheckDone && tickerValidation.data?.categoryConflict) {
      toast({ title: tickerValidation.data.categoryConflict, variant: "destructive" });
      return;
    }
    if (tickerCheckDone && tickerValidation.data?.valid === false && !pendingInvalidTickerConfirm) {
      setPendingInvalidTickerConfirm(true);
      toast({
        title: `"${ticker}" não tem cotação encontrada — confira a digitação.`,
        description: "Clique em salvar de novo se o ticker estiver certo mesmo assim.",
        variant: "destructive",
      });
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
    const isSavings = treasuryKey === "poupanca";
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
        // títulos, mas todo mundo sabe quanto investiu. Poupança não tem quantidade
        // nenhuma — é só um saldo — então fica travada em 1.
        quantity: selectedBond ? (derivedQuantity ?? enteredQuantity) : isSavings ? 1 : enteredQuantity,
        averagePrice: selectedBond ? effectiveUnitPrice : Number(averagePrice),
        purchaseDate: purchaseDate || undefined,
        category: category as any,
        treasuryBondType: selectedBond?.bondType ?? null,
        treasuryMaturityDate: selectedBond?.maturityDate ?? null,
        isSavingsAccount: isSavings,
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

  const editingAsset = assets?.find((a) => a.id === editingId) ?? null;

  // Só busca com o diálogo aberto e fora de poupança: ali o "preço médio" é um saldo, não
  // preço de compra, e não existe lançamento a listar.
  // Um lançamento que não seja o saldo inicial significa que a posição tem origem
  // registrada de verdade — e a partir daí o total deixa de ser editável direto, para não
  // existirem duas formas de definir o mesmo número.
  const purchasesEnabled = isEditOpen && editingId != null && !editingAsset?.isSavingsAccount;
  const { data: purchases } = useListAssetPurchases(editingId ?? 0, {
    query: { queryKey: getListAssetPurchasesQueryKey(editingId ?? 0), enabled: purchasesEnabled },
  });
  const hasRealPurchase = (purchases ?? []).some((p) => !p.isInitialBalance);
  const createPurchase = useCreateAssetPurchase();
  const deletePurchase = useDeleteAssetPurchase();

  const refreshAfterPurchase = () => {
    queryClient.invalidateQueries({ queryKey: getListAssetsQueryKey() });
    if (editingId != null) queryClient.invalidateQueries({ queryKey: getListAssetPurchasesQueryKey(editingId) });
  };

  const handleAddPurchase = () => {
    if (editingId == null) return;
    const qty = Number(purchaseQty);
    const price = Number(purchasePrice);
    if (!(qty > 0) || !(price > 0) || !purchaseDateNew) {
      toast({ title: "Preencha quantidade, preço e data do lançamento.", variant: "destructive" });
      return;
    }
    createPurchase.mutate(
      { id: editingId, data: { quantity: qty, unitPrice: price, tradeDate: purchaseDateNew } },
      {
        onSuccess: () => {
          setPurchaseQty(""); setPurchasePrice(""); setPurchaseDateNew("");
          refreshAfterPurchase();
          toast({ title: "Lançamento registrado — preço médio recalculado." });
        },
        onError: () => toast({ title: "Erro ao registrar o lançamento.", variant: "destructive" }),
      },
    );
  };

  const handleDeletePurchase = (purchaseId: number) => {
    if (editingId == null) return;
    deletePurchase.mutate({ id: editingId, purchaseId }, {
      onSuccess: () => { refreshAfterPurchase(); toast({ title: "Lançamento removido — preço médio recalculado." }); },
      onError: () => toast({
        title: "Não foi possível remover.",
        description: "A posição precisa de pelo menos um lançamento. Para encerrá-la, exclua a posição.",
        variant: "destructive",
      }),
    });
  };

  const handleEditOpen = (asset: any) => {
    setEditingId(asset.id);
    setTicker(asset.ticker);
    setQuantity(asset.quantity.toString());
    setAveragePrice(asset.averagePrice.toString());
    setCategory(asset.category);
    setPurchaseDate(asset.purchaseDate ?? "");
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
        // null (e não undefined) quando o campo é esvaziado: o servidor só ignora o
        // campo quando ele vem undefined, então sem isso não haveria como APAGAR uma
        // data cadastrada por engano.
        purchaseDate: purchaseDate || null,
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

  const handleSavingsMoveOpen = (asset: Asset) => {
    setMovingSavingsAsset(asset);
    setMoveType("deposito");
    setMoveAmount("");
    setMoveDate(new Date().toISOString().slice(0, 10));
  };

  const moveNewBalance = movingSavingsAsset && Number(moveAmount) > 0
    ? (movingSavingsAsset.currentPrice ?? movingSavingsAsset.averagePrice)
      + (moveType === "deposito" ? Number(moveAmount) : -Number(moveAmount))
    : null;

  const handleSavingsMoveSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!movingSavingsAsset || moveNewBalance == null) return;
    if (moveNewBalance <= 0) {
      toast({ title: "O saque não pode ser maior que o saldo estimado hoje.", variant: "destructive" });
      return;
    }
    updateAsset.mutate({
      id: movingSavingsAsset.id,
      data: { averagePrice: moveNewBalance, purchaseDate: moveDate, quantity: 1, category: "renda_fixa" as any },
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAssetsQueryKey() });
        setMovingSavingsAsset(null);
        toast({ title: `${moveType === "deposito" ? "Depósito" : "Saque"} registrado — novo saldo ${formatCurrency(moveNewBalance)}.` });
      },
      onError: () => {
        toast({ title: "Erro ao registrar movimentação.", variant: "destructive" });
      },
    });
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
                    {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
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
                      <SelectItem value="poupanca">Poupança</SelectItem>
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
                  {treasuryKey === "poupanca" && (
                    <Input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="POUPANÇA NUBANK" required />
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <Label>Ticker</Label>
                  <Input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="PETR4" required />
                  {ticker.trim().length > 0 && (
                    <TickerValidationFeedback
                      isChecking={category !== "renda_fixa" && (ticker.trim() !== debouncedTicker || tickerValidation.isFetching)}
                      result={tickerCheckDone ? tickerValidation.data ?? null : null}
                    />
                  )}
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
                        min={EARLIEST_TRADE_DATE_INPUT} max={new Date().toISOString().slice(0, 10)}
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

                  <div className="space-y-2">
                    <Label htmlFor="manual-unit-price" className="text-xs text-muted-foreground font-normal">
                      PU exato do comprovante (opcional)
                    </Label>
                    <Input
                      id="manual-unit-price"
                      type="number"
                      step="0.01"
                      min="0.01"
                      placeholder={historicalPrice ? String(historicalPrice.buyUnitPrice) : "Ex: 730,37"}
                      value={manualUnitPrice}
                      onChange={(e) => setManualUnitPrice(e.target.value)}
                    />
                    <p className="text-[11px] text-muted-foreground text-pretty">
                      O Tesouro Direto negocia durante o pregão todo — o PU que sincronizamos é uma referência
                      única por dia, então pode diferir um pouco do preço real da sua execução. Preencha aqui
                      só se tiver o comprovante da corretora com o PU exato; senão, deixe em branco.
                    </p>
                  </div>

                  <div className="rounded-md border border-border/60 p-3 text-sm space-y-1">
                    {manualUnitPriceValue ? (
                      <>
                        <div className="flex justify-between gap-2">
                          <span className="text-muted-foreground">PU do comprovante</span>
                          <span className="font-mono font-medium">{formatCurrency(manualUnitPriceValue)}</span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span className="text-muted-foreground">Quantidade</span>
                          <span className="font-mono font-medium">
                            {derivedQuantity ? derivedQuantity.toLocaleString("pt-BR", { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : "—"}
                          </span>
                        </div>
                      </>
                    ) : priceQuery.isFetching ? (
                      <p className="text-muted-foreground">Buscando o PU dessa data…</p>
                    ) : priceQuery.isError ? (
                      <p className="text-destructive text-pretty">
                        Sem PU publicado para esse título até {purchaseDate ? formatShortDate(purchaseDate) : "essa data"}.
                        Confira a data — pode ser anterior à emissão do título — ou informe o PU do comprovante acima.
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
              ) : treasuryKey === "poupanca" ? (
                <>
                  {/* Poupança não tem "quantidade de cotas" nem PU — é só um saldo que
                      rende no aniversário mensal. Sem investedAmount/PU pra derivar
                      nada: a pessoa informa o saldo que já sabe, e a data em que sabia
                      esse valor. quantity fica travada em 1 na hora de submeter. */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="savings-balance">Saldo conhecido</Label>
                      <Input
                        id="savings-balance"
                        type="number"
                        step="0.01"
                        min="0.01"
                        placeholder="1000,00"
                        value={averagePrice}
                        onChange={(e) => setAveragePrice(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="savings-date">Data desse saldo</Label>
                      <Input
                        id="savings-date"
                        type="date"
                        value={purchaseDate}
                        min={EARLIEST_TRADE_DATE_INPUT} max={new Date().toISOString().slice(0, 10)}
                        onChange={(e) => setPurchaseDate(e.target.value)}
                        required
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground text-pretty">
                    A partir daqui o app projeta o saldo de hoje usando o rendimento real da poupança
                    publicado pelo Banco Central — só credita no aniversário mensal completo, igual a
                    conta de verdade. Pra registrar um depósito ou saque depois, use o botão de
                    cifrão na posição já cadastrada, em vez de cadastrar de novo.
                  </p>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Quantidade</Label>
                      <Input type="number" step="0.0001" min="0.0001" max={MAX_VALOR_INPUT} value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
                    </div>
                    <div className="space-y-2">
                      <Label>Preço Médio</Label>
                      <Input type="number" step="0.01" min="0.01" max={MAX_VALOR_INPUT} value={averagePrice} onChange={(e) => setAveragePrice(e.target.value)} required />
                    </div>
                  </div>
                  {/* Opcional, mas com consequência concreta: a data-com de cada provento
                      vem do provedor, então com a data de compra o app CONSEGUE decidir
                      a quais proventos você tinha direito. Sem ela, todos caem em
                      "confira" e a conferência sobra para o usuário. */}
                  <div className="space-y-2">
                    <Label htmlFor="quoted-purchase-date">
                      Data da compra <span className="font-normal text-muted-foreground">(opcional)</span>
                    </Label>
                    <Input
                      id="quoted-purchase-date"
                      type="date"
                      value={purchaseDate}
                      min={EARLIEST_TRADE_DATE_INPUT} max={new Date().toISOString().slice(0, 10)}
                      onChange={(e) => setPurchaseDate(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground text-pretty">
                      Com ela, o app sabe a quais proventos você tinha direito — compara com a
                      data-com de cada pagamento — e sugere para registro só os que são seus.
                      Sem ela, todos aparecem marcados para você conferir.
                    </p>
                  </div>
                </>
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
                    <EmptyPortfolioMessage />
                  </TableCell>
                </TableRow>
              ) : (
                assets?.map((asset) => {
                  const analysis = analyses?.find(a => a.ticker === asset.ticker);
                  const isProfit = asset.profitLoss && asset.profitLoss >= 0;

                  return (
                    <TableRow key={asset.id}>
                      <TableCell className="font-bold">
                        <div className="flex items-center gap-1.5">
                          {asset.ticker}
                          <CorporateEventBadge warning={asset.corporateEventWarning} />
                        </div>
                      </TableCell>
                      <TableCell>
                        <div>{categoryLabel(asset.category)}</div>
                        {asset.dividendFrequency && (
                          <div className="text-xs text-muted-foreground">{asset.dividendFrequency}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono">{asset.isSavingsAccount ? '—' : asset.quantity}</TableCell>
                      <TableCell className="text-right font-mono">{formatCurrency(asset.averagePrice)}</TableCell>
                      <TableCell className="text-right font-mono">
                        <div className="flex items-center justify-end gap-1.5">
                          {asset.currentPrice ? formatCurrency(asset.currentPrice) : '-'}
                          <ChangeBadge changePercent={asset.changePercent} />
                        </div>
                        {asset.isSavingsAccount && (
                          <div className="text-xs font-sans text-muted-foreground">saldo estimado hoje</div>
                        )}
                        {asset.priceAsOf && (
                          // Âmbar sinaliza problema, e título público datado não é
                          // problema: o Tesouro publica o PU com atraso por natureza.
                          <div className={`text-xs font-sans ${asset.treasuryBondType ? "text-muted-foreground" : "text-amber-700 dark:text-amber-500"}`}>
                            {priceMoment(asset)}
                          </div>
                        )}
                        {acceptsPriceTarget(asset.category) && (
                          <PriceTargetControl ticker={asset.ticker} currentPrice={asset.currentPrice ?? null}
                            align="right" className="mt-1 w-full font-sans" />
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
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => asset.isSavingsAccount ? handleSavingsMoveOpen(asset) : handleSellOpen(asset)}
                            title={asset.isSavingsAccount ? "Movimentar" : "Vender"}
                            className="text-muted-foreground hover:text-foreground"
                          >
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
          <Card><CardContent className="py-8 text-center text-muted-foreground"><EmptyPortfolioMessage /></CardContent></Card>
        ) : (
          assets?.map((asset) => {
            const analysis = analyses?.find(a => a.ticker === asset.ticker);
            const isProfit = asset.profitLoss && asset.profitLoss >= 0;

            return (
              <Card key={asset.id}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-bold text-lg flex items-center gap-1.5">
                        {asset.ticker}
                        <CorporateEventBadge warning={asset.corporateEventWarning} />
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {categoryLabel(asset.category)}
                        {asset.dividendFrequency && ` · ${asset.dividendFrequency}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {analysis?.available === false ? (
                        <Badge variant="outline">Em breve</Badge>
                      ) : analysis?.status ? (
                        <Badge variant="outline" className={analysisStatusConfigFor(analysis.status, analysis.statusReason).className}>{analysisStatusConfigFor(analysis.status, analysis.statusReason).label}</Badge>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => asset.isSavingsAccount ? handleSavingsMoveOpen(asset) : handleSellOpen(asset)}
                        title={asset.isSavingsAccount ? "Movimentar" : "Vender"}
                        className="text-muted-foreground hover:text-foreground"
                      >
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
                      <div className="font-mono">{asset.isSavingsAccount ? '—' : asset.quantity}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">
                        {asset.isSavingsAccount && asset.purchaseDate ? `Saldo em ${formatShortDate(asset.purchaseDate)}` : 'Preço Médio'}
                      </div>
                      <div className="font-mono">{formatCurrency(asset.averagePrice)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">
                        {asset.isSavingsAccount ? 'Saldo Estimado' : asset.treasuryBondType ? 'PU de Recompra' : asset.priceAsOf ? 'Última Cotação' : 'Cotação Atual'}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono">{asset.currentPrice ? formatCurrency(asset.currentPrice) : '-'}</span>
                        <ChangeBadge changePercent={asset.changePercent} />
                      </div>
                      {asset.priceAsOf && (
                        <div className={`text-xs ${asset.treasuryBondType ? "text-muted-foreground" : "text-amber-700 dark:text-amber-500"}`}>
                          {priceMoment(asset)}
                        </div>
                      )}
                      {acceptsPriceTarget(asset.category) && (
                        <PriceTargetControl ticker={asset.ticker} currentPrice={asset.currentPrice ?? null} className="mt-1" />
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
                <Input
                  type="number"
                  step="0.0001"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  required
                  disabled={!!editingAsset?.isSavingsAccount || hasRealPurchase}
                />
              </div>
              <div className="space-y-2">
                <Label>{editingAsset?.isSavingsAccount ? "Saldo" : "Preço Médio"}</Label>
                <Input type="number" step="0.01" value={averagePrice} onChange={(e) => setAveragePrice(e.target.value)} required
                  disabled={hasRealPurchase} />
              </div>
            </div>
            {hasRealPurchase && (
              <p className="text-xs text-muted-foreground text-pretty">
                Quantidade, preço médio e data de compra são calculados a partir dos {purchases?.length} lançamentos abaixo.
                Para corrigir, edite o lançamento errado em vez do total.
              </p>
            )}
            <div className="space-y-2">
              <Label>Categoria</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {/* Sem este campo na edição, ativo já cadastrado nunca ganharia data de
                compra — só re-cadastrando. É o caso de toda posição anterior a esta
                versão, que é justamente quem tem proventos acumulados para registrar. */}
            <div className="space-y-2">
              <Label htmlFor="edit-purchase-date">
                {editingAsset?.isSavingsAccount ? (
                  "Data desse saldo"
                ) : (
                  <>Data da compra <span className="font-normal text-muted-foreground">(opcional)</span></>
                )}
              </Label>
              <Input
                id="edit-purchase-date"
                type="date"
                value={purchaseDate}
                min={EARLIEST_TRADE_DATE_INPUT} max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setPurchaseDate(e.target.value)}
                disabled={hasRealPurchase}
              />
              <p className="text-xs text-muted-foreground text-pretty">
                {editingAsset?.isSavingsAccount
                  ? "Atualize saldo e data sempre que depositar ou sacar — é assim que se mantém a estimativa em dia."
                  : hasRealPurchase
                    ? "É a data do lançamento mais antigo. Para mudá-la, edite aquele lançamento."
                    : "Preenchendo, o app passa a saber a quais proventos você tinha direito e para de pedir conferência em cada um."}
              </p>
            </div>
            {/* Lançamentos: é o que dá procedência ao preço médio. Sem esta lista, o número
                era só o que alguém digitou — e uma divergência com a corretora não tinha
                como ser investigada senão por eliminação. */}
            {purchasesEnabled && (
              <div className="space-y-3 rounded-md border border-border/60 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <Label className="text-sm">Lançamentos</Label>
                  <span className="text-xs text-muted-foreground">
                    preço médio <strong className="font-mono font-medium text-foreground">
                      {formatCurrency(editingAsset?.averagePrice ?? 0)}
                    </strong>
                  </span>
                </div>

                {(purchases ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground text-pretty">
                    Sem lançamentos registrados ainda.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {(purchases ?? []).map((p) => (
                      <div key={p.id} className="flex items-center justify-between gap-2 text-sm">
                        <div className="min-w-0">
                          <span className="font-mono">{formatShortDate(p.tradeDate)}</span>
                          <span className="text-muted-foreground"> · </span>
                          <span className="font-mono">{p.quantity}</span>
                          <span className="text-muted-foreground"> × </span>
                          <span className="font-mono">{formatCurrency(p.unitPrice)}</span>
                          {p.isInitialBalance && (
                            <span className="ml-1.5 text-[11px] text-muted-foreground">saldo informado</span>
                          )}
                        </div>
                        <Button
                          type="button" variant="ghost" size="icon"
                          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => handleDeletePurchase(p.id)}
                          disabled={deletePurchase.isPending}
                          title="Remover lançamento"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Três colunas fixas não cabem em 390px — o campo de data estourava
                    para fora da tela no iPhone. Quantidade e preço dividem a linha, e a
                    data ocupa a largura inteira embaixo até haver espaço para as três. */}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <Input type="number" step="0.000001" min="0.000001" max={MAX_VALOR_INPUT} placeholder="Qtd"
                    value={purchaseQty} onChange={(e) => setPurchaseQty(e.target.value)} />
                  <Input type="number" step="0.01" min="0.01" max={MAX_VALOR_INPUT} placeholder="Preço"
                    value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} />
                  <Input type="date" className="col-span-2 sm:col-span-1"
                    min={EARLIEST_TRADE_DATE_INPUT} max={new Date().toISOString().slice(0, 10)}
                    value={purchaseDateNew} onChange={(e) => setPurchaseDateNew(e.target.value)} />
                </div>
                <Button type="button" variant="outline" size="sm" className="w-full"
                  onClick={handleAddPurchase} disabled={createPurchase.isPending}>
                  <Plus className="w-3.5 h-3.5 mr-1" />
                  {createPurchase.isPending ? "Registrando..." : "Adicionar lançamento"}
                </Button>
                <p className="text-[11px] text-muted-foreground text-pretty">
                  Use a data da NEGOCIAÇÃO, não a da liquidação — a corretora costuma mostrar
                  a segunda, que cai dois dias úteis depois.
                </p>
              </div>
            )}

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
              <Input type="date" min={EARLIEST_TRADE_DATE_INPUT} max={new Date().toISOString().slice(0, 10)}
                value={saleDate} onChange={(e) => setSaleDate(e.target.value)} required />
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

      {/* Movimentar Poupança — depósito/saque calculado a partir do saldo estimado de
          hoje, em vez de exigir que a pessoa faça a conta e edite o saldo à mão. */}
      <Dialog open={!!movingSavingsAsset} onOpenChange={(open) => !open && setMovingSavingsAsset(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Movimentar {movingSavingsAsset?.ticker}</DialogTitle>
            <DialogDescription>
              Registra um depósito ou saque a partir do saldo estimado de hoje.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSavingsMoveSubmit} className="space-y-4 py-4">
            <div className="rounded-md border border-border/60 p-3 text-sm">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Saldo estimado hoje</span>
                <span className="font-mono font-medium">
                  {formatCurrency(movingSavingsAsset?.currentPrice ?? movingSavingsAsset?.averagePrice ?? 0)}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={moveType === "deposito" ? "default" : "outline"}
                onClick={() => setMoveType("deposito")}
              >
                Depósito
              </Button>
              <Button
                type="button"
                variant={moveType === "saque" ? "default" : "outline"}
                onClick={() => setMoveType("saque")}
              >
                Saque
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="move-amount">Valor</Label>
                <Input
                  id="move-amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  placeholder="500,00"
                  value={moveAmount}
                  onChange={(e) => setMoveAmount(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="move-date">Data</Label>
                <Input
                  id="move-date"
                  type="date"
                  value={moveDate}
                  min={EARLIEST_TRADE_DATE_INPUT} max={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => setMoveDate(e.target.value)}
                  required
                />
              </div>
            </div>
            {moveNewBalance != null && (
              <div className="bg-muted/50 p-3 rounded-md text-sm border border-border/50">
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Novo saldo</span>
                  <span className={`font-mono font-medium ${moveNewBalance <= 0 ? "text-destructive" : ""}`}>
                    {formatCurrency(moveNewBalance)}
                  </span>
                </div>
              </div>
            )}
            <p className="text-[11px] text-muted-foreground text-pretty">
              O aniversário mensal reinicia a partir de hoje — se a movimentação for feita perto da data de
              crédito, o rendimento daquele ciclo pode ficar um pouco diferente do extrato real da corretora.
            </p>
            <DialogFooter>
              <Button type="submit" disabled={updateAsset.isPending || moveNewBalance == null || moveNewBalance <= 0}>
                {updateAsset.isPending ? "Salvando..." : "Confirmar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
