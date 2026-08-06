import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMe, getGetMeQueryKey,
  useGetInvestorProfile, useUpdateInvestorProfile, getGetInvestorProfileQueryKey,
  type InvestorProfile,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle } from "lucide-react";

// Em anos, não em "curto/médio/longo": o degrau que importa está entre 2 e 5 anos,
// e o rótulo vago escondia essa fronteira.
const HORIZON_YEARS_OPTIONS = [
  { value: "1", label: "Menos de 2 anos" },
  { value: "3", label: "2 a 5 anos" },
  { value: "7", label: "5 a 10 anos" },
  { value: "15", label: "Mais de 10 anos" },
];

const EMERGENCY_FUND_OPTIONS = [
  { value: "sim", label: "Sim — tenho reserva para pelo menos 6 meses" },
  { value: "nao", label: "Não — ainda não tenho reserva" },
];

const PORTFOLIO_SHARE_OPTIONS = [
  { value: "menos_25", label: "Menos de 25%" },
  { value: "de_25_50", label: "Entre 25% e 50%" },
  { value: "de_50_75", label: "Entre 50% e 75%" },
  { value: "mais_75", label: "Mais de 75%" },
];

const INCOME_STABILITY_OPTIONS = [
  { value: "estavel", label: "Estável — salário fixo ou equivalente" },
  { value: "variavel", label: "Variável — comissões, autônomo, PJ" },
  { value: "instavel", label: "Instável — sem previsibilidade" },
];

const LOSS_TOLERANCE_OPTIONS = [
  { value: "baixa", label: "Baixa — fico desconfortável com qualquer queda" },
  { value: "media", label: "Média — aceito oscilações moderadas" },
  { value: "alta", label: "Alta — aceito quedas fortes por um retorno maior" },
];

const OBJECTIVE_OPTIONS = [
  { value: "preservar", label: "Preservar capital" },
  { value: "renda", label: "Gerar renda passiva" },
  { value: "crescimento", label: "Crescimento de patrimônio no longo prazo" },
];

const EXPERIENCE_OPTIONS = [
  { value: "iniciante", label: "Iniciante" },
  { value: "intermediario", label: "Intermediária" },
  { value: "avancado", label: "Avançada" },
];

const LIQUIDITY_NEED_OPTIONS = [
  { value: "nao", label: "Não" },
  { value: "sim", label: "Sim" },
];

const CLASSIFICATION_BADGE: Record<string, "default" | "secondary" | "destructive"> = {
  Conservador: "default",
  Moderado: "secondary",
  Arrojado: "destructive",
};


const LIMITED_BY_LABEL: Record<string, string> = {
  capacidade: "Sua tolerância a risco é maior que a sua capacidade — o que limita o perfil é a situação financeira, não o apetite.",
  tolerancia: "Sua capacidade de assumir risco é maior que a tolerância declarada — há margem financeira que o apetite não acompanha.",
  equilibrado: "Capacidade e tolerância estão alinhadas.",
};

/**
 * Leitura do perfil: os dois eixos, o que limitou o resultado, as travas acionadas
 * e a comparação com a carteira real. A classificação sozinha não explica por que
 * o resultado foi aquele.
 */
function ProfileReading({ profile }: { profile: InvestorProfile }) {
  // Perfil da régua antiga: as respostas de capacidade nunca foram feitas, então
  // exibir a barra seria mostrar confiança que o dado não tem.
  if (profile.capacityComplete === false) {
    return (
      <Card>
        <CardContent className="flex gap-3 p-6 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-500 mt-0.5" />
          <span className="text-pretty">
            Seu perfil foi salvo antes das perguntas sobre reserva de emergência, prazo e renda existirem.
            Responda o questionário acima de novo para obter a leitura completa.
          </span>
        </CardContent>
      </Card>
    );
  }

  const hasScores = profile.capacityScore != null && profile.toleranceScore != null;
  if (!hasScores && !profile.revealedClassification) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Leitura do Perfil</CardTitle>
        <CardDescription>Como a classificação foi obtida e o que a carteira real mostra.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {hasScores && (
          <div className="space-y-3">
            {[
              { label: "Capacidade de assumir risco", value: profile.capacityScore!, hint: "Prazo, reserva, liquidez, peso no patrimônio e renda" },
              { label: "Tolerância a risco", value: profile.toleranceScore!, hint: "Quanto de oscilação você aceita, e experiência" },
            ].map((axis) => (
              <div key={axis.label} className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="font-medium">{axis.label}</span>
                  <span className="font-mono font-bold">{axis.value.toFixed(0)}/100</span>
                </div>
                <div className="h-2 w-full bg-secondary overflow-hidden rounded-full">
                  <div className="h-full bg-primary transition-all" style={{ width: `${Math.max(0, Math.min(100, axis.value))}%` }} />
                </div>
                <p className="text-[11px] text-muted-foreground">{axis.hint}</p>
              </div>
            ))}
            <p className="text-xs text-muted-foreground text-pretty">
              Vale a menor das duas. {LIMITED_BY_LABEL[profile.limitedBy ?? "equilibrado"]}
            </p>
          </div>
        )}

        {profile.constraints && profile.constraints.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Travas aplicadas</h4>
            <ul className="space-y-2">
              {profile.constraints.map((c, i) => (
                <li key={i} className="text-sm flex gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-500 mt-0.5" />
                  <span className="text-pretty text-justify hyphens-auto">{c}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {profile.revealedClassification && (
          <div className="space-y-2">
            <h4 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Perfil revelado pela carteira</h4>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="outline">Declarado: {profile.classification}</Badge>
              <Badge variant="outline">Carteira: {profile.revealedClassification}</Badge>
            </div>
            <p className={`text-sm leading-relaxed text-pretty text-justify hyphens-auto rounded-md border p-3 ${
              profile.divergenceMessage
                ? "border-amber-500/20 bg-amber-500/5"
                : "border-border/50 bg-muted/40"
            }`}>
              {profile.divergenceMessage ??
                `A carteira está posicionada de forma coerente com o perfil declarado: ${profile.revealedVariableIncomePercent?.toFixed(0) ?? "?"}% em renda variável, maior posição com ${profile.revealedLargestPositionPercent?.toFixed(0) ?? "?"}% do patrimônio.`}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Settings() {
  const { data: user } = useGetMe({ query: { queryKey: getGetMeQueryKey() } });
  const { data: profile, error: profileError } = useGetInvestorProfile({
    query: { queryKey: getGetInvestorProfileQueryKey(), retry: false },
  });
  const updateProfile = useUpdateInvestorProfile();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [horizonYears, setHorizonYears] = useState("");
  const [lossTolerance, setLossTolerance] = useState("");
  const [objective, setObjective] = useState("");
  const [experience, setExperience] = useState("");
  const [liquidityNeed, setLiquidityNeed] = useState("");
  const [emergencyFund, setEmergencyFund] = useState("");
  const [portfolioShare, setPortfolioShare] = useState("");
  const [incomeStability, setIncomeStability] = useState("");

  useEffect(() => {
    if (!profile) return;
    // Campos novos vêm null em perfis salvos pela régua antiga: ficam em branco e
    // o usuário precisa respondê-los para salvar de novo.
    setHorizonYears(profile.horizonYears != null ? String(profile.horizonYears) : "");
    setLossTolerance(profile.lossTolerance);
    setObjective(profile.objective);
    setExperience(profile.experience);
    setLiquidityNeed(profile.liquidityNeed);
    setEmergencyFund(profile.emergencyFund ?? "");
    setPortfolioShare(profile.portfolioShare ?? "");
    setIncomeStability(profile.incomeStability ?? "");
  }, [profile]);

  const profileNotSet = (profileError as any)?.status === 404;
  const canSubmit = horizonYears && lossTolerance && objective && experience && liquidityNeed && emergencyFund && portfolioShare && incomeStability;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    updateProfile.mutate(
      {
        data: {
          horizonYears: Number(horizonYears),
          lossTolerance: lossTolerance as any,
          objective: objective as any,
          experience: experience as any,
          liquidityNeed: liquidityNeed as any,
          emergencyFund: emergencyFund as any,
          portfolioShare: portfolioShare as any,
          incomeStability: incomeStability as any,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetInvestorProfileQueryKey() });
          toast({ title: "Perfil de investidor atualizado." });
        },
        onError: () => {
          toast({ title: "Erro ao salvar perfil.", variant: "destructive" });
        },
      }
    );
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Configurações</h1>
        <p className="text-muted-foreground">Gerencie seu perfil e preferências.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Conta</CardTitle>
          <CardDescription>Informações básicas da conta.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Nome Completo</Label>
            <Input value={user?.name || ""} disabled readOnly />
          </div>
          <div className="space-y-2">
            <Label>E-mail</Label>
            <Input value={user?.email || ""} disabled readOnly />
          </div>
          <div className="space-y-2">
            <Label>Membro desde</Label>
            <Input value={user ? new Date(user.createdAt).toLocaleDateString('pt-BR') : ""} disabled readOnly />
          </div>
        </CardContent>
      </Card>

      <Card>
        <form onSubmit={handleSubmit}>
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <div>
                <CardTitle>Perfil de Investidor</CardTitle>
                <CardDescription>
                  {profileNotSet
                    ? "Responda para receber sugestões de ativos alinhadas ao seu perfil de risco."
                    : "Suas respostas definem a classificação usada nas Oportunidades."}
                </CardDescription>
              </div>
              {profile && (
                <Badge variant={CLASSIFICATION_BADGE[profile.classification] ?? "default"}>
                  {profile.classification}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Em quanto tempo você pode precisar desse dinheiro?</Label>
              <Select value={horizonYears} onValueChange={setHorizonYears}>
                <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  {HORIZON_YEARS_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Você tem reserva de emergência?</Label>
              <Select value={emergencyFund} onValueChange={setEmergencyFund}>
                <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  {EMERGENCY_FUND_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Tolerância a perdas</Label>
              <Select value={lossTolerance} onValueChange={setLossTolerance}>
                <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  {LOSS_TOLERANCE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Objetivo principal</Label>
              <Select value={objective} onValueChange={setObjective}>
                <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  {OBJECTIVE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Experiência com investimentos</Label>
              <Select value={experience} onValueChange={setExperience}>
                <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  {EXPERIENCE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Vai precisar desse dinheiro no curto prazo?</Label>
              <Select value={liquidityNeed} onValueChange={setLiquidityNeed}>
                <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  {LIQUIDITY_NEED_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Quanto do seu patrimônio total está nesta carteira?</Label>
              <Select value={portfolioShare} onValueChange={setPortfolioShare}>
                <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  {PORTFOLIO_SHARE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Como é a sua renda?</Label>
              <Select value={incomeStability} onValueChange={setIncomeStability}>
                <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  {INCOME_STABILITY_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
          <CardFooter className="pt-4 border-t mt-2">
            <Button type="submit" disabled={!canSubmit || updateProfile.isPending}>
              {updateProfile.isPending ? "Salvando..." : profile ? "Atualizar Perfil" : "Salvar Perfil"}
            </Button>
          </CardFooter>
        </form>
      </Card>

      {profile && <ProfileReading profile={profile} />}
    </div>
  );
}
