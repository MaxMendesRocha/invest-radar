import { useState } from "react";
import { Link } from "wouter";
import {
  useGetStarterPortfolios,
  getGetStarterPortfoliosQueryKey,
  type StarterPortfolio,
  type StarterPortfolios,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Compass, Landmark, ShieldAlert, ClipboardList, Wallet } from "lucide-react";
import { formatCurrency, rateVintage } from "@/lib/utils";
import {
  CATEGORY_LABEL,
  SUGGESTION_NOTE,
  SizingLine,
  decimal,
  integer,
  maturityYear,
  unitLabelFor,
} from "@/components/allocation-shared";

/**
 * A primeira tela útil para quem acabou de se cadastrar: as três carteiras-alvo lado a
 * lado, para uma pessoa que ainda não sabe qual é a dela.
 *
 * Três colunas e não uma. Mostrar só uma exigiria adivinhar o perfil de quem não
 * respondeu o questionário — e o contraste entre 80% e 30% de renda fixa é a explicação
 * mais curta que existe do que o questionário decide.
 *
 * A tela inteira é composição de motor: nada aqui calcula peso, escolhe ativo ou escreve
 * justificativa. O que ela acrescenta é a hierarquia entre números que NÃO valem a mesma
 * coisa — ver a nota de origens mais abaixo.
 */

const CLASSIFICATION_BADGE: Record<string, "default" | "secondary" | "destructive"> = {
  Conservador: "default",
  Moderado: "secondary",
  Arrojado: "destructive",
};

const CLASSIFICATION_LINE: Record<string, string> = {
  Conservador: "Prioriza não perder. Aceita render menos em troca de oscilar pouco.",
  Moderado: "Aceita oscilação em parte da carteira para render acima da renda fixa.",
  Arrojado: "Aceita queda relevante no meio do caminho em troca de retorno maior no longo prazo.",
};

function ProfileColumn({ profile, amount, highlighted }: { profile: StarterPortfolio; amount: number | null; highlighted: boolean }) {
  const fixedIncome = profile.items.find((item) => item.category === "renda_fixa");
  const variable = profile.items.filter((item) => item.category !== "renda_fixa");

  return (
    <Card className={highlighted ? "border-primary" : undefined}>
      <CardHeader className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            {profile.classification}
            {highlighted && <Badge variant={CLASSIFICATION_BADGE[profile.classification] ?? "default"}>seu perfil</Badge>}
          </CardTitle>
        </div>
        <CardDescription className="text-pretty">{CLASSIFICATION_LINE[profile.classification]}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* O número de destaque da coluna, e o único com respaldo de praxe de mercado.
            Tudo o mais nesta tela é menor que ele de propósito. */}
        <div className="rounded-lg border border-border/60 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium">Renda fixa</span>
            <span className="text-2xl font-bold font-mono">{integer.format(profile.fixedIncomePercent)}%</span>
          </div>
          {/* O valor vem do motor, não de multiplicar o percentual pelo total: quando o
              piso derruba uma classe, o dinheiro dela é redistribuído e a renda fixa
              recebe um pouco mais do que o alvo. Recalcular aqui exibiria um número que
              não é o que a tela está mandando comprar. */}
          <p className="text-xs text-muted-foreground mt-1">
            {integer.format(100 - profile.fixedIncomePercent)}% em renda variável
            {amount != null && fixedIncome?.amount != null && (
              <> · {formatCurrency(fixedIncome.amount)} de {formatCurrency(amount)}</>
            )}
          </p>
        </div>

        <div className="space-y-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Como se reparte a renda variável</p>
          {variable.map((item) => (
            <div key={item.category} className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{CATEGORY_LABEL[item.category] ?? item.category}</span>
                <span className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                  {decimal.format(item.targetPercent)}%
                  {item.amount != null && item.amount > 0 && <> · {formatCurrency(item.amount)}</>}
                </span>
              </div>
              {/* Barra do ALVO — não há "atual" numa carteira que ainda não existe, então
                  a barra de Saúde do Portfólio (atual x alvo) não serve aqui. */}
              <div className="h-1.5 w-full bg-secondary overflow-hidden rounded-full">
                <div className="h-full bg-blue-600 dark:bg-blue-500" style={{ width: `${Math.min(100, item.targetPercent)}%` }} />
              </div>

              {item.suggestions.length > 0 && (
                <div className="space-y-1.5 pl-0.5">
                  {item.suggestions.map((s) => (
                    <div key={s.ticker}>
                      <div className="text-sm flex gap-2">
                        <span className="font-mono font-medium">{s.ticker}</span>
                        <span className="text-muted-foreground truncate" title={s.reason}>{s.name}</span>
                      </div>
                      {s.sizing && <SizingLine sizing={s.sizing} unitLabel={unitLabelFor(item.category)} />}
                    </div>
                  ))}
                  {/* Sem esta frase as quantidades somam na cabeça de quem lê. Cada linha
                      usa a fatia inteira: o alvo do app é por classe, não por ticker. */}
                  {item.amount != null && item.amount > 0 && item.suggestions.filter((s) => s.sizing).length > 1 && (
                    <p className="text-xs text-muted-foreground text-pretty">
                      Cada linha usa {formatCurrency(item.amount)} inteiros — são alternativas, não uma soma.
                    </p>
                  )}
                </div>
              )}

              {item.suggestions.length === 0 && (
                <p className="text-xs text-muted-foreground text-pretty">{SUGGESTION_NOTE[item.suggestionsStatus]}</p>
              )}

              {/* Classe que o valor de partida não alcança. O motor tirou ela do plano e
                  redistribuiu — dizer isso é melhor do que exibir R$ 0,00 sem explicação.
                  Vem depois dos candidatos, não antes: primeiro o usuário vê o que a
                  classe seria, depois por que ela ainda não entra neste valor. */}
              {item.amount === 0 && (
                <p className="text-xs text-muted-foreground text-pretty">
                  Com {formatCurrency(amount ?? 0)} de partida esta fatia ficaria pequena demais para valer a
                  corretagem — o valor dela foi para as outras classes. Ela entra quando a carteira crescer.
                </p>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function TreasuryBlock({ treasury, hasProfile }: { treasury: StarterPortfolios["treasury"]; hasProfile: boolean }) {
  return (
    <Card>
      <CardHeader className="space-y-1.5">
        <CardTitle className="flex items-center gap-2"><Landmark className="w-4 h-4" /> A parte de renda fixa</CardTitle>
        {/* O título é um só nas três colunas nos dois casos — muda apenas de onde vem a
            escolha. Sem questionário, é o argumento para respondê-lo; com questionário,
            é o que ele já entregou. */}
        <CardDescription className="text-pretty">
          O título sugerido é <strong className="font-medium text-foreground">o mesmo nas três colunas</strong>, e isso
          não é simplificação: ele depende de quando você pode precisar do dinheiro e de você já ter reserva de
          emergência — perguntas do questionário, não do perfil de risco.{" "}
          {hasProfile ? (
            <>Este veio das suas respostas. O que muda entre as colunas é apenas <em>quanto</em> vai para renda fixa.</>
          ) : (
            <>O que muda entre as colunas é <em>quanto</em> vai para renda fixa; <em>qual</em> título só o
            questionário resolve.</>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {treasury.suggestions.length === 0 ? (
          <p className="text-sm text-muted-foreground text-pretty">{SUGGESTION_NOTE.tesouro_indisponivel}</p>
        ) : (
          treasury.suggestions.map((t, index) => (
            <div key={`${t.bondType}-${t.maturityDate}`} className={index === 0 ? "" : "opacity-70"}>
              <div className="text-sm flex flex-wrap gap-x-2 items-baseline">
                <span className="font-medium">{t.bondType} {maturityYear(t.maturityDate)}</span>
                <span className="font-mono text-xs">{t.rateLabel}</span>
              </div>
              {/* O primeiro é a recomendação; os outros existem para o usuário ver o
                  contraponto, então só o primeiro leva a justificativa. */}
              {index === 0 && <p className="text-xs text-muted-foreground text-pretty mt-0.5">{t.reason}</p>}
              <p className="text-xs text-muted-foreground mt-0.5">
                A partir de {formatCurrency(t.minimumInvestment)} · taxa de {rateVintage(t.baseDate)}
              </p>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export default function CarteiraDePartida() {
  const [input, setInput] = useState("");
  const [amount, setAmount] = useState<number | null>(null);
  const params = amount != null ? { amount } : undefined;
  const { data, isLoading } = useGetStarterPortfolios(params, {
    query: { queryKey: getGetStarterPortfoliosQueryKey(params) },
  });

  const declared = data?.declaredClassification ?? null;
  const [tab, setTab] = useState<string | null>(null);
  const activeTab = tab ?? declared ?? "Moderado";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Carteira de Partida</h1>
        <p className="text-muted-foreground text-pretty">
          Como um investidor de cada perfil montaria a carteira do zero — para você ver o caminho antes de
          cadastrar o primeiro ativo.
        </p>
      </div>

      {/* O pedido central da tela: dizer que o enquadramento ainda não foi feito. */}
      {declared == null ? (
        <Card className="border-primary/40">
          <CardContent className="pt-6 flex flex-col sm:flex-row sm:items-center gap-3">
            <ClipboardList className="w-5 h-5 shrink-0 text-primary" />
            <p className="text-sm text-pretty flex-1">
              Estas três carteiras são pontos de partida por perfil.{" "}
              <strong className="font-medium">Você ainda não respondeu o questionário de perfil</strong>, então o app
              não sabe em qual delas você se encaixa — e não vai adivinhar. São oito perguntas.
            </p>
            <Button asChild className="shrink-0">
              <Link href="/settings">Responder o questionário</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-6 flex flex-col sm:flex-row sm:items-center gap-3">
            <ClipboardList className="w-5 h-5 shrink-0 text-muted-foreground" />
            {/* div e não p: o Badge renderiza um div, e um bloco dentro de <p> é
                aninhamento inválido — o React reclama e o HTML quebra o parágrafo. */}
            <div className="text-sm text-pretty flex-1">
              Seu perfil declarado é <Badge variant={CLASSIFICATION_BADGE[declared] ?? "default"}>{declared}</Badge>{" "}
              — a coluna dele fica destacada. As outras duas continuam à vista de propósito: é o contraste entre elas
              que mostra o que o perfil decide.
            </div>
            <Button asChild variant="outline" className="shrink-0">
              <Link href="/settings">Refazer o questionário</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {data?.hasAssets && (
        <p className="text-sm text-amber-700 dark:text-amber-500 flex gap-1.5 items-start">
          <Wallet className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span className="text-pretty">
            Você já tem ativos cadastrados, e esta tela <strong className="font-medium">ignora</strong> o que existe —
            ela sempre monta do zero. Para ajustar a carteira que você já tem, use Saúde do Portfólio, que compara o
            atual com o alvo.
          </span>
        </p>
      )}

      {/* Vem antes das carteiras porque vem antes delas na vida real. Não é conselho
          inventado: é a mesma regra que faz o motor do Tesouro sugerir o Selic enquanto
          a reserva não está formada — e a segunda frase só aparece nesse caso, porque
          com o questionário respondido o motor pode sugerir outro título e a afirmação
          deixaria de ser verdade. */}
      <p className="text-sm text-muted-foreground flex gap-1.5 items-start">
        <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span className="text-pretty">
          Antes de qualquer uma das três: reserva de emergência. Nenhuma delas funciona se um imprevisto obrigar você
          a vender no pior momento.
          {declared == null && (
            <> É por isso que, sem o questionário respondido, o título sugerido abaixo é o único que permite sacar a
            qualquer hora sem risco de prejuízo na saída.</>
          )}
        </span>
      </p>

      <form
        className="flex items-end gap-2 max-w-md"
        onSubmit={(e) => { e.preventDefault(); setAmount(Number(input) || null); }}
      >
        <div className="flex-1 space-y-1">
          <Label htmlFor="starter-amount" className="text-xs">Com quanto você pretende começar? (opcional)</Label>
          <Input
            id="starter-amount"
            type="number"
            min={1}
            step="0.01"
            placeholder="Só os percentuais, sem valor"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="font-mono"
          />
        </div>
        <Button type="submit" disabled={!Number(input)}>Converter em reais</Button>
      </form>

      {isLoading && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {[0, 1, 2].map((i) => <Card key={i} className="h-96 animate-pulse bg-muted/20" />)}
        </div>
      )}

      {data && (
        <>
          {/* Desktop: as três lado a lado, que é o ponto da tela. Mobile: abas, porque
              três cartões empilhados viram três telas e o contraste se perde. */}
          <div className="hidden lg:grid lg:grid-cols-3 gap-6">
            {data.profiles.map((profile) => (
              <ProfileColumn
                key={profile.classification}
                profile={profile}
                amount={data.amount ?? null}
                highlighted={profile.classification === declared}
              />
            ))}
          </div>

          <Tabs value={activeTab} onValueChange={setTab} className="lg:hidden">
            <TabsList className="grid w-full grid-cols-3">
              {data.profiles.map((profile) => (
                <TabsTrigger key={profile.classification} value={profile.classification}>
                  {profile.classification}
                </TabsTrigger>
              ))}
            </TabsList>
            {data.profiles.map((profile) => (
              <TabsContent key={profile.classification} value={profile.classification} className="mt-4">
                <ProfileColumn profile={profile} amount={data.amount ?? null} highlighted={profile.classification === declared} />
              </TabsContent>
            ))}
          </Tabs>

          <TreasuryBlock treasury={data.treasury} hasProfile={declared != null} />

          {/* A nota de origens. Sem ela a tela apresentaria três números de credibilidades
              diferentes com o mesmo peso — que é exatamente o erro que uma tela de
              primeiro acesso não pode cometer. */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><Compass className="w-4 h-4" /> De onde vem cada número</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p className="text-pretty">
                <strong className="font-medium text-foreground">Renda fixa × renda variável (80/60/30)</strong> — é
                praxe de mercado, o ponto médio das faixas usadas para cada perfil. É o número em que esta tela mais
                se apoia.
              </p>
              <p className="text-pretty">
                <strong className="font-medium text-foreground">A divisão da parte variável</strong> (metade em ações,
                o resto entre FIIs e ETFs) <strong className="font-medium text-foreground">não</strong> é praxe
                consagrada — não existe consenso comparável sobre isso. É uma convenção deste app, e serve como ponto
                de partida declarado. Você pode alterá-la em Saúde do Portfólio depois de ter carteira.
              </p>
              <p className="text-pretty">
                <strong className="font-medium text-foreground">Os ativos listados</strong> são os mais bem colocados
                da varredura vigente na classe, ordenados pelo risco que combina com o perfil da coluna — os mesmos
                critérios da tela de Oportunidades. São candidatos para você estudar, não recomendação de compra.
              </p>
              <p className="text-pretty">
                Esta tela não cadastra nada por você. Quando comprar de verdade, registre o ativo em Minha Carteira
                com o preço e a data da nota de corretagem — é assim que o preço médio sai certo.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
