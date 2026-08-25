-- analyses: coluna `confidence` — o portão de dado insuficiente (AGUARDAR).
--
-- Rodar UMA vez no Supabase (SQL Editor) antes de subir o código. Idempotente e sem
-- backfill: a coluna nasce nula e cada análise passa a gravá-la ao ser regerada.
--
-- ## O que a coluna guarda
--
-- JSON de DataConfidence (artifacts/api-server/src/lib/data-confidence-engine.ts): o
-- nível (`suficiente` / `parcial` / `insuficiente`) e a lista de lacunas encontradas no
-- dado que sustenta aquela linha — cotação ausente ou datada, poucos indicadores.
--
-- É gravado junto com a análise, e não recalculado na leitura, porque o `status` que já
-- está na linha foi decidido com ele. Recalcular depois poderia mostrar uma justificativa
-- diferente da que produziu o status, que é a forma mais confusa possível de exibir as
-- duas coisas lado a lado.
--
-- ## Por que nula é seguro
--
-- Linha gravada antes desta coluna existir não tem lacuna registrada, e o leitor trata
-- isso como `suficiente`. É a escolha certa: a ausência aqui é falta de REGISTRO, não
-- falta de dado. Tratar como insuficiente jogaria toda análise antiga para AGUARDAR na
-- primeira leitura depois do deploy — um alerta em massa sobre nada.
--
-- O status `AGUARDAR` também passa a ser gravado na coluna `status`, que já é text e não
-- tem constraint de enum, então não precisa de alteração.

ALTER TABLE public.analyses
  ADD COLUMN IF NOT EXISTS confidence text;

-- Conferência: a coluna existe e nenhuma linha existente foi tocada.
SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name = 'analyses' AND column_name = 'confidence') AS coluna_criada,
  (SELECT count(*) FROM public.analyses) AS linhas,
  (SELECT count(*) FROM public.analyses WHERE confidence IS NULL) AS sem_registro;
