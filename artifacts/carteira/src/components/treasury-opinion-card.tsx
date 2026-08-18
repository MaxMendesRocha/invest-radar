import type { TreasuryOpinion } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Info, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { formatCurrency } from "@/lib/utils";

const PT_BR_2 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (v: number | null) => (v != null ? `${PT_BR_2.format(v)}%` : "?");
const fmtDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("pt-BR");

const TREND_ICON = { alta: TrendingUp, queda: TrendingDown, estavel: Minus } as const;

/**
 * Comparação de taxa pra um título do Tesouro Direto — a versão de "Parecer" que renda
 * fixa pública admite. Sem score: nada aqui compara ENTRE títulos, só a taxa de hoje
 * contra a própria faixa recente do MESMO título e contra Selic/IPCA atuais.
 */
export function TreasuryOpinionCard({ opinion }: { opinion: TreasuryOpinion }) {
  const range = opinion.rateRange;
  const TrendIcon = opinion.macro.selicTrend ? TREND_ICON[opinion.macro.selicTrend] : null;

  return (
    <Card className="overflow-hidden">
      <div className="p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-16 h-16 rounded-lg bg-muted flex flex-col items-center justify-center shrink-0">
              <span className="font-bold text-base font-mono leading-none">{PT_BR_2.format(opinion.buyRate)}%</span>
              <span className="text-[9px] text-muted-foreground mt-1">a.a.</span>
            </div>
            <div className="min-w-0">
              <h3 className="text-xl font-bold font-mono">{opinion.label}</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Título público federal · vencimento {fmtDate(opinion.maturityDate)}
              </p>
            </div>
          </div>

          <div className="text-right shrink-0">
            <div className="text-2xl font-bold font-mono">{formatCurrency(opinion.buyUnitPrice)}</div>
            <div className="text-xs text-muted-foreground">PU de compra · base {fmtDate(opinion.baseDate)}</div>
          </div>
        </div>

        <div className="mt-6 rounded-lg border p-4 border-dashed">
          <p className="text-sm font-semibold">{opinion.rateLabel}</p>
          <p className="mt-1.5 text-xs text-muted-foreground text-pretty">
            Taxa de compra publicada hoje pelo Tesouro Nacional. Não é score nem recomendação — é a taxa de
            hoje contra a própria faixa recente deste título e contra o cenário de juro atual.
          </p>
        </div>

        {range ? (
          <div className="mt-6 space-y-1.5">
            <div className="flex justify-between text-xs font-medium text-muted-foreground">
              <span>Mín. {range.days}d: {fmtPct(range.min)}</span>
              <span>Máx. {range.days}d: {fmtPct(range.max)}</span>
            </div>
            {range.percentile != null ? (
              <>
                <Progress value={range.percentile} className="h-2" />
                <p className="text-[10px] text-muted-foreground">
                  Taxa de hoje está a {range.percentile.toFixed(0)}% da faixa dos últimos {range.days} dias
                  (média de {fmtPct(range.avg)}).
                </p>
              </>
            ) : (
              <p className="text-[10px] text-muted-foreground">
                Taxa estável nos últimos {range.days} dias — sem variação pra posicionar numa faixa.
              </p>
            )}
          </div>
        ) : (
          <div className="mt-6 flex flex-wrap items-start gap-2 text-xs px-3 py-2 rounded-md border bg-muted/40 border-border/50">
            <Info className="w-3.5 h-3.5 shrink-0 text-muted-foreground mt-0.5" />
            <span className="text-muted-foreground text-pretty">
              Histórico curto demais nos últimos 90 dias pra montar uma faixa confiável de comparação.
            </span>
          </div>
        )}

        <div className="mt-6 pt-6 border-t space-y-4">
          <div>
            <h4 className="flex items-center gap-2 font-semibold mb-2 text-xs uppercase tracking-wider text-muted-foreground">
              Contra a Selic agora
            </h4>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono font-medium">Selic {fmtPct(opinion.macro.selic)}</span>
              {opinion.macro.selicTrend && TrendIcon && (
                <span className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                  <TrendIcon className="w-3 h-3" /> tendência de {opinion.macro.selicTrend}
                </span>
              )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground text-pretty">
              Juro real embutido na Selic hoje: <span className="font-medium text-foreground">{fmtPct(opinion.macro.realInterestRate)}</span> (Selic{" "}
              {fmtPct(opinion.macro.selic)} vs. IPCA de {fmtPct(opinion.macro.ipca12m)} em 12 meses).{" "}
              {opinion.indexer === "ipca"
                ? `Este título trava ${fmtPct(opinion.buyRate)} reais ao ano até o vencimento, independente do ciclo de juros.`
                : opinion.indexer === "selic"
                  ? "O rendimento deste título acompanha a Selic — sobe e desce junto com ela até o vencimento."
                  : `Este título trava uma taxa nominal de ${fmtPct(opinion.buyRate)} ao ano até o vencimento, sem proteção contra inflação surpresa.`}
            </p>
          </div>

          <div className="flex flex-wrap items-start gap-2 text-xs px-3 py-2 rounded-md border bg-muted/40 border-border/50">
            <Info className="w-3.5 h-3.5 shrink-0 text-muted-foreground mt-0.5" />
            <span className="text-muted-foreground text-pretty">{opinion.liquidityNote}</span>
          </div>
        </div>
      </div>
    </Card>
  );
}
