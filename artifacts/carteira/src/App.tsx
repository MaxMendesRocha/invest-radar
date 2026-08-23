import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter } from 'wouter';

import { AuthGuard } from '@/components/auth-guard';
import AppLayout from '@/components/layout/app-layout';

// Pages
import Login from '@/pages/login';
import Register from '@/pages/register';
import Dashboard from '@/pages/dashboard';
import Carteira from '@/pages/carteira';
import CarteiraDePartida from '@/pages/carteira-de-partida';
import Radar from '@/pages/radar';
import Analise from '@/pages/analise';
import Parecer from '@/pages/parecer';
import Oportunidades from '@/pages/oportunidades';
import Dividendos from '@/pages/dividendos';
import Vendas from '@/pages/vendas';
import Saude from '@/pages/saude';
import Settings from '@/pages/settings';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function ProtectedRoutes() {
  return (
    <AuthGuard>
      <AppLayout>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/carteira" component={Carteira} />
          <Route path="/carteira-de-partida" component={CarteiraDePartida} />
          <Route path="/radar" component={Radar} />
          <Route path="/analise" component={Analise} />
          <Route path="/parecer" component={Parecer} />
          <Route path="/oportunidades" component={Oportunidades} />
          <Route path="/dividendos" component={Dividendos} />
          <Route path="/vendas" component={Vendas} />
          <Route path="/saude" component={Saude} />
          <Route path="/settings" component={Settings} />
          <Route component={NotFound} />
        </Switch>
      </AppLayout>
    </AuthGuard>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
      <Route component={ProtectedRoutes} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
