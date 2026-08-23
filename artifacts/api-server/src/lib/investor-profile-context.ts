import type { InvestorProfile } from "@workspace/db";

/**
 * Traduz o perfil declarado do investidor em texto para o prompt.
 *
 * Existe porque o perfil estava sendo lido e quase todo descartado: o app buscava a
 * linha inteira e usava só `classification`, para derivar os limites de concentração.
 * Objetivo, horizonte, reserva de emergência e estabilidade de renda ficavam no banco
 * sem nunca chegar a quem escreve o texto — e o resultado era um parecer idêntico para
 * quem acumula com trinta anos pela frente e para quem já vive da renda da carteira.
 *
 * Nada aqui é inferido. Campo não preenchido simplesmente não vira linha, porque
 * "horizonte não declarado" e "horizonte curto" levam a conselhos opostos e chutar entre
 * os dois é pior que omitir.
 */

export interface InvestorProfileContext {
  classification: string | null;
  horizon: string | null;
  horizonYears: number | null;
  lossTolerance: string | null;
  objective: string | null;
  experience: string | null;
  liquidityNeed: string | null;
  emergencyFund: string | null;
  portfolioShare: string | null;
  incomeStability: string | null;
}

export function toProfileContext(profile: InvestorProfile | null | undefined): InvestorProfileContext | null {
  if (!profile) return null;
  return {
    classification: profile.classification ?? null,
    horizon: profile.horizon ?? null,
    horizonYears: profile.horizonYears ?? null,
    lossTolerance: profile.lossTolerance ?? null,
    objective: profile.objective ?? null,
    experience: profile.experience ?? null,
    liquidityNeed: profile.liquidityNeed ?? null,
    emergencyFund: profile.emergencyFund ?? null,
    portfolioShare: profile.portfolioShare ?? null,
    incomeStability: profile.incomeStability ?? null,
  };
}

const OBJECTIVE_LABEL: Record<string, string> = {
  preservar: "preservar patrimônio",
  renda: "gerar renda corrente",
  crescimento: "crescimento de patrimônio no longo prazo",
};

const HORIZON_LABEL: Record<string, string> = {
  curto: "curto prazo",
  medio: "médio prazo",
  longo: "longo prazo",
};

// O banco guarda os valores sem acento ("avancado", "medio"); o texto que vai pra IA
// não deveria herdar essa limitação de armazenamento.
const EXPERIENCE_LABEL: Record<string, string> = {
  iniciante: "iniciante",
  intermediario: "intermediária",
  avancado: "avançada",
};

const TOLERANCE_LABEL: Record<string, string> = {
  baixa: "baixa",
  media: "média",
  alta: "alta",
};

const SHARE_LABEL: Record<string, string> = {
  menos_25: "menos de 25%",
  de_25_50: "entre 25% e 50%",
  de_50_75: "entre 50% e 75%",
  mais_75: "mais de 75%",
};

/**
 * Linha de contexto do perfil, ou `null` quando não há perfil declarado.
 *
 * O texto é afirmativo sobre o que foi DECLARADO pela pessoa, não sobre o que ela
 * deveria fazer — a leitura continua sendo da IA, e a régua determinística (score,
 * status, limites de concentração) segue decidindo sozinha, como sempre.
 */
export function describeInvestorProfile(ctx: InvestorProfileContext | null): string | null {
  if (!ctx) return null;

  const parts: string[] = [];
  if (ctx.classification) parts.push(`perfil declarado ${ctx.classification}`);
  if (ctx.objective) parts.push(`objetivo de ${OBJECTIVE_LABEL[ctx.objective] ?? ctx.objective}`);
  if (ctx.horizon) {
    parts.push(
      ctx.horizonYears != null
        ? `horizonte de ${HORIZON_LABEL[ctx.horizon] ?? ctx.horizon} (${ctx.horizonYears} anos)`
        : `horizonte de ${HORIZON_LABEL[ctx.horizon] ?? ctx.horizon}`,
    );
  }
  if (ctx.lossTolerance) parts.push(`tolerância a perda ${TOLERANCE_LABEL[ctx.lossTolerance] ?? ctx.lossTolerance}`);
  if (ctx.experience) parts.push(`experiência ${EXPERIENCE_LABEL[ctx.experience] ?? ctx.experience}`);
  if (parts.length === 0) return null;

  let line = `Perfil de quem é dono desta carteira: ${parts.join(", ")}.`;

  // Reserva de emergência é o fator de risco mais concreto do perfil e o mais fácil de
  // esquecer numa análise ativo a ativo: sem ela, qualquer necessidade de caixa vira
  // venda forçada, no preço que o mercado der no dia. Merece linha própria e explícita.
  if (ctx.emergencyFund === "nao") {
    line += " ATENÇÃO: a pessoa declarou NÃO ter reserva de emergência cobrindo 6 meses de despesa.";
  }
  if (ctx.liquidityNeed === "sim") {
    line += " Declarou que pode precisar resgatar este dinheiro antes do horizonte planejado.";
  }
  if (ctx.incomeStability === "instavel" || ctx.incomeStability === "variavel") {
    line += ` Renda pessoal ${ctx.incomeStability === "instavel" ? "instável" : "variável"}.`;
  }
  if (ctx.portfolioShare) {
    line += ` Esta carteira representa ${SHARE_LABEL[ctx.portfolioShare] ?? ctx.portfolioShare} do patrimônio total dela.`;
  }

  return line;
}

/**
 * Instrução de como USAR o perfil no texto. Separada da descrição porque a descrição é
 * dado e esta é diretriz — e porque as duas IAs (parecer de carteira e parecer
 * pré-compra) precisam da mesma orientação sem duplicar a redação.
 */
export const PROFILE_PROMPT_GUIDANCE =
  `Use o perfil para CALIBRAR o tom e o que priorizar, nunca para mudar o status ou o score — ` +
  `esses vêm da régua determinística e não se discutem. Objetivo de renda corrente muda o que ` +
  `importa num ativo (previsibilidade e consistência do provento pesam mais que valorização); ` +
  `objetivo de crescimento inverte isso. Horizonte curto ou necessidade declarada de liquidez ` +
  `tornam volatilidade e liquidez do papel muito mais relevantes que fundamentos de longo prazo. ` +
  `Ausência de reserva de emergência é o fator mais grave do perfil: mencione-a explicitamente ` +
  `quando estiver avaliando aumentar posição ou manter concentração alta, porque sem reserva ` +
  `qualquer imprevisto vira venda forçada no pior momento. Se a pessoa é iniciante, explique o ` +
  `raciocínio em vez de só concluir. Não repita os campos do perfil como lista — use-os para ` +
  `escolher o que dizer.`;
