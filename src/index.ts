import { storageStateExists } from "./auth/storage.js";
import { loadScanConfig } from "./config/env.js";
import { runPoller } from "./poller/poller.js";
import { scan } from "./scanner/scan.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<void> {
  const config = loadScanConfig();
  if (config.autoSubmit) {
    logger.info("AUTO SUBMIT: ENABLED");
    logger.info("CONTROLLED LIVE MODE");
    logger.info("MAX LIVE SUBMITS THIS PROCESS: 1");
  } else {
    logger.info("AUTO SUBMIT: DISABLED");
  }
  if (!(await storageStateExists())) {
    throw new Error("Authentication state is missing. Run: npm run login");
  }

  const shutdown = new AbortController();
  const requestShutdown = (): void => {
    if (!shutdown.signal.aborted) {
      logger.info("Shutdown requested...");
      shutdown.abort();
    }
  };
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);

  try {
    await runPoller(() => scan(config), {
      intervals: config.pollingIntervals,
      signal: shutdown.signal,
    });
  } finally {
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("SIGTERM", requestShutdown);
  }
}

main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
