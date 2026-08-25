-- financial_facts: coluna `period_kind` + reconstrução da série.
--
-- Rodar UMA vez no Supabase (SQL Editor) ANTES de subir o código que ingere o ITR. Sem a
-- coluna o insert do sync falha; sem a coluna NA CHAVE, dois terços do dado trimestral
-- seriam descartados em silêncio.
--
-- Idempotente. Ensaiado numa base local com a mesma forma da produção (13 colunas,
-- 57.048 linhas, todas DFP).
--
-- ## Por que a coluna existe
--
-- O informe trimestral publica o MESMO `period_end` duas vezes: uma linha com o trimestre
-- isolado e outra com o acumulado do ano. No 2T de 2025 do Banco do Brasil,
-- `2025-04-01 → 2025-06-30` (R$ 78 mi) e `2025-01-01 → 2025-06-30` (R$ 149 mi) têm o
-- mesmo fim de período. Medido no arquivo de 2025: 1.794 de 2.706 chaves têm mais de um
-- período. A chave antiga não distinguia as duas, então o `ON CONFLICT DO NOTHING`
-- guardaria a que chegasse primeiro — e qual seria dependeria da ordem das linhas no CSV.
-- Medido na ingestão completa: 22.689 linhas perdidas.
--
-- ## Por que a tabela é esvaziada em vez de migrada no lugar
--
-- As linhas que já estão aqui foram ingeridas antes da conferência de escala, e carregam
-- um defeito da fonte que o parser repassava: `ESCALA_MOEDA` às vezes vem errada, e a BRK
-- AMBIENTAL ficou com a receita de 2020 gravada como R$ 2.382.216 **e** como
-- R$ 2.382.216.000 — os mesmos dígitos em duas escalas. O sync novo descarta essas linhas
-- na origem, mas ele só INSERE: as ruins que já estão gravadas continuariam aqui para
-- sempre.
--
-- Esvaziar não custa nada porque nada aqui é original: cada linha é derivada de arquivo
-- público da CVM, e a reconstrução inteira (anual + trimestral) levou de 2min40s a 7min em
-- medições repetidas — a variação é o tempo de resposta do portal, não do processamento.
-- Migrar no lugar deixaria metade da série corrigida e metade não, que é pior do que
-- qualquer uma das duas.

BEGIN;

ALTER TABLE public.financial_facts
  ADD COLUMN IF NOT EXISTS period_kind text;

-- Esvazia para o job reconstruir com a conferência de escala aplicada. É também o que
-- dispensa backfill da coluna nova: não sobra linha para classificar.
--
-- (Se por algum motivo a série precisar ser preservada, troque este TRUNCATE pelo UPDATE
--  comentado abaixo — mas então o defeito de escala descrito acima permanece na história.)
--   UPDATE public.financial_facts
--      SET period_kind = CASE WHEN period_start IS NULL THEN 'saldo' ELSE 'exercicio' END
--    WHERE period_kind IS NULL AND document_type = 'DFP';
TRUNCATE public.financial_facts;

-- Trava: NOT NULL só entra depois de não haver linha sem classificação. Com a tabela
-- vazia é trivialmente verdade; com o UPDATE acima, protege contra linha esquecida.
DO $$
DECLARE orfas integer;
BEGIN
  SELECT count(*) INTO orfas FROM public.financial_facts WHERE period_kind IS NULL;
  IF orfas > 0 THEN
    RAISE EXCEPTION 'ha % linha(s) sem period_kind — classifique antes de seguir', orfas;
  END IF;
END $$;

ALTER TABLE public.financial_facts
  ALTER COLUMN period_kind SET NOT NULL;

-- A troca da constraint tem de ser DROP e ADD, e não um ADD a mais: manter a antiga
-- deixaria a chave estreita valendo, e ela é exatamente a que rejeita o segundo período
-- do mesmo trimestre.
ALTER TABLE public.financial_facts
  DROP CONSTRAINT IF EXISTS financial_facts_periodo_unico;
ALTER TABLE public.financial_facts
  ADD CONSTRAINT financial_facts_periodo_unico
  UNIQUE (cnpj, metric, period_end, period_kind, document_type, version);

COMMIT;

-- Conferência agora: 14 colunas, 0 linhas.
SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name = 'financial_facts') AS colunas,
  (SELECT count(*) FROM public.financial_facts) AS linhas;

-- ===========================================================================
-- SEGUNDA PARTE — rodar SÓ DEPOIS que o código novo estiver no ar.
-- ===========================================================================
--
-- A tabela está vazia e a coluna é NOT NULL, então o código ANTIGO não consegue mais
-- gravar nela: ele insere sem `period_kind` e a inserção é rejeitada. Isso por si só é
-- inofensivo — mas o scheduler carimba `last_run_at` mesmo quando o job FALHA, e o gap é
-- de uma semana. Ou seja: se o job antigo rodar nesta janela, ele falha, marca a hora, e
-- a reconstrução fica esperando sete dias com a série vazia.
--
-- Por isso o comando abaixo está fora da transação e fora da ordem: ele é o gatilho, e
-- disparar o gatilho antes de o código novo subir é justamente o que causa o problema.
--
-- Depois do deploy, rode esta linha. Ela devolve o job ao estado de "nunca rodou" — o
-- scheduler só pula a checagem de `minGapMs` quando NÃO existe registro anterior —, e ele
-- dispara ~30s depois do próximo boot (STARTUP_DELAY_MS), levando de 3 a 7 minutos.
--
--   DELETE FROM public.job_runs WHERE job_name = 'sync-financial-facts';
--
-- Depois que ele rodar, a distribuição esperada é esta — 5 combinações,
-- ~188 mil linhas, nenhuma linha DFP classificada como trimestre:
--
--   DFP | exercicio |  25.364
--   DFP | saldo     |  31.387
--   ITR | acumulado |  30.075
--   ITR | saldo     |  62.071
--   ITR | trimestre |  39.085
--
-- SELECT document_type, period_kind, count(*) FROM public.financial_facts
--  GROUP BY 1, 2 ORDER BY 1, 2;
