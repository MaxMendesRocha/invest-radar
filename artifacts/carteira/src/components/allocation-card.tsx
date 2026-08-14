import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAllocation,
  getGetAllocationQueryKey,
  useUpsertAllocation,
  useGetAllocationPlan,
  getGetAllocationPlanQueryKey,
  type AllocationItem,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Target, Wallet, Pencil } from "lucide-react";
import { formatCurrency, formatShortDate } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

const CATEGORY_LABEL: Record<string, string> = {
  renda_fixa: "Renda Fixa",
  acoes: "Ações",
  fiis: "FIIs",
  etfs: "ETFs",
  bdrs: "BDRs",
  fundos: "Fundos",
};

const SOURCE_LABEL: Record<string, string> = {
  personalizado: "Alvos definidos por você.",
  perfil: "Alvos derivados do seu perfil de investidor. Você pode editá-los.",
  generico: "Perfil ainda não preenchido — estes são alvos genéricos de partida, não calculados a partir das suas respostas.",
};

const SUGGESTION_NOTE: Record<string, string> = {
  sem_ticker_de_bolsa: "Sem sugestão de ativo: fundos não têm ticker de bolsa nem fonte pública de dados para ranquear.",
  sem_candidato: "Sem candidato na varredura atual — ETFs não têm fundamento individual (P/L, ROE, margem), então não passam pela triagem por fundamentos.",
  tesouro_indisponivel: "A sincronização com o Tesouro Direto ainda não rodou. As sugestões aparecem assim que ela acontecer — é uma vez por dia.",
};

/** "2045-05-15" -> "2045" — o ano basta para o usuário reconhecer o título. */
function maturityYear(iso: string): string {
  return iso.slice(0, 4);
}

/** "89,6" — pt-BR, uma casa. As barras e os textos abaixo falam em pontos percentuais. */
const decimal = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
/** Fração de título do Tesouro: "0,03". Duas casas, que é a granularidade da compra. */
const fraction = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Sizing = { unitPrice: number; units: number; investedAmount: number; leftover: number };

/**
 * Quantas linhas do item exibem quantidade. Com uma só não há o que confundir — o aviso
 * de "não é soma" apareceria como ruído.
 */
function sizedCount(item: { suggestions: { sizing?: Sizing | null }[]; treasurySuggestions?: { sizing?: Sizing | null }[] | null }): number {
  const bolsa = item.suggestions.filter((s) => s.sizing).length;
  const tesouro = (item.treasurySuggestions ?? []).filter((t) => t.sizing).length;
  return bolsa + tesouro;
}

/**
 * A linha que converte reais em quantidade — o passo que faltava entre "R$ 206,86 em
 * FIIs" e a ordem de compra na corretora.
 *
 * `units: 0` não é ausência de resposta, é a resposta: a fatia não paga uma unidade.
 * Esconder esse caso deixaria o usuário procurando a informação que o app tem.
 */
function SizingLine({ sizing, unitLabel }: { sizing: Sizing; unitLabel: "ação" | "cota" | "título" }) {
  const plural = unitLabel === "ação" ? "ações" : `${unitLabel}s`;
  const isFractional = unitLabel === "título";

  if (sizing.units === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        A fatia não alcança {isFractional ? "a compra mínima" : `1 ${unitLabel}`} — {formatCurrency(sizing.unitPrice)}
        {isFractional ? " o título inteiro (mínimo de R$ 30)" : " cada"}.
      </p>
    );
  }

  const quantity = isFractional ? fraction.format(sizing.units) : integer.format(sizing.units);
  const noun = isFractional ? (sizing.units === 1 ? unitLabel : plural) : sizing.units === 1 ? unitLabel : plural;

  return (
    <p className="text-xs text-muted-foreground">
      <span className="font-mono font-medium text-foreground">{quantity} {noun}</span>
      {" × "}{formatCurrency(sizing.unitPrice)} = {formatCurrency(sizing.investedAmount)}
      {sizing.leftover > 0 && ` · sobram ${formatCurrency(sizing.leftover)}`}
    </p>
  );
}

/**
 * Uma barra por classe: o preenchimento é o peso atual, o traço é o alvo.
 *
 * A escala é fixa em 0-100% para todas as linhas, e não o máximo de cada uma. Com
 * escala por linha, uma classe em 89,6% e outra em 10,4% desenhavam barras do mesmo
 * tamanho — cada uma "cheia" na sua própria régua — e a comparação visual entre
 * classes, que é o motivo de o gráfico existir, dizia o contrário dos números.
 */
function AllocationBar({ item }: { item: AllocationItem }) {
  const overweight = item.deviationPp < 0;

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-sm gap-2">
        <span className="font-medium">{CATEGORY_LABEL[item.category] ?? item.category}</span>
        <span className="font-mono text-xs text-muted-foreground whitespace-nowrap">
          {decimal.format(item.currentPercent)}% · alvo {integer.format(item.targetPercent)}%
        </span>
      </div>
      <div className="relative h-2 w-full bg-secondary overflow-hidden rounded-full">
        <div
          className={`h-full transition-all ${overweight ? "bg-orange-500" : "bg-blue-600 dark:bg-blue-500"}`}
          style={{ width: `${Math.min(100, item.currentPercent)}%` }}
        />
        <div
          className="absolute top-0 h-full w-0.5 bg-foreground/70"
          // Sem o recuo o traço de um alvo em 100% cairia metade fora do trilho.
          style={{ left: `calc(${Math.min(100, item.targetPercent)}% - 1px)` }}
          aria-hidden
        />
      </div>
      <div className="text-xs text-muted-foreground">
        {Math.abs(item.deviationPp) < 0.05
          ? "No alvo."
          : overweight
            ? `${decimal.format(Math.abs(item.deviationPp))}pp acima do alvo (${formatCurrency(Math.abs(item.deviationValue))} a mais).`
            : `${decimal.format(item.deviationPp)}pp abaixo do alvo (faltam ${formatCurrency(item.deviationValue)}).`}
      </div>
    </div>
  );
}

function PolicyEditor({ items, onDone }: { items: AllocationItem[]; onDone: () => void }) {
  const [targets, setTargets] = useState<Record<string, string>>(
    Object.fromEntries(items.map((i) => [i.category, String(Math.round(i.targetPercent * 100) / 100)])),
  );
  const queryClient = useQueryClient();
  const upsert = useUpsertAllocation();
  const { toast } = useToast();

  const total = Object.values(targets).reduce((sum, v) => sum + (Number(v) || 0), 0);
  const balanced = Math.abs(total - 100) <= 0.01;

  const handleSave = async () => {
    try {
      await upsert.mutateAsync({
        data: { targets: Object.entries(targets).map(([category, value]) => ({ category: category as never, targetPercent: Number(value) || 0 })) },
      });
      queryClient.invalidateQueries({ queryKey: getGetAllocationQueryKey() });
      toast({ title: "Alocação-alvo salva." });
      onDone();
    } catch {
      toast({ title: "Erro ao salvar a alocação-alvo.", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {items.map((item) => (
          <div key={item.category} className="space-y-1">
            <Label htmlFor={`target-${item.category}`} className="text-xs">{CATEGORY_LABEL[item.category] ?? item.category}</Label>
            <Input
              id={`target-${item.category}`}
              type="number"
              min={0}
              max={100}
              step="0.01"
              value={targets[item.category] ?? "0"}
              onChange={(e) => setTargets((prev) => ({ ...prev, [item.category]: e.target.value }))}
              className="font-mono"
            />
          </div>
        ))}
      </div>
      <div className={`text-sm font-mono ${balanced ? "text-muted-foreground" : "text-destructive"}`}>
        Soma: {new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(total)}%{balanced ? "" : " — precisa somar 100%"}
      </div>
      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={!balanced || upsert.isPending}>
          {upsert.isPending ? "Salvando..." : "Salvar alvos"}
        </Button>
        <Button variant="ghost" onClick={onDone}>Cancelar</Button>
      </div>
    </div>
  );
}

function ContributionPlan() {
  const [input, setInput] = useState("");
  const [amount, setAmount] = useState<number | null>(null);
  const { data: plan, isFetching } = useGetAllocationPlan(
    { amount: amount ?? 0 },
    { query: { queryKey: getGetAllocationPlanQueryKey({ amount: amount ?? 0 }), enabled: amount != null && amount > 0 } },
  );

  return (
    <div className="space-y-4">
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => { e.preventDefault(); setAmount(Number(input) || null); }}
      >
        <div className="flex-1 space-y-1">
          <Label htmlFor="contribution" className="text-xs">Quanto você vai aportar?</Label>
          <Input
            id="contribution"
            type="number"
            min={1}
            step="0.01"
            placeholder="1000"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="font-mono"
          />
        </div>
        <Button type="submit" disabled={!Number(input)}>Calcular</Button>
      </form>

      {isFetching && <div className="h-24 animate-pulse bg-muted/30 rounded-lg" />}

      {plan && !isFetching && (
        plan.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nenhuma classe está abaixo do alvo — mesmo depois do aporte, a carteira já estaria onde
            você definiu. Aportar em qualquer classe aqui é escolha sua, não correção de desvio.
          </p>
        ) : (
          <div className="space-y-4">
            {plan.items.map((item) => (
              <div key={item.category} className="border border-border/60 rounded-lg p-3 space-y-2">
                <div className="flex justify-between items-baseline gap-2">
                  <span className="font-medium">{CATEGORY_LABEL[item.category] ?? item.category}</span>
                  <span className="font-mono font-bold">{formatCurrency(item.amount)}</span>
                </div>
                {item.suggestions.length > 0 && (
                  <div className="space-y-2">
                    {item.suggestions.map((s) => (
                      <div key={s.ticker}>
                        <div className="text-sm flex gap-2">
                          <span className="font-mono font-medium">{s.ticker}</span>
                          <span className="text-muted-foreground truncate" title={s.reason}>{s.name}</span>
                        </div>
                        {s.sizing && (
                          <SizingLine sizing={s.sizing} unitLabel={item.category === "fiis" ? "cota" : "ação"} />
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {item.treasurySuggestions && item.treasurySuggestions.length > 0 && (
                  <div className="space-y-2">
                    {item.treasurySuggestions.map((t, index) => (
                      <div key={`${t.bondType}-${t.maturityDate}`} className={index === 0 ? "" : "opacity-70"}>
                        <div className="text-sm flex flex-wrap gap-x-2 items-baseline">
                          <span className="font-medium">{t.bondType} {maturityYear(t.maturityDate)}</span>
                          <span className="font-mono text-xs">{t.rateLabel}</span>
                        </div>
                        {/* O primeiro é a recomendação; os outros existem para o usuário
                            ver o contraponto, então só o primeiro leva a justificativa. */}
                        {index === 0 && <p className="text-xs text-muted-foreground text-pretty mt-0.5">{t.reason}</p>}
                        {t.sizing && <div className="mt-0.5"><SizingLine sizing={t.sizing} unitLabel="título" /></div>}
                        <p className="text-xs text-muted-foreground mt-0.5">
                          A partir de {formatCurrency(t.minimumInvestment)} · taxa de {formatShortDate(t.baseDate)}
                        </p>
                      </div>
                    ))}
                  </div>
                )}

                {/* Sem esta frase as quantidades somam na cabeça de quem lê e o usuário
                    gasta o triplo da fatia. Cada linha usa a fatia inteira porque o alvo
                    do app é por classe, não por ticker — ratear entre os candidatos seria
                    inventar uma política que não existe. Vale para bolsa e para o Tesouro,
                    por isso a nota é do item e não de cada lista. */}
                {sizedCount(item) > 1 && (
                  <p className="text-xs text-muted-foreground text-pretty">
                    Cada linha usa {formatCurrency(item.amount)} inteiros — são alternativas para a
                    fatia, não uma soma.
                  </p>
                )}

                {item.suggestions.length === 0 && (item.treasurySuggestions?.length ?? 0) === 0 && (
                  <p className="text-xs text-muted-foreground text-pretty">{SUGGESTION_NOTE[item.suggestionsStatus]}</p>
                )}
              </div>
            ))}
            {plan.deviationBefore != null && plan.deviationAfter != null && (
              <p className="text-sm text-muted-foreground">
                Desvio total da carteira: {decimal.format(plan.deviationBefore)}pp → <strong>{decimal.format(plan.deviationAfter)}pp</strong> depois deste aporte.
              </p>
            )}
            <p className="text-xs text-muted-foreground text-pretty">
              O plano só compra — rebalancear vendendo custa IR e corretagem. Classes acima do alvo
              não recebem aporte e voltam ao lugar conforme a carteira cresce.
            </p>
          </div>
        )
      )}
    </div>
  );
}

export function AllocationCard() {
  const { data: allocation, isLoading } = useGetAllocation({ query: { queryKey: getGetAllocationQueryKey() } });
  const [editing, setEditing] = useState(false);

  if (isLoading) return <Card className="h-64 animate-pulse bg-muted/20" />;
  if (!allocation) return null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2"><Target className="w-4 h-4" /> Alocação-alvo</CardTitle>
            <CardDescription className="text-pretty">{SOURCE_LABEL[allocation.source]}</CardDescription>
          </div>
          {!editing && (
            <Button variant="ghost" size="icon" onClick={() => setEditing(true)} aria-label="Editar alocação-alvo">
              <Pencil className="w-4 h-4" />
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {editing ? (
            <PolicyEditor items={allocation.items} onDone={() => setEditing(false)} />
          ) : (
            allocation.items
              // Classe com alvo zero e nada investido não diz nada — só ocuparia espaço.
              .filter((item) => item.targetPercent > 0 || item.currentValue > 0)
              .map((item) => <AllocationBar key={item.category} item={item} />)
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="space-y-1.5">
          <CardTitle className="flex items-center gap-2"><Wallet className="w-4 h-4" /> Onde aportar</CardTitle>
          <CardDescription className="text-pretty">
            Distribui um aporte novo priorizando as classes mais distantes do alvo.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ContributionPlan />
        </CardContent>
      </Card>
    </div>
  );
}
