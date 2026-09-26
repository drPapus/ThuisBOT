import { storageStateExists } from "./auth/storage.js";
import { checkStoredSession } from "./auth/checkStoredSession.js";
import { loadScanConfig } from "./config/env.js";
import { runPoller } from "./poller/poller.js";
import { createAutomaticLiveRuntime, scan } from "./scanner/scan.js";
import { logger } from "./utils/logger.js";
import { sendTelegramNotification } from "./notifications/telegramNotifier.js";
import {
  prepareMobileLogin,
  startMobileLoginProcess,
} from "./auth/mobileLoginLauncher.js";

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

    await runPoller(
      () => scan(config, liveRuntime),
      {
        intervals: config.pollingIntervals,
        signal: shutdown.signal,

 onAuthRequired: async () => {
  let mobileLoginUrl: string | undefined;

  try {
    mobileLoginUrl = await prepareMobileLogin();
    logger.info("Mobile login infrastructure ready.");
   
    startMobileLoginProcess();
  } catch (error: unknown) {
    logger.error(
      `Failed to prepare mobile login: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

    await sendTelegramNotification(
      [
        "🔴 ThuisBOT SESSION EXPIRED",
        "",
        "Thuispoort session expired.",
        "Automatic reactions are paused.",
        "",
        ...(mobileLoginUrl
          ? [
              "🔐 Open mobile login:",
              mobileLoginUrl,
            "",
            ]
          : [
              "⚠️ Mobile login link could not be created.",
            "",
            ]),
        "ThuisBOT is still running and waiting for a new session.",
      ].join("\n"),
    );
  },

        checkAuth: () =>
          checkStoredSession(config.aanbodPageUrl),

        onAuthRestored: async () => {
          await sendTelegramNotification(
            [
              "🟢 ThuisBOT SESSION RESTORED",
              "",
              "Thuispoort session is valid again.",
              "Automatic reactions resumed.",
            ].join("\n"),
          );
        },

        authRetryIntervalMs: 30 * 1000,
      },
    );
  } finally {
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("SIGTERM", requestShutdown);
  }
}

main().catch((error: unknown) => {
  logger.error(
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
