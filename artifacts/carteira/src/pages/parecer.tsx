import { useState, type FormEvent } from "react";
import { useGetAssetOpinion, getGetAssetOpinionQueryKey } from "@workspace/api-client-react";
import { usePriceTarget } from "@/hooks/use-price-target";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Search, Check, AlertTriangle, Newspaper, Sparkles, TrendingUp, Coins, LineChart, CalendarClock } from "lucide-react";
import { formatCurrency, formatPercent } from "@/lib/utils";

/**
 * Preço-alvo do usuário para o ticker consultado.
 *
 * Fica nesta tela porque é aqui que a pergunta "quanto isso vale" é feita — antes de
 * comprar. O app não tem essa informação e não vai ter: `targetMeanPrice` dá 403 em
 * todos os planos do provedor. Quem assina casa de análise tem o número; o app só
 * precisava de onde recebê-lo.
 *
 * O upside é a ÚNICA coisa calculada aqui. O alvo é dado de terceiro, exibido com a
 * procedência que o usuário escreveu, e nunca se mistura com o score nem com a
 * triagem — apresentar opinião de fora como medição do Radar seria o mesmo erro que
 * fabricar número.
 */
function PriceTargetBlock({ ticker, currentPrice }: { ticker: string; currentPrice: number }) {
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState("");
  const [source, setSource] = useState("");

  // Salvar, remover e reportar erro vivem no hook porque Minha Carteira expõe o mesmo
  // controle com outra aparência — o que não pode divergir entre as telas é o que
  // acontece quando o salvamento falha.
  const { target: existing, error, setError, save: persist, remove, isSaving } = usePriceTarget(ticker, {
    onSaved: () => setIsEditing(false),
  });

  const openEditor = () => {
    setValue(existing ? String(existing.targetPrice).replace(".", ",") : "");
    setSource(existing?.source ?? "");
    setError(null);
    setIsEditing(true);
  };

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    persist(value, source);
  };

  if (isEditing) {
    return (
      <form onSubmit={save} className="mt-4 rounded-lg border p-4">
        <p className="text-sm font-semibold">Preço-alvo para {ticker}</p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="target-price">Alvo (R$)</label>
            <Input id="target-price" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="29,92" required />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="target-source">Fonte (opcional)</label>
            <Input id="target-source" value={source} onChange={(e) => setSource(e.target.value)} placeholder="Eleven, meu cálculo…" maxLength={80} />
          </div>
        </div>
        {error && <p className="mt-3 text-xs text-destructive text-pretty">{error}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={isSaving}>{isSaving ? "Salvando..." : "Salvar"}</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setIsEditing(false)}>Cancelar</Button>
          {existing && (
            <Button type="button" size="sm" variant="ghost" className="text-destructive"
              onClick={() => { remove.mutate({ ticker }); setIsEditing(false); }}>
              Remover
            </Button>
          )}
        </div>
      </form>
    );
  }

  if (!existing) {
    return (
      <button type="button" onClick={openEditor}
        className="mt-4 w-full rounded-lg border border-dashed p-3 text-left text-xs text-muted-foreground hover:bg-muted/40">
        <span className="font-medium text-foreground">Definir preço-alvo</span> — se você acompanha alguma casa de
        análise, informe o alvo dela e o app calcula o upside contra a cotação real. O Radar não tem esse número:
        preço-alvo de analista não é publicado por nenhum provedor de dados aberto.
      </button>
    );
  }

  const upside = existing.upsidePercent;
  const stale = upside != null && upside < 0;

  return (
    <button type="button" onClick={openEditor} className="mt-4 w-full rounded-lg border p-3 text-left hover:bg-muted/40">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm">
          Preço-alvo <span className="font-mono font-semibold">{formatCurrency(existing.targetPrice)}</span>
          {existing.source && <span className="text-xs text-muted-foreground"> · {existing.source}</span>}
        </p>
        {upside != null && (
          <p className={`font-mono text-sm font-semibold ${upside >= 0 ? "text-green-600 dark:text-green-500" : "text-destructive"}`}>
            {upside >= 0 ? "+" : ""}{formatPercent(upside)}
          </p>
        )}
      </div>
      {/* Alvo abaixo da cotação quase sempre significa alvo velho, não pessimismo:
          relatório é datado e o preço andou desde então. Dizer isso evita ler como
          recomendação de venda algo que é só defasagem. */}
      <p className="mt-1 text-[11px] text-muted-foreground text-pretty">
        {stale
          ? `Contra a cotação de hoje (${formatCurrency(currentPrice)}), o alvo já ficou para trás — vale conferir se a fonte publicou revisão.`
          : `Upside contra ${formatCurrency(currentPrice)}. Número seu, não do Radar — só o cálculo é do app.`}
      </p>
    </button>
  );
}

const CROSS_SIGNAL_LABELS: Record<string, string> = {
  golden_cross_recente: "Cruzamento dourado recente",
  death_cross_recente: "Cruzamento da morte recente",
  acima_sma200: "Tendência de alta (longo prazo)",
  abaixo_sma200: "Tendência de baixa (longo prazo)",
};

export default function Parecer() {
  const [ticker, setTicker] = useState("");
  const [submittedTicker, setSubmittedTicker] = useState<string | null>(null);

  const { data: opinion, isLoading, isError, error } = useGetAssetOpinion(submittedTicker ?? "", {
    query: {
      queryKey: getGetAssetOpinionQueryKey(submittedTicker ?? ""),
      enabled: !!submittedTicker,
      retry: false,
    },
  });

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const clean = ticker.trim().toUpperCase();
    if (clean) setSubmittedTicker(clean);
  };

  const rangePercent =
    opinion?.fiftyTwoWeekHigh != null && opinion?.fiftyTwoWeekLow != null && opinion.fiftyTwoWeekHigh > opinion.fiftyTwoWeekLow
      ? Math.min(100, Math.max(0, ((opinion.price - opinion.fiftyTwoWeekLow) / (opinion.fiftyTwoWeekHigh - opinion.fiftyTwoWeekLow)) * 100))
      : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Parecer de Ativo</h1>
        <p className="text-muted-foreground">Consulte um ticker antes de comprar — fundamentos, tendência de dividendo, notícias e leitura da IA, mesmo sem tê-lo na carteira.</p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
            <Input
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
              placeholder="Ex: WEGE3, HGLG11, BOVA11..."
              className="font-mono"
            />
            <Button type="submit" disabled={isLoading} className="gap-2 shrink-0">
              <Search className="w-4 h-4" />
              {isLoading ? "Buscando..." : "Consultar"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {isLoading && (
        <Card className="animate-pulse h-40 bg-muted/20" />
      )}

      {isError && (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            <p className="font-medium">
              {(error as any)?.status === 404
                ? "Ticker não encontrado ou sem cotação disponível."
                : "Não foi possível consultar esse ativo agora. Tente novamente em instantes."}
            </p>
          </CardContent>
        </Card>
      )}

      {opinion && (
        <Card className="overflow-hidden">
          <div className="p-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-center gap-4 min-w-0">
                <div className="w-16 h-16 rounded-lg bg-muted flex items-center justify-center font-bold text-xl font-mono shrink-0">
                  {opinion.available ? opinion.score : "?"}
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-xl font-bold font-mono">{opinion.ticker}</h3>
                    {opinion.name && <span className="text-sm text-muted-foreground truncate">{opinion.name}</span>}
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    {opinion.available ? (
                      <>Classificação: <span className="font-medium text-foreground">{opinion.scoreClassification}</span></>
                    ) : (
                      "Fundamentos detalhados indisponíveis para este ativo"
                    )}
                  </p>
                </div>
              </div>

              <div className="text-right shrink-0">
                <div className="text-2xl font-bold font-mono">{formatCurrency(opinion.price)}</div>
                {opinion.fiveDayChangePercent != null && (
                  <div className={`text-xs font-medium ${opinion.fiveDayChangePercent >= 0 ? "text-green-600 dark:text-green-400" : "text-destructive"}`}>
                    {opinion.fiveDayChangePercent >= 0 ? "+" : ""}{opinion.fiveDayChangePercent.toFixed(1)}% (5 pregões)
                  </div>
                )}
              </div>
            </div>

            {/* Veredito de TRIAGEM, logo abaixo do score, que é o número de que ele
                deriva. Diz "atende / não atende ao corte do Radar" e nunca "compre":
                esta tela é consultada para ativo que a pessoa não tem, e transformar
                uma régua interna em recomendação seria a primeira afirmação inventada
                do app. A contagem de riscos vai ao lado, não dentro — ver
                screenForPurchase para por que risco não derruba o veredito. */}
            <div
              className={`mt-6 rounded-lg border p-4 ${
                opinion.screening.outcome === "atende"
                  ? "border-green-600/30 bg-green-600/5"
                  : opinion.screening.outcome === "nao_atende"
                    ? "border-amber-600/30 bg-amber-600/5"
                    : "border-dashed"
              }`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-semibold">
                  {opinion.screening.outcome === "atende" && "Atende ao corte de compra do Radar"}
                  {opinion.screening.outcome === "nao_atende" && "Não atende ao corte de compra do Radar"}
                  {opinion.screening.outcome === "sem_dados" && "Sem dados suficientes para triagem"}
                </p>
                {opinion.available && (
                  <p className="font-mono text-xs text-muted-foreground">
                    score {opinion.score} · corte {opinion.screening.scoreThreshold}
                  </p>
                )}
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground text-pretty">
                {opinion.screening.outcome === "sem_dados"
                  ? "Sem indicadores reais suficientes, o Radar não emite triagem — é o mesmo piso de evidência que evita veredito sobre número quebrado."
                  : "É o corte de nota do próprio app, não uma recomendação de compra."}
                {opinion.screening.riskCount > 0 && (
                  <>
                    {" "}
                    <span className="font-medium text-foreground">
                      {opinion.screening.riskCount === 1
                        ? "1 fator de risco identificado"
                        : `${opinion.screening.riskCount} fatores de risco identificados`}
                    </span>{" "}
                    abaixo — eles não entram nesta conta, e podem pesar mais que a nota.
                  </>
                )}
              </p>
            </div>

            <PriceTargetBlock ticker={opinion.ticker} currentPrice={opinion.price} />

            {rangePercent != null && (
              <div className="mt-6 space-y-1.5">
                <div className="flex justify-between text-xs font-medium text-muted-foreground">
                  <span>Mín. 52 sem: {formatCurrency(opinion.fiftyTwoWeekLow!)}</span>
                  <span>Máx. 52 sem: {formatCurrency(opinion.fiftyTwoWeekHigh!)}</span>
                </div>
                <Progress value={rangePercent} className="h-2" />
                <p className="text-[10px] text-muted-foreground">Preço atual está a {rangePercent.toFixed(0)}% do range de 52 semanas.</p>
              </div>
            )}

            <div className="mt-8 pt-6 border-t grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className="space-y-6">
                {opinion.positives.length > 0 && (
                  <div>
                    <h4 className="flex items-center gap-2 font-semibold mb-3 text-sm uppercase tracking-wider text-muted-foreground">
                      <Check className="w-4 h-4 text-green-500" /> Pontos Positivos
                    </h4>
                    <ul className="space-y-2">
                      {opinion.positives.map((p, i) => (
                        <li key={i} className="text-sm flex gap-2">
                          <span className="text-primary mt-0.5">•</span>
                          <span className="break-words">{p}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {opinion.risks.length > 0 && (
                  <div>
                    <h4 className="flex items-center gap-2 font-semibold mb-3 text-sm uppercase tracking-wider text-muted-foreground">
                      <AlertTriangle className="w-4 h-4 text-destructive" /> Fatores de Risco
                    </h4>
                    <ul className="space-y-2">
                      {opinion.risks.map((r, i) => (
                        <li key={i} className="text-sm flex gap-2 text-muted-foreground">
                          <span className="text-destructive mt-0.5">•</span>
                          <span className="break-words">{r}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {opinion.dividendTrend && (
                  <div className="flex flex-wrap items-center gap-2 text-xs px-3 py-2 rounded-md border bg-muted/40 border-border/50">
                    <Coins className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                    <span className="font-medium">
                      Provento {opinion.dividendTrend.growthPercent >= 0 ? "cresceu" : "caiu"} {Math.abs(opinion.dividendTrend.growthPercent).toFixed(1)}% nos últimos 12 meses
                    </span>
                  </div>
                )}

                {opinion.dividendFrequency && (
                  <div className="flex flex-wrap items-center gap-2 text-xs px-3 py-2 rounded-md border bg-muted/40 border-border/50">
                    <CalendarClock className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                    <span className="font-medium">Paga {opinion.dividendFrequency.toLowerCase()}</span>
                  </div>
                )}

                {opinion.technical && (opinion.technical.rsi14 != null || opinion.technical.crossSignal) && (
                  <div className="flex flex-wrap items-center gap-2 text-xs px-3 py-2 rounded-md border bg-muted/40 border-border/50">
                    <LineChart className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                    <span className="font-medium">
                      {[
                        opinion.technical.rsi14 != null
                          ? `RSI ${opinion.technical.rsi14.toFixed(0)} (${opinion.technical.rsi14 >= 70 ? "sobrecomprado" : opinion.technical.rsi14 <= 30 ? "sobrevendido" : "neutro"})`
                          : null,
                        opinion.technical.crossSignal ? CROSS_SIGNAL_LABELS[opinion.technical.crossSignal] ?? opinion.technical.crossSignal : null,
                      ].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                )}

                {opinion.newsItems.length > 0 && (
                  <div>
                    <h4 className="flex items-center gap-2 font-semibold mb-2 text-xs uppercase tracking-wider text-muted-foreground">
                      <Newspaper className="w-3 h-3" /> Notícias Recentes
                    </h4>
                    <ul className="space-y-1">
                      {opinion.newsItems.map((n, i) => (
                        <li key={i} className="text-xs text-muted-foreground break-words">- {n}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className="max-w-prose text-sm">
                <h4 className="flex items-center gap-2 font-semibold mb-3 text-sm uppercase tracking-wider text-muted-foreground">
                  <Sparkles className="w-4 h-4" /> Parecer
                </h4>
                <div className="bg-muted/50 p-4 rounded-md text-sm leading-relaxed text-pretty text-justify hyphens-auto border border-border/50">
                  {opinion.opinion}
                </div>
                <p className="text-[10px] text-muted-foreground mt-2 flex items-center gap-1">
                  <TrendingUp className="w-3 h-3" /> Primeira leitura pré-compra, não é recomendação formal de investimento.
                </p>
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
