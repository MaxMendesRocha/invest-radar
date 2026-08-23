import app from "./app";
import { logger } from "./lib/logger";
import { startScheduler } from "./lib/scheduler";
import { OPPORTUNITIES_JOB } from "./lib/opportunities-engine";
import { TREASURY_JOB } from "./lib/treasury-data";
import { FII_EVENTS_JOB } from "./lib/fii-events-sync";
import { PORTFOLIO_SNAPSHOT_JOB } from "./lib/portfolio-snapshot-job";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

startScheduler([OPPORTUNITIES_JOB, TREASURY_JOB, FII_EVENTS_JOB, PORTFOLIO_SNAPSHOT_JOB]);
