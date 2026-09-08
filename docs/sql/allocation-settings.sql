-- allocation_settings: a banda de tolerância do rebalanceamento.
--
-- Rodar UMA vez no Supabase, ANTES ou DEPOIS do deploy — tanto faz. É aditivo e sem
-- risco: nenhuma tabela existente muda, e o código trata ausência de linha como "nunca
-- configurou", caindo no padrão declarado de 5 p.p. em allocation-engine.ts.
--
-- ## O que a banda resolve
--
-- O alvo sozinho não decide nada. Uma classe a 52% contra alvo de 50% está fora do alvo
-- pela aritmética e dentro do ruído pela prática — e o app tratava as duas situações
-- igual, sugerindo aporte para desvio de 0,06 p.p. Chamado que aparece sempre deixa de
-- ser lido.
--
-- ## Por que tabela nova, e não coluna em allocation_policies
--
-- Aquela é uma linha por CLASSE por usuário. A banda é uma só para a carteira inteira,
-- então repeti-la em seis linhas seria modelagem que convida à divergência: bastaria uma
-- atualização parcial para o mesmo usuário ter duas bandas.

CREATE TABLE IF NOT EXISTS public.allocation_settings (
  user_id    integer PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  band_pp    numeric(5,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Conferência: a tabela existe e está vazia (ninguém configurou ainda).
SELECT count(*) AS linhas FROM public.allocation_settings;
