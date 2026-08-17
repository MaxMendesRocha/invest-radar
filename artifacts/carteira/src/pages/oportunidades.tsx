import { useMemo, useState } from "react";
import {
  useListOpportunities,
  getListOpportunitiesQueryKey,
  useGetInvestorProfile,
  getGetInvestorProfileQueryKey,
  useGetOpportunitiesNextRefresh,
} from "@workspace/api-client-react";
import { formatCurrency, formatPercent, formatShortDateTime } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { categoryLabel } from "@/lib/categories";
import { Lightbulb, TrendingUp, ShieldAlert, ArrowRight, Target, RefreshCw, AlertTriangle } from "lucide-react";

// Mesmo motivo do card de Indicadores Oficiais: o ponto do formato en-US colide com
// o separador de milhar pt-BR usado no resto do app.
const PP_FORMAT = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

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
  const { data: nextRefresh } = useGetOpportunitiesNextRefresh();

  const allItems = opportunities?.items ?? [];
  const orderedBy = opportunities?.orderedBy;

  // Categorias PRESENTES na varredura atual, na mesma ordem em que aparecem na
  // lista já ranqueada — não uma lista fixa. Uma varredura sem BDR aprovado, por
  // exemplo, não deve oferecer um botão de filtro que sempre daria lista vazia.
  const categories = useMemo(() => {
    const seen = new Set<string>();
    for (const opp of allItems) seen.add(opp.category);
    return Array.from(seen);
  }, [allItems]);

  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const items = categoryFilter ? allItems.filter((opp) => opp.category === categoryFilter) : allItems;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Oportunidades</h1>
        <p className="text-muted-foreground">Ativos rankeados com base em fundamentos, valuation e momento de mercado.</p>
        {!profile ? null : orderedBy === "premio_dividendo" ? (
          // Sem flex: o gap transformaria o <strong> em item separado e afastaria a
          // vírgula seguinte do texto.
          <p className="text-sm text-muted-foreground">
            Ordenado pelo <strong className="font-medium text-foreground">prêmio de dividendo sobre o setor</strong>, porque seu objetivo é renda passiva.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground flex flex-wrap items-center gap-2">
            Priorizado para o seu perfil:
            <Badge variant={CLASSIFICATION_BADGE[profile.classification] ?? "default"}>{profile.classification}</Badge>
          </p>
        )}
        {!profile && (
          <p className="text-sm text-muted-foreground">
            Defina seu perfil de investidor em Configurações para priorizar essa lista pelo seu apetite a risco.
          </p>
        )}
        {opportunities?.dividendPremiumPending && (
          <p className="text-sm text-amber-700 dark:text-amber-500 flex gap-1.5 items-start">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span className="text-pretty">
              A comparação com o setor ainda não está disponível nesta lista — ela é calculada na varredura,
              e a atual é anterior a esse cálculo. Até a próxima atualização a ordem segue o seu perfil de risco.
            </span>
          </p>
        )}
        {nextRefresh?.nextRefreshAt && (
          <p className="text-sm text-muted-foreground flex items-center gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" />
            Próxima atualização da lista: {new Date(nextRefresh.nextRefreshAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" })}
          </p>
        )}
      </div>

      {/* Some com 1 categoria só: filtrar entre uma opção não é filtro, é ruído.
          "Todas" não entra na contagem — ela não é uma categoria, é a ausência de
          filtro. */}
      {categories.length > 1 && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant={categoryFilter === null ? "default" : "outline"}
            onClick={() => setCategoryFilter(null)}
          >
            Todas
          </Button>
          {categories.map((category) => (
            <Button
              key={category}
              type="button"
              size="sm"
              variant={categoryFilter === category ? "default" : "outline"}
              onClick={() => setCategoryFilter(category)}
            >
              {categoryLabel(category)}
            </Button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {isLoading ? (
          Array(6).fill(0).map((_, i) => (
            <Card key={i} className="animate-pulse h-80 bg-muted/20" />
          ))
        ) : items.length === 0 ? (
          <div className="col-span-full py-12 text-center text-muted-foreground">
            <Lightbulb className="w-12 h-12 mx-auto mb-4 opacity-20" />
            {categoryFilter ? (
              <p>Nenhuma oportunidade em {categoryLabel(categoryFilter)} na varredura atual.</p>
            ) : (
              <p>Nenhuma oportunidade detectada no momento.</p>
            )}
          </div>
        ) : (
          items.map((opp, idx) => (
            <Card key={opp.id} className="flex flex-col overflow-hidden border-border/50 hover:border-primary/50 transition-colors relative">
              <div className="absolute top-0 right-0 p-3">
                <div className="w-8 h-8 bg-primary text-primary-foreground rounded-full flex items-center justify-center font-bold text-sm">
                  #{idx + 1}
                </div>
              </div>
              <CardHeader className="pb-4 pr-16">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-2xl font-mono">{opp.ticker}</CardTitle>
                    <Badge variant="outline" className="text-[10px]">{categoryLabel(opp.category)}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground font-medium break-words">{opp.name}</p>
                </div>
              </CardHeader>
              <CardContent className="flex-1 space-y-4">
                <div className="grid grid-cols-3 gap-2 p-3 bg-muted/30 rounded-lg border border-border/50">
                  <div>
                    <p className="text-[10px] uppercase text-muted-foreground tracking-wider mb-1">
                      {opp.priceAsOf ? 'Última cotação' : 'Cotação'}
                    </p>
                    <p className="font-bold font-mono">
                      {opp.currentPrice != null ? formatCurrency(opp.currentPrice) : '-'}
                    </p>
                    {opp.priceAsOf && (
                      <p className="text-[10px] text-amber-700 dark:text-amber-500">{formatShortDateTime(opp.priceAsOf)}</p>
                    )}
                  </div>
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
                  <p className="text-sm font-medium mb-1 leading-relaxed text-pretty text-justify hyphens-auto">{opp.reason}</p>
                  <div className="flex items-center gap-2 text-xs mt-2">
                    <span className="text-muted-foreground">Risco:</span>
                    <Badge variant={RISK_MAP[opp.riskLevel] as any} className="h-5 px-1.5 text-[10px] uppercase">
                      {opp.riskLevel}
                    </Badge>
                    {opp.dividendFrequency && (
                      <span className="text-muted-foreground">· Paga {opp.dividendFrequency.toLowerCase()}</span>
                    )}
                    <span className="text-muted-foreground ml-auto">Horizonte: {opp.horizon}</span>
                  </div>

                  {opp.dividendPremiumPP != null && (
                    <p className="text-xs text-muted-foreground mt-2 text-pretty">
                      {opp.dividendPremiumPP >= 0 ? "+" : "−"}
                      {PP_FORMAT.format(Math.abs(opp.dividendPremiumPP))} p.p. {opp.dividendPremiumPP >= 0 ? "acima" : "abaixo"} da
                      mediana do setor{opp.sector ? ` ${opp.sector}` : ""}
                      {opp.sectorMedianYield != null ? `, que é de ${PP_FORMAT.format(opp.sectorMedianYield)}%` : ""}
                      {opp.sectorSampleSize != null ? ` (${opp.sectorSampleSize} ativos)` : ""}.
                    </p>
                  )}

                  {opp.implausibleYield && (
                    <div className="flex gap-2 items-start text-xs mt-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-2.5">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-500 mt-0.5" />
                      <span className="text-pretty">
                        Yield acima do dobro da mediana do setor. Nessa faixa costuma indicar amortização de cota
                        contada como rendimento, evento não recorrente ou preço em colapso — trate como alerta,
                        não como oportunidade.
                      </span>
                    </div>
                  )}
                </div>
              </CardContent>
              <CardFooter className="pt-0 pb-4 flex gap-4">
                <div className="w-full space-y-2">
                  {opp.positives.slice(0,2).map((p, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                      <ArrowRight className="w-3 h-3 mt-0.5 shrink-0 text-primary" />
                      <span>{p}</span>
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
