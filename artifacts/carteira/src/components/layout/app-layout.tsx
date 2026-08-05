import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Wallet,
  Radar,
  Activity,
  Search,
  Lightbulb,
  Coins,
  Banknote,
  Stethoscope,
  Settings as SettingsIcon,
  LogOut,
  Menu
} from "lucide-react";
import { useGetMe, useLogout, getGetMeQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/carteira", label: "Minha Carteira", icon: Wallet },
  { href: "/radar", label: "Radar Inteligente", icon: Radar },
  { href: "/analise", label: "Análise de Ativos", icon: Activity },
  { href: "/parecer", label: "Parecer de Ativo", icon: Search },
  { href: "/oportunidades", label: "Oportunidades", icon: Lightbulb },
  { href: "/dividendos", label: "Dividendos", icon: Coins },
  { href: "/vendas", label: "Operações Encerradas", icon: Banknote },
  { href: "/saude", label: "Saúde do Portfólio", icon: Stethoscope },
];

// Most-used sections get one-thumb access on mobile; the rest stay in the drawer.
const MOBILE_TAB_ITEMS = [
  { href: "/", label: "Início", icon: LayoutDashboard },
  { href: "/carteira", label: "Carteira", icon: Wallet },
  { href: "/radar", label: "Radar", icon: Radar },
  { href: "/analise", label: "Análise", icon: Activity },
  { href: "/oportunidades", label: "Oport.", icon: Lightbulb },
];

function MobileBottomNav() {
  const [location] = useLocation();

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-sidebar text-sidebar-foreground border-t border-sidebar-border pb-[env(safe-area-inset-bottom)]">
      <div className="flex items-stretch h-14">
        {MOBILE_TAB_ITEMS.map((item) => {
          const isActive = location === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors ${
                isActive
                  ? "text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/60 hover:text-sidebar-foreground"
              }`}
            >
              <item.icon className="w-5 h-5" />
              <span className="text-[10px] leading-none">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
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
    <div className="flex flex-col h-full">
      <div className="p-6 flex items-center gap-3">
        <div className="w-8 h-8 bg-primary-foreground text-primary flex items-center justify-center rounded-sm">
          <Radar className="w-5 h-5" />
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
              onClick={onNavigate}
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
          onClick={onNavigate}
          className="flex items-center gap-3 px-3 py-2 rounded-md transition-colors hover:bg-sidebar-accent/50 text-sidebar-foreground/80 hover:text-sidebar-foreground w-full text-left"
        >
          <SettingsIcon className="w-4 h-4" />
          <span className="text-sm">Configurações</span>
        </Link>
        <button
          onClick={() => { handleLogout(); onNavigate?.(); }}
          className="flex items-center gap-3 px-3 py-2 mt-1 rounded-md transition-colors hover:bg-destructive/20 text-sidebar-foreground/80 hover:text-destructive w-full text-left"
        >
          <LogOut className="w-4 h-4" />
          <span className="text-sm">Sair</span>
        </button>
      </div>
    </div>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    // h-screen só a partir de md: no desktop o container precisa de altura fechada pra
    // que a rolagem aconteça DENTRO do conteúdo (overflow-y-auto abaixo) e a sidebar
    // fique parada — com min-h-screen o container crescia com o conteúdo, a rolagem
    // interna nunca era acionada e a sidebar rolava junto, saindo da tela. No mobile
    // mantém min-h-screen de propósito: o header do topo rola junto (padrão de app
    // mobile), já que a navegação principal fica na barra inferior fixa.
    <div className="min-h-screen md:h-screen bg-background flex flex-col md:flex-row">
      {/* Mobile top bar */}
      <header className="md:hidden flex items-center gap-3 px-4 h-14 border-b border-sidebar-border bg-sidebar text-sidebar-foreground flex-shrink-0">
        <Button variant="ghost" size="icon" onClick={() => setMobileNavOpen(true)} aria-label="Abrir menu">
          <Menu className="w-5 h-5" />
        </Button>
        <div className="w-6 h-6 bg-primary-foreground text-primary flex items-center justify-center rounded-sm">
          <Radar className="w-4 h-4" />
        </div>
        <span className="font-bold tracking-tight">InvestRadar</span>
      </header>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="p-0 w-72 bg-sidebar text-sidebar-foreground border-sidebar-border">
          <div className="sr-only">
            <SheetTitle>Menu de navegação</SheetTitle>
            <SheetDescription>Links para as seções do InvestRadar</SheetDescription>
          </div>
          <SidebarNav onNavigate={() => setMobileNavOpen(false)} />
        </SheetContent>
      </Sheet>

      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-64 bg-sidebar text-sidebar-foreground flex-col flex-shrink-0 border-r border-sidebar-border">
        <SidebarNav />
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 pb-20 md:p-8">
          <div className="max-w-7xl mx-auto w-full">
            {children}
          </div>
        </div>
      </main>

      <MobileBottomNav />
    </div>
  );
}
