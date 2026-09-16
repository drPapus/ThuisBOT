import { chromium } from "playwright";
import { fetchActueelAanbod, SessionExpiredError } from "../api/aanbod.js";
import { STORAGE_STATE_PATH } from "../auth/storage.js";
import type { ScanConfig } from "../config/env.js";
import { reportNewWoningen, reportSummary } from "../dry-run/reporter.js";
import { formatAmsterdamDateTime } from "../scheduler/scheduler.js";
import { loadKnownWoningen, saveKnownWoningen } from "../state/knownWoningen.js";
import { logger } from "../utils/logger.js";
import { normalizeWoningen } from "../woningen/normalize.js";
import { detectNewWoningen } from "./detectNew.js";

function reportExpiredSession(): void {
  logger.error("SESSION/API PROFILE NOT AUTHENTICATED");
  console.error("Run: npm run login");
}

export async function scan(config: ScanConfig): Promise<void> {
  // Load state before fetching so corrupted/unreadable state always fails closed.
  const loadedState = await loadKnownWoningen();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
    const raw = await fetchActueelAanbod(context, config.aanbodPageUrl);
    const woningen = normalizeWoningen(raw);
    const uniqueCurrent = detectNewWoningen(woningen, []).current;
    logger.info(`Received: ${uniqueCurrent.length} unique woningen`);

    if (!loadedState.exists) {
      logger.info("STATE: no baseline found");
      await saveKnownWoningen(uniqueCurrent.map((woning) => woning.id));
      logger.info("BASELINE CREATED");
      logger.info(`Known woningen: ${uniqueCurrent.length}`);
      logger.info("New: 0");
      reportSummary(uniqueCurrent.length, 0);
      return;
    }

    const result = detectNewWoningen(uniqueCurrent, loadedState.state.knownIds);
    logger.info(`Known before scan: ${loadedState.state.knownIds.length}`);
    logger.info(`New: ${result.newWoningen.length}`);

    if (result.newWoningen.length > 0) {
      // Persist first: a failed write must never emit repeatable NEW events.
      await saveKnownWoningen(result.updatedKnownIds);
      logger.info(`State updated: ${result.updatedKnownIds.length} known woningen`);
      reportNewWoningen(result.newWoningen, formatAmsterdamDateTime(new Date()));
    }

    reportSummary(result.current.length, result.newWoningen.length);
  } catch (error: unknown) {
    if (error instanceof SessionExpiredError) {
      reportExpiredSession();
      return;
    }
    throw error;
  } finally {
    await browser.close();
  }
}
