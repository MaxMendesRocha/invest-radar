import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Wallet,
  // Radar segue sendo o símbolo da MARCA (o logo "InvestRadar"). Ele saiu do item
  // "Radar Inteligente" justamente para parar de disputar leitura com a navegação —
  // agora aparece uma vez só, e quer dizer o produto.
  Radar,
  Compass,
  BellRing,
  Gauge,
  FileSearch,
  Telescope,
  Coins,
  Receipt,
  ShieldCheck,
  Settings as SettingsIcon,
  LogOut,
  Menu,
  MoreHorizontal
} from "lucide-react";
import { useGetMe, useLogout, getGetMeQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";

/**
 * O ícone mostra o que a tela ENTREGA — não faz trocadilho com o nome dela. O rótulo
 * já está escrito ao lado; o ícone precisa acrescentar informação, não repetir a
 * palavra. E dois itens do mesmo menu não podem dividir a mesma família de metáfora,
 * porque a 20px da barra inferior só resta a silhueta.
 *
 * O que isso corrigiu:
 *  - Radar e Activity eram os dois "sinal" (arcos concêntricos e linha de pulso), e
 *    apareciam LADO A LADO na barra do mobile. Era a única colisão visível de uma vez.
 *  - Coins e Banknote eram os dois "dinheiro", sem nada indicando qual era qual.
 *  - Search para Parecer descrevia como se CHEGA à tela, não o que ela produz.
 *  - Stethoscope para Saúde e Lightbulb para Oportunidades eram trocadilho e clichê:
 *    o primeiro ecoava a palavra "saúde", o segundo dizia "tive uma ideia" para uma
 *    varredura com triagem.
 */
const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/carteira", label: "Minha Carteira", icon: Wallet },
  // Compass e não uma carteira: o ícone diz "por onde começar", que é o que a tela
  // entrega. Repetir a metáfora de carteira do item acima só duplicaria a silhueta.
  { href: "/carteira-de-partida", label: "Carteira de Partida", icon: Compass },
  { href: "/radar", label: "Radar Inteligente", icon: BellRing },
  { href: "/analise", label: "Análise de Ativos", icon: Gauge },
  { href: "/parecer", label: "Parecer de Ativo", icon: FileSearch },
  { href: "/oportunidades", label: "Oportunidades", icon: Telescope },
  { href: "/dividendos", label: "Dividendos", icon: Coins },
  { href: "/vendas", label: "Operações Encerradas", icon: Receipt },
  { href: "/saude", label: "Saúde do Portfólio", icon: ShieldCheck },
];

// Most-used sections get one-thumb access on mobile; the rest ficam no drawer,
// alcançável pelo botão "Mais" da própria barra inferior (ver MobileBottomNav) —
// sem depender do hambúrguer do topo, que rola pra fora da tela junto com a página.
const MOBILE_TAB_ITEMS = [
  { href: "/", label: "Início", icon: LayoutDashboard },
  { href: "/carteira", label: "Carteira", icon: Wallet },
  { href: "/radar", label: "Radar", icon: BellRing },
  { href: "/analise", label: "Análise", icon: Gauge },
];

function MobileBottomNav({ onOpenMenu }: { onOpenMenu: () => void }) {
  const [location] = useLocation();
  // Numa seção sem aba própria (Carteira de Partida, Oportunidades, Parecer, Dividendos,
  // Operações Encerradas, Saúde, Configurações) nenhum dos 4 links acenderia e o usuário
  // ficaria sem referência de onde está — nesse caso "Mais" fica destacado.
  const isOnDrawerSection = !MOBILE_TAB_ITEMS.some((item) => item.href === location);

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-sidebar text-sidebar-foreground border-t border-sidebar-border pb-[env(safe-area-inset-bottom)]">
      <div className="flex items-stretch h-14">
        {MOBILE_TAB_ITEMS.map((item) => {
          const isActive = location === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex-1 flex flex-col items-center justify-center gap-1 transition-colors ${
                isActive
                  ? "text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/60 hover:text-sidebar-foreground"
              }`}
            >
              {/* Cápsula atrás do ícone ativo. Aqui ela faz mais falta que na lateral:
                  a barra inferior não tem realce de linha, então a única marca de
                  "você está aqui" era a cor do traço — diferença fraca a 20px e para
                  quem enxerga cor de forma atípica. A pílula acrescenta forma. */}
              <span
                className={`flex h-7 w-12 items-center justify-center rounded-full transition-colors ${
                  isActive ? "bg-sidebar-accent" : "bg-transparent"
                }`}
              >
                <item.icon className="w-5 h-5" />
              </span>
              <span className="text-[10px] leading-none">{item.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={onOpenMenu}
          aria-label="Abrir menu"
          className={`flex-1 flex flex-col items-center justify-center gap-1 transition-colors ${
            isOnDrawerSection
              ? "text-sidebar-accent-foreground"
              : "text-sidebar-foreground/60 hover:text-sidebar-foreground"
          }`}
        >
          <span
            className={`flex h-7 w-12 items-center justify-center rounded-full transition-colors ${
              isOnDrawerSection ? "bg-sidebar-accent" : "bg-transparent"
            }`}
          >
            <MoreHorizontal className="w-5 h-5" />
          </span>
          <span className="text-[10px] leading-none">Mais</span>
        </button>
      </div>
    </nav>
  );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const [location, setLocation] = useLocation();
  const { data: user } = useGetMe();
  const logout = useLogout();
  const queryClient = useQueryClient();

  /**
   * No mobile este componente vive dentro da gaveta, e o clique em "Sair" fecha a
   * gaveta — desmontando o próprio componente antes de a resposta do servidor chegar.
   * Callbacks passados para `mutate(vars, { onSuccess })` não são chamados quando o
   * componente desmonta antes de a mutation resolver, então o POST saía, o servidor
   * destruía a sessão e a tela continuava exatamente a mesma até o usuário dar F5.
   * No desktop nada disso aparecia: a sidebar não desmonta, e localmente a resposta
   * volta rápido demais para perder a corrida — só com a latência real do Railway o
   * desmonte chegava primeiro.
   *
   * Await em mutateAsync mantém a continuação na nossa própria promise, que não
   * depende do componente continuar montado.
   */
  const handleLogout = async () => {
    try {
      await logout.mutateAsync();
    } catch {
      // Falha de rede não deve prender o usuário na área autenticada: sair da tela é
      // o caminho seguro, e o AuthGuard revalida a sessão do outro lado.
    } finally {
      queryClient.removeQueries({ queryKey: getGetMeQueryKey() });
      setLocation("/login");
    }
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
              className={`flex items-center gap-2.5 px-2 py-1.5 rounded-md transition-colors ${
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                  : "hover:bg-sidebar-accent/50 text-sidebar-foreground/80 hover:text-sidebar-foreground"
              }`}
            >
              {/* Na lateral a linha inteira já acende, então a cápsula entra discreta:
                  só dá ao ícone um plano próprio, em vez de duplicar o realce. */}
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors ${
                  isActive ? "bg-sidebar-primary/15" : "bg-transparent"
                }`}
              >
                <item.icon className="w-4 h-4" />
              </span>
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

      <MobileBottomNav onOpenMenu={() => setMobileNavOpen(true)} />
    </div>
  );
}
