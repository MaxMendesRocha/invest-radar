import { db, opportunitiesTable, sectorBenchmarksTable, type InsertOpportunity, type InsertSectorBenchmark } from "@workspace/db";
import { getFundamentals, getDividendEvents, getFiiProfiles, getTechnicalSeries, sumLast12Months, classifyDividendFrequency, type Fundamentals, type FiiProfile } from "./market-data";
import { analyzeFundamentals, analyzeFii } from "./analysis-engine";
import { getMacroSnapshot } from "./macro-data";
import { computeFinancialHealth } from "./financial-health-engine";
import { classifySustainabilityOf } from "./dividend-value-engine";
import { fetchTickerUniverse, type UniverseEntry } from "./ticker-universe";
import { describeOpportunity } from "./opportunities-ai";
import { benchmarkGroupFor, averageDailyVolumeValue, evalFiiEligibility } from "./fii-engine";
import { logger } from "./logger";
import type { JobDefinition } from "./scheduler";

// Fundamentos ruins não entram na lista de "sugestões" — continua sendo "do Estavel
// pra cima" na classificação do Radar, mas o piso do Estavel passou de 60 para 65 na
// recalibragem das faixas (ver scoreClassification em analysis-engine.ts). Sem mover
// isso junto, o corte teria passado a pegar também a faixa Atenção.
const MIN_OPPORTUNITY_SCORE = 65;

// Nível de risco determinístico a partir do beta real — comparando o BETA, não a nota
// que evalVolatility deriva dele. Antes isto lia `volatility.score >= 85`, o que
// funcionava por acidente enquanto as notas eram degraus fixos; com a curva
// interpolada a mesma comparação passaria a significar beta 0,66 em vez do 0,7
// documentado. Ler o beta direto mantém o limiar dizendo o que diz.
const LOW_BETA_CEILING = 0.7;
const MEDIUM_BETA_CEILING = 1.2;

function riskLevelFor(f: Fundamentals): "Baixo" | "Medio" | "Alto" {
  if (f.beta == null) return "Medio"; // sem beta disponível (comum em FII/ETF/BDR): neutro, não chutado pra baixo/alto
  if (f.beta <= LOW_BETA_CEILING) return "Baixo";
  if (f.beta <= MEDIUM_BETA_CEILING) return "Medio";
  return "Alto";
}

// Não existe fonte de dado real para "retorno potencial futuro" no plano atual —
// o módulo que traria preço-alvo de analistas (financial-data) retorna 403. Em vez
// de inventar um número, usamos uma heurística DOCUMENTADA e transparente:
// combina o score do Radar (0-100, já baseado em fundamentos reais) com o dividend
// yield real, num intervalo plausível (0% a 35%). Isso é uma estimativa interna do
// Radar, não uma previsão de mercado — se a brapi.dev algum dia expuser
// targetMeanPrice de verdade, trocar por (targetMeanPrice - price) / price aqui.
function computePotentialReturn(score: number, f: Fundamentals): number {
  const scoreComponent = Math.max(0, score - 50) * 0.5; // 0 a 25
  const dividendComponent = (f.dividendYield ?? 0) * 100 * 0.8; // dividend yield já é decimal
  return Math.round(Math.min(35, scoreComponent + dividendComponent) * 100) / 100;
}

// Abaixo disso, "média do setor" seria estatisticamente pouco confiável (2 empresas
// não representam um setor) — o setor inteiro fica de fora da tabela nesse caso,
// nunca publica uma média de amostra pequena demais.
const MIN_SECTOR_SAMPLE = 3;

/**
 * MEDIANA, não média. O nome das colunas em sector_benchmarks continua `avg_*` por
 * compatibilidade, mas o que elas guardam é a mediana — trocar isso exigiria uma
 * migração só para renomear.
 *
 * A diferença é material com amostra pequena: o MFII11, com DY declarado de 38% num
 * grupo de 4 fundos híbridos, puxava a MÉDIA do grupo para 21,75% e assim deixava de
 * parecer atípico contra uma referência que ele mesmo havia distorcido. A mediana
 * não se move com um extremo.
 *
 * Também alinha o número ao texto: a interface e os prompts sempre disseram
 * "mediana do setor".
 */
function median(values: (number | null)[]): number | null {
  return percentile(values, 0.5);
}

/**
 * Percentil por ordenação, sem interpolação — o valor devolvido é sempre um número que
 * uma companhia real do setor tem de fato.
 *
 * Interpolar entre dois vizinhos produziria um P/L que ninguém pratica, e a faixa de
 * entrada derivada dele afirmaria uma precisão que a amostra (mínimo de 3, ver
 * MIN_SECTOR_SAMPLE) não sustenta.
 */
const numeroOuNulo = (v: number | null): string | null => (v != null ? String(v) : null);

function percentile(values: (number | null)[], q: number): number | null {
  const real = values.filter((v): v is number => v != null).sort((a, b) => a - b);
  if (real.length === 0) return null;
  if (q === 0.5 && real.length % 2 === 0) {
    const mid = real.length / 2;
    return (real[mid - 1] + real[mid]) / 2;
  }
  return real[Math.min(real.length - 1, Math.floor(q * real.length))];
}

// Exportada para poder ser exercitada com um punhado de tickers reais sem rodar a
// varredura inteira, que faz uma chamada de IA por candidato. É de onde saem os quartis
// que a faixa de entrada de ação consome (stock-price-zones.ts), então conseguir rodá-la
// isolada é o que permite conferir a faixa contra dado de verdade.
//
// Médias setoriais reais a partir de TODO o universo com fundamentos disponíveis
// (não só os candidatos que passaram no score mínimo) — usar só os "aprovados" pra
// calcular a média enviesaria pra cima, fazendo qualquer ativo parecer caro por
// comparação. Setor vem de Fundamentals.sector (summaryProfile real da brapi.dev),
// mesma fonte já usada em sectorFor().
export function computeSectorBenchmarks(
  fundamentalsByTicker: Map<string, Fundamentals>,
  fiiProfileByTicker: Map<string, FiiProfile>,
): InsertSectorBenchmark[] {
  const bySector = new Map<string, Fundamentals[]>();
  for (const [ticker, f] of fundamentalsByTicker) {
    const group = benchmarkGroupFor(f, fiiProfileByTicker.get(ticker));
    if (!group) continue;
    if (!bySector.has(group)) bySector.set(group, []);
    bySector.get(group)!.push(f);
  }

  const rows: InsertSectorBenchmark[] = [];
  for (const [sector, list] of bySector) {
    if (list.length < MIN_SECTOR_SAMPLE) continue;
    const avgPriceEarnings = median(list.map((f) => f.priceEarnings));
    const avgPriceToBook = median(list.map((f) => f.priceToBook));
    const avgReturnOnEquity = median(list.map((f) => f.returnOnEquity));
    const avgDividendYield = median(list.map((f) => f.dividendYield));
    const avgProfitMargins = median(list.map((f) => f.profitMargins));
    rows.push({
      sector,
      avgPriceEarnings: avgPriceEarnings != null ? String(avgPriceEarnings) : null,
      avgPriceToBook: avgPriceToBook != null ? String(avgPriceToBook) : null,
      avgReturnOnEquity: avgReturnOnEquity != null ? String(avgReturnOnEquity) : null,
      avgDividendYield: avgDividendYield != null ? String(avgDividendYield) : null,
      avgProfitMargins: avgProfitMargins != null ? String(avgProfitMargins) : null,
      // Quartis de P/L e P/VP: é deles que sai a FAIXA de entrada em reais, e não só a
      // comparação "caro ou barato contra os pares". Mesmo scan, sem custo novo.
      p25PriceEarnings: numeroOuNulo(percentile(list.map((f) => f.priceEarnings), 0.25)),
      p75PriceEarnings: numeroOuNulo(percentile(list.map((f) => f.priceEarnings), 0.75)),
      p25PriceToBook: numeroOuNulo(percentile(list.map((f) => f.priceToBook), 0.25)),
      p75PriceToBook: numeroOuNulo(percentile(list.map((f) => f.priceToBook), 0.75)),
      sampleSize: list.length,
    });
  }
  return rows;
}

/**
 * Reescaneia TICKER_UNIVERSE com fundamentos reais, recalcula o score determinístico
 * de cada um (mesmo analyzeFundamentals do Radar por ativo) e substitui inteiramente
 * a tabela `opportunities` pelos que batem o score mínimo — tickers sem fundamentos
 * disponíveis simplesmente não entram, nunca com dado inventado. Chamada pelo
 * scheduler a cada semana (ver lib/scheduler.ts) e pelo endpoint interno de disparo
 * manual (routes/internal.ts).
 */
export async function regenerateOpportunities(): Promise<{ summary: string }> {
  const universe = await fetchTickerUniverse();

  // Universo vazio quase sempre significa que a brapi.dev está fora do ar ou o
  // token expirou — nesse caso não mexe na tabela existente (fica com os dados da
  // última rodada bem-sucedida) em vez de esvaziá-la sem ter nada real pra colocar.
  if (universe.length === 0) {
    logger.warn("regenerateOpportunities abortado: fetchTickerUniverse devolveu universo vazio");
    return { summary: "0 oportunidades geradas — universo de tickers indisponível, tabela não foi alterada" };
  }

  // dividendEvents em paralelo com fundamentals — o payout ratio avaliado dentro de
  // analyzeFundamentals precisa do DPS real dos últimos 12 meses, mesma fonte já usada
  // pra dividendTrend no Parecer de Ativo e em POST /analysis/generate.
  const fiiTickers = universe.filter((u) => u.category === "fiis").map((u) => u.ticker);

  const [fundamentalsByTicker, dividendEventsByTicker, fiiProfileByTicker, macro, fiiSeriesByTicker] = await Promise.all([
    getFundamentals(universe.map((u) => u.ticker)),
    getDividendEvents(universe.map((u) => ({ ticker: u.ticker, category: u.category }))),
    // Em lote (?symbols=A,B,C), uma chamada só — o segmento é o que permite comparar
    // FII contra os pares certos em vez de contra todos os FIIs juntos.
    getFiiProfiles(fiiTickers),
    // Selic: referência contra a qual o rendimento de FII é lido (ver analyzeFii).
    getMacroSnapshot(),
    // Só pros FIIs do universo, não pro universo inteiro — é a mesma série (1 ano,
    // cacheada 24h) que technical-engine.ts já usa noutro lugar, aqui reaproveitada
    // pra medir liquidez de negociação (ver evalFiiEligibility em fii-engine.ts).
    getTechnicalSeries(fiiTickers),
  ]);
  const now = Date.now();

  // Em paralelo — sequencial levava ~90s pra varrer o universo inteiro (uma
  // chamada real à Anthropic por ativo qualificado).
  const candidates = universe.map((entry) => {
    const fundamentals = fundamentalsByTicker.get(entry.ticker);
    if (!fundamentals) return null;
    const dividendEvents = dividendEventsByTicker.get(entry.ticker) ?? [];
    const dps12m = sumLast12Months(dividendEvents, now);
    // FII tem régua própria — a de ação trata P/VP e dividend yield de FII como se
    // fossem de empresa e devolve 90+ para todo mundo (ver analysis-engine.ts).
    const analysis =
      entry.category === "fiis"
        ? analyzeFii({
            profile: fiiProfileByTicker.get(entry.ticker) ?? null,
            dividendEvents,
            price: fundamentals.price,
            selicPercent: macro.selic,
          }, 0, undefined, now)
        : analyzeFundamentals(fundamentals, dps12m);
    if (!analysis.available || analysis.score < MIN_OPPORTUNITY_SCORE) return null;

    // Uma oportunidade é uma sugestão de compra, então o portão de dado insuficiente
    // vale aqui como vale na análise: sem base para afirmar, o ativo não entra na lista
    // em vez de entrar com a nota que os poucos indicadores disponíveis produziram. O
    // caso concreto é o FII avaliado só pelo yield — a renormalização levava um peso de
    // 35% a 100% e o fundo saía com nota alta apoiada num número só.
    if (analysis.confidence.level === "insuficiente") return null;

    // Elegibilidade de FII: liquidez de negociação e patrimônio, pisos medidos contra
    // o universo real (ver evalFiiEligibility). Score bom não basta — um FII com
    // fundamentos excelentes mas negociado a menos de R$700 mil/dia é uma sugestão
    // que a pessoa não consegue montar posição relevante sem mover o próprio preço.
    // Só se aplica a FII: o critério de liquidez pedido foi especificamente para FII,
    // e ação/ETF/BDR já usam bolsa suficientemente líquida por natureza do universo.
    if (entry.category === "fiis") {
      const avgDailyVolumeBrl = averageDailyVolumeValue(fiiSeriesByTicker.get(entry.ticker) ?? []);
      const eligibility = evalFiiEligibility(avgDailyVolumeBrl, fiiProfileByTicker.get(entry.ticker)?.equity ?? null);
      if (!eligibility.eligible) return null;
    }

    return { entry, fundamentals, analysis };
  }).filter((c): c is { entry: UniverseEntry; fundamentals: Fundamentals; analysis: ReturnType<typeof analyzeFundamentals> } => c != null);

  const rows: InsertOpportunity[] = await Promise.all(
    candidates.map(async ({ entry, fundamentals, analysis }) => {
      const name = fundamentals.name ?? entry.fallbackName;
      const ai = await describeOpportunity(
        entry,
        name,
        fundamentals,
        analysis,
        fiiProfileByTicker.get(entry.ticker)?.segmentType ?? null,
      );

      return {
        ticker: entry.ticker,
        name,
        category: entry.category,
        score: String(analysis.score),
        potentialReturn: String(computePotentialReturn(analysis.score, fundamentals)),
        dividendYield: String((fundamentals.dividendYield ?? 0) * 100),
        riskLevel: riskLevelFor(fundamentals),
        sector: benchmarkGroupFor(fundamentals, fiiProfileByTicker.get(entry.ticker)),
        dividendFrequency: classifyDividendFrequency(dividendEventsByTicker.get(entry.ticker) ?? [], now)?.label ?? null,
        dividendSustainability: classifySustainabilityOf(
          computeFinancialHealth(fundamentals, sumLast12Months(dividendEventsByTicker.get(entry.ticker) ?? [], now)),
        ),
        reason: ai?.reason ?? analysis.positives[0] ?? analysis.risks[0] ?? "Ativo dentro dos critérios de triagem do Radar.",
        positives: JSON.stringify(ai?.positives ?? analysis.positives.slice(0, 3)),
        risks: JSON.stringify(ai?.risks ?? analysis.risks.slice(0, 3)),
        horizon: ai?.horizon ?? "Médio prazo",
      };
    })
  );

  // Subproduto do mesmo scan — médias setoriais reais a partir do universo inteiro
  // (fundamentalsByTicker), não só dos candidatos aprovados. Usado por
  // analysis-ai.ts/opinion-ai.ts pra comparação com pares (routes/analysis.ts busca
  // via getSectorBenchmark, leitura barata, sem refazer o scan a cada Parecer de Ativo).
  const sectorBenchmarkRows = computeSectorBenchmarks(fundamentalsByTicker, fiiProfileByTicker);

  // Transação — diferente do delete+insert simples de scripts/src/seed-opportunities.ts,
  // que roda manual e offline. Este job roda em produção com usuários lendo
  // /opportunities ao mesmo tempo; sem transação haveria uma janela real com a
  // tabela vazia entre o delete e o insert. sector_benchmarks entra na mesma transação
  // por conveniência (mesmo job, mesmo scan), não por precisar de atomicidade com
  // opportunities especificamente.
  await db.transaction(async (tx) => {
    await tx.delete(opportunitiesTable);
    if (rows.length > 0) await tx.insert(opportunitiesTable).values(rows);

    await tx.delete(sectorBenchmarksTable);
    if (sectorBenchmarkRows.length > 0) await tx.insert(sectorBenchmarksTable).values(sectorBenchmarkRows);
  });

  const summary = `${rows.length} oportunidades geradas de ${universe.length} tickers varridos, ${sectorBenchmarkRows.length} setores com amostra suficiente pra média`;
  logger.info({ generated: rows.length, universeSize: universe.length }, "regenerateOpportunities concluído");
  return { summary };
}

// Definição compartilhada entre o scheduler (index.ts) e o disparo manual
// (routes/internal.ts), pra manter nome e intervalo alvo num único lugar.
export const OPPORTUNITIES_JOB: JobDefinition = {
  name: "regenerate-opportunities",
  minGapMs: 7 * 24 * 60 * 60 * 1000, // 1 semana
  run: regenerateOpportunities,
};
