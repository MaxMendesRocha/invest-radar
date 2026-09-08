import { useGetAllocation, getGetAllocationQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Scale } from "lucide-react";
import { Link } from "wouter";
import { formatCurrency } from "@/lib/utils";
import { CATEGORY_LABEL, decimal, decimalOptional, integer } from "@/components/allocation-shared";

/**
 * O veredito de rebalanceamento, em uma linha, na tela onde a pessoa cai ao abrir o app.
 *
 * A carteira já tinha alvo e desvio; o que faltava era o corte que transforma desvio em
 * decisão. Sem banda, "FIIs a 2,1 p.p. do alvo" e "FIIs a 8,4 p.p." chegavam com o mesmo
 * peso, e a resposta mais frequente — *não faça nada* — era a única que o app não sabia
 * dar. Ele empurrava a conclusão para o leitor justamente na decisão que ele não tem como
 * tomar sem uma regra escrita.
 *
 * ## Por que na Visão Geral e não em Saúde do Portfólio
 *
 * O detalhe (barras, alvos, plano de aporte) continua em Saúde. Mas um aviso que só
 * aparece na tela que a pessoa visita quando já decidiu rebalancear não avisa nada — ele
 * confirma. O gatilho precisa estar onde ela chega sem estar procurando.
 *
 * ## Carteira vazia não recebe veredito
 *
 * `balanced` é `true` sem patrimônio (não existe desvio percentual sobre base zero), então
 * um usuário recém-cadastrado leria "nada a fazer" sobre uma carteira que ele ainda nem
 * montou. O convite da Carteira de Partida, logo acima, é a mensagem certa nesse estado.
 */

/** "Ações, FIIs e Renda Fixa" — vírgula até o penúltimo, "e" antes do último. */
function listar(partes: string[]): string {
  if (partes.length <= 1) return partes[0] ?? "";
  return `${partes.slice(0, -1).join(", ")} e ${partes[partes.length - 1]}`;
}

export function RebalanceVerdict() {
  const { data: allocation } = useGetAllocation({ query: { queryKey: getGetAllocationQueryKey() } });

  // Silencioso enquanto carrega: é uma linha de decisão, e um esqueleto piscando no topo
  // da home custa mais atenção do que entrega.
  if (!allocation || allocation.bandPp == null) return null;
  if (!(allocation.totalPatrimony > 0)) return null;

  const banda = `${decimalOptional.format(allocation.bandPp)} p.p.`;
  const fora = allocation.outOfBand ?? [];

  if (allocation.balanced) {
    return (
      <Card className="border-green-600/30 dark:border-green-500/30">
        <CardContent className="pt-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <CheckCircle2 className="w-5 h-5 shrink-0 text-green-600 dark:text-green-500" />
          <div className="flex-1 space-y-0.5">
            <p className="text-sm font-medium">Nada a fazer este mês.</p>
            <p className="text-xs text-muted-foreground text-pretty">
              Nenhuma classe passou de {banda} do alvo. Mexer por menos que isso costuma custar mais
              em corretagem e imposto do que corrige.
            </p>
          </div>
          <Button asChild variant="ghost" size="sm" className="shrink-0 self-start sm:self-auto">
            <Link href="/saude">Ver alocação</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  // `deviationPp` positivo é ABAIXO do alvo — a mesma convenção das barras em Saúde.
  const pior = allocation.items.find((i) => i.category === allocation.worstCategory) ?? null;

  return (
    <Card className="border-orange-500/40">
      <CardContent className="pt-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <Scale className="w-5 h-5 shrink-0 text-orange-500" />
        <div className="flex-1 space-y-0.5">
          {/* A classe vem DEPOIS da banda, e não antes com um verbo, porque a concordância
              não dá para deduzir da contagem: "Ações" é rótulo plural de uma classe só, e
              "Ações está fora" saía errado sempre que exatamente uma classe estourava. */}
          <p className="text-sm font-medium text-pretty">
            Fora da banda de {banda}: {listar(fora.map((c) => CATEGORY_LABEL[c] ?? c))}.
          </p>
          <p className="text-xs text-muted-foreground text-pretty">
            {pior ? (
              <>
                {CATEGORY_LABEL[pior.category] ?? pior.category} {decimal.format(pior.deviationPp)} p.p. abaixo
                do alvo
                {/* `amountToFix` é null com alvo de 100%, onde não existe aporte finito que
                    feche a conta. A frase então para na medição, em vez de inventar valor. */}
                {allocation.amountToFix != null && (
                  <>
                    : um aporte de {formatCurrency(allocation.amountToFix)} devolve essa classe ao alvo
                    {allocation.contributionsToFix != null && allocation.monthlyPace != null && (
                      <>
                        {" "}— {integer.format(allocation.contributionsToFix)}{" "}
                        {allocation.contributionsToFix === 1 ? "aporte" : "aportes"} no seu ritmo de{" "}
                        {formatCurrency(allocation.monthlyPace)}/mês
                      </>
                    )}
                  </>
                )}
                .
              </>
            ) : (
              /* Nenhuma classe fora da banda está ABAIXO do alvo. Aporte não corrige isso, e
                 o app não manda vender: a venda realiza IR e corretagem para consertar um
                 desvio que a própria entrada de dinheiro novo dilui com o tempo. */
              <>
                Aporte não corrige classe acima do alvo — ela volta ao lugar conforme o resto da
                carteira cresce. Vender resolveria mais rápido, ao custo de IR e corretagem.
              </>
            )}
          </p>
        </div>
        <Button asChild variant="ghost" size="sm" className="shrink-0 self-start sm:self-auto">
          <Link href="/saude">Ver alocação</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
