import {
  useGetPortfolioHealth,
  getGetPortfolioHealthQueryKey,
  useGetPortfolioSummary,
  getGetPortfolioSummaryQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Activity, ShieldCheck, HeartPulse } from "lucide-react";

export default function Saude() {
  const { data: health, isLoading } = useGetPortfolioHealth({ query: { queryKey: getGetPortfolioHealthQueryKey() } });
  const { data: summary, isLoading: isLoadingSummary } = useGetPortfolioSummary({ query: { queryKey: getGetPortfolioSummaryQueryKey() } });
  const hasAssets = (summary?.assetCount ?? 0) > 0;

  const getScoreColor = (score: number) => {
    if (score >= 80) return "text-green-600 dark:text-green-500";
    if (score >= 60) return "text-blue-600 dark:text-blue-500";
    if (score >= 40) return "text-orange-500";
    return "text-destructive";
  };

  const getProgressColorClass = (score: number) => {
    if (score >= 80) return "bg-green-600 dark:bg-green-500";
    if (score >= 60) return "bg-blue-600 dark:bg-blue-500";
    if (score >= 40) return "bg-orange-500";
    return "bg-destructive";
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Saúde do Portfólio</h1>
        <p className="text-muted-foreground">Raio-x estrutural e diagnóstico completo da sua carteira.</p>
      </div>

      {isLoading || isLoadingSummary ? (
        <div className="grid gap-6">
          <Card className="h-64 animate-pulse bg-muted/20" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card className="h-48 animate-pulse bg-muted/20" />
            <Card className="h-48 animate-pulse bg-muted/20" />
          </div>
        </div>
      ) : !health || !hasAssets ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center p-12 text-center text-muted-foreground">
            <HeartPulse className="w-12 h-12 mb-4 opacity-20" />
            <p className="text-lg font-medium">Diagnóstico Indisponível</p>
            <p className="text-sm">Adicione ativos para habilitar a análise de saúde.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6">
          <Card className="border-t-4 border-t-primary">
            <CardContent className="p-8">
              <div className="flex flex-col md:flex-row items-center gap-8 md:gap-16 justify-center">
                <div className="relative flex items-center justify-center">
                  <svg className="w-48 h-48 transform -rotate-90">
                    <circle cx="96" cy="96" r="88" stroke="currentColor" strokeWidth="12" fill="transparent" className="text-muted/20" />
                    <circle 
                      cx="96" cy="96" r="88" stroke="currentColor" strokeWidth="12" fill="transparent"
                      strokeDasharray={2 * Math.PI * 88}
                      strokeDashoffset={2 * Math.PI * 88 * (1 - health.score / 100)}
                      className={getScoreColor(health.score)}
                      strokeLinecap="round"
                    />
                  </svg>
                  <div className="absolute flex flex-col items-center justify-center">
                    <span className={`text-5xl font-bold font-mono ${getScoreColor(health.score)}`}>{health.score}</span>
                    <span className="text-sm uppercase tracking-widest font-semibold text-muted-foreground mt-1">Score</span>
                  </div>
                </div>
                
                <div className="text-center md:text-left space-y-4 max-w-md">
                  <div>
                    <h2 className="text-3xl font-bold tracking-tight mb-2">Classificação: {health.classification}</h2>
                    <p className="text-muted-foreground leading-relaxed text-pretty text-justify hyphens-auto">
                      {health.aiDiagnosis ??
                        "Sua carteira apresenta um perfil estrutural condizente com a classificação obtida. " +
                        "A pontuação geral pondera fatores de risco, diversificação qualitativa e consistência de fluxo de caixa."}
                    </p>
                  </div>
                  <div className="flex items-center justify-center md:justify-start gap-2 text-sm font-medium">
                    <ShieldCheck className="w-4 h-4 text-primary" /> Diagnóstico validado
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Pilares Estruturais</CardTitle>
                <CardDescription>Análise dimensional detalhada.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {[
                  { label: "Diversificação", value: health.diversification },
                  { label: "Gerenciamento de Risco", value: health.risk },
                  { label: "Geração de Renda (Dividendos)", value: health.dividends },
                  { label: "Potencial de Crescimento", value: health.growth },
                ].map((item) => (
                  <div key={item.label} className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="font-medium">{item.label}</span>
                      <span className={`font-mono font-bold ${getScoreColor(item.value)}`}>{item.value}/100</span>
                    </div>
                    {/* Custom progress color via inline style hack or custom class if supported, doing a simple override */}
                    <div className="h-2 w-full bg-secondary overflow-hidden rounded-full">
                      <div className={`h-full ${getProgressColorClass(item.value)} transition-all`} style={{ width: `${item.value}%` }} />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Risco de Concentração</CardTitle>
                <CardDescription>Avaliação de exposição excessiva.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                 <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="font-medium">Saúde da Exposição</span>
                      <span className={`font-mono font-bold ${getScoreColor(health.concentration)}`}>{health.concentration}/100</span>
                    </div>
                    <div className="h-2 w-full bg-secondary overflow-hidden rounded-full">
                      <div className={`h-full ${getProgressColorClass(health.concentration)} transition-all`} style={{ width: `${health.concentration}%` }} />
                    </div>
                  </div>
                  
                  <div className="bg-muted/50 p-4 rounded-lg border border-border/50 text-sm leading-relaxed mt-4">
                    <h4 className="font-semibold mb-2 flex items-center gap-2"><Activity className="w-4 h-4"/> Interpretação</h4>
                    Um score alto indica que seu capital está bem distribuído, mitigando o impacto de quedas bruscas em ativos isolados. 
                    Scores abaixo de 60 indicam alerta de concentração de setor ou ativo.
                  </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
