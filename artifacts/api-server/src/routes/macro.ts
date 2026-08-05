import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/auth";
import { getMacroSnapshot } from "../lib/macro-data";
import { getIbovespaQuote } from "../lib/benchmark-data";

const router: IRouter = Router();

// O Ibovespa é composto aqui, e não dentro de getMacroSnapshot, porque vem da
// brapi e não do BCB — benchmark-data.ts já importa de macro-data.ts, então
// buscá-lo lá dentro criaria um ciclo de import. Cada lado mantém seu cache.
router.get("/macro", requireAuth, async (req, res): Promise<void> => {
  const [snapshot, ibovespa] = await Promise.all([getMacroSnapshot(), getIbovespaQuote()]);
  res.json({
    ...snapshot,
    ibovespa: ibovespa.price,
    ibovespaChangePercent: ibovespa.changePercent,
  });
});

export default router;
