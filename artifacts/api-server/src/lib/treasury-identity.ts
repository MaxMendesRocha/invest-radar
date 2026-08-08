import { db, treasuryBondsTable } from "@workspace/db";

/**
 * Identidade de uma posição em título público.
 *
 * O `ticker` de um ativo é texto livre, e título do Tesouro não tem ticker. Deixar o
 * usuário digitar produzia duas falhas silenciosas: "TESOURO IPCA+ 2035" e "TD IPCA
 * 2035" viravam posições separadas do mesmo papel (a consolidação de compra casa por
 * ticker + categoria), e nenhuma das duas strings conseguia ser ligada ao par
 * (família, vencimento) da tabela de preços — então a posição nunca era marcada a
 * mercado.
 *
 * A solução é o servidor derivar o rótulo do próprio título escolhido. Duas compras do
 * mesmo papel geram exatamente a mesma string, sempre.
 */

export interface TreasuryRef {
  bondType: string;
  maturityDate: string; // ISO
}

/** "Tesouro IPCA+ com Juros Semestrais" + 2040-08-15 -> "TESOURO IPCA+ JS 2040". */
export function canonicalTickerFor(ref: TreasuryRef): string {
  const year = ref.maturityDate.slice(0, 4);
  // "com Juros Semestrais" viraria um rótulo longo demais para a tabela da carteira,
  // mas não pode ser descartado: o título com cupom é um papel diferente do sem cupom,
  // com o MESMO vencimento em alguns casos (IPCA+ 2032 existe nas duas formas). Sem a
  // marca, os dois consolidariam na mesma posição.
  const withCoupon = /juros semestrais/i.test(ref.bondType);
  const family = ref.bondType.replace(/\s*com Juros Semestrais\s*/i, "").trim();
  return `${family} ${withCoupon ? "JS " : ""}${year}`.toUpperCase();
}

/** Rótulo legível para tela, sem a compressão do ticker. */
export function displayLabelFor(ref: TreasuryRef): string {
  return `${ref.bondType} ${ref.maturityDate.slice(0, 4)}`;
}

export interface TreasuryBondOption extends TreasuryRef {
  baseDate: string;
  buyRate: number;
  buyUnitPrice: number;
  sellUnitPrice: number | null;
  label: string;
}

export async function listTreasuryBondOptions(): Promise<TreasuryBondOption[]> {
  const rows = await db.select().from(treasuryBondsTable);
  return rows
    .map((row) => ({
      bondType: row.bondType,
      maturityDate: row.maturityDate,
      baseDate: row.baseDate,
      buyRate: parseFloat(row.buyRate),
      buyUnitPrice: parseFloat(row.buyUnitPrice),
      sellUnitPrice: row.sellUnitPrice == null ? null : parseFloat(row.sellUnitPrice),
      label: displayLabelFor(row),
    }))
    .sort((a, b) => a.bondType.localeCompare(b.bondType, "pt-BR") || a.maturityDate.localeCompare(b.maturityDate));
}

/**
 * Confirma que o par existe na tabela sincronizada, para um cadastro não gravar um
 * título que a lista de preços não conhece — o que faria a posição parecer marcada a
 * mercado sem nunca ser.
 *
 * Devolve null quando a tabela está vazia, e quem chama trata isso como "não consigo
 * validar agora" em vez de "inválido": recusar cadastro porque a sincronização diária
 * ainda não rodou puniria o usuário por um estado interno do servidor.
 */
export async function findTreasuryBond(ref: TreasuryRef): Promise<{ found: boolean; tableEmpty: boolean }> {
  const rows = await db.select({ bondType: treasuryBondsTable.bondType, maturityDate: treasuryBondsTable.maturityDate }).from(treasuryBondsTable);
  if (rows.length === 0) return { found: false, tableEmpty: true };
  const found = rows.some((r) => r.bondType === ref.bondType && r.maturityDate === ref.maturityDate);
  return { found, tableEmpty: false };
}
