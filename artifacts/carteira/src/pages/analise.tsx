import { useState } from "react";
import { 
  useListAssetAnalyses, 
  useGeneratePortfolioAnalysis,
  getListAssetAnalysesQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { BrainCircuit, Check, AlertTriangle, Newspaper, Bell, Activity } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

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
          <p className="text-muted-foreground">Avaliação fundamentalista guiada por inteligência artificial.</p>
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
                        <div>
                          <h4 className="flex items-center gap-2 font-semibold mb-3 text-sm uppercase tracking-wider text-muted-foreground">
                            <Activity className="w-4 h-4" /> Recomendação Tática
                          </h4>
                          <div className="bg-muted/50 p-4 rounded-md text-sm leading-relaxed border border-border/50">
                            {analysis.monitoringRecommendation}
                          </div>
                        </div>

                        {(analysis.newsItems.length > 0 || analysis.alerts.length > 0) && (
                          <div className="grid grid-cols-2 gap-4">
                            {analysis.newsItems.length > 0 && (
                              <div>
                                <h4 className="flex items-center gap-2 font-semibold mb-2 text-xs uppercase tracking-wider text-muted-foreground">
                                  <Newspaper className="w-3 h-3" /> Radar de Notícias
                                </h4>
                                <ul className="space-y-1">
                                  {analysis.newsItems.slice(0,2).map((n, i) => (
                                    <li key={i} className="text-xs truncate" title={n}>- {n}</li>
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
                                    <li key={i} className="text-xs text-orange-600 dark:text-orange-400 truncate" title={a}>- {a}</li>
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
