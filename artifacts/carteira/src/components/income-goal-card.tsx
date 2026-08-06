import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetIncomeGoal,
  useUpsertIncomeGoal,
  getGetIncomeGoalQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Target, Check, AlertTriangle } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

/**
 * Meta de renda passiva e progresso. Fica na tela de Dividendos, ao lado da projeção
 * que alimenta o cálculo — o número corrente do card é exatamente a renda mensal
 * projetada a partir dos proventos reais dos últimos 12 meses.
 */
export function IncomeGoalCard() {
  const { data: goal, error } = useGetIncomeGoal({ query: { queryKey: getGetIncomeGoalQueryKey(), retry: false } });
  const upsert = useUpsertIncomeGoal();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [target, setTarget] = useState("");
  const [year, setYear] = useState("");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!goal) return;
    setTarget(String(goal.targetMonthlyIncome));
    setYear(String(goal.targetYear));
  }, [goal]);

  const notSet = (error as any)?.status === 404;
  const showForm = notSet || editing;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const targetMonthlyIncome = Number(target);
    const targetYear = Number(year);
    if (!Number.isFinite(targetMonthlyIncome) || targetMonthlyIncome <= 0) return;
    if (!Number.isInteger(targetYear) || targetYear < 2020 || targetYear > 2100) return;

    upsert.mutate(
      { data: { targetMonthlyIncome, targetYear } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetIncomeGoalQueryKey() });
          setEditing(false);
          toast({ title: "Meta de renda atualizada." });
        },
        onError: () => toast({ title: "Erro ao salvar a meta.", variant: "destructive" }),
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Target className="w-4 h-4 text-muted-foreground" />
              Meta de Renda Passiva
            </CardTitle>
            <CardDescription>
              {notSet
                ? "Defina quanto quer receber por mês e até quando."
                : "Progresso a partir dos proventos reais dos últimos 12 meses."}
            </CardDescription>
          </div>
          {goal && !showForm && (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>Editar</Button>
          )}
        </div>
      </CardHeader>

      <CardContent>
        {showForm ? (
          <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3 sm:items-end">
            <div className="space-y-2 flex-1">
              <Label>Renda mensal desejada (R$)</Label>
              <Input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" placeholder="2000" />
            </div>
            <div className="space-y-2 flex-1">
              <Label>Até o fim de qual ano</Label>
              <Input value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" placeholder="2034" />
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={upsert.isPending}>{upsert.isPending ? "Salvando..." : "Salvar"}</Button>
              {!notSet && <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancelar</Button>}
            </div>
          </form>
        ) : goal ? (
          <div className="space-y-5">
            <div>
              <div className="flex justify-between items-baseline text-sm mb-1.5">
                <span className="font-medium">
                  {formatCurrency(goal.currentMonthlyIncome)} de {formatCurrency(goal.targetMonthlyIncome)} por mês
                </span>
                <span className="font-mono font-bold">{goal.progressPercent.toFixed(1)}%</span>
              </div>
              <div className="h-2.5 w-full bg-secondary overflow-hidden rounded-full">
                <div
                  className={`h-full transition-all ${goal.achieved ? "bg-green-600 dark:bg-green-500" : "bg-primary"}`}
                  style={{ width: `${Math.max(0, Math.min(100, goal.progressPercent))}%` }}
                />
              </div>
            </div>

            {goal.achieved ? (
              <div className="flex gap-2 items-start text-sm rounded-md border border-green-500/20 bg-green-500/5 p-3">
                <Check className="w-4 h-4 shrink-0 text-green-600 dark:text-green-500 mt-0.5" />
                <span>Meta atingida — a carteira já projeta a renda mensal que você definiu.</span>
              </div>
            ) : goal.overdue ? (
              <div className="flex gap-2 items-start text-sm rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
                <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-500 mt-0.5" />
                <span className="text-pretty">O prazo de {goal.targetYear} já passou e a meta não foi atingida. Vale revisar o alvo ou o prazo.</span>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <p className="text-xs uppercase text-muted-foreground tracking-wider mb-1">Prazo</p>
                  <p className="text-lg font-bold font-mono">{goal.monthsRemaining} meses</p>
                  <p className="text-[11px] text-muted-foreground">até o fim de {goal.targetYear}</p>
                </div>
                <div>
                  <p className="text-xs uppercase text-muted-foreground tracking-wider mb-1">Falta acumular</p>
                  <p className="text-lg font-bold font-mono">{goal.capitalGap != null ? formatCurrency(goal.capitalGap) : "-"}</p>
                  <p className="text-[11px] text-muted-foreground">ao yield atual da carteira</p>
                </div>
                <div>
                  <p className="text-xs uppercase text-muted-foreground tracking-wider mb-1">Aporte mensal</p>
                  <p className="text-lg font-bold font-mono">
                    {goal.requiredMonthlyContribution != null ? formatCurrency(goal.requiredMonthlyContribution) : "-"}
                  </p>
                  <p className="text-[11px] text-muted-foreground">sem contar reinvestimento</p>
                </div>
              </div>
            )}

            {!goal.achieved && goal.capitalGap == null && (
              <p className="text-xs text-muted-foreground text-pretty">
                O quanto falta acumular depende do yield da carteira, que ainda não pode ser medido —
                é preciso ter ativos com histórico real de proventos nos últimos 12 meses.
              </p>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
