-- financial_facts — série histórica de demonstrações das companhias abertas (CVM/DFP).
--
-- Rodar UMA vez no Supabase (SQL Editor) antes de disparar o sync. Idempotente: rodar de
-- novo não faz nada e não apaga dado.
--
-- Extraído do banco onde o `drizzle-kit push` criou a tabela, não transcrito à mão — os
-- nomes de constraint e índice são os que o Drizzle espera encontrar depois.
--
-- IMPORTANTE: use ESTE script, não `drizzle-kit push`. O push reporta a constraint única
-- abaixo como ausente mesmo quando ela existe, e oferece TRUNCAR a tabela para poder
-- criá-la — o que apagaria a série histórica inteira. A causa não foi identificada (nome
-- longo, forma do callback, índice secundário, número de colunas e `mode` das datas foram
-- todos descartados). Se algum dia rodar push nesta base, responda NÃO à pergunta.

CREATE TABLE IF NOT EXISTS public.financial_facts (
    id            serial PRIMARY KEY,
    cnpj          text NOT NULL,
    cvm_code      text NOT NULL,
    company_name  text NOT NULL,
    metric        text NOT NULL,
    -- Null em conta de balanço: saldo numa data não tem período inicial.
    period_start  date,
    period_end    date NOT NULL,
    -- DT_RECEB da CVM: quando o número passou a ser público. É o "known at" da série, e
    -- sem ele qualquer estudo retrospectivo usa informação que ainda não existia.
    published_at  date,
    -- Versão do documento. Retificação chega com versão maior e vira linha nova, para a
    -- publicação original não ser apagada.
    version       integer NOT NULL,
    -- Já em reais: o arquivo publica em MIL e a conversão acontece na ingestão.
    value         numeric(24,2) NOT NULL,
    -- DFP (exercício anual) ou ITR (informe trimestral).
    document_type text NOT NULL,
    -- O que o período É: `saldo` (balanço, um instante), `exercicio` (o ano fiscal de um
    -- DFP), `trimestre` (~3 meses de um ITR) ou `acumulado` (6 ou 9 meses de um ITR).
    -- Não é redundante com as datas: o ITR publica o MESMO period_end duas vezes, uma com
    -- o trimestre isolado e outra com o acumulado do ano, e sem esta coluna na chave
    -- única dois terços do dado trimestral seriam descartados em silêncio.
    period_kind   text NOT NULL,
    source_url    text,
    created_at    timestamp DEFAULT now() NOT NULL
);

-- A versão entra na chave de propósito: é o que permite retificação conviver com a
-- publicação original em vez de sobrescrevê-la.
--
-- O nome é explícito porque o automático teria 67 caracteres e o Postgres trunca em 63,
-- deixando banco e schema com nomes diferentes.
ALTER TABLE public.financial_facts
  DROP CONSTRAINT IF EXISTS financial_facts_periodo_unico;
ALTER TABLE public.financial_facts
  ADD CONSTRAINT financial_facts_periodo_unico
  UNIQUE (cnpj, metric, period_end, period_kind, document_type, version);

CREATE INDEX IF NOT EXISTS financial_facts_cnpj_idx
  ON public.financial_facts USING btree (cnpj, metric, period_end);

-- Conferência: deve devolver 14 colunas e 0 linhas.
SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name = 'financial_facts') AS colunas,
  (SELECT count(*) FROM public.financial_facts) AS linhas;
