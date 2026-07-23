import { 
  useListAlerts, 
  useMarkAlertRead, 
  useDeleteAlert,
  getListAlertsQueryKey 
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
  Newspaper
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

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
};

export default function Radar() {
  const { data: alerts, isLoading } = useListAlerts({ query: { queryKey: getListAlertsQueryKey() } });
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
                  <div className="flex-1 space-y-1">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        {alert.ticker && (
                          <Badge variant="outline" className="font-mono bg-background">
                            {alert.ticker}
                          </Badge>
                        )}
                        <h3 className={`font-semibold ${!alert.isRead ? '' : 'text-muted-foreground'}`}>
                          {alert.title}
                        </h3>
                        <Badge variant={config.badge as any} className="text-[10px] uppercase tracking-wider h-5">
                          {alert.severity}
                        </Badge>
                      </div>
                      <div className="flex gap-2">
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
