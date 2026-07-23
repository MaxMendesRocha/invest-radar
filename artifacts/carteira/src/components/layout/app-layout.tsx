import { Link, useLocation } from "wouter";
import { 
  LayoutDashboard, 
  Wallet, 
  Radar, 
  Activity, 
  Lightbulb, 
  Coins, 
  Stethoscope, 
  Settings as SettingsIcon,
  LogOut
} from "lucide-react";
import { useGetMe, useLogout, getGetMeQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/carteira", label: "Minha Carteira", icon: Wallet },
  { href: "/radar", label: "Radar Inteligente", icon: Radar },
  { href: "/analise", label: "Análise de Ativos", icon: Activity },
  { href: "/oportunidades", label: "Oportunidades", icon: Lightbulb },
  { href: "/dividendos", label: "Dividendos", icon: Coins },
  { href: "/saude", label: "Saúde do Portfólio", icon: Stethoscope },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { data: user } = useGetMe();
  const logout = useLogout();
  const queryClient = useQueryClient();

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        queryClient.removeQueries({ queryKey: getGetMeQueryKey() });
        setLocation("/login");
      }
    });
  };

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row">
      {/* Sidebar */}
      <aside className="w-full md:w-64 bg-sidebar text-sidebar-foreground flex flex-col flex-shrink-0 border-r border-sidebar-border">
        <div className="p-6 flex items-center gap-3">
          <div className="w-8 h-8 bg-primary-foreground text-primary flex items-center justify-center rounded-sm font-bold">
            IR
          </div>
          <span className="font-bold text-lg tracking-tight">InvestRadar</span>
        </div>
        
        <nav className="flex-1 px-4 py-2 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const isActive = location === item.href;
            return (
              <Link 
                key={item.href} 
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-md transition-colors ${
                  isActive 
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" 
                    : "hover:bg-sidebar-accent/50 text-sidebar-foreground/80 hover:text-sidebar-foreground"
                }`}
              >
                <item.icon className="w-4 h-4" />
                <span className="text-sm">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-sidebar-border mt-auto">
          <div className="px-3 py-2 mb-2">
            <div className="text-xs text-sidebar-foreground/50 uppercase tracking-wider font-semibold mb-1">
              Investidor
            </div>
            <div className="text-sm font-medium truncate" title={user?.name}>
              {user?.name}
            </div>
          </div>
          <Link 
            href="/settings"
            className="flex items-center gap-3 px-3 py-2 rounded-md transition-colors hover:bg-sidebar-accent/50 text-sidebar-foreground/80 hover:text-sidebar-foreground w-full text-left"
          >
            <SettingsIcon className="w-4 h-4" />
            <span className="text-sm">Configurações</span>
          </Link>
          <button 
            onClick={handleLogout}
            className="flex items-center gap-3 px-3 py-2 mt-1 rounded-md transition-colors hover:bg-destructive/20 text-sidebar-foreground/80 hover:text-destructive w-full text-left"
          >
            <LogOut className="w-4 h-4" />
            <span className="text-sm">Sair</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 md:p-8">
          <div className="max-w-7xl mx-auto w-full">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
