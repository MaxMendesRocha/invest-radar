import { db, treasuryBondsTable, type TreasuryBond } from "@workspace/db";
import { and, avg, count, desc, eq, gte, lte, max, min } from "drizzle-orm";

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

/**
 * Data-base mais recente já sincronizada. A tabela virou série histórica, então tudo
 * que quer dizer "hoje" precisa passar por aqui — sem o filtro, uma consulta traria
 * duas décadas de preços do mesmo título.
 */
export async function latestBaseDate(): Promise<string | null> {
  const [row] = await db.select({ latest: max(treasuryBondsTable.baseDate) }).from(treasuryBondsTable);
  return row?.latest ?? null;
}

/** Todos os títulos na data-base mais recente — o equivalente à antiga "foto do dia". */
export async function latestTreasuryBonds(): Promise<TreasuryBond[]> {
  const latest = await latestBaseDate();
  if (!latest) return [];
  return db.select().from(treasuryBondsTable).where(eq(treasuryBondsTable.baseDate, latest));
}

/**
 * PU de compra do título na data pedida, ou na data-base publicada imediatamente antes.
 *
 * O "ou antes" não é conveniência: compra em sábado, domingo ou feriado não tem
 * publicação no próprio dia, e exigir data exata devolveria "não encontrado" para uma
 * compra perfeitamente válida. A data-base efetivamente usada volta junto para a tela
 * poder dizer de quando é o número — se o usuário comprou num sábado, o PU exibido é o
 * da sexta, e ele merece saber disso.
 */
export async function priceOnDate(ref: TreasuryRef, date: string): Promise<{ baseDate: string; buyUnitPrice: number } | null> {
  const [row] = await db
    .select({ baseDate: treasuryBondsTable.baseDate, buyUnitPrice: treasuryBondsTable.buyUnitPrice })
    .from(treasuryBondsTable)
    .where(and(
      eq(treasuryBondsTable.bondType, ref.bondType),
      eq(treasuryBondsTable.maturityDate, ref.maturityDate),
      lte(treasuryBondsTable.baseDate, date),
    ))
    .orderBy(desc(treasuryBondsTable.baseDate))
    .limit(1);

  if (!row) return null;
  const price = parseFloat(row.buyUnitPrice);
  return Number.isFinite(price) && price > 0 ? { baseDate: row.baseDate, buyUnitPrice: price } : null;
}

export interface TreasuryRateRange {
  days: number;
  min: number;
  max: number;
  avg: number;
  sampleCount: number;
}

/** Amostra mínima de pregões na janela pra faixa valer alguma coisa — abaixo disso o
 *  histórico é curto demais (título recém-emitido, ou janela cruzando um período sem
 *  sincronização) e devolver uma faixa calculada em cima de poucos pontos seria uma
 *  medição disfarçada de robustez que ela não tem. */
const MIN_SAMPLE_FOR_RANGE = 15;

function daysAgoIso(days: number, now: Date): string {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Faixa (mín/máx/média) da taxa de compra de um título nos últimos `days` dias-base
 * publicados. Usada para comparar a taxa de hoje contra o próprio histórico recente do
 * MESMO título — nunca contra outro título, que teria prêmio de prazo diferente.
 */
export async function rateRangeFor(ref: TreasuryRef, days: number): Promise<TreasuryRateRange | null> {
  const since = daysAgoIso(days, new Date());
  const [row] = await db
    .select({
      min: min(treasuryBondsTable.buyRate),
      max: max(treasuryBondsTable.buyRate),
      avg: avg(treasuryBondsTable.buyRate),
      sampleCount: count(),
    })
    .from(treasuryBondsTable)
    .where(and(
      eq(treasuryBondsTable.bondType, ref.bondType),
      eq(treasuryBondsTable.maturityDate, ref.maturityDate),
      gte(treasuryBondsTable.baseDate, since),
    ));

  if (!row || row.sampleCount < MIN_SAMPLE_FOR_RANGE || row.min == null || row.max == null || row.avg == null) return null;

  const min_ = parseFloat(row.min);
  const max_ = parseFloat(row.max);
  const avg_ = parseFloat(row.avg);
  if (!Number.isFinite(min_) || !Number.isFinite(max_) || !Number.isFinite(avg_)) return null;

  return { days, min: min_, max: max_, avg: avg_, sampleCount: row.sampleCount };
}

export async function listTreasuryBondOptions(): Promise<TreasuryBondOption[]> {
  const rows = await latestTreasuryBonds();
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
  const rows = await latestTreasuryBonds();
  if (rows.length === 0) return { found: false, tableEmpty: true };
  const found = rows.some((r) => r.bondType === ref.bondType && r.maturityDate === ref.maturityDate);
  return { found, tableEmpty: false };
}
