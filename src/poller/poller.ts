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

export interface PollerOptions {
  intervals: PollingIntervals;
  signal: AbortSignal;
  now?: () => Date;
  onAuthRequired?: () => Promise<void>;
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
  runScan: () => Promise<PollerScanResult>,
  {
    intervals,
    signal,
    now = () => new Date(),
    onAuthRequired,
   }: PollerOptions,
 ): Promise<void> {
  logger.info("POLLER STARTED");
  let lastMode: PollingMode | undefined;

  while (!signal.aborted) {
    const scanMode = determinePollingMode(now());
    logMode(lastMode, scanMode);
    lastMode = scanMode;
    logger.info("Starting scan...");
  try {
   const result = await runScan();

   if (result.status === "AUTH_REQUIRED") {
    logger.error("AUTH REQUIRED — normal polling stopped.");
    logger.error("Automatic reactions are paused.");
    logger.error("Run: npm run login");
   
  if (onAuthRequired) {
    await onAuthRequired();
  }

    break;
  }
} catch (error: unknown) {
  logger.error(`Scan failed: ${error instanceof Error ? error.message : String(error)}`);
}

    if (signal.aborted) break;
    const schedule = calculateNextDelay(now(), intervals);
    logMode(lastMode, schedule.mode);
    lastMode = schedule.mode;
    logger.info(`Next scan in ${Math.ceil(schedule.delayMs / 1_000)}s`);
    logger.info(
     `Next boundary: ${schedule.boundary.nextMode} at ${formatAmsterdamDateTime(schedule.boundary.at)}`,
   );
    await wait(schedule.delayMs, signal);
  }

  logger.info("Poller stopped.");
}
