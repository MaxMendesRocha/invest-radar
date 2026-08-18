import type { TreasuryBondOption, TreasuryRateRange } from "./treasury-identity";
import type { MacroSnapshot } from "./macro-data";
import { indexerForBondType, liquidityNoteFor, rateLabelFor, type TreasuryIndexer } from "./treasury-engine";

/**
 * Comparação de taxa para um título público específico — o equivalente de "parecer" que
 * um título de renda fixa admite. Não existe score aqui: não há fundamento pra comparar
 * ENTRE títulos como existe entre ações (ver analysis-engine.ts). A pergunta que este
 * motor responde é mais restrita e mais honesta: a taxa de HOJE deste título está boa
 * contra a própria faixa recente dele, e contra o cenário de juro atual?
 */

export interface TreasuryOpinionRateRange extends TreasuryRateRange {
  /** Posição da taxa de hoje na faixa, 0-100. null quando min===max (taxa parada na
   *  janela) — dividir por zero produziria um número, mas nenhuma posição real. */
  percentile: number | null;
}

export interface TreasuryOpinion {
  bondType: string;
  maturityDate: string;
  label: string;
  baseDate: string;
  buyRate: number;
  buyUnitPrice: number;
  rateLabel: string;
  indexer: TreasuryIndexer | null;
  rateRange: TreasuryOpinionRateRange | null;
  macro: Pick<MacroSnapshot, "selic" | "selicTrend" | "ipca12m" | "realInterestRate">;
  liquidityNote: string;
}

const FLAT_RANGE_EPSILON = 0.01;

function percentileFor(rate: number, range: TreasuryRateRange): number | null {
  const span = range.max - range.min;
  if (span < FLAT_RANGE_EPSILON) return null;
  return Math.min(100, Math.max(0, ((rate - range.min) / span) * 100));
}

export function buildTreasuryOpinion(
  bond: TreasuryBondOption,
  rateRange: TreasuryRateRange | null,
  macro: MacroSnapshot,
): TreasuryOpinion {
  const indexer = indexerForBondType(bond.bondType);

  return {
    bondType: bond.bondType,
    maturityDate: bond.maturityDate,
    label: bond.label,
    baseDate: bond.baseDate,
    buyRate: bond.buyRate,
    buyUnitPrice: bond.buyUnitPrice,
    // Sem indexador reconhecido (família fora da allowlist de treasury-engine.ts), o
    // rótulo cai pra genérico em vez de quebrar — mesmo espírito de degradação de
    // indexerForBondType.
    rateLabel: indexer ? rateLabelFor(indexer, bond.buyRate) : `${bond.buyRate.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`,
    indexer,
    rateRange: rateRange && { ...rateRange, percentile: percentileFor(bond.buyRate, rateRange) },
    macro: {
      selic: macro.selic,
      selicTrend: macro.selicTrend,
      ipca12m: macro.ipca12m,
      realInterestRate: macro.realInterestRate,
    },
    // Selic é o único indexador sem marcação a mercado no resgate — sem família
    // reconhecida, a nota mais segura é a de ALERTA (trata como se marcasse a mercado),
    // nunca a de conforto do Tesouro Selic sobre um título que não foi confirmado como tal.
    liquidityNote: liquidityNoteFor(indexer ?? "prefixado"),
  };
}
