import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMe, getGetMeQueryKey,
  useGetInvestorProfile, useUpdateInvestorProfile, getGetInvestorProfileQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

const HORIZON_OPTIONS = [
  { value: "curto", label: "Curto prazo (até 1 ano)" },
  { value: "medio", label: "Médio prazo (1 a 5 anos)" },
  { value: "longo", label: "Longo prazo (mais de 5 anos)" },
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

export default function Settings() {
  const { data: user } = useGetMe({ query: { queryKey: getGetMeQueryKey() } });
  const { data: profile, error: profileError } = useGetInvestorProfile({
    query: { queryKey: getGetInvestorProfileQueryKey(), retry: false },
  });
  const updateProfile = useUpdateInvestorProfile();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [horizon, setHorizon] = useState("");
  const [lossTolerance, setLossTolerance] = useState("");
  const [objective, setObjective] = useState("");
  const [experience, setExperience] = useState("");
  const [liquidityNeed, setLiquidityNeed] = useState("");

  useEffect(() => {
    if (!profile) return;
    setHorizon(profile.horizon);
    setLossTolerance(profile.lossTolerance);
    setObjective(profile.objective);
    setExperience(profile.experience);
    setLiquidityNeed(profile.liquidityNeed);
  }, [profile]);

  const profileNotSet = (profileError as any)?.status === 404;
  const canSubmit = horizon && lossTolerance && objective && experience && liquidityNeed;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    updateProfile.mutate(
      { data: { horizon: horizon as any, lossTolerance: lossTolerance as any, objective: objective as any, experience: experience as any, liquidityNeed: liquidityNeed as any } },
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
              <Label>Horizonte de investimento</Label>
              <Select value={horizon} onValueChange={setHorizon}>
                <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  {HORIZON_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
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
          </CardContent>
          <CardFooter className="pt-4 border-t mt-2">
            <Button type="submit" disabled={!canSubmit || updateProfile.isPending}>
              {updateProfile.isPending ? "Salvando..." : profile ? "Atualizar Perfil" : "Salvar Perfil"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
