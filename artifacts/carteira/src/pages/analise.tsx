import { useState } from "react";
import {
  useListAssetAnalyses,
  useGeneratePortfolioAnalysis,
  getListAssetAnalysesQueryKey,
  type AssetAnalysis,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { BrainCircuit, Check, AlertTriangle, Newspaper, Bell, Activity, Clock, Receipt, LineChart, CalendarClock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/utils";

function TaxBadge({ tax }: { tax: AssetAnalysis["taxEstimate"] }) {
  if (!tax) return null;

  const isLoss = tax.grossGain < 0;
  const colorClass = isLoss
    ? "bg-muted/40 border-border/50 text-muted-foreground"
    : tax.exempt
    ? "bg-green-500/10 border-green-500/20 text-green-700 dark:text-green-400"
    : "bg-amber-500/10 border-amber-500/20 text-amber-700 dark:text-amber-400";

  const label = isLoss
    ? `Prejuízo estimado de ${formatCurrency(Math.abs(tax.grossGain))} — sem IR se vender agora`
    : tax.exempt
    ? `Isento de IR se vender agora (ganho de ${formatCurrency(tax.grossGain)})`
    : `IR estimado: ${formatCurrency(tax.taxOwed)} (${(tax.taxRate * 100).toFixed(0)}%) · líquido: ${formatCurrency(tax.netGain)}`;

  return (
    <div className={`flex flex-wrap items-center gap-2 text-xs px-3 py-2 rounded-md border mb-3 ${colorClass}`}>
      <Receipt className="w-3.5 h-3.5 shrink-0" />
      <span className="font-medium">{label}</span>
      <span className="text-[10px] opacity-70 sm:ml-auto">estimativa isolada, não considera outras vendas do mês</span>
    </div>
  );
}

const CROSS_SIGNAL_LABELS: Record<string, string> = {
  golden_cross_recente: "Cruzamento dourado recente",
  death_cross_recente: "Cruzamento da morte recente",
  acima_sma200: "Tendência de alta (longo prazo)",
  abaixo_sma200: "Tendência de baixa (longo prazo)",
};

function TechnicalBadge({ technical }: { technical: AssetAnalysis["technical"] }) {
  if (!technical) return null;

  const parts: string[] = [];
  if (technical.rsi14 != null) {
    const label = technical.rsi14 >= 70 ? "sobrecomprado" : technical.rsi14 <= 30 ? "sobrevendido" : "neutro";
    parts.push(`RSI ${technical.rsi14.toFixed(0)} (${label})`);
  }
  if (technical.crossSignal) {
    parts.push(CROSS_SIGNAL_LABELS[technical.crossSignal] ?? technical.crossSignal);
  }
  if (parts.length === 0) return null;

  const isCaution = technical.crossSignal === "death_cross_recente" || technical.crossSignal === "abaixo_sma200" || (technical.rsi14 != null && technical.rsi14 >= 70);
  const isFavorable = technical.crossSignal === "golden_cross_recente" || technical.crossSignal === "acima_sma200" || (technical.rsi14 != null && technical.rsi14 <= 30);
  const colorClass = isCaution
    ? "bg-amber-500/10 border-amber-500/20 text-amber-700 dark:text-amber-400"
    : isFavorable
    ? "bg-green-500/10 border-green-500/20 text-green-700 dark:text-green-400"
    : "bg-muted/40 border-border/50 text-muted-foreground";

  return (
    <div className={`flex flex-wrap items-center gap-2 text-xs px-3 py-2 rounded-md border mb-3 ${colorClass}`}>
      <LineChart className="w-3.5 h-3.5 shrink-0" />
      <span className="font-medium">{parts.join(" · ")}</span>
      <span className="text-[10px] opacity-70 sm:ml-auto">indicador técnico, 1 ano de candles reais</span>
    </div>
  );
}

function DividendFrequencyBadge({ dividendFrequency }: { dividendFrequency: AssetAnalysis["dividendFrequency"] }) {
  if (!dividendFrequency) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs px-3 py-2 rounded-md border mb-3 bg-muted/40 border-border/50 text-muted-foreground">
      <CalendarClock className="w-3.5 h-3.5 shrink-0" />
      <span className="font-medium text-foreground">Paga {dividendFrequency.toLowerCase()}</span>
      <span className="text-[10px] opacity-70 sm:ml-auto">a partir do histórico real dos últimos 12 meses</span>
    </div>
  );
}

const STATUS_MAP: Record<string, { color: string, label: string }> = {
  MANTER: { color: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20", label: "Manter" },
  ATENCAO: { color: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20", label: "Atenção" },
  REAVALIAR: { color: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20", label: "Reavaliar" },
  POSSIVEL_SAIDA: { color: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20", label: "Possível Saída" }
};

export default function Analise() {
  const { data: analyses, isLoading } = useListAssetAnalyses({ query: { queryKey: getListAssetAnalysesQueryKey() } });
  const generateAnalysis = useGeneratePortfolioAnalysis();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleGenerate = () => {
    generateAnalysis.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAssetAnalysesQueryKey() });
        toast({ title: "Análise gerada com sucesso." });
      },
      onError: () => {
        toast({ title: "Erro ao gerar análise.", variant: "destructive" });
      }
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-bold tracking-tight">Análise de Ativos</h1>
          <p className="text-muted-foreground">Avaliação fundamentalista por regras, com base em dados reais de mercado.</p>
        </div>
        
        <Button onClick={handleGenerate} disabled={generateAnalysis.isPending} className="gap-2">
          <BrainCircuit className={`w-4 h-4 ${generateAnalysis.isPending ? 'animate-pulse' : ''}`} />
          {generateAnalysis.isPending ? 'Processando...' : 'Gerar Nova Análise'}
        </Button>
      </div>

      <div className="grid gap-4">
        {isLoading ? (
          <div className="space-y-4">
            <Card className="animate-pulse h-32 bg-muted/20" />
            <Card className="animate-pulse h-32 bg-muted/20" />
          </div>
        ) : analyses?.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center p-12 text-center text-muted-foreground">
              <Activity className="w-12 h-12 mb-4 opacity-20" />
              <p className="text-lg font-medium">Nenhuma análise disponível</p>
              <p className="text-sm mb-4">Adicione ativos à sua carteira e gere uma análise.</p>
              <Button variant="outline" onClick={handleGenerate}>Gerar Agora</Button>
            </CardContent>
          </Card>
        ) : (
          analyses?.map((analysis) => {
            if (!analysis.available) {
              return (
                <Card key={analysis.ticker} className="overflow-hidden">
                  <div className="p-6 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                      <div className="w-16 h-16 rounded-lg bg-muted flex items-center justify-center">
                        <Clock className="w-6 h-6 text-muted-foreground" />
                      </div>
                      <div>
                        <h3 className="text-xl font-bold font-mono">{analysis.ticker}</h3>
                        <p className="text-sm text-muted-foreground mt-1 max-w-md text-pretty text-justify hyphens-auto">{analysis.monitoringRecommendation}</p>
                      </div>
                    </div>
                    <Badge variant="outline">Em breve</Badge>
                  </div>
                  {analysis.newsItems.length > 0 && (
                    <div className="px-6 pb-6">
                      <h4 className="flex items-center gap-2 font-semibold mb-2 text-xs uppercase tracking-wider text-muted-foreground">
                        <Newspaper className="w-3 h-3" /> Radar de Notícias
                      </h4>
                      <ul className="space-y-1">
                        {analysis.newsItems.map((n, i) => (
                          <li key={i} className="text-xs text-muted-foreground break-words">- {n}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </Card>
              );
            }

            const isExpanded = expandedId === analysis.ticker;
            const statusConfig = STATUS_MAP[analysis.status] || STATUS_MAP.MANTER;

            return (
              <Card 
                key={analysis.ticker} 
                className={`overflow-hidden transition-all duration-200 cursor-pointer ${isExpanded ? 'ring-2 ring-primary border-primary' : 'hover:border-primary/50'}`}
                onClick={() => setExpandedId(isExpanded ? null : analysis.ticker)}
              >
                <div className="p-6">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                      <div className="w-16 h-16 rounded-lg bg-muted flex items-center justify-center font-bold text-xl font-mono">
                        {analysis.score}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-xl font-bold font-mono">{analysis.ticker}</h3>
                          <Badge variant="outline" className={`border ${statusConfig.color}`}>
                            {statusConfig.label}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground mt-1">
                          Classificação: <span className="font-medium text-foreground">{analysis.scoreClassification}</span>
                        </p>
                      </div>
                    </div>
                    
                    <div className="w-full md:w-64 space-y-1.5">
                      <div className="flex justify-between text-xs font-medium">
                        <span>Score Quality</span>
                        <span>{analysis.score}/100</span>
                      </div>
                      <Progress value={analysis.score} className="h-2" />
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="mt-8 pt-6 border-t grid grid-cols-1 md:grid-cols-2 gap-8 animate-in fade-in slide-in-from-top-4">
                      <div className="space-y-6">
                        <div>
                          <h4 className="flex items-center gap-2 font-semibold mb-3 text-sm uppercase tracking-wider text-muted-foreground">
                            <Check className="w-4 h-4 text-green-500" /> Pontos Positivos
                          </h4>
                          <ul className="space-y-2">
                            {analysis.positives.map((p, i) => (
                              <li key={i} className="text-sm flex gap-2">
                                <span className="text-primary mt-0.5">•</span>
                                <span>{p}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                        
                        <div>
                          <h4 className="flex items-center gap-2 font-semibold mb-3 text-sm uppercase tracking-wider text-muted-foreground">
                            <AlertTriangle className="w-4 h-4 text-destructive" /> Fatores de Risco
                          </h4>
                          <ul className="space-y-2">
                            {analysis.risks.map((r, i) => (
                              <li key={i} className="text-sm flex gap-2 text-muted-foreground">
                                <span className="text-destructive mt-0.5">•</span>
                                <span>{r}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>

                      <div className="space-y-6">
                        <div className="max-w-prose text-sm">
                          <h4 className="flex items-center gap-2 font-semibold mb-3 text-sm uppercase tracking-wider text-muted-foreground">
                            <Activity className="w-4 h-4" /> Recomendação Tática
                          </h4>
                          <TaxBadge tax={analysis.taxEstimate} />
                          <TechnicalBadge technical={analysis.technical} />
                          <DividendFrequencyBadge dividendFrequency={analysis.dividendFrequency} />
                          <div className="bg-muted/50 p-4 rounded-md text-sm leading-relaxed text-pretty text-justify hyphens-auto border border-border/50">
                            {analysis.monitoringRecommendation}
                          </div>
                        </div>

                        {(analysis.newsItems.length > 0 || analysis.alerts.length > 0) && (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            {analysis.newsItems.length > 0 && (
                              <div>
                                <h4 className="flex items-center gap-2 font-semibold mb-2 text-xs uppercase tracking-wider text-muted-foreground">
                                  <Newspaper className="w-3 h-3" /> Radar de Notícias
                                </h4>
                                <ul className="space-y-1">
                                  {analysis.newsItems.slice(0,2).map((n, i) => (
                                    <li key={i} className="text-xs break-words">- {n}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {analysis.alerts.length > 0 && (
                              <div>
                                <h4 className="flex items-center gap-2 font-semibold mb-2 text-xs uppercase tracking-wider text-muted-foreground">
                                  <Bell className="w-3 h-3" /> Alertas Ativos
                                </h4>
                                <ul className="space-y-1">
                                  {analysis.alerts.slice(0,2).map((a, i) => (
                                    <li key={i} className="text-xs text-orange-600 dark:text-orange-400 break-words">- {a}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
