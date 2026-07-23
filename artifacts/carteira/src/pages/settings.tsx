import { useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export default function Settings() {
  const { data: user } = useGetMe({ query: { queryKey: getGetMeQueryKey() } });

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Configurações</h1>
        <p className="text-muted-foreground">Gerencie seu perfil e preferências.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Perfil do Investidor</CardTitle>
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
          
          <div className="pt-4 border-t mt-6">
            <Button variant="outline" disabled>Atualizar Perfil (Em breve)</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
