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

export const ANALYSIS_STATUS: Record<string, AnalysisStatusConfig> = {
  COMPRAR: { label: "Comprar", className: GREEN },
  MANTER: { label: "Manter", className: BLUE },
  VENDER: { label: "Vender", className: RED },

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
