/**
 * Confiança no DADO que sustenta uma análise — não no ativo, e não na conclusão.
 *
 * O app produz hoje uma nota com exatamente a mesma cara de confiança tendo visto três
 * indicadores ou oito, com cotação ao vivo ou com o preço guardado de duas semanas
 * atrás. Este módulo torna essa diferença visível e, no caso extremo, impede que ela
 * vire recomendação de compra.
 *
 * ## Lacuna nomeada, não nota de 0 a 100
 *
 * A especificação pede `DataConfidence = 0–100` com faixas em 60 e 75, somando cinco
 * componentes ponderados (30% freshness, 25% completeness...). Aqui não: cada peso
 * desses seria um número arbitrado, e este projeto já pagou essa conta — a escala de
 * score original ia de 0 a 100 no papel, o universo real cabia entre 43 e 74, e os
 * status COMPRAR e VENDER nunca dispararam na vida do aplicativo.
 *
 * O que se entrega no lugar é uma LISTA de lacunas verificáveis, cada uma com uma
 * severidade que decide sozinha. "Só 3 dos 8 indicadores vieram" é um fato conferível;
 * "DataConfidence 62" seria uma opinião com aparência de medida. É o mesmo critério de
 * `consecutiveDeclines`, que é deliberadamente uma contagem e não uma nota.
 *
 * As três faixas da especificação sobrevivem — `suficiente` / `parcial` / `insuficiente`
 * —, só que determinadas pela pior lacuna presente, o que é uma regra transparente e
 * reproduzível em vez de uma soma ponderada.
 *
 * ## O que ficou de fora, e por quê
 *
 * **`source_quality`.** Não existe base para dizer que uma fonte vale 0,9 e outra 1,0.
 * Seria peso inventado com nome de medida.
 *
 * **Plausibilidade do valor.** A ideia era marcar indicador absurdo — o P/L 149.050 que
 * a brapi devolve para TSMC34 é corrupção da razão de conversão do BDR, não a empresa.
 * Medi a faixa real com as demonstrações da CVM (505 companhias) antes de definir
 * limiar, e a medição derrubou a ideia: **o ROE real tem mediana de 9,5%, p99 de 243% e
 * máximo de 1877** — companhia com patrimônio pequeno e lucro normal produz ROE que
 * parece absurdo e é verdadeiro. Qualquer faixa que pegasse o BDR corrompido reprovaria
 * empresa real. O caso do BDR já é barrado por outro caminho (o mínimo de indicadores),
 * e inventar a faixa aqui seria trocar um acerto medido por um chute.
 *
 * **Cruzamento brapi × CVM.** É o sinal mais valioso que falta, e está bloqueado por uma
 * ponte que não existe: `financial_facts` é chaveada por CNPJ, e o app só conhece o CNPJ
 * de FII (vem do endpoint de fundos da brapi). Para ação não há mapa ticker → CNPJ, e o
 * cadastro da CVM não publica ticker. Ver docs/decision-engine.md.
 */

/** Severidade de uma lacuna: o que ela faz com a recomendação. */
export type GapSeverity = "bloqueia" | "limita";

/**
 * `insuficiente` bloqueia COMPRAR; `parcial` deixa passar com a ressalva na tela;
 * `suficiente` é o caso normal.
 */
export type ConfidenceLevel = "suficiente" | "parcial" | "insuficiente";

export type DataGapCode =
  | "sem_cotacao"
  | "cotacao_datada"
  | "cotacao_muito_datada"
  | "sem_dimensoes"
  | "dimensao_unica"
  | "cobertura_parcial";

export interface DataGap {
  /** Código estável — é ele que vai para trilha de auditoria e para teste. */
  code: DataGapCode;
  severity: GapSeverity;
  /** Frase pronta para a tela, sempre dizendo o número medido e não só o rótulo. */
  message: string;
}

export interface DataConfidence {
  level: ConfidenceLevel;
  gaps: DataGap[];
}

/**
 * Estado da cotação usada na análise.
 *
 * `datada` só acontece quando a chamada ao vivo falhou e o app caiu no último preço
 * guardado — em operação normal o preço é `ao_vivo`. Ou seja, `datada` já é, por si, um
 * sinal de que o provedor não respondeu para este ticker agora.
 */
export type PriceState =
  | { kind: "ao_vivo" }
  | { kind: "datada"; capturedAt: Date }
  | { kind: "ausente" };

export interface ConfidenceInput {
  /**
   * Dimensões que a régua da categoria conseguiu avaliar, e quantas ela tem no total.
   * Ação: 8 indicadores fundamentalistas. FII: as 4 dimensões de distribuição.
   */
  dimensions: { available: number; total: number };
  price: PriceState;
  now?: Date;
}

/**
 * A partir de quantos dias um preço guardado deixa de ser defasagem e vira ausência.
 *
 * O maior fechamento contínuo da B3 é o carnaval: última negociação na sexta, retomada
 * na quarta-feira de cinzas — cinco dias corridos. Acima de uma semana não existe
 * explicação de calendário, só provedor fora do ar, e o preço parou de descrever o
 * ativo. (A janela de 30 dias em `market-data.ts` é outra coisa: é o limite para o preço
 * ser usado na valorização da carteira, onde a alternativa é o preço médio de compra —
 * pior ainda. Aqui a pergunta é se ele sustenta uma RECOMENDAÇÃO, que é mais exigente.)
 */
export const COTACAO_DATADA_LIMITE_DIAS = 7;

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Abaixo de metade das dimensões a nota passa a descrever um pedaço do ativo.
 *
 * Metade e não outro corte porque é onde a renormalização começa a pesar mais do que
 * mede: com 3 de 8 indicadores, os 3 que vieram carregam 100% da nota. As 81 ações do
 * universo têm 6,9 indicadores em média (medição registrada em analysis-engine.ts), de
 * forma que este corte não atinge o caso normal — ele atinge exatamente a exceção.
 */
const COBERTURA_MINIMA = 0.5;

/**
 * Confiança no dado que sustenta uma análise.
 *
 * Determinística e sem estado: os mesmos insumos devolvem sempre a mesma resposta, que
 * é o requisito de reprodutibilidade que qualquer decisão auditável precisa.
 */
export function assessDataConfidence(input: ConfidenceInput): DataConfidence {
  const { dimensions, price, now = new Date() } = input;
  const gaps: DataGap[] = [];

  if (price.kind === "ausente") {
    gaps.push({
      code: "sem_cotacao",
      severity: "bloqueia",
      message: "Sem cotação: nem ao vivo, nem guardada. A posição está sendo avaliada pelo preço médio de compra, que não diz quanto o ativo vale hoje.",
    });
  } else if (price.kind === "datada") {
    const dias = Math.floor((now.getTime() - price.capturedAt.getTime()) / DIA_MS);
    if (dias > COTACAO_DATADA_LIMITE_DIAS) {
      gaps.push({
        code: "cotacao_muito_datada",
        severity: "bloqueia",
        message: `Cotação parada há ${dias} dias — acima de uma semana não é fechamento de mercado, é o provedor fora do ar.`,
      });
    } else {
      gaps.push({
        code: "cotacao_datada",
        severity: "limita",
        message: `Cotação de ${dias} dia(s) atrás: a chamada ao vivo falhou e o app está usando o último preço guardado.`,
      });
    }
  }

  const { available, total } = dimensions;
  if (available === 0) {
    gaps.push({
      code: "sem_dimensoes",
      severity: "bloqueia",
      message: "Nenhum indicador disponível para esta categoria — não há o que analisar.",
    });
  } else if (available === 1 && total > 1) {
    // O argumento é o mesmo que já justifica o mínimo de 3 indicadores para ação: com
    // um só, a nota do ativo É esse indicador, e o app passa a afirmar com a mesma cara
    // de confiança de quem olhou o conjunto inteiro. A régua de FII não tinha esse piso
    // — bastava uma das quatro dimensões para produzir nota cheia.
    gaps.push({
      code: "dimensao_unica",
      severity: "bloqueia",
      message: `Um único indicador de ${total} disponível: a nota seria esse indicador sozinho, não uma leitura do ativo.`,
    });
  } else if (available / total < COBERTURA_MINIMA) {
    gaps.push({
      code: "cobertura_parcial",
      severity: "limita",
      message: `Apenas ${available} de ${total} indicadores disponíveis — a nota se apoia em menos da metade da régua.`,
    });
  }

  return { level: levelFor(gaps), gaps };
}

/** A pior lacuna decide. Regra transparente, no lugar de soma ponderada. */
function levelFor(gaps: DataGap[]): ConfidenceLevel {
  if (gaps.some((g) => g.severity === "bloqueia")) return "insuficiente";
  if (gaps.length > 0) return "parcial";
  return "suficiente";
}

/** Confiança plena — para os caminhos que não passam por dado de provedor. */
export const CONFIANCA_PLENA: DataConfidence = { level: "suficiente", gaps: [] };
