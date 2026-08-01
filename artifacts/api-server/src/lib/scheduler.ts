import { db, jobRunsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // checa de hora em hora
const STARTUP_DELAY_MS = 30 * 1000; // dá tempo da conexão com o banco estabilizar no boot

export interface JobDefinition {
  name: string;
  minGapMs: number;
  run: () => Promise<{ summary: string }>;
}

const runningJobs = new Set<string>();

// Roda o job e registra o resultado em job_runs incondicionalmente — usado tanto
// pelo scheduler (depois de checar minGapMs) quanto pelo endpoint de disparo manual
// (routes/internal.ts), que ignora o gap de propósito mas ainda precisa atualizar
// lastRunAt pra não fazer o scheduler automático rodar de novo 1h depois.
export async function runJobAndRecord(job: JobDefinition): Promise<{ summary: string } | null> {
  if (runningJobs.has(job.name)) return null; // guard contra sobreposição no mesmo processo

  runningJobs.add(job.name);
  const startedAt = Date.now();
  try {
    const result = await job.run();
    await db
      .insert(jobRunsTable)
      .values({ jobName: job.name, lastRunAt: new Date(), lastStatus: "sucesso", lastDurationMs: Date.now() - startedAt })
      .onConflictDoUpdate({
        target: jobRunsTable.jobName,
        set: { lastRunAt: new Date(), lastStatus: "sucesso", lastError: null, lastDurationMs: Date.now() - startedAt },
      });
    logger.info({ job: job.name, summary: result.summary }, "Job agendado executado com sucesso");
    return result;
  } catch (err) {
    await db
      .insert(jobRunsTable)
      .values({ jobName: job.name, lastRunAt: new Date(), lastStatus: "erro", lastError: String(err) })
      .onConflictDoUpdate({
        target: jobRunsTable.jobName,
        set: { lastRunAt: new Date(), lastStatus: "erro", lastError: String(err) },
      });
    logger.error({ err, job: job.name }, "Job agendado falhou");
    throw err;
  } finally {
    runningJobs.delete(job.name);
  }
}

async function maybeRunJob(job: JobDefinition): Promise<void> {
  const [row] = await db.select().from(jobRunsTable).where(eq(jobRunsTable.jobName, job.name));
  if (row?.lastRunAt && Date.now() - row.lastRunAt.getTime() < job.minGapMs) return;

  await runJobAndRecord(job).catch(() => {}); // já logado dentro de runJobAndRecord
}

/**
 * Scheduler in-process resiliente a restart: `lastRunAt` fica persistido no
 * Postgres (não em memória), então um redeploy/restart do Railway não perde o
 * estado — ao voltar, o processo consulta o banco e decide corretamente se já
 * passou `minGapMs` desde a última execução real, sem depender de o processo ter
 * ficado no ar o intervalo inteiro. Checagem de hora em hora é folgada o bastante
 * pra um alvo de dias (pior caso: ~1h de atraso). Roda uma checagem logo após o
 * boot (STARTUP_DELAY_MS) — não só na primeira hora — pra pegar o caso de o app
 * ter ficado fora do ar mais tempo que o intervalo alvo.
 */
export function startScheduler(jobs: JobDefinition[]): void {
  setTimeout(() => jobs.forEach((job) => void maybeRunJob(job)), STARTUP_DELAY_MS);
  setInterval(() => jobs.forEach((job) => void maybeRunJob(job)), CHECK_INTERVAL_MS);
}
