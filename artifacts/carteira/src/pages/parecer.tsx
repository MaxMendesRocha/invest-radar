import { useState, type FormEvent } from "react";
import { useGetAssetOpinion, getGetAssetOpinionQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Search, Check, AlertTriangle, Newspaper, Sparkles, TrendingUp, Coins, LineChart, CalendarClock } from "lucide-react";
import { formatCurrency } from "@/lib/utils";

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

              <div>
                <h4 className="flex items-center gap-2 font-semibold mb-3 text-sm uppercase tracking-wider text-muted-foreground">
                  <Sparkles className="w-4 h-4" /> Parecer
                </h4>
                <div className="bg-muted/50 p-4 rounded-md text-sm leading-relaxed border border-border/50">
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
