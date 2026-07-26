import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/auth";
import { getMacroSnapshot } from "../lib/macro-data";

const router: IRouter = Router();

router.get("/macro", requireAuth, async (req, res): Promise<void> => {
  res.json(await getMacroSnapshot());
});

export default router;
