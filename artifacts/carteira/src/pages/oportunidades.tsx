import {
  useListOpportunities,
  getListOpportunitiesQueryKey,
  useGetInvestorProfile,
  getGetInvestorProfileQueryKey,
} from "@workspace/api-client-react";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Lightbulb, TrendingUp, ShieldAlert, ArrowRight, Target } from "lucide-react";

const RISK_MAP = {
  Baixo: "default",
  Medio: "secondary",
  Alto: "destructive"
};

const CLASSIFICATION_BADGE: Record<string, "default" | "secondary" | "destructive"> = {
  Conservador: "default",
  Moderado: "secondary",
  Arrojado: "destructive",
};

export default function Oportunidades() {
  const { data: opportunities, isLoading } = useListOpportunities({ query: { queryKey: getListOpportunitiesQueryKey() } });
  const { data: profile } = useGetInvestorProfile({ query: { queryKey: getGetInvestorProfileQueryKey(), retry: false } });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Oportunidades</h1>
        <p className="text-muted-foreground">Ativos rankeados com base em fundamentos, valuation e momento de mercado.</p>
        {profile ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            Priorizado para o seu perfil:
            <Badge variant={CLASSIFICATION_BADGE[profile.classification] ?? "default"}>{profile.classification}</Badge>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Defina seu perfil de investidor em Configurações para priorizar essa lista pelo seu apetite a risco.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {isLoading ? (
          Array(6).fill(0).map((_, i) => (
            <Card key={i} className="animate-pulse h-80 bg-muted/20" />
          ))
        ) : opportunities?.length === 0 ? (
          <div className="col-span-full py-12 text-center text-muted-foreground">
            <Lightbulb className="w-12 h-12 mx-auto mb-4 opacity-20" />
            <p>Nenhuma oportunidade detectada no momento.</p>
          </div>
        ) : (
          opportunities?.map((opp, idx) => (
            <Card key={opp.id} className="flex flex-col overflow-hidden border-border/50 hover:border-primary/50 transition-colors relative">
              <div className="absolute top-0 right-0 p-3">
                <div className="w-8 h-8 bg-primary text-primary-foreground rounded-full flex items-center justify-center font-bold text-sm">
                  #{idx + 1}
                </div>
              </div>
              <CardHeader className="pb-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-2xl font-mono">{opp.ticker}</CardTitle>
                      <Badge variant="outline" className="text-[10px]">{opp.category}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground font-medium truncate" title={opp.name}>{opp.name}</p>
                  </div>
                  {opp.currentPrice != null && (
                    <div className="text-right shrink-0">
                      <p className="text-[10px] uppercase text-muted-foreground tracking-wider mb-1">Cotação</p>
                      <p className="font-bold font-mono">{formatCurrency(opp.currentPrice)}</p>
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent className="flex-1 space-y-4">
                <div className="grid grid-cols-2 gap-2 p-3 bg-muted/30 rounded-lg border border-border/50">
                  <div>
                    <p className="text-[10px] uppercase text-muted-foreground tracking-wider mb-1 flex items-center gap-1">
                      <TrendingUp className="w-3 h-3" /> Upside
                    </p>
                    <p className="font-bold text-green-600 dark:text-green-400 font-mono">
                      +{formatPercent(opp.potentialReturn)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase text-muted-foreground tracking-wider mb-1 flex items-center gap-1">
                      <Target className="w-3 h-3" /> Div. Yield
                    </p>
                    <p className="font-bold font-mono">
                      {formatPercent(opp.dividendYield)}
                    </p>
                  </div>
                </div>

                <div>
                  <p className="text-sm font-medium mb-1 line-clamp-2">{opp.reason}</p>
                  <div className="flex items-center gap-2 text-xs mt-2">
                    <span className="text-muted-foreground">Risco:</span>
                    <Badge variant={RISK_MAP[opp.riskLevel] as any} className="h-5 px-1.5 text-[10px] uppercase">
                      {opp.riskLevel}
                    </Badge>
                    <span className="text-muted-foreground ml-auto">Horizonte: {opp.horizon}</span>
                  </div>
                </div>
              </CardContent>
              <CardFooter className="pt-0 pb-4 flex gap-4">
                <div className="w-full space-y-2">
                  {opp.positives.slice(0,2).map((p, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                      <ArrowRight className="w-3 h-3 mt-0.5 shrink-0 text-primary" />
                      <span className="line-clamp-1">{p}</span>
                    </div>
                  ))}
                </div>
              </CardFooter>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
