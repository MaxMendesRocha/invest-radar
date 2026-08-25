/**
 * Configuração visual dos status de análise, compartilhada entre a tela de Análise
 * e a de Minha Carteira. Antes cada uma tinha o seu mapa: a Carteira exibia o enum
 * cru ("POSSIVEL_SAIDA") e usava variantes de Badge cuja intensidade não
 * correspondia à gravidade.
 */
export interface AnalysisStatusConfig {
  label: string;
  className: string;
}

const GREEN = "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20";
const BLUE = "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20";
const YELLOW = "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20";
const ORANGE = "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20";
const RED = "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20";

/** Cinza: AGUARDAR não é gravidade, é ausência de base — não pode competir por atenção. */
const GRAY = "bg-muted text-muted-foreground border-border";

export const ANALYSIS_STATUS: Record<string, AnalysisStatusConfig> = {
  COMPRAR: { label: "Comprar", className: GREEN },
  MANTER: { label: "Manter", className: BLUE },
  VENDER: { label: "Vender", className: RED },

  // Dado insuficiente. Deliberadamente neutro e não amarelo/laranja: as outras cores
  // dizem algo sobre o ATIVO, e este status não diz nada sobre o ativo — diz que o app
  // não tem base para falar. Pintar de alerta faria o usuário ler "cuidado com esse
  // papel" onde o que existe é "não sei".
  AGUARDAR: { label: "Aguardar dados", className: GRAY },

  // Status da régua antiga de 4 níveis. Ficam aqui porque as linhas já gravadas em
  // `analyses` só passam a usar o vocabulário novo na próxima geração — sem isso
  // elas cairiam no fallback e apareceriam como "Manter", trocando um alerta por
  // um estado neutro. Podem sair depois que todas as análises forem regeneradas.
  ATENCAO: { label: "Atenção", className: YELLOW },
  REAVALIAR: { label: "Reavaliar", className: ORANGE },
  POSSIVEL_SAIDA: { label: "Possível Saída", className: RED },
};

export function analysisStatusConfig(status: string | null | undefined): AnalysisStatusConfig {
  return ANALYSIS_STATUS[status ?? ""] ?? ANALYSIS_STATUS.MANTER;
}

/**
 * O mesmo VENDER vinha de duas causas que pedem ações opostas, e a palavra sozinha não
 * distinguia — quem lia não sabia se devia vender tudo ou parte.
 *
 * "Reduzir" quando o problema é o TAMANHO da posição: o ativo pode ser ótimo, e a
 * resposta é vender só o excedente. Laranja e não vermelho porque não é um problema de
 * qualidade do ativo.
 *
 * "Vender" continua quando o problema é o ATIVO, e aí o rótulo não sugere quantidade
 * nenhuma de propósito: quanto reduzir de um papel cuja tese piorou depende de
 * convicção e prazo, e o app não tem como decidir isso.
 */
export function analysisStatusConfigFor(
  status: string | null | undefined,
  statusReason: string | null | undefined,
): AnalysisStatusConfig {
  if (status === "VENDER" && statusReason === "concentracao") {
    return { label: "Reduzir", className: ORANGE };
  }
  return analysisStatusConfig(status);
}
