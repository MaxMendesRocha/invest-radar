import { Router, type IRouter } from "express";
import { requireInternalToken } from "../middlewares/internal-auth";
import { OPPORTUNITIES_JOB } from "../lib/opportunities-engine";
import { TREASURY_JOB } from "../lib/treasury-data";
import { FII_EVENTS_JOB } from "../lib/fii-events-sync";
import { runJobAndRecord } from "../lib/scheduler";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Dispara manualmente o mesmo job que o scheduler roda a cada semana — útil pra
// testar sem esperar. Ignora o minGapMs de propósito (chamada manual sempre
// executa), mas passa por runJobAndRecord pra atualizar job_runs.lastRunAt, então
// não faz o scheduler automático rodar de novo 1h depois. runJobAndRecord pode
// lançar (ex: erro real do job, ou colisão de upsert concorrente em job_runs
// durante um deploy — já aconteceu em produção) — sempre responder JSON aqui,
// nunca deixar escapar pro handler HTML padrão do Express.
router.post("/internal/opportunities/regenerate", requireInternalToken, async (req, res): Promise<void> => {
  try {
    const result = await runJobAndRecord(OPPORTUNITIES_JOB);
    if (!result) {
      res.status(409).json({ error: "Job já está em execução" });
      return;
    }
    res.json(result);
  } catch (err) {
    logger.error({ err }, "POST /internal/opportunities/regenerate falhou");
    res.status(500).json({ error: "Falha ao regenerar oportunidades — ver logs do servidor" });
  }
});

// Mesmo padrão do handler acima: dispara o job diário do Tesouro sob demanda, para
// popular a tabela num ambiente novo sem esperar a primeira janela do scheduler.
router.post("/internal/treasury/sync", requireInternalToken, async (req, res): Promise<void> => {
  try {
    const result = await runJobAndRecord(TREASURY_JOB);
    if (!result) {
      res.status(409).json({ error: "Job já está em execução" });
      return;
    }
    res.json(result);
  } catch (err) {
    logger.error({ err }, "POST /internal/treasury/sync falhou");
    res.status(500).json({ error: "Falha ao sincronizar o Tesouro Direto — ver logs do servidor" });
  }
});

// Mesmo padrão. Na primeira execução este job faz o backfill do histórico inteiro
// (2019 em diante), então num ambiente novo vale disparar na mão em vez de esperar a
// janela semanal — sem a série, o detector de evento corporativo não tem o que comparar.
router.post("/internal/fii-events/sync", requireInternalToken, async (req, res): Promise<void> => {
  try {
    const result = await runJobAndRecord(FII_EVENTS_JOB);
    if (!result) {
      res.status(409).json({ error: "Job já está em execução" });
      return;
    }
    res.json(result);
  } catch (err) {
    logger.error({ err }, "POST /internal/fii-events/sync falhou");
    res.status(500).json({ error: "Falha ao sincronizar o informe mensal de FII — ver logs do servidor" });
  }
});

export default router;
