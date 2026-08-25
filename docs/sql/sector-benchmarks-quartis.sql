-- sector_benchmarks: quartis de P/L e P/VP — o que dá FAIXA em vez de ponto.
--
-- Rodar UMA vez no Supabase (SQL Editor). Aditivo e idempotente: as colunas nascem nulas
-- e não há backfill possível nem necessário — os quartis são subproduto da varredura
-- semanal, que já busca os fundamentos do universo inteiro e agora calcula os percentis
-- de graça, sem chamada nova a provedor nenhum.
--
-- ## Por que a mediana sozinha não bastava
--
-- A mediana responde "caro ou barato contra os pares", que é comparação. Faixa de entrada
-- em reais é outra pergunta, e precisa de DISPERSÃO: a faixa é justamente o intervalo
-- entre "preço de pechincha para este setor" (múltiplo do p25) e "preço normal para este
-- setor" (múltiplo da mediana). Com um valor central só dá para produzir um ponto, e
-- ponto único afirma uma precisão que não existe.
--
-- ## Enquanto estiverem nulas
--
-- As faixas de entrada de ação simplesmente não saem — `computeStockPriceZones` devolve
-- null sem os quartis. É o comportamento certo: preencher as duas pontas com a mediana
-- produziria um "intervalo" de largura zero com cara de faixa medida.
--
-- Nota sobre os nomes: as colunas existentes se chamam `avg_*` por compatibilidade, mas
-- guardam a MEDIANA desde a correção anterior (uma média era distorcida por um único
-- extremo — o MFII11 com DY de 38% num grupo de 4 fundos). As novas se chamam `p25_*` e
-- `p75_*`, que é o que de fato são.

ALTER TABLE public.sector_benchmarks
  ADD COLUMN IF NOT EXISTS p25_price_earnings numeric(10,4),
  ADD COLUMN IF NOT EXISTS p75_price_earnings numeric(10,4),
  ADD COLUMN IF NOT EXISTS p25_price_to_book  numeric(10,4),
  ADD COLUMN IF NOT EXISTS p75_price_to_book  numeric(10,4);

-- Conferência: 4 colunas novas, nenhuma linha existente tocada.
SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name = 'sector_benchmarks'
      AND column_name IN ('p25_price_earnings','p75_price_earnings',
                          'p25_price_to_book','p75_price_to_book')) AS colunas_novas,
  (SELECT count(*) FROM public.sector_benchmarks) AS setores;

-- As colunas se preenchem sozinhas na próxima varredura semanal de oportunidades
-- (job `regenerate-opportunities`). Para antecipar, apague o registro dele em job_runs DEPOIS
-- do deploy — o job dispara ~30s após o boot seguinte:
--
--   DELETE FROM public.job_runs WHERE job_name = 'regenerate-opportunities';
