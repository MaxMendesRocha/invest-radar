-- asset_purchases: coluna `broker_note_number` — a chave de idempotência da importação
-- de nota de corretagem em PDF.
--
-- Rodar UMA vez no Supabase (SQL Editor) antes de subir o código. Idempotente, aditiva e
-- sem backfill: a coluna nasce nula e só a importação passa a preenchê-la.
--
-- ## Por que precisa existir
--
-- O arquivo que a corretora exporta contém o PERÍODO INTEIRO, não só o que é novo. Quem
-- importa em agosto e volta em setembro reenvia agosto junto, e sem um identificador
-- estável a segunda importação criaria de novo cada compra: quantidade dobrada e preço
-- médio envenenado — exatamente o número que asset_purchases existe para proteger.
--
-- O número da nota serve porque ele é da CORRETORA e não nosso: é o mesmo em qualquer
-- reexportação do mesmo pregão. Alternativas que se cogitou e não servem — hash do
-- arquivo muda quando a corretora regenera o PDF; (ticker, data, quantidade, preço)
-- colide de verdade, porque comprar 1 cota ao mesmo preço no mesmo dia em duas ordens é
-- comum no fracionário.
--
-- ## Por que nula é segura, e por que NÃO há UNIQUE aqui
--
-- Lançamento digitado à mão e saldo inicial não têm nota, e vão continuar sem. Preencher
-- com um valor sintético para poder criar uma restrição transformaria "não sei" em "é
-- diferente de todos os outros", que é o oposto do que a coluna afirma.
--
-- A unicidade também não pode ser (user_id, broker_note_number): a MESMA nota carrega
-- várias operações, inclusive do mesmo papel em mercados diferentes — a nota 26896 tem
-- TAESA no fracionário e DEVA à vista. A restrição correta é por operação dentro da nota,
-- e ela é aplicada na escrita, não no banco: a importação consulta quais números de nota
-- o usuário já tem e recusa reimportá-los inteiros. Uma UNIQUE parcial aqui rejeitaria a
-- segunda linha de uma nota legítima de duas operações.
--
-- O índice abaixo é o que essa consulta usa, e é só isso que ele é.

ALTER TABLE public.asset_purchases
  ADD COLUMN IF NOT EXISTS broker_note_number text;

CREATE INDEX IF NOT EXISTS asset_purchases_broker_note_idx
  ON public.asset_purchases (user_id, broker_note_number)
  WHERE broker_note_number IS NOT NULL;

-- Conferência: a coluna e o índice existem, e nenhum lançamento existente foi tocado.
SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name = 'asset_purchases' AND column_name = 'broker_note_number') AS coluna_criada,
  (SELECT count(*) FROM pg_indexes
     WHERE tablename = 'asset_purchases' AND indexname = 'asset_purchases_broker_note_idx') AS indice_criado,
  (SELECT count(*) FROM public.asset_purchases) AS lancamentos,
  (SELECT count(*) FROM public.asset_purchases WHERE broker_note_number IS NULL) AS sem_nota;
