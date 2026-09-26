import { storageStateExists } from "./auth/storage.js";
import { loadScanConfig } from "./config/env.js";
import { runPoller } from "./poller/poller.js";
import { createAutomaticLiveRuntime, scan } from "./scanner/scan.js";
import { logger } from "./utils/logger.js";
import { sendTelegramNotification } from "./notifications/telegramNotifier.js";

async function main(): Promise<void> {
  const config = loadScanConfig();
  if (config.autoSubmit) {
    logger.info("AUTO SUBMIT ........ ENABLED");
    logger.info("MODE ............... AUTONOMOUS");
    logger.info(`MAX LIVE ATTEMPTS .. ${config.maxLiveSubmitsPerRun}`);
    logger.info(`MIN INTERVAL ....... ${config.minLiveSubmitIntervalMs} ms`);
  } else {
    logger.info("AUTO SUBMIT ........ DISABLED");
    logger.info("MODE ............... DRY RUN");
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
    const liveRuntime = createAutomaticLiveRuntime(config);
    await runPoller(() => scan(config, liveRuntime), {
  intervals: config.pollingIntervals,
  signal: shutdown.signal,
  onAuthRequired: async () => {
    await sendTelegramNotification(
      [
        "🔴 ThuisBOT stopped",
        "",
        "Thuispoort session expired.",
        "Automatic reactions are paused.",
        "",
        "Run: npm run login",
        "Then start the service again:",
        "sudo systemctl start thuisbot",
       ].join("\n"),
      );
    },
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
