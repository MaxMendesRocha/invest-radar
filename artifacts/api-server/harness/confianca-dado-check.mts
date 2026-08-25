import {
  assessDataConfidence,
  COTACAO_DATADA_LIMITE_DIAS,
  CONFIANCA_PLENA,
  type PriceState,
} from "../src/lib/data-confidence-engine";
import {
  resolveAnalysisStatus,
  resolveStatusReason,
  screenForPurchase,
  concentrationLimitsFor,
  BUY_SCORE_THRESHOLD,
  type AnalysisResult,
} from "../src/lib/analysis-engine";

/**
 * O portão de dado insuficiente.
 *
 * O que estes casos protegem não é o cálculo — é a RECUSA. O app produzia uma nota com a
 * mesma cara de confiança tendo visto três indicadores ou oito, e a partir dela dizia
 * "Comprar". Os casos abaixo fixam quando ele passa a dizer "não sei" em vez disso, e —
 * igualmente importante — quando ele NÃO deve calar.
 *
 * As asserções são todas sobre funções puras — mesmos insumos, mesma resposta, que é o
 * requisito de reprodutibilidade de qualquer decisão auditável. Ainda assim o harness
 * PRECISA de `DATABASE_URL` no ambiente: `analysis-engine` importa `market-data`, que
 * abre a conexão no carregamento do módulo. Nenhuma consulta é feita aqui; é só o grafo
 * de import cobrando a variável.
 *
 *   DATABASE_URL=... node harness/confianca-dado-check.mts
 */

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FALHA"} ${label}\n      obtido   ${a}\n      esperado ${e}`);
}

const AO_VIVO: PriceState = { kind: "ao_vivo" };
const HOJE = new Date("2026-08-25T12:00:00Z");
const diasAtras = (n: number): PriceState => ({
  kind: "datada",
  capturedAt: new Date(HOJE.getTime() - n * 24 * 60 * 60 * 1000),
});

// --- Cobertura de indicadores ---------------------------------------------

console.log("--- cobertura ---");

check("oito de oito indicadores não gera lacuna",
  assessDataConfidence({ dimensions: { available: 8, total: 8 }, price: AO_VIVO }).level, "suficiente");

// Metade é o corte: com menos que isso os indicadores presentes carregam 100% da nota
// depois da renormalização. As 81 ações do universo têm 6,9 em média, então o corte
// atinge a exceção e não o caso normal.
check("quatro de oito (metade exata) ainda é suficiente",
  assessDataConfidence({ dimensions: { available: 4, total: 8 }, price: AO_VIVO }).level, "suficiente");

check("três de oito vira parcial",
  assessDataConfidence({ dimensions: { available: 3, total: 8 }, price: AO_VIVO }).level, "parcial");

check("três de oito nomeia a lacuna",
  assessDataConfidence({ dimensions: { available: 3, total: 8 }, price: AO_VIVO }).gaps.map((g) => g.code),
  ["cobertura_parcial"]);

// O caso concreto que motivou o portão: a régua de FII não tinha piso, então bastava
// UMA das quatro dimensões (yield, peso 35%) para o fundo sair com nota cheia depois da
// renormalização. A de ação já se protegia com o mínimo de 3 indicadores.
check("uma dimensão de quatro bloqueia (o buraco da régua de FII)",
  assessDataConfidence({ dimensions: { available: 1, total: 4 }, price: AO_VIVO }).level, "insuficiente");

check("duas de quatro é parcial, não bloqueia",
  assessDataConfidence({ dimensions: { available: 2, total: 4 }, price: AO_VIVO }).level, "suficiente");

check("nenhuma dimensão bloqueia",
  assessDataConfidence({ dimensions: { available: 0, total: 4 }, price: AO_VIVO }).gaps.map((g) => g.code),
  ["sem_dimensoes"]);

// --- Cotação ---------------------------------------------------------------

console.log("\n--- cotação ---");

check("cotação ao vivo não gera lacuna",
  assessDataConfidence({ dimensions: { available: 8, total: 8 }, price: AO_VIVO }).level, "suficiente");

check("sem cotação bloqueia",
  assessDataConfidence({ dimensions: { available: 8, total: 8 }, price: { kind: "ausente" } }).gaps.map((g) => g.code),
  ["sem_cotacao"]);

// Fronteira do limite: o maior fechamento contínuo da B3 é o carnaval (sexta a quarta,
// cinco dias corridos), então até uma semana ainda cabe em calendário. Acima disso é
// provedor fora do ar. Os três casos abaixo cercam o limite dos dois lados.
check(`cotação de ${COTACAO_DATADA_LIMITE_DIAS} dias limita, mas não bloqueia`,
  assessDataConfidence({ dimensions: { available: 8, total: 8 }, price: diasAtras(COTACAO_DATADA_LIMITE_DIAS), now: HOJE }).level,
  "parcial");

check(`cotação de ${COTACAO_DATADA_LIMITE_DIAS + 1} dias bloqueia`,
  assessDataConfidence({ dimensions: { available: 8, total: 8 }, price: diasAtras(COTACAO_DATADA_LIMITE_DIAS + 1), now: HOJE }).level,
  "insuficiente");

check("cotação de 1 dia já aparece como lacuna (a chamada ao vivo falhou)",
  assessDataConfidence({ dimensions: { available: 8, total: 8 }, price: diasAtras(1), now: HOJE }).gaps.map((g) => g.code),
  ["cotacao_datada"]);

// --- O portão sobre o status ----------------------------------------------

console.log("\n--- portão ---");

const LIMITES = concentrationLimitsFor("Moderado"); // high 25, critical 40
const INSUFICIENTE = assessDataConfidence({ dimensions: { available: 1, total: 4 }, price: AO_VIVO });
const PARCIAL = assessDataConfidence({ dimensions: { available: 3, total: 8 }, price: AO_VIVO });

check("score alto com dado insuficiente NÃO vira COMPRAR",
  resolveAnalysisStatus(95, 5, LIMITES, INSUFICIENTE), "AGUARDAR");

check("score alto com dado suficiente continua COMPRAR",
  resolveAnalysisStatus(95, 5, LIMITES, CONFIANCA_PLENA), "COMPRAR");

check("dado parcial não impede COMPRAR — só limita",
  resolveAnalysisStatus(95, 5, LIMITES, PARCIAL), "COMPRAR");

// Score baixo com dado ruim não é acusação: a nota pode estar baixa só porque metade
// dos indicadores não veio. AGUARDAR, e não VENDER.
check("score baixo com dado insuficiente não acusa o ativo",
  resolveAnalysisStatus(20, 5, LIMITES, INSUFICIENTE), "AGUARDAR");

check("e não inventa motivo de fundamento",
  resolveStatusReason(20, 5, LIMITES, INSUFICIENTE), null);

// A outra ponta, e é a que importa não errar: concentração é aritmética sobre a carteira
// da própria pessoa. Não depende de provedor nenhum, então continua valendo mesmo quando
// o app não sabe mais nada sobre o ativo. Calar sobre 60% do patrimônio num papel só
// porque a cotação envelheceu seria trocar um alerta real por silêncio.
check("concentração crítica sobrevive ao portão",
  resolveAnalysisStatus(95, 60, LIMITES, INSUFICIENTE), "VENDER");

check("e o motivo é só a concentração",
  resolveStatusReason(95, 60, LIMITES, INSUFICIENTE), "concentracao");

// --- O portão sobre a triagem pré-compra ----------------------------------

console.log("\n--- triagem pré-compra ---");

function resultado(score: number, confidence: AnalysisResult["confidence"]): AnalysisResult {
  return {
    available: true, score, scoreClassification: "Excelente", status: "COMPRAR",
    statusReason: null, positives: [], risks: [], monitoringRecommendation: "", confidence,
  };
}

check("acima do corte com dado bom atende",
  screenForPurchase(resultado(BUY_SCORE_THRESHOLD, CONFIANCA_PLENA)).outcome, "atende");

// "sem_dados" e não "nao_atende": as duas frases dizem coisas diferentes. "Não atende"
// afirma que a régua foi aplicada e o ativo ficou abaixo do corte; com dado insuficiente
// a régua não chegou a ser aplicada, e reprovar o ativo por falha do provedor seria o
// mesmo erro do outro lado.
check("acima do corte com dado insuficiente não vira veredito sobre o ativo",
  screenForPurchase(resultado(95, INSUFICIENTE)).outcome, "sem_dados");

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
