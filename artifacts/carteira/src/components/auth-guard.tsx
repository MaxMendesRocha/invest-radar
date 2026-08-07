import { useEffect, useRef } from 'react';
import { useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { useGetMe, useLogout, getGetMeQueryKey } from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 30 * 1000;
// Eventos que contam como "usuário ativo" — deliberadamente sem chamada de rede
// nenhuma nessa lista, pra não resetar o timer sozinho a cada poll automático.
const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'] as const;

/** Desloga por inatividade real do usuário (30min sem interação na aba), não por
 * expiração de cookie — reaproveita o mesmo fluxo de logout manual (destrói a sessão
 * no servidor, limpa o cache, redireciona), só que disparado por um timer local em vez
 * de clique no botão "Sair". */
function useIdleLogout(enabled: boolean) {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const logout = useLogout();
  const { toast } = useToast();
  const lastActivityRef = useRef(Date.now());

  useEffect(() => {
    if (!enabled) return;

    const markActive = () => { lastActivityRef.current = Date.now(); };
    ACTIVITY_EVENTS.forEach((event) => window.addEventListener(event, markActive, { passive: true }));

    // mutateAsync em vez de callbacks de mutate pelo mesmo motivo de app-layout.tsx:
    // a continuação fica numa promise nossa, e não depende de o componente seguir
    // montado até a resposta chegar.
    const interval = setInterval(async () => {
      if (Date.now() - lastActivityRef.current < IDLE_TIMEOUT_MS) return;
      try {
        await logout.mutateAsync();
      } catch {
        // Ver app-layout.tsx: falha de rede não deve manter o usuário na área logada.
      } finally {
        queryClient.removeQueries({ queryKey: getGetMeQueryKey() });
        toast({ title: 'Sessão expirada por inatividade.' });
        setLocation('/login');
      }
    }, IDLE_CHECK_INTERVAL_MS);

    return () => {
      ACTIVITY_EVENTS.forEach((event) => window.removeEventListener(event, markActive));
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading, isError } = useGetMe();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && isError) {
      setLocation('/login');
    }
  }, [isLoading, isError, setLocation]);

  useIdleLogout(!isLoading && !isError && !!user);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse space-y-4 flex flex-col items-center">
          <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin"></div>
          <div className="text-sm text-muted-foreground font-mono">CARREGANDO...</div>
        </div>
      </div>
    );
  }

  if (isError || !user) {
    return null; // Will redirect
  }

  return <>{children}</>;
}
