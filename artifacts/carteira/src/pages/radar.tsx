import {
  useListAlerts,
  useMarkAlertRead,
  useDeleteAlert,
  getListAlertsQueryKey,
  useGetMacroSnapshot,
  getGetMacroSnapshotQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle,
  AlertCircle,
  Info,
  CheckCircle2,
  Trash2,
  BellRing,
  TrendingDown,
  TrendingUp,
  Minus,
  Newspaper,
  Landmark,
  PieChart,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const SELIC_TREND_ICON: Record<string, any> = { alta: TrendingUp, queda: TrendingDown, estavel: Minus };

const SEVERITY_CONFIG = {
  Critico: { color: "text-destructive border-destructive/20 bg-destructive/5", icon: AlertTriangle, badge: "destructive" },
  Alto: { color: "text-orange-600 dark:text-orange-500 border-orange-500/20 bg-orange-500/5", icon: AlertCircle, badge: "secondary" },
  Medio: { color: "text-blue-600 dark:text-blue-500 border-blue-500/20 bg-blue-500/5", icon: Info, badge: "outline" },
  Baixo: { color: "text-muted-foreground border-border bg-muted/50", icon: CheckCircle2, badge: "outline" },
};

const TYPE_ICONS: Record<string, any> = {
  preco: TrendingDown,
  fundamentos: AlertCircle,
  noticias: Newspaper,
  dividendos: BellRing,
  concentracao: PieChart,
};

export default function Radar() {
  const { data: alerts, isLoading } = useListAlerts({ query: { queryKey: getListAlertsQueryKey() } });
  const { data: macro, isLoading: isLoadingMacro } = useGetMacroSnapshot({ query: { queryKey: getGetMacroSnapshotQueryKey() } });
  const markRead = useMarkAlertRead();
  const deleteAlert = useDeleteAlert();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleMarkRead = (id: number) => {
    markRead.mutate({ id }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListAlertsQueryKey() })
    });
  };

  const handleDelete = (id: number) => {
    deleteAlert.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAlertsQueryKey() });
        toast({ title: "Alerta removido." });
      }
    });
  };

  const unreadCount = alerts?.filter(a => !a.isRead).length || 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight">Radar Inteligente</h1>
          {unreadCount > 0 && (
            <Badge variant="destructive" className="rounded-full px-2 py-0.5">
              {unreadCount} novos
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground">Monitoramento ativo de riscos e eventos do seu portfólio.</p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Landmark className="w-4 h-4" /> Cenário Macroeconômico
          </CardTitle>
          <CardDescription>Indicadores oficiais do Banco Central (SGS), atualizados periodicamente.</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoadingMacro ? (
            <div className="h-12 bg-muted/20 animate-pulse rounded" />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <p className="text-xs uppercase text-muted-foreground tracking-wider mb-1">Selic</p>
                <div className="flex items-center gap-2">
                  <span className="text-xl font-bold font-mono">
                    {macro?.selic != null ? `${macro.selic.toFixed(2)}%` : "-"}
                  </span>
                  {macro?.selicTrend && (() => {
                    const TrendIcon = SELIC_TREND_ICON[macro.selicTrend] ?? Minus;
                    return <TrendIcon className="w-4 h-4 text-muted-foreground" />;
                  })()}
                </div>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground tracking-wider mb-1">IPCA (12 meses)</p>
                <span className="text-xl font-bold font-mono">
                  {macro?.ipca12m != null ? `${macro.ipca12m.toFixed(2)}%` : "-"}
                </span>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground tracking-wider mb-1">Dólar (PTAX)</p>
                <span className="text-xl font-bold font-mono">
                  {macro?.usdBrl != null ? `R$ ${macro.usdBrl.toFixed(4)}` : "-"}
                </span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4">
        {isLoading ? (
          Array(3).fill(0).map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6 h-24 bg-muted/20" />
            </Card>
          ))
        ) : alerts?.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center p-12 text-center text-muted-foreground">
              <CheckCircle2 className="w-12 h-12 mb-4 opacity-20" />
              <p className="text-lg font-medium">Tudo tranquilo</p>
              <p className="text-sm">Nenhum alerta ativo no seu radar.</p>
            </CardContent>
          </Card>
        ) : (
          alerts?.map((alert) => {
            const config = SEVERITY_CONFIG[alert.severity as keyof typeof SEVERITY_CONFIG] || SEVERITY_CONFIG.Baixo;
            const TypeIcon = TYPE_ICONS[alert.type] || Info;
            const Icon = config.icon;

            return (
              <Card key={alert.id} className={`overflow-hidden transition-colors ${!alert.isRead ? config.color : 'opacity-70'}`}>
                <div className="flex p-4 gap-4">
                  <div className="mt-1">
                    <Icon className="w-5 h-5" />
                  </div>
                  <div className="flex-1 space-y-1 min-w-0">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2 min-w-0">
                        {alert.ticker && (
                          <Badge variant="outline" className="font-mono bg-background shrink-0">
                            {alert.ticker}
                          </Badge>
                        )}
                        <h3 className={`font-semibold break-words ${!alert.isRead ? '' : 'text-muted-foreground'}`}>
                          {alert.title}
                        </h3>
                        <Badge variant={config.badge as any} className="text-[10px] uppercase tracking-wider h-5 shrink-0">
                          {alert.severity}
                        </Badge>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        {!alert.isRead && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleMarkRead(alert.id)}
                            className="h-8 text-xs"
                          >
                            Marcar lido
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(alert.id)}
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                    <p className={`text-sm ${!alert.isRead ? 'text-foreground/90' : 'text-muted-foreground'}`}>
                      {alert.message}
                    </p>
                    <div className="flex items-center gap-2 pt-2 text-xs text-muted-foreground">
                      <TypeIcon className="w-3 h-3" />
                      <span className="capitalize">{alert.type}</span>
                      <span>•</span>
                      <span>{new Date(alert.createdAt).toLocaleString('pt-BR')}</span>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
