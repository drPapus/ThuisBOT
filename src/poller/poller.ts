import {
  calculateNextDelay,
  determinePollingMode,
  formatAmsterdamTime,
  type PollingIntervals,
  type PollingMode,
} from "../scheduler/scheduler.js";
import { logger } from "../utils/logger.js";

export interface PollerOptions {
  intervals: PollingIntervals;
  signal: AbortSignal;
  now?: () => Date;
}

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

function logMode(previous: PollingMode | undefined, current: PollingMode): void {
  if (previous === undefined) {
    logger.info(`POLL MODE: ${current}`);
  } else if (previous !== current) {
    logger.info(`POLL MODE: ${previous} → ${current}`);
  }
}

export async function runPoller(
  runScan: () => Promise<void>,
  { intervals, signal, now = () => new Date() }: PollerOptions,
): Promise<void> {
  logger.info("POLLER STARTED");
  let lastMode: PollingMode | undefined;

  while (!signal.aborted) {
    const scanMode = determinePollingMode(now());
    logMode(lastMode, scanMode);
    lastMode = scanMode;
    logger.info("Starting scan...");
    try {
      await runScan();
    } catch (error: unknown) {
      logger.error(`Scan failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (signal.aborted) break;
    const schedule = calculateNextDelay(now(), intervals);
    logMode(lastMode, schedule.mode);
    lastMode = schedule.mode;
    logger.info(`Next scan in ${Math.ceil(schedule.delayMs / 1_000)}s`);
    logger.info(
      `Next boundary: ${schedule.boundary.nextMode} at ${formatAmsterdamTime(schedule.boundary.at)}`,
    );
    await wait(schedule.delayMs, signal);
  }

  logger.info("Poller stopped.");
}
