import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListPriceTargets,
  getListPriceTargetsQueryKey,
  useUpsertPriceTarget,
  useDeletePriceTarget,
} from "@workspace/api-client-react";

/**
 * Comportamento do preço-alvo, compartilhado entre as duas telas que o expõem.
 *
 * Existe porque o mesmo controle aparece em contextos com necessidades visuais opostas:
 * no Parecer de Ativo ele é o primeiro encontro e precisa explicar por que o app não
 * tem esse número; em Minha Carteira é uma linha a mais num cartão já cheio. Formas
 * diferentes, mesma lógica de salvar, remover e reportar erro — que é justamente o que
 * não deve divergir entre as duas.
 */
export function usePriceTarget(ticker: string, options?: { onSaved?: () => void }) {
  const queryClient = useQueryClient();
  const { data: targets } = useListPriceTargets({ query: { queryKey: getListPriceTargetsQueryKey() } });
  const target = targets?.find((t) => t.ticker === ticker) ?? null;

  // Sem isto, uma falha ao salvar não fazia nada visível e o usuário concluía que o
  // clique não pegou. Vale para rede, validação e para o caso em que a tabela ainda
  // não existe no banco (o deploy não roda migração).
  const [error, setError] = useState<string | null>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListPriceTargetsQueryKey() });

  const upsert = useUpsertPriceTarget({
    mutation: {
      onMutate: () => setError(null),
      // Fechar o editor é responsabilidade do onSaved, e só depois do sucesso: fechar
      // otimista esconderia justamente a mensagem de erro que este hook existe para dar.
      onSuccess: () => { invalidate(); options?.onSaved?.(); },
      onError: () => setError("Não foi possível salvar o preço-alvo. Tente de novo em instantes."),
    },
  });
  const remove = useDeletePriceTarget({
    mutation: { onSuccess: invalidate, onError: () => setError("Não foi possível remover o preço-alvo.") },
  });

  /** Aceita vírgula decimal, que é como se digita preço em português. */
  const save = (raw: string, source: string) => {
    const parsed = Number(raw.replace(",", "."));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("Informe um valor maior que zero.");
      return;
    }
    upsert.mutate({ ticker, data: { targetPrice: parsed, source: source.trim() || null } });
  };

  return { target, error, setError, save, remove, isSaving: upsert.isPending };
}
