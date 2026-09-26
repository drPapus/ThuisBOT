import {
  calculateNextDelay,
  determinePollingMode,
  formatAmsterdamDateTime,
  type PollingIntervals,
  type PollingMode,
} from "../scheduler/scheduler.js";
import { logger } from "../utils/logger.js";

export type PollerScanResult =
  | { status: "OK" }
  | { status: "AUTH_REQUIRED" };

export type PollerAuthStatus = "VALID" | "EXPIRED";

export interface PollerOptions {
  intervals: PollingIntervals;
  signal: AbortSignal;
  now?: () => Date;

  onAuthRequired?: () => Promise<void>;
  checkAuth?: () => Promise<PollerAuthStatus>;
  onAuthRestored?: () => Promise<void>;

  authRetryIntervalMs?: number;
}

const DEFAULT_AUTH_RETRY_INTERVAL_MS = 5 * 60 * 1000;

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timeout = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });

    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function logMode(
  previous: PollingMode | undefined,
  current: PollingMode,
): void {
  if (previous === undefined) {
    logger.info(`POLL MODE: ${current}`);
  } else if (previous !== current) {
    logger.info(`POLL MODE: ${previous} → ${current}`);
  }
}

export async function runPoller(
  runScan: () => Promise<PollerScanResult>,
  {
    intervals,
    signal,
    now = () => new Date(),
    onAuthRequired,
    checkAuth,
    onAuthRestored,
    authRetryIntervalMs = DEFAULT_AUTH_RETRY_INTERVAL_MS,
  }: PollerOptions,
): Promise<void> {
  logger.info("POLLER STARTED");

  let lastMode: PollingMode | undefined;
  let authRequired = false;

  while (!signal.aborted) {
    /*
     * AUTH-WAIT mode.
     *
     * No normal scans or automatic reactions are attempted while the
     * authenticated session is known to be expired.
     */
    if (authRequired) {
      logger.info(
        `AUTH-WAIT — next session check in ${Math.ceil(
          authRetryIntervalMs / 1_000,
        )}s`,
      );

      await wait(authRetryIntervalMs, signal);

      if (signal.aborted) break;

      if (!checkAuth) {
        logger.error(
          "AUTH-WAIT cannot continue: no session checker configured.",
        );
        break;
      }

      try {
        logger.info("AUTH-WAIT — checking stored session...");
        const status = await checkAuth();

        if (status === "EXPIRED") {
          logger.info("AUTH-WAIT — session still expired.");
          continue;
        }

        logger.info("SESSION RESTORED");
        authRequired = false;
        lastMode = undefined;

        if (onAuthRestored) {
          await onAuthRestored();
        }

        // Immediately resume normal scanning with the restored session.
        continue;
      } catch (error: unknown) {
        logger.error(
          `Session check failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );

        // A transient failure of the session checker must not resume
        // automatic reactions. Stay safely in AUTH-WAIT.
        continue;
      }
    }

    const scanMode = determinePollingMode(now());
    logMode(lastMode, scanMode);
    lastMode = scanMode;

    logger.info("Starting scan...");

    try {
      const result = await runScan();

      if (result.status === "AUTH_REQUIRED") {
        logger.error("AUTH REQUIRED — entering AUTH-WAIT.");
        logger.error("Automatic reactions are paused.");

        authRequired = true;

        if (onAuthRequired) {
          await onAuthRequired();
        }

        continue;
      }
    } catch (error: unknown) {
      logger.error(
        `Scan failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (signal.aborted) break;

    const schedule = calculateNextDelay(now(), intervals);
    logMode(lastMode, schedule.mode);
    lastMode = schedule.mode;

    logger.info(
      `Next scan in ${Math.ceil(schedule.delayMs / 1_000)}s`,
    );
    logger.info(
      `Next boundary: ${schedule.boundary.nextMode} at ${formatAmsterdamDateTime(
        schedule.boundary.at,
      )}`,
    );

    await wait(schedule.delayMs, signal);
  }

  logger.info("Poller stopped.");
}
