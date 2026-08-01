import { Router, type IRouter } from "express";
import { requireInternalToken } from "../middlewares/internal-auth";
import { OPPORTUNITIES_JOB } from "../lib/opportunities-engine";
import { runJobAndRecord } from "../lib/scheduler";

const router: IRouter = Router();

// Dispara manualmente o mesmo job que o scheduler roda a cada 2 dias — útil pra
// testar sem esperar. Ignora o minGapMs de propósito (chamada manual sempre
// executa), mas passa por runJobAndRecord pra atualizar job_runs.lastRunAt, então
// não faz o scheduler automático rodar de novo 1h depois.
router.post("/internal/opportunities/regenerate", requireInternalToken, async (req, res): Promise<void> => {
  const result = await runJobAndRecord(OPPORTUNITIES_JOB);
  if (!result) {
    res.status(409).json({ error: "Job já está em execução" });
    return;
  }
  res.json(result);
});

export default router;
