-- financial_facts: apaga o patrimônio líquido para ele ser reconstruído correto.
--
-- Rodar UMA vez no Supabase, **DEPOIS** que o código novo estiver no ar, junto com o
-- gatilho do job (a segunda parte deste arquivo).
--
-- ## Por que apagar, e não deixar o sync corrigir
--
-- O sync só INSERE, com `ON CONFLICT DO NOTHING`. A linha errada já está gravada com a
-- mesma chave única (cnpj, metric, period_end, period_kind, document_type, version), então
-- o valor certo simplesmente não entra — medido: um sync completo depois da correção
-- gravou **0 fatos novos**. Sem o DELETE, a correção não tem efeito nenhum.
--
-- ## O que estava errado
--
-- O balanço patrimonial passivo de instituição financeira usa outro plano de contas. O
-- código `2.03`, que numa companhia comum é "Patrimônio Líquido Consolidado", vira outra
-- conta no banco:
--
--   Banco do Brasil   2.03 = Provisões                                (R$ 39 bi)
--                     2.07 = Patrimônio Líquido Consolidado           (R$ 194 bi)
--   Itaú Unibanco     2.03 = Passivos Financeiros ao Custo Amortizado (R$ 2.351 bi)
--                     2.08 = Patrimônio Líquido Consolidado           (R$ 215 bi)
--
-- Ou seja, o Itaú tinha um PASSIVO de R$ 2,3 trilhões gravado como patrimônio líquido —
-- dez vezes o valor certo e de outra natureza. Qualquer ROE ou alavancagem calculado sobre
-- isso seria ficção com cara de medição.
--
-- A correção passou a buscar pelo RÓTULO, como já se faz com o lucro líquido. Medido no
-- BPP consolidado de 2025, "Patrimônio Líquido Consolidado" aparece em 438 de 438
-- companhias; o código 2.03 cobriria 428 (97,7%).
--
-- ## Por que só esta métrica
--
-- As outras oito não têm o problema: `ativo_total` (código `1`) é "Ativo Total" em 441 de
-- 441 linhas, e `receita` (`3.01`) tem 100% de cobertura — nela muda só o RÓTULO
-- ("Receitas de Intermediação Financeira" no banco), que é o conceito certo, não defeito.
-- Um TRUNCATE da tabela inteira custaria uma reconstrução de 3 a 7 minutos sem necessidade.
--
-- ## Impacto enquanto estiver vazia
--
-- Nenhum: até esta correção, `patrimonio_liquido` não era consumido por tela nenhuma. O
-- defeito foi encontrado ao construir a decomposição DuPont, que seria a primeira leitura.

-- Conferência ANTES: quantas linhas existem e como está o Itaú.
SELECT
  (SELECT count(*) FROM public.financial_facts WHERE metric = 'patrimonio_liquido') AS linhas_antes,
  (SELECT round(value / 1e9, 1) FROM public.financial_facts
    WHERE metric = 'patrimonio_liquido' AND cnpj = '60872504000123'
      AND document_type = 'DFP' AND period_end = '2025-12-31'
    ORDER BY version DESC LIMIT 1) AS itau_bilhoes_antes;

DELETE FROM public.financial_facts WHERE metric = 'patrimonio_liquido';

-- ===========================================================================
-- SEGUNDA PARTE — o gatilho, na mesma janela.
-- ===========================================================================
--
-- Diferente da migração do period_kind, aqui NÃO há risco em disparar junto: a coluna não
-- mudou de forma e o código antigo continua gravando normalmente (só gravaria errado de
-- novo, o que o DELETE acima desfaria na próxima execução). Ainda assim, rode depois do
-- deploy — não há motivo para reconstruir com o código velho.
--
--   DELETE FROM public.job_runs WHERE job_name = 'sync-financial-facts';
--
-- O job dispara na batida de hora seguinte e leva de 3 a 7 minutos.
--
-- ## Conferência DEPOIS
--
-- O patrimônio sobre o ativo total denuncia o defeito melhor que o valor absoluto: banco
-- capitalizado fica na casa de 7% a 8%, industrial entre 30% e 40%. Antes da correção o
-- Itaú aparecia com 77%, que é impossível para um banco.
--
--   SELECT t.ticker,
--          round(pl.value / 1e9, 1) AS pl_bilhoes,
--          round(100 * pl.value / at.value, 1) AS pl_sobre_ativo_pct
--     FROM public.company_tickers t
--     JOIN public.financial_facts pl
--       ON pl.cnpj = t.cnpj AND pl.metric = 'patrimonio_liquido'
--      AND pl.document_type = 'DFP' AND pl.period_end = '2025-12-31'
--     JOIN public.financial_facts at
--       ON at.cnpj = t.cnpj AND at.metric = 'ativo_total'
--      AND at.document_type = 'DFP' AND at.period_end = '2025-12-31'
--    WHERE t.ticker IN ('BBAS3','ITUB4','PETR4','VALE3')
--    ORDER BY t.ticker;
--
-- Esperado:
--
--   BBAS3   193.6 bi    7.9%
--   ITUB4   215.1 bi    7.0%
--   PETR4   417.6 bi   34.1%
--   VALE3   188.9 bi   39.7%
