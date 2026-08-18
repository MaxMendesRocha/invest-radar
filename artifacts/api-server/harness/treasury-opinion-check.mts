import { buildTreasuryOpinion } from "../src/lib/treasury-opinion-engine";
import { rateRangeFor, findTreasuryBond, listTreasuryBondOptions } from "../src/lib/treasury-identity";
import type { TreasuryBondOption, TreasuryRateRange } from "../src/lib/treasury-identity";
import type { MacroSnapshot } from "../src/lib/macro-data";

let failures = 0;
function check(label: string, condition: boolean, detail: string): void {
  console.log(`${condition ? "OK  " : "FALHA"} ${label}`);
  if (!condition) {
    console.log(`      ${detail}`);
    failures++;
  }
}

const MACRO: MacroSnapshot = {
  selic: 14.0,
  selicTrend: "queda",
  ipca12m: 4.44,
  usdBrl: 5.4,
  usdBrlChangePercent: null,
  igpm12m: null,
  realInterestRate: 9.15,
  updatedAt: new Date().toISOString(),
};

function bond(overrides: Partial<TreasuryBondOption>): TreasuryBondOption {
  return {
    bondType: "Tesouro IPCA+",
    maturityDate: "2040-08-15",
    baseDate: "2026-08-17",
    buyRate: 7.66,
    buyUnitPrice: 1697.78,
    sellUnitPrice: 1690.0,
    label: "Tesouro IPCA+ 2040",
    ...overrides,
  };
}

// ── Fixtures: percentil, indexador, rótulo, nota de liquidez ────────────────

{
  // Caso real medido em 17/08: faixa 7,25-7,83, taxa 7,66 -> ~70,7%.
  const range: TreasuryRateRange = { days: 90, min: 7.25, max: 7.83, avg: 7.56, sampleCount: 62 };
  const op = buildTreasuryOpinion(bond({}), range, MACRO);
  check("percentil bate com a conta manual (~70,7%)", op.rateRange != null && Math.abs(op.rateRange.percentile! - 70.6896) < 0.01, JSON.stringify(op.rateRange));
  check("indexador reconhecido como ipca", op.indexer === "ipca", op.indexer ?? "null");
  check("rótulo formatado com IPCA +", op.rateLabel === "IPCA + 7,66% a.a.", op.rateLabel);
  check("nota de liquidez alerta sobre marcação a mercado", op.liquidityNote.includes("marcação a mercado no resgate antecipado"), op.liquidityNote);
}

{
  // Faixa parada (min === max) -> percentil null, não uma posição fabricada.
  const range: TreasuryRateRange = { days: 90, min: 0.0, max: 0.0, avg: 0.0, sampleCount: 62 };
  const op = buildTreasuryOpinion(bond({ bondType: "Tesouro Selic", maturityDate: "2027-03-01", buyRate: 0, buyUnitPrice: 19681.49, label: "Tesouro Selic 2027" }), range, MACRO);
  check("faixa parada -> percentil null", op.rateRange != null && op.rateRange.percentile === null, JSON.stringify(op.rateRange));
  check("Selic com deságio 0 -> rótulo sem sinal", op.rateLabel === "Selic", op.rateLabel);
  check("Selic -> nota de liquidez tranquiliza sobre resgate", op.liquidityNote.includes("não sofre marcação a mercado"), op.liquidityNote);
}

{
  // Sem histórico suficiente na janela (rateRangeFor já filtra isso e devolve null).
  const op = buildTreasuryOpinion(bond({}), null, MACRO);
  check("sem faixa -> rateRange null (não inventa)", op.rateRange === null, JSON.stringify(op.rateRange));
}

{
  // Família fora da allowlist de treasury-engine.ts (ex. só-recompra) -> degrada,
  // não quebra: indexador null, rótulo genérico, nota de liquidez do lado cauteloso.
  const op = buildTreasuryOpinion(bond({ bondType: "Tesouro IGPM+ com Juros Semestrais", buyRate: 5.1, label: "Tesouro IGPM+ JS 2031" }), null, MACRO);
  check("família fora da allowlist -> indexer null", op.indexer === null, op.indexer ?? "null");
  check("família fora da allowlist -> rótulo genérico", op.rateLabel === "5,10%", op.rateLabel);
  check("família fora da allowlist -> nota de liquidez do lado cauteloso (não a do Selic)", op.liquidityNote.includes("marcação a mercado no resgate antecipado"), op.liquidityNote);
}

{
  const range: TreasuryRateRange = { days: 90, min: 12.0, max: 15.0, avg: 13.5, sampleCount: 40 };
  const op = buildTreasuryOpinion(bond({ bondType: "Tesouro Prefixado", buyRate: 15.0, buyUnitPrice: 500.0, label: "Tesouro Prefixado 2029" }), range, MACRO);
  check("percentil no teto da faixa = 100", op.rateRange != null && op.rateRange.percentile === 100, JSON.stringify(op.rateRange));
  check("rótulo prefixado sem prefixo IPCA/Selic", op.rateLabel === "15,00% a.a.", op.rateLabel);
}

// ── Contra o banco real: rateRangeFor de um título de verdade ───────────────

{
  const bonds = await listTreasuryBondOptions();
  if (bonds.length === 0) {
    console.log("SKIP checagem ao vivo — catálogo do Tesouro ainda não sincronizado neste ambiente.");
  } else {
    const real = bonds.find((b) => b.bondType === "Tesouro IPCA+" && b.maturityDate === "2040-08-15") ?? bonds[0];
    const ref = { bondType: real.bondType, maturityDate: real.maturityDate };
    const { found } = await findTreasuryBond(ref);
    check("findTreasuryBond confirma título real no catálogo", found, JSON.stringify(ref));

    const range = await rateRangeFor(ref, 90);
    check("rateRangeFor devolve faixa real ou null (nunca lança)", range === null || (range.min <= range.avg && range.avg <= range.max), JSON.stringify(range));

    const macro = MACRO; // sem chamar getMacroSnapshot aqui — checagem de rede real já é feita noutro harness
    const opinion = buildTreasuryOpinion(real, range, macro);
    check("buildTreasuryOpinion com dado real não lança e preenche os campos obrigatórios", opinion.label === real.label && opinion.buyRate === real.buyRate, JSON.stringify(opinion));
    console.log(`\nReal: ${opinion.label} — ${opinion.rateLabel}, faixa 90d: ${JSON.stringify(opinion.rateRange)}`);
  }
}

console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
