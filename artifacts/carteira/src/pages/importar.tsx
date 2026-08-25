import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  usePreviewBrokerImport,
  useCommitBrokerImport,
  getListAssetsQueryKey,
  type BrokerImportPreview,
  type BrokerImportPosition,
  type BrokerImportResult,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/utils";
import { categoryLabel } from "@/lib/categories";
import { Link } from "wouter";
import { FileUp, CheckCircle2, AlertTriangle, HelpCircle, Info, ArrowRight } from "lucide-react";

/**
 * Importação de nota de corretagem — a tela de conferência.
 *
 * O que ela existe para impedir é a gravação automática. O servidor já sabe conciliar,
 * mas conciliação é inferência sobre dois PDFs, e o que ela produz vira preço médio,
 * patrimônio e análise. Um erro aqui não fica visível como erro: fica visível como uma
 * carteira ligeiramente diferente da real, que é o tipo de defeito que ninguém procura.
 *
 * ## Nada vem marcado por padrão que a pessoa não possa conferir
 *
 * Posição `casado` vem marcada porque o nome bateu com uma única posição em custódia e o
 * preço confirmou. `ambiguo` e `sem_correspondencia` vêm desmarcadas e **não dá para
 * marcá-las sem escolher o ticker** — é a tela recusando gravar um palpite.
 *
 * Nota já importada também vem desmarcada, e isso não é erro: o arquivo da corretora traz
 * o período inteiro, então reenviar o que já entrou é o caminho normal.
 *
 * ## As vendas aparecem aqui, e não no resultado da gravação
 *
 * Descoberto testando com o documento real: uma venda que zerou a posição não deixa nada
 * em custódia, logo não casa com ticker nenhum, logo nunca chega ao passo de gravação. Se
 * a tela só mostrasse as vendas devolvidas pelo servidor, a venda mais comum — a saída
 * total — sumiria da conferência sem nunca ter sido mencionada.
 */

/** Categorias possíveis quando o sufixo 11 não decide. Ver b3-ticker.ts no servidor. */
const CATEGORIAS_DO_11 = ["fiis", "etfs", "acoes"] as const;

interface Escolha {
  incluir: boolean;
  ticker: string | null;
  category: string | null;
}

const STATUS_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "outline"; icon: typeof CheckCircle2 }> = {
  casado: { label: "Conferido", variant: "default", icon: CheckCircle2 },
  ambiguo: { label: "Precisa decidir", variant: "secondary", icon: HelpCircle },
  sem_correspondencia: { label: "Sem correspondência", variant: "outline", icon: AlertTriangle },
};

export default function Importar() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [preview, setPreview] = useState<BrokerImportPreview | null>(null);
  const [escolhas, setEscolhas] = useState<Record<string, Escolha>>({});
  const [resultado, setResultado] = useState<BrokerImportResult | null>(null);

  const previewMutation = usePreviewBrokerImport({
    mutation: {
      onSuccess: (data) => {
        setPreview(data);
        setResultado(null);
        setEscolhas(escolhasIniciais(data));
      },
      onError: (err) => {
        const detalhe = (err as { data?: { error?: string } })?.data?.error;
        toast({
          variant: "destructive",
          title: "Não foi possível ler os arquivos",
          description: detalhe ?? "Confira se os PDFs são a nota de corretagem e o extrato de custódia.",
        });
      },
    },
  });

  const commitMutation = useCommitBrokerImport({
    mutation: {
      onSuccess: (data) => {
        setResultado(data);
        setPreview(null);
        void queryClient.invalidateQueries({ queryKey: getListAssetsQueryKey() });
      },
      onError: (err) => {
        const detalhe = (err as { data?: { error?: string } })?.data?.error;
        toast({ variant: "destructive", title: "Nada foi gravado", description: detalhe ?? "Tente novamente." });
      },
    },
  });

  function enviarArquivos(files: FileList | null) {
    if (!files || files.length === 0) return;
    previewMutation.mutate({ data: { files: Array.from(files) } });
  }

  function confirmar() {
    if (!preview) return;
    const positions = preview.positions
      .filter((p) => escolhas[p.specificationRoot]?.incluir)
      .map((p) => {
        const e = escolhas[p.specificationRoot];
        return {
          ticker: e.ticker!,
          category: e.category as "acoes" | "fiis" | "etfs" | "bdrs",
          // Todas as operações vão, inclusive as vendas e as de nota já importada: quem
          // decide o que fazer com elas é o servidor, que tem a regra. Filtrar aqui
          // criaria uma segunda cópia dessa regra, livre para divergir.
          trades: p.trades.map((t) => ({
            noteNumber: t.noteNumber,
            tradeDate: t.tradeDate,
            side: t.side,
            quantity: t.quantity,
            price: t.price,
          })),
        };
      });

    if (positions.length === 0) {
      toast({ title: "Nenhuma posição marcada", description: "Marque ao menos uma para importar." });
      return;
    }
    commitMutation.mutate({ data: { positions } });
  }

  const vendas = preview ? vendasLidas(preview) : [];
  const marcadas = preview?.positions.filter((p) => escolhas[p.specificationRoot]?.incluir).length ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Importar nota de corretagem</h1>
        <p className="text-muted-foreground">
          Envie a nota e o extrato de custódia em PDF. Nada é gravado antes de você conferir.
        </p>
      </div>

      {!preview && !resultado && (
        <EnvioDeArquivos onFiles={enviarArquivos} carregando={previewMutation.isPending} />
      )}

      {resultado && <Resultado resultado={resultado} onNovaImportacao={() => setResultado(null)} />}

      {preview && (
        <>
          {preview.problems.length > 0 && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertTitle>Sobre os arquivos enviados</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4 space-y-1 mt-1">
                  {preview.problems.map((p) => <li key={p}>{p}</li>)}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          <Card>
            <CardHeader>
              <CardTitle>O que foi lido</CardTitle>
              <CardDescription>
                {preview.noteNumbers.length} nota(s){preview.custodyDate && <> · custódia de {formatarData(preview.custodyDate)}</>}
                {preview.totalCosts > 0 && <> · {formatCurrency(preview.totalCosts)} em taxas</>}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {preview.positions.map((p) => (
                <LinhaDePosicao
                  key={p.specificationRoot}
                  posicao={p}
                  escolha={escolhas[p.specificationRoot]}
                  jaImportadas={preview.alreadyImported}
                  onChange={(e) => setEscolhas((prev) => ({ ...prev, [p.specificationRoot]: e }))}
                />
              ))}
            </CardContent>
          </Card>

          {vendas.length > 0 && <Vendas vendas={vendas} />}

          {preview.custodyOnly.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Em custódia, sem operação nas notas</CardTitle>
                <CardDescription>
                  Compradas antes do período das notas enviadas. Não entram na importação — se ainda
                  não estão na sua carteira, cadastre-as ou envie as notas mais antigas.
                </CardDescription>
              </CardHeader>
              <CardContent className="text-sm space-y-1">
                {preview.custodyOnly.map((c) => (
                  <div key={c.ticker} className="flex justify-between gap-4">
                    <span className="font-medium">{c.ticker}</span>
                    <span className="text-muted-foreground truncate">{c.description}</span>
                    <span className="tabular-nums">{c.quantity}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={confirmar} disabled={commitMutation.isPending || marcadas === 0}>
              {commitMutation.isPending ? "Gravando…" : `Importar ${marcadas} posição(ões)`}
            </Button>
            <Button variant="ghost" onClick={() => setPreview(null)} disabled={commitMutation.isPending}>
              Cancelar
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * O estado inicial de cada linha.
 *
 * Só `casado` nasce marcado, e só quando a categoria já está resolvida. Ticker por decidir
 * ou categoria por decidir mantêm a linha desmarcada — a tela não escolhe por ninguém.
 */
function escolhasIniciais(preview: BrokerImportPreview): Record<string, Escolha> {
  const out: Record<string, Escolha> = {};
  for (const p of preview.positions) {
    const semCompraNova = p.trades.every(
      (t) => t.side === "venda" || preview.alreadyImported.includes(t.noteNumber),
    );
    out[p.specificationRoot] = {
      incluir: p.status === "casado" && p.category != null && !semCompraNova,
      ticker: p.ticker,
      category: p.category,
    };
  }
  return out;
}

/** As vendas de todas as posições, casadas ou não. Ver o docstring do módulo. */
function vendasLidas(preview: BrokerImportPreview) {
  return preview.positions.flatMap((p) =>
    p.trades
      .filter((t) => t.side === "venda")
      .map((t) => ({ nome: p.specificationRoot, ticker: p.ticker, ...t })),
  );
}

function LinhaDePosicao({
  posicao,
  escolha,
  jaImportadas,
  onChange,
}: {
  posicao: BrokerImportPosition;
  escolha: Escolha | undefined;
  jaImportadas: string[];
  onChange: (e: Escolha) => void;
}) {
  if (!escolha) return null;

  const badge = STATUS_BADGE[posicao.status] ?? STATUS_BADGE.sem_correspondencia;
  const Icone = badge.icon;

  const compras = posicao.trades.filter((t) => t.side === "compra");
  const comprasNovas = compras.filter((t) => !jaImportadas.includes(t.noteNumber));
  const notasRepetidas = compras.length - comprasNovas.length;

  // Marcar exige ticker E categoria resolvidos, e ao menos uma compra que ainda não entrou.
  const podeMarcar = escolha.ticker != null && escolha.category != null && comprasNovas.length > 0;

  /**
   * Por que a caixa está apagada.
   *
   * Controle desabilitado sem motivo declarado é a pior combinação possível: a pessoa vê
   * que não pode marcar, não vê o que fazer, e conclui que a importação quebrou. Cada
   * motivo aqui vem com a ação que o resolve — ou com a saída, quando não há ação.
   */
  const motivoBloqueio = podeMarcar
    ? null
    : escolha.ticker == null
      ? compras.length === 0
        ? "Só há venda nesta posição — vendas são registradas em Operações Encerradas."
        : "Sem ticker identificado. Envie o extrato de custódia junto, ou cadastre esta posição à mão em Minha Carteira."
      : escolha.category == null
        ? "Escolha a categoria acima para poder importar."
        : "Todas as compras desta posição já estão na carteira.";

  return (
    <div className="rounded-lg border p-3 space-y-3">
      <div className="flex items-start gap-3">
        <Checkbox
          className="mt-1"
          checked={escolha.incluir}
          disabled={!podeMarcar}
          onCheckedChange={(v) => onChange({ ...escolha, incluir: v === true })}
          aria-label={`Importar ${posicao.specificationRoot}`}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{posicao.specificationRoot}</span>
            <Badge variant={badge.variant} className="gap-1">
              <Icone className="h-3 w-3" />
              {badge.label}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">{posicao.reason}</p>
          {motivoBloqueio && (
            <p className="text-sm font-medium text-amber-700 dark:text-amber-500">{motivoBloqueio}</p>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 pl-7">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Ticker</label>
          {posicao.candidates.length > 0 && posicao.status !== "casado" ? (
            <Select
              value={escolha.ticker ?? undefined}
              onValueChange={(v) => onChange({ ...escolha, ticker: v })}
            >
              <SelectTrigger><SelectValue placeholder="Escolha" /></SelectTrigger>
              <SelectContent>
                {posicao.candidates.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-sm font-medium tabular-nums">
              {posicao.ticker ?? <span className="text-muted-foreground font-normal">não identificado</span>}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Categoria</label>
          {posicao.category == null && posicao.ticker != null ? (
            <Select
              value={escolha.category ?? undefined}
              onValueChange={(v) => onChange({ ...escolha, category: v })}
            >
              <SelectTrigger><SelectValue placeholder="Escolha" /></SelectTrigger>
              <SelectContent>
                {CATEGORIAS_DO_11.map((c) => (
                  <SelectItem key={c} value={c}>{categoryLabel(c)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-sm font-medium">
              {escolha.category ? categoryLabel(escolha.category) : <span className="text-muted-foreground font-normal">—</span>}
            </p>
          )}
        </div>
      </div>

      {/* O sufixo 11 é FII, ETF e unit ao mesmo tempo; a convenção da B3 não separa. */}
      {posicao.category == null && posicao.ticker != null && (
        <p className="pl-7 text-xs text-muted-foreground">
          O final <strong>11</strong> é usado por FII, ETF e unit de ação — o código sozinho não diz qual.
        </p>
      )}

      <div className="pl-7 space-y-1 text-sm">
        {compras.map((t, i) => {
          const repetida = jaImportadas.includes(t.noteNumber);
          return (
            <div key={`${t.noteNumber}-${i}`} className={`flex flex-wrap gap-x-3 tabular-nums ${repetida ? "text-muted-foreground line-through" : ""}`}>
              <span>{formatarData(t.tradeDate)}</span>
              <span>{t.quantity} × {formatCurrency(t.price)}</span>
              <span className="text-muted-foreground">= {formatCurrency(t.total)}</span>
              <span className="text-xs text-muted-foreground">nota {t.noteNumber}</span>
            </div>
          );
        })}
        {notasRepetidas > 0 && (
          <p className="text-xs text-muted-foreground">
            {notasRepetidas} operação(ões) já estão na carteira e não serão gravadas de novo.
          </p>
        )}
        {posicao.custodyQuantity != null && (
          <p className="text-xs text-muted-foreground">
            Custódia: {posicao.custodyQuantity}
            {posicao.quantityBefore != null && posicao.quantityBefore > 0 && (
              <> — {posicao.quantityBefore} já existia antes destas notas</>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

function Vendas({ vendas }: { vendas: { nome: string; ticker: string | null; quantity: number; price: number; tradeDate: string }[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Vendas lidas — não entram na importação</CardTitle>
        <CardDescription>
          A nota traz só o preço de venda. O custo da posição vendida, o resultado e o imposto
          vêm do histórico da sua carteira, e calcular isso a partir de um dado incompleto
          gravaria um valor de IR errado. Registre estas em Operações Encerradas.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {vendas.map((v, i) => (
          <div key={i} className="flex flex-wrap justify-between gap-2 text-sm tabular-nums">
            <span className="font-medium">{v.ticker ?? v.nome}</span>
            <span>{formatarData(v.tradeDate)}</span>
            <span>{v.quantity} × {formatCurrency(v.price)}</span>
          </div>
        ))}
        <Separator className="my-2" />
        <Button asChild variant="outline" size="sm">
          <Link href="/vendas">Ir para Operações Encerradas <ArrowRight className="ml-1 h-3 w-3" /></Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function Resultado({ resultado, onNovaImportacao }: { resultado: BrokerImportResult; onNovaImportacao: () => void }) {
  const nada = resultado.imported.length === 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{nada ? "Nada de novo para gravar" : "Importação concluída"}</CardTitle>
        <CardDescription>
          {nada
            ? "Todas as operações enviadas já estavam na carteira."
            : "As posições abaixo foram criadas ou atualizadas. O preço médio foi recalculado a partir dos lançamentos."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {resultado.imported.map((i) => (
          <div key={i.ticker} className="flex justify-between tabular-nums">
            <span className="font-medium">{i.ticker}</span>
            <span>{i.quantity} un · {i.purchases} lançamento(s)</span>
          </div>
        ))}

        {resultado.skippedNotes.length > 0 && (
          <p className="text-muted-foreground">
            Notas já importadas, puladas: {resultado.skippedNotes.join(", ")}.
          </p>
        )}

        {resultado.rejected.length > 0 && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Não gravadas</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4 mt-1 space-y-1">
                {resultado.rejected.map((r) => <li key={r.ticker}><strong>{r.ticker}</strong>: {r.reason}</li>)}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        <div className="flex gap-3 pt-2">
          <Button asChild><Link href="/carteira">Ver minha carteira</Link></Button>
          <Button variant="ghost" onClick={onNovaImportacao}>Importar outra</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function EnvioDeArquivos({ onFiles, carregando }: { onFiles: (f: FileList | null) => void; carregando: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Envie os dois documentos</CardTitle>
        <CardDescription>
          Pode mandar os dois de uma vez, em qualquer ordem — o app identifica cada um pelo
          cabeçalho. Até 12 arquivos de 8 MB.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center hover:bg-muted/50">
          <FileUp className="h-8 w-8 text-muted-foreground" />
          <span className="font-medium">{carregando ? "Lendo os PDFs…" : "Escolher arquivos PDF"}</span>
          <span className="text-sm text-muted-foreground">Nota de corretagem e extrato de custódia</span>
          <input
            type="file"
            accept="application/pdf,.pdf"
            multiple
            className="sr-only"
            disabled={carregando}
            onChange={(e) => onFiles(e.target.files)}
          />
        </label>

        <div className="text-sm text-muted-foreground space-y-2">
          <p>
            <strong className="text-foreground">Por que os dois?</strong> A nota tem data, quantidade
            e preço, mas identifica o papel pelo nome, não pelo código. O extrato tem o código, mas
            não tem preço nem data. Um completa o outro — e é isso que evita o app adivinhar ticker.
          </p>
          <p>
            As datas usadas são as do <strong className="text-foreground">pregão</strong>, não as de
            liquidação: é no pregão que o preço foi formado.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function formatarData(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
