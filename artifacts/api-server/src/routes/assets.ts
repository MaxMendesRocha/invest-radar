import { Router, type IRouter } from "express";
import { db, assetsTable, salesTable, assetPurchasesTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { CreateAssetBody, UpdateAssetBody, GetAssetParams, UpdateAssetParams, DeleteAssetParams, SellAssetParams, SellAssetBody, ValidateTickerQueryParams, CreateAssetPurchaseBody, DeleteAssetPurchaseParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import { getPricesFor, getDividendEvents, getDividendEventsForTicker, classifyDividendFrequency, getQuotes, type DividendFrequency, type PricePoint } from "../lib/market-data";
import { canonicalTickerFor, findTreasuryBond } from "../lib/treasury-identity";
import { estimateCapitalGainsTax } from "../lib/tax-engine";
import { computeMonthlyTaxSummary } from "../lib/monthly-tax-engine";
import { isoDate, todayInAppTimezone, implausibleTradeDate, invalidTradeDate } from "../lib/local-date";
import { categoryConflict as b3CategoryConflict } from "../lib/b3-ticker";
import { recomputeAssetCache, listPurchases } from "../lib/purchase-ledger-sync";
import { getCorporateEventWarnings, type CorporateEventWarning } from "../lib/corporate-events";

const router: IRouter = Router();

function enrichAsset(asset: {
  id: number; userId: number; ticker: string; quantity: string;
  averagePrice: string; purchaseDate: string | null; category: string;
  treasuryBondType: string | null; treasuryMaturityDate: string | null;
  isSavingsAccount: boolean;
  sector: string | null; notes: string | null;
  createdAt: Date; updatedAt: Date;
}, quoted: PricePoint | null, dividendFrequency: DividendFrequency | null, corporateEvent: CorporateEventWarning | null = null) {
  const qty = parseFloat(asset.quantity);
  const avgPrice = parseFloat(asset.averagePrice);
  const totalCost = qty * avgPrice;
  const currentPrice = quoted?.price ?? null;
  const totalValue = currentPrice ? qty * currentPrice : null;
  const profitLoss = totalValue != null ? totalValue - totalCost : null;
  const profitLossPercent = profitLoss != null && totalCost > 0 ? (profitLoss / totalCost) * 100 : null;

  return {
    id: asset.id,
    userId: asset.userId,
    ticker: asset.ticker,
    quantity: qty,
    averagePrice: avgPrice,
    purchaseDate: asset.purchaseDate,
    category: asset.category,
    treasuryBondType: asset.treasuryBondType,
    treasuryMaturityDate: asset.treasuryMaturityDate,
    isSavingsAccount: asset.isSavingsAccount,
    sector: asset.sector,
    notes: asset.notes,
    currentPrice,
    // Preenchido só quando currentPrice é o último preço conhecido em vez da cotação
    // de agora (provedor fora do ar). Sem esse campo a tela exibiria um preço datado
    // com a mesma cara de um preço ao vivo, e o lucro/prejuízo calculado a partir
    // dele pareceria apurado neste instante.
    priceAsOf: quoted?.asOf?.toISOString() ?? null,
    // Variação % do dia, direto do provedor — null pra título público (PU diário, sem
    // "fechou em alta/baixa hoje" real) e pra preço datado (provedor fora do ar).
    changePercent: quoted?.changePercent ?? null,
    totalValue,
    profitLoss,
    profitLossPercent,
    dividendFrequency: dividendFrequency?.label ?? null,
    // Desdobramento, grupamento ou amortização que o fundo sofreu DEPOIS da data de
    // compra registrada. O app não corrige a posição — não tem como saber o que a pessoa
    // fez na corretora — mas sem esse aviso o preço médio envelhece em silêncio, que foi
    // exatamente como uma divergência real passou despercebida até aparecer no extrato.
    corporateEventWarning: corporateEvent,
    createdAt: asset.createdAt.toISOString(),
  };
}


// Usado pelas rotas de mutação/leitura de um único ativo (criar/editar/buscar), onde
// não vale a pena buscar o histórico em lote — só um ticker por vez.
async function dividendFrequencyFor(ticker: string): Promise<DividendFrequency | null> {
  const events = await getDividendEventsForTicker(ticker);
  return classifyDividendFrequency(events, Date.now());
}

router.get("/assets", requireAuth, async (req, res): Promise<void> => {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, req.session.userId!));
  const prices = await getPricesFor(assets);
  // Reaproveita o mesmo histórico real de proventos já usado em /portfolio/dividends/*
  // (getDividendEvents, cache de 6h) — periodicidade classificada a partir da mesma
  // fonte, sem chamada nova à API além da já feita hoje pra outras telas.
  const dividendEventsByTicker = await getDividendEvents(assets.map((a) => ({ ticker: a.ticker, category: a.category })));
  const corporateEvents = await getCorporateEventWarnings(assets);
  const now = Date.now();
  res.json(assets.map((a) => enrichAsset(
    a,
    prices.get(a.ticker.toUpperCase()) ?? null,
    classifyDividendFrequency(dividendEventsByTicker.get(a.ticker.toUpperCase()) ?? [], now),
    corporateEvents.get(a.ticker.toUpperCase()) ?? null,
  )));
});

/**
 * Confere se um ticker tem cotação real ANTES de virar posição — pra pegar erro de
 * digitação ("DVF11" em vez de "DVFF11") no formulário, não depois que já criou uma
 * posição fantasma sem preço. `getQuotes` é o mesmo lookup real usado em todo o app
 * (market-data.ts), então "válido" aqui significa exatamente o que decide se as
 * outras telas conseguem mostrar cotação pra esse ticker.
 */
router.get("/assets/validate-ticker", requireAuth, async (req, res): Promise<void> => {
  const params = ValidateTickerQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const quotes = await getQuotes([params.data.ticker]);
  const quote = quotes.get(params.data.ticker.toUpperCase()) ?? null;
  // O conflito de categoria não depende de cotação: é leitura do próprio sufixo. Vale
  // responder mesmo para ticker sem preço — inclusive porque um dos dois problemas
  // costuma explicar o outro.
  const categoryConflict = params.data.category
    ? b3CategoryConflict(params.data.ticker, params.data.category)
    : null;
  res.json({ valid: quote != null, name: quote?.name ?? null, categoryConflict });
});

router.post("/assets", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateAssetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { ticker, quantity, averagePrice, purchaseDate, category, sector, notes } = parsed.data;
  const { treasuryBondType, treasuryMaturityDate, isSavingsAccount } = parsed.data;

  // Título público: o par identifica o papel e o ticker passa a ser derivado dele, não
  // digitado — ver treasury-identity.ts para o porquê.
  const treasuryRef = treasuryBondType && treasuryMaturityDate
    ? { bondType: treasuryBondType, maturityDate: isoDate(treasuryMaturityDate) }
    : null;

  if (treasuryRef && category !== "renda_fixa") {
    res.status(400).json({ error: "Título do Tesouro Direto só pode ser cadastrado na categoria Renda Fixa." });
    return;
  }
  if (isSavingsAccount && category !== "renda_fixa") {
    res.status(400).json({ error: "Poupança só pode ser cadastrada na categoria Renda Fixa." });
    return;
  }
  // Categoria errada não é detalhe de rótulo: ela decide alíquota de IR, isenção de
  // provento, limiar de concentração e em qual fatia da alocação-alvo a posição entra.
  // Só bloqueia o que a convenção da B3 PROVA estar errado — ver lib/b3-ticker.ts.
  const conflict = treasuryRef ? null : b3CategoryConflict(ticker, category);
  if (conflict) {
    res.status(400).json({ error: conflict });
    return;
  }
  const badDate = purchaseDate ? invalidTradeDate(req.body?.purchaseDate, isoDate(purchaseDate)) : null;
  if (badDate) {
    res.status(400).json({ error: badDate });
    return;
  }
  // Metade do par é sempre erro de chamada, e aceitá-lo gravaria uma posição que se
  // apresenta como título público sem conseguir ser ligada a preço nenhum.
  if (!treasuryRef && (treasuryBondType || treasuryMaturityDate)) {
    res.status(400).json({ error: "Informe família e vencimento do título juntos, ou nenhum dos dois." });
    return;
  }
  if (treasuryRef) {
    const { found, tableEmpty } = await findTreasuryBond(treasuryRef);
    // Tabela vazia é falha nossa (sincronização diária ainda não rodou), não do usuário
    // — o cadastro passa e a posição é marcada a mercado na primeira sincronização.
    if (!found && !tableEmpty) {
      res.status(400).json({ error: `Título não encontrado na lista do Tesouro Direto: ${treasuryRef.bondType} ${treasuryRef.maturityDate}.` });
      return;
    }
  }

  // Aparar antes de gravar: "   " passa pelo minLength do schema e vira uma posição com
  // ticker em branco — que não aparece em busca nenhuma e nunca consolida com a posição
  // certa, porque as strings diferem.
  const tickerUpper = treasuryRef ? canonicalTickerFor(treasuryRef) : ticker.trim().toUpperCase();
  if (!tickerUpper) {
    res.status(400).json({ error: "Informe o ticker do ativo." });
    return;
  }

  // Comprar mais de um ticker que já está na carteira consolida na mesma linha em vez
  // de criar uma segunda posição — soma a quantidade e recalcula o preço médio
  // ponderado, igual a qualquer corretora faria. Só considera a mesma categoria (o
  // preço médio de "acoes" e "bdrs" do mesmo ticker, por exemplo, nunca deveriam se
  // misturar, embora isso praticamente não aconteça na prática).
  const [existing] = await db.select().from(assetsTable).where(
    and(eq(assetsTable.userId, req.session.userId!), eq(assetsTable.ticker, tickerUpper), eq(assetsTable.category, category))
  );

  if (existing) {
    // Poupança não tem "comprar mais unidades" — reenviar o cadastro é a pessoa
    // informando um saldo/data NOVOS, não uma segunda compra pra fazer média ponderada
    // com a antiga (isso produziria um número sem sentido). Substitui em vez de
    // consolidar; é o mesmo efeito de editar a posição, só que pelo formulário de
    // cadastro.
    if (existing.isSavingsAccount) {
      const [updated] = await db.update(assetsTable)
        .set({ quantity: String(quantity), averagePrice: String(averagePrice), purchaseDate: purchaseDate ? isoDate(purchaseDate) : null })
        .where(eq(assetsTable.id, existing.id))
        .returning();
      const prices = await getPricesFor([updated]);
      const dividendFrequency = await dividendFrequencyFor(updated.ticker);
      res.status(200).json(enrichAsset(updated, prices.get(updated.ticker.toUpperCase()) ?? null, dividendFrequency));
      return;
    }

    // Consolidar deixou de ser um `update` que sobrescreve o preço médio anterior: agora
    // é a CONSEQUÊNCIA de registrar mais um lançamento e reproduzir a posição inteira.
    // O número final é o mesmo de sempre (média ponderada), mas passa a ter procedência —
    // dá pra ver de onde veio e corrigir uma linha errada sem apagar as outras.
    await db.insert(assetPurchasesTable).values({
      userId: req.session.userId!,
      assetId: existing.id,
      quantity: String(quantity),
      unitPrice: String(averagePrice),
      tradeDate: purchaseDate ? isoDate(purchaseDate) : todayInAppTimezone(),
    });
    await recomputeAssetCache(existing.id);

    const [updated] = await db.select().from(assetsTable).where(eq(assetsTable.id, existing.id));
    const prices = await getPricesFor([updated]);
    const dividendFrequency = await dividendFrequencyFor(updated.ticker);
    res.status(200).json(enrichAsset(updated, prices.get(updated.ticker.toUpperCase()) ?? null, dividendFrequency));
    return;
  }

  const [asset] = await db.insert(assetsTable).values({
    userId: req.session.userId!,
    ticker: tickerUpper,
    quantity: String(quantity),
    averagePrice: String(averagePrice),
    purchaseDate: purchaseDate ? isoDate(purchaseDate) : null,
    category,
    treasuryBondType: treasuryRef?.bondType ?? null,
    treasuryMaturityDate: treasuryRef?.maturityDate ?? null,
    isSavingsAccount: isSavingsAccount ?? false,
    sector: sector ?? null,
    notes: notes ?? null,
  }).returning();

  // Posição nova nasce já com o primeiro lançamento — assim não existe estado em que a
  // quantidade e o preço médio não tenham origem registrada. Poupança fica de fora: ali
  // o "preço médio" é um saldo, não preço de compra.
  if (!asset.isSavingsAccount) {
    await db.insert(assetPurchasesTable).values({
      userId: req.session.userId!,
      assetId: asset.id,
      quantity: String(quantity),
      unitPrice: String(averagePrice),
      tradeDate: purchaseDate ? isoDate(purchaseDate) : todayInAppTimezone(),
    });
  }

  const prices = await getPricesFor([asset]);
  const dividendFrequency = await dividendFrequencyFor(asset.ticker);
  res.status(201).json(enrichAsset(asset, prices.get(asset.ticker.toUpperCase()) ?? null, dividendFrequency));
});

router.get("/assets/:id", requireAuth, async (req, res): Promise<void> => {
  const params = GetAssetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [asset] = await db.select().from(assetsTable).where(
    and(eq(assetsTable.id, params.data.id), eq(assetsTable.userId, req.session.userId!))
  );
  if (!asset) {
    res.status(404).json({ error: "Asset não encontrado" });
    return;
  }
  const prices = await getPricesFor([asset]);
  const dividendFrequency = await dividendFrequencyFor(asset.ticker);
  res.json(enrichAsset(asset, prices.get(asset.ticker.toUpperCase()) ?? null, dividendFrequency));
});

router.patch("/assets/:id", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateAssetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateAssetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const updates: Record<string, unknown> = {};
  if (parsed.data.ticker != null) updates.ticker = parsed.data.ticker.toUpperCase();
  if (parsed.data.quantity != null) updates.quantity = String(parsed.data.quantity);
  if (parsed.data.averagePrice != null) updates.averagePrice = String(parsed.data.averagePrice);
  if (parsed.data.purchaseDate !== undefined) updates.purchaseDate = parsed.data.purchaseDate ? isoDate(parsed.data.purchaseDate) : null;
  if (parsed.data.category != null) updates.category = parsed.data.category;
  if (parsed.data.sector !== undefined) updates.sector = parsed.data.sector;
  if (parsed.data.notes !== undefined) updates.notes = parsed.data.notes;

  // Quantidade e preço médio deixaram de ser editáveis DIRETAMENTE: são derivados dos
  // lançamentos. Editar a posição passa a editar o lançamento de saldo inicial, para não
  // existirem duas formas de definir o mesmo número — que é a origem do problema que este
  // recurso resolve.
  //
  // Poupança é a exceção, e precisa ser explícita: ali `averagePrice` é o SALDO da conta,
  // não preço de compra, e o diálogo "Movimentar Poupança" grava por este mesmo PATCH. Se
  // o desvio para lançamento valesse pra todo mundo, depósito e saque quebrariam.
  const [current] = await db.select().from(assetsTable).where(
    and(eq(assetsTable.id, params.data.id), eq(assetsTable.userId, req.session.userId!))
  );
  if (!current) {
    res.status(404).json({ error: "Asset não encontrado" });
    return;
  }

  // averagePrice zero só faz sentido em poupança, onde o campo é SALDO e zerar a conta
  // é operação real. Em posição de bolsa ele é preço de compra, e zero produziria
  // exatamente a posição corrompida que estas travas existem para impedir.
  if (!current.isSavingsAccount && parsed.data.averagePrice === 0) {
    res.status(400).json({ error: "Preço médio precisa ser maior que zero." });
    return;
  }
  const badEditDate = parsed.data.purchaseDate ? invalidTradeDate(req.body?.purchaseDate, isoDate(parsed.data.purchaseDate)) : null;
  if (badEditDate) {
    res.status(400).json({ error: badEditDate });
    return;
  }

  const mexeNaPosicao = parsed.data.quantity != null || parsed.data.averagePrice != null || parsed.data.purchaseDate !== undefined;
  if (!current.isSavingsAccount && mexeNaPosicao) {
    const purchases = await listPurchases(current.id);
    const inicial = purchases.find((p) => p.isInitialBalance);

    // Com lançamento real registrado, o número não é mais editável por aqui: a correção é
    // na linha errada, não no total. Sem isso o cache voltaria a poder divergir da fonte,
    // reabrindo exatamente a porta que este recurso fecha.
    if (purchases.length > 0 && !inicial) {
      res.status(409).json({
        error: "Esta posição tem lançamentos registrados — corrija o lançamento em vez da posição.",
      });
      return;
    }

    const novaQtd = parsed.data.quantity ?? parseFloat(current.quantity);
    const novoPreco = parsed.data.averagePrice ?? parseFloat(current.averagePrice);
    const novaData = parsed.data.purchaseDate !== undefined
      ? (parsed.data.purchaseDate ? isoDate(parsed.data.purchaseDate) : null)
      : current.purchaseDate;

    if (inicial) {
      await db.update(assetPurchasesTable)
        .set({
          quantity: String(novaQtd),
          unitPrice: String(novoPreco),
          tradeDate: novaData ?? inicial.tradeDate,
        })
        .where(eq(assetPurchasesTable.id, inicial.id));
    } else {
      await db.insert(assetPurchasesTable).values({
        userId: req.session.userId!,
        assetId: current.id,
        quantity: String(novaQtd),
        unitPrice: String(novoPreco),
        tradeDate: novaData ?? todayInAppTimezone(),
        isInitialBalance: true,
      });
    }

    // O cache sai do replay, não do que foi digitado — inclusive a data de compra, que
    // passa a ser a do lançamento mais antigo.
    delete updates.quantity;
    delete updates.averagePrice;
    delete updates.purchaseDate;
  }

  const [asset] = Object.keys(updates).length > 0
    ? await db.update(assetsTable)
        .set(updates)
        .where(and(eq(assetsTable.id, params.data.id), eq(assetsTable.userId, req.session.userId!)))
        .returning()
    : [current];

  if (!asset) {
    res.status(404).json({ error: "Asset não encontrado" });
    return;
  }
  await recomputeAssetCache(asset.id);
  const [fresh] = await db.select().from(assetsTable).where(eq(assetsTable.id, asset.id));

  const prices = await getPricesFor([fresh]);
  const dividendFrequency = await dividendFrequencyFor(fresh.ticker);
  res.json(enrichAsset(fresh, prices.get(fresh.ticker.toUpperCase()) ?? null, dividendFrequency));
});

router.delete("/assets/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteAssetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await db.delete(assetsTable).where(
    and(eq(assetsTable.id, params.data.id), eq(assetsTable.userId, req.session.userId!))
  );
  res.sendStatus(204);
});

function serializeSale(sale: typeof salesTable.$inferSelect) {
  return {
    id: sale.id,
    userId: sale.userId,
    ticker: sale.ticker,
    category: sale.category,
    quantity: parseFloat(sale.quantity),
    averagePrice: parseFloat(sale.averagePrice),
    salePrice: parseFloat(sale.salePrice),
    saleDate: sale.saleDate,
    grossGain: parseFloat(sale.grossGain),
    taxOwed: sale.taxOwed != null ? parseFloat(sale.taxOwed) : null,
    notes: sale.notes,
    createdAt: sale.createdAt.toISOString(),
  };
}

// Tolerância pra erro de arredondamento de ponto flutuante ao comparar a quantidade
// vendida com a quantidade restante da posição — sem isso, vender "a posição toda"
// podia deixar um resíduo tipo 0.000000003 e nunca encerrar o asset de verdade.
const QUANTITY_EPSILON = 1e-6;

/**
 * Lançamentos de uma posição — as compras que produzem o preço médio.
 *
 * Existir esta lista é o ponto do recurso: o preço médio deixa de ser um número sem
 * procedência e passa a ter de onde vir, linha a linha.
 */
router.get("/assets/:id/purchases", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateAssetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [asset] = await db.select().from(assetsTable).where(
    and(eq(assetsTable.id, params.data.id), eq(assetsTable.userId, req.session.userId!))
  );
  if (!asset) {
    res.status(404).json({ error: "Asset não encontrado" });
    return;
  }
  const purchases = await listPurchases(asset.id);
  res.json(purchases.map((p) => ({
    id: p.id,
    quantity: parseFloat(p.quantity),
    unitPrice: parseFloat(p.unitPrice),
    tradeDate: p.tradeDate,
    isInitialBalance: p.isInitialBalance,
    note: p.note,
  })));
});

router.post("/assets/:id/purchases", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateAssetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateAssetPurchaseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const badTradeDate = invalidTradeDate(req.body?.tradeDate, isoDate(parsed.data.tradeDate));
  if (badTradeDate) {
    res.status(400).json({ error: badTradeDate });
    return;
  }
  const [asset] = await db.select().from(assetsTable).where(
    and(eq(assetsTable.id, params.data.id), eq(assetsTable.userId, req.session.userId!))
  );
  if (!asset) {
    res.status(404).json({ error: "Asset não encontrado" });
    return;
  }
  // Poupança não tem compra: o "preço médio" ali é um saldo, e depósito/saque tem caminho
  // próprio no diálogo "Movimentar Poupança".
  if (asset.isSavingsAccount) {
    res.status(400).json({ error: "Poupança não registra lançamento de compra — use Movimentar Poupança." });
    return;
  }

  await db.insert(assetPurchasesTable).values({
    userId: req.session.userId!,
    assetId: asset.id,
    quantity: String(parsed.data.quantity),
    unitPrice: String(parsed.data.unitPrice),
    tradeDate: isoDate(parsed.data.tradeDate),
    note: parsed.data.note ?? null,
  });
  await recomputeAssetCache(asset.id);

  const [fresh] = await db.select().from(assetsTable).where(eq(assetsTable.id, asset.id));
  const prices = await getPricesFor([fresh]);
  const dividendFrequency = await dividendFrequencyFor(fresh.ticker);
  res.status(201).json(enrichAsset(fresh, prices.get(fresh.ticker.toUpperCase()) ?? null, dividendFrequency));
});

router.delete("/assets/:id/purchases/:purchaseId", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteAssetPurchaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [asset] = await db.select().from(assetsTable).where(
    and(eq(assetsTable.id, params.data.id), eq(assetsTable.userId, req.session.userId!))
  );
  if (!asset) {
    res.status(404).json({ error: "Asset não encontrado" });
    return;
  }

  const purchases = await listPurchases(asset.id);
  // Apagar o último lançamento deixaria a posição sem origem para a quantidade e o preço
  // médio — um estado que o recomputeAssetCache não conserta (ele não toca em posição sem
  // lançamento, justamente para não zerar carteira de quem ainda não passou pelo
  // backfill). Quem quer zerar a posição apaga a posição.
  if (purchases.length <= 1) {
    res.status(409).json({ error: "A posição precisa de pelo menos um lançamento. Para encerrá-la, exclua a posição." });
    return;
  }

  await db.delete(assetPurchasesTable).where(
    and(eq(assetPurchasesTable.id, params.data.purchaseId), eq(assetPurchasesTable.assetId, asset.id))
  );
  await recomputeAssetCache(asset.id);

  const [fresh] = await db.select().from(assetsTable).where(eq(assetsTable.id, asset.id));
  const prices = await getPricesFor([fresh]);
  const dividendFrequency = await dividendFrequencyFor(fresh.ticker);
  res.json(enrichAsset(fresh, prices.get(fresh.ticker.toUpperCase()) ?? null, dividendFrequency));
});

router.post("/assets/:id/sell", requireAuth, async (req, res): Promise<void> => {
  const params = SellAssetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = SellAssetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Mesma trava da compra: a data da venda entra na consolidação mensal de IR, e uma
  // venda no futuro jogaria imposto para um mês que ainda não fechou.
  const badSaleDate = invalidTradeDate(req.body?.saleDate, isoDate(parsed.data.saleDate));
  if (badSaleDate) {
    res.status(400).json({ error: badSaleDate });
    return;
  }

  const [asset] = await db.select().from(assetsTable).where(
    and(eq(assetsTable.id, params.data.id), eq(assetsTable.userId, req.session.userId!))
  );
  if (!asset) {
    res.status(404).json({ error: "Asset não encontrado" });
    return;
  }

  const existingQty = parseFloat(asset.quantity);
  const { salePrice, saleDate, quantity } = parsed.data;
  const soldQty = quantity ?? existingQty;

  if (soldQty <= 0 || soldQty > existingQty + QUANTITY_EPSILON) {
    res.status(400).json({ error: "Quantidade vendida inválida — deve ser maior que zero e não pode superar a posição atual." });
    return;
  }

  // Reaproveita o mesmo motor de IR usado no parecer de ativos (tax-engine.ts), mas
  // agora com o preço de venda REAL, não mais uma estimativa de "e se eu vendesse
  // hoje" — esta venda já aconteceu de verdade. null pra renda_fixa/fundos, categorias
  // fora do escopo de ganho de capital em renda variável.
  const averagePrice = parseFloat(asset.averagePrice);
  const tax = estimateCapitalGainsTax(asset.category, soldQty, averagePrice, salePrice);
  const grossGain = tax ? tax.grossGain : (salePrice - averagePrice) * soldQty;

  const remainingQty = existingQty - soldQty;

  // Registrar a venda e baixar a posição são o mesmo fato e precisam ser atômicos.
  // Separados, uma falha entre os dois deixaria a venda registrada com a posição
  // intacta — a mesma quantidade contada duas vezes, em dinheiro, e ainda entrando
  // na apuração mensal de IR.
  const sale = await db.transaction(async (tx) => {
    const [inserted] = await tx.insert(salesTable).values({
      userId: req.session.userId!,
      ticker: asset.ticker,
      category: asset.category,
      quantity: String(soldQty),
      averagePrice: String(averagePrice),
      salePrice: String(salePrice),
      saleDate: saleDate.toISOString().slice(0, 10),
      grossGain: String(grossGain),
      taxOwed: tax ? String(tax.taxOwed) : null,
    }).returning();

    if (remainingQty > QUANTITY_EPSILON) {
      // Venda parcial: reduz a quantidade, preço médio de compra não muda. Continua sendo
      // um update direto porque a venda acabou de ser inserida DENTRO desta transação e o
      // replay a enxergaria de qualquer forma — mas o resultado é o mesmo, e o
      // recomputeAssetCache logo abaixo confirma isso fora da transação.
      await tx.update(assetsTable).set({ quantity: String(remainingQty) }).where(eq(assetsTable.id, asset.id));
    } else {
      // Venda total: a posição encerrou de verdade, não faz sentido mostrar quantidade
      // zero em "Minha Carteira".
      await tx.delete(assetsTable).where(eq(assetsTable.id, asset.id));
    }

    return inserted;
  });

  res.status(201).json(serializeSale(sale));
});

router.get("/sales", requireAuth, async (req, res): Promise<void> => {
  const sales = await db.select().from(salesTable)
    .where(eq(salesTable.userId, req.session.userId!))
    .orderBy(desc(salesTable.saleDate), desc(salesTable.id));
  res.json(sales.map(serializeSale));
});

// Consolidação mensal por categoria — sempre recalculada a partir do histórico real
// de vendas (nunca persistida), então reflete automaticamente qualquer venda nova
// registrada. Ordenado por mês mais recente primeiro (mesmo sentido de GET /sales).
router.get("/sales/monthly-tax", requireAuth, async (req, res): Promise<void> => {
  const sales = await db.select().from(salesTable).where(eq(salesTable.userId, req.session.userId!));
  const summary = computeMonthlyTaxSummary(
    sales.map((s) => ({
      category: s.category,
      saleDate: s.saleDate,
      quantity: parseFloat(s.quantity),
      salePrice: parseFloat(s.salePrice),
      grossGain: parseFloat(s.grossGain),
    }))
  );
  res.json(summary);
});

export default router;
