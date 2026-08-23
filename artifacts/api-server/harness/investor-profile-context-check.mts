import { describeInvestorProfile, toProfileContext, PROFILE_PROMPT_GUIDANCE, type InvestorProfileContext } from "../src/lib/investor-profile-context";

let failures = 0;
function check(label: string, condition: boolean, detail: string): void {
  console.log(`${condition ? "OK  " : "FALHA"} ${label}`);
  if (!condition) {
    console.log(`      ${detail}`);
    failures++;
  }
}

const empty: InvestorProfileContext = {
  classification: null, horizon: null, horizonYears: null, lossTolerance: null, objective: null,
  experience: null, liquidityNeed: null, emergencyFund: null, portfolioShare: null, incomeStability: null,
};
const ctx = (over: Partial<InvestorProfileContext>): InvestorProfileContext => ({ ...empty, ...over });

// ── Ausência é ausência ─────────────────────────────────────────────────────
// Sem perfil o prompt não ganha linha nenhuma: "horizonte não declarado" e "horizonte
// curto" levam a conselhos opostos, e chutar entre os dois é pior que omitir.
{
  check("sem perfil -> null", describeInvestorProfile(null) === null, "devolveu texto");
  check("perfil todo vazio -> null", describeInvestorProfile(empty) === null, String(describeInvestorProfile(empty)));
  check("toProfileContext(null) -> null", toProfileContext(null) === null, "devolveu objeto");
}

// ── Campo preenchido isolado já rende linha ─────────────────────────────────
{
  const only = describeInvestorProfile(ctx({ objective: "renda" }));
  check("só objetivo já produz linha", only != null && only.includes("gerar renda corrente"), String(only));
  check("não inventa os campos ausentes",
    only != null && !only.includes("horizonte") && !only.includes("tolerância"), String(only));
}

// ── Reserva de emergência ausente é destaque, não nota de rodapé ────────────
// É o fator mais concreto do perfil e o mais fácil de esquecer numa análise ativo a
// ativo: sem reserva, qualquer imprevisto vira venda forçada no preço do dia.
{
  const sem = describeInvestorProfile(ctx({ classification: "Conservador", emergencyFund: "nao" }));
  check("sem reserva -> alerta explícito", sem != null && sem.includes("NÃO ter reserva de emergência"), String(sem));

  const com = describeInvestorProfile(ctx({ classification: "Conservador", emergencyFund: "sim" }));
  check("com reserva -> não vira ruído", com != null && !com.includes("reserva de emergência"), String(com));
}

// ── Rótulos legíveis, não os valores crus do banco ──────────────────────────
{
  const t = describeInvestorProfile(ctx({ experience: "avancado", lossTolerance: "media", horizon: "medio" }));
  check("experiência acentuada", t != null && t.includes("avançada"), String(t));
  check("tolerância acentuada", t != null && t.includes("média"), String(t));
  check("horizonte legível", t != null && t.includes("médio prazo"), String(t));
  check("valor cru do banco não vaza", t != null && !t.includes("avancado") && !t.includes("medio"), String(t));
}

// ── Horizonte em anos, quando declarado ─────────────────────────────────────
{
  const comAnos = describeInvestorProfile(ctx({ horizon: "longo", horizonYears: 25 }));
  check("horizonte com anos", comAnos != null && comAnos.includes("(25 anos)"), String(comAnos));
  const semAnos = describeInvestorProfile(ctx({ horizon: "longo" }));
  check("horizonte sem anos não inventa número",
    semAnos != null && !semAnos.includes("anos)"), String(semAnos));
}

// ── Perfis opostos produzem textos diferentes ───────────────────────────────
// É o ponto do recurso: o prompt deixava de distinguir quem acumula de quem vive de renda.
{
  const renda = describeInvestorProfile(ctx({
    classification: "Conservador", objective: "renda", horizon: "curto",
    liquidityNeed: "sim", emergencyFund: "nao", incomeStability: "instavel",
  }));
  const cresc = describeInvestorProfile(ctx({
    classification: "Arrojado", objective: "crescimento", horizon: "longo",
    liquidityNeed: "nao", emergencyFund: "sim", incomeStability: "estavel",
  }));
  check("perfis opostos geram textos diferentes", renda !== cresc, "textos idênticos");
  check("só o de renda menciona resgate antecipado",
    renda!.includes("resgatar") && !cresc!.includes("resgatar"), `${renda}\n---\n${cresc}`);
  check("renda estável não vira linha", !cresc!.includes("Renda pessoal"), String(cresc));
}

// ── A diretriz protege a régua determinística ───────────────────────────────
// A IA narra; score e status vêm do motor. Se esta instrução sumir do prompt, o perfil
// deixa de calibrar o tom e passa a poder contaminar o veredito.
{
  check("diretriz proíbe mexer em status/score",
    PROFILE_PROMPT_GUIDANCE.includes("nunca para mudar o status ou o score"),
    PROFILE_PROMPT_GUIDANCE.slice(0, 120));
}

if (failures > 0) {
  console.log(`\n${failures} caso(s) falharam.`);
  process.exit(1);
}
console.log("\nTodos os casos passaram.");
