/**
 * Configuração visual dos status de análise, compartilhada entre a tela de Análise
 * e a de Minha Carteira. Antes cada uma tinha o seu mapa: a Carteira exibia o enum
 * cru ("POSSIVEL_SAIDA") e usava variantes de Badge cuja intensidade não
 * correspondia à gravidade.
 *
 * A ordem das cores segue a gravidade — verde, amarelo, laranja, vermelho. Até
 * então "Atenção" era laranja e "Reavaliar" amarelo, invertendo os dois: pelo
 * score, Reavaliar (40-59) é pior que Atenção (60-74).
 */
export interface AnalysisStatusConfig {
  label: string;
  className: string;
}

export const ANALYSIS_STATUS: Record<string, AnalysisStatusConfig> = {
  MANTER: {
    label: "Manter",
    className: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
  },
  ATENCAO: {
    label: "Atenção",
    className: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20",
  },
  REAVALIAR: {
    label: "Reavaliar",
    className: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20",
  },
  POSSIVEL_SAIDA: {
    label: "Possível Saída",
    className: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
  },
};

export function analysisStatusConfig(status: string | null | undefined): AnalysisStatusConfig {
  return ANALYSIS_STATUS[status ?? ""] ?? ANALYSIS_STATUS.MANTER;
}
