-- allocation_settings: a banda de tolerância do rebalanceamento.
--
-- Rodar UMA vez no Supabase, **antes do deploy**. É aditivo e sem risco — nenhuma tabela
-- existente muda —, mas a ordem importa: `allocationOverview` faz SELECT nesta tabela em
-- toda chamada de GET /portfolio/allocation, então subir o código antes derrubaria Saúde
-- do Portfólio e o veredito da Visão Geral com erro de relação inexistente.
--
-- O que é opcional é a LINHA, não a tabela: ausência de linha significa "nunca
-- configurou" e cai no padrão declarado de 5 p.p. em allocation-engine.ts.
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

-- ## Sobre os limites da coluna
--
-- `numeric(5,2)` aceita até 999,99, folgado acima do teto de 50 p.p. que a rota valida.
-- A trava fica na rota, e não num CHECK, porque o teto é decisão de produto ("acima disso
-- a banda deixa de recusar qualquer carteira concebível") e não invariante do dado —
-- mudá-lo não deveria exigir migração. O que a coluna garante é o que é estrutural:
-- não-nulo, e apagado junto com o usuário.

BEGIN;

CREATE TABLE IF NOT EXISTS public.allocation_settings (
  user_id    integer PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  band_pp    numeric(5,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Conferência. Esperado: uma linha, com `ok` em todas as colunas e 0 registros.
--
-- Não basta "rodou sem erro": com `IF NOT EXISTS`, um CREATE que não fez nada porque a
-- tabela já existia com OUTRA forma também não daria erro. Por isso a checagem olha as
-- colunas, e não a existência.

SELECT
  CASE WHEN to_regclass('public.allocation_settings') IS NOT NULL
       THEN 'ok' ELSE 'FALTA A TABELA' END                                  AS tabela,
  CASE WHEN (SELECT count(*) FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'allocation_settings'
               AND column_name IN ('user_id','band_pp','created_at','updated_at')) = 4
       THEN 'ok' ELSE 'COLUNAS DIVERGENTES' END                             AS colunas,
  CASE WHEN (SELECT data_type FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'allocation_settings'
               AND column_name = 'band_pp') = 'numeric'
       THEN 'ok' ELSE 'TIPO DE band_pp DIVERGENTE' END                      AS tipo_band_pp,
  CASE WHEN EXISTS (SELECT 1 FROM information_schema.table_constraints
                    WHERE table_schema = 'public' AND table_name = 'allocation_settings'
                      AND constraint_type = 'FOREIGN KEY')
       THEN 'ok' ELSE 'SEM FK PARA users' END                               AS fk_users,
  (SELECT count(*) FROM public.allocation_settings)                         AS linhas;
