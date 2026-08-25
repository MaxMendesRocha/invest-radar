-- company_tickers — a ponte entre o ticker da carteira e o CNPJ da CVM.
--
-- Rodar UMA vez no Supabase (SQL Editor) antes de subir o código. Idempotente: rodar de
-- novo não faz nada e não apaga dado.
--
-- ## Por que ela existe
--
-- `financial_facts` é chaveada por CNPJ, o que está certo — PETR3 e PETR4 são a mesma
-- demonstração. Mas `assets` é chaveada por ticker, e o app só conhecia o CNPJ de FII
-- (vem pronto do endpoint de fundos da brapi). Para ação não havia mapa nenhum: as
-- 187.982 linhas de demonstração já ingeridas **não alcançavam um único ativo de ação**.
--
-- ## Por que ticker pode ser chave primária
--
-- Medido sobre os oito anos de FCA (2019–2026), depois de descartar códigos fora da
-- convenção da B3: 650 tickers, 650 pares distintos, **zero ticker apontando para mais de
-- um CNPJ**. O lixo descartado eram companhias preenchendo o campo com "0000", "N/A" ou
-- "NÃO HÁ" — e eram exatamente esses seis que apareciam ligados a vários CNPJs.
--
-- ## O que ela cobre
--
-- 618 ações, 30 units e 2 BDRs, em 430 companhias (382 delas com demonstrações na base).
-- Conferido contra tickers reais: ABEV3, BBDC4, EGIE3, ITUB4, MGLU3, PETR4, RENT3, VALE3
-- e WEGE3 resolvem. AAPL34, MSFT34, BOVA11, HGLG11, MXRF11 e XPML11 **não** — e é o
-- comportamento correto: Apple não presta contas à CVM, e fundo imobiliário tem registro
-- próprio, fora do FCA.

CREATE TABLE IF NOT EXISTS public.company_tickers (
    -- Código de negociação da B3, maiúsculo e sem o sufixo de fracionário (PETR4, não
    -- PETR4F — é o mesmo papel, e a normalização acontece na leitura).
    ticker           text PRIMARY KEY,
    -- Só dígitos, no mesmo formato de financial_facts.cnpj, para o join ser direto.
    cnpj             text NOT NULL,
    company_name     text NOT NULL,
    -- "Ações Ordinárias", "Ações Preferenciais", "Units" — como a CVM classifica.
    security_kind    text,
    -- Quando o papel parou de ser negociado. Preenchido em 32 das 537 linhas de 2026:
    -- é deslistagem real, não campo morto.
    trading_ended_at date,
    updated_at       timestamp DEFAULT now() NOT NULL
);

-- O caminho inverso: quais papéis uma companhia tem. É o que responde "PETR3 e PETR4
-- dividem a mesma demonstração".
CREATE INDEX IF NOT EXISTS company_tickers_cnpj_idx
  ON public.company_tickers USING btree (cnpj);

-- O mapa é preenchido pelo job `sync-financial-facts`, que passou a atualizar a ponte
-- junto com as demonstrações — mesma fonte, mesmo portal, e uma é inútil sem a outra.
--
-- O gatilho do job (o DELETE em job_runs) é ÚNICO para os dois, e está descrito na
-- segunda parte de financial-facts-period-kind.sql. Rodar de lá, depois do deploy: uma
-- execução do job preenche a série e a ponte de uma vez.

-- Conferência: 6 colunas, 0 linhas.
SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name = 'company_tickers') AS colunas,
  (SELECT count(*) FROM public.company_tickers) AS linhas;
