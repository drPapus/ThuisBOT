import { chromium } from "playwright";
import { fetchActueelAanbod, SessionExpiredError } from "./api/aanbod.js";
import { STORAGE_STATE_PATH, storageStateExists } from "./auth/storage.js";
import { loadScanConfig } from "./config/env.js";
import { reportEligible, reportSummary } from "./dry-run/reporter.js";
import { logger } from "./utils/logger.js";
import { filterEligible } from "./woningen/filter.js";
import { normalizeWoningen } from "./woningen/normalize.js";

function expiredAndExit(): void {
  logger.error("SESSION/API PROFILE NOT AUTHENTICATED");
  console.error("Run: npm run login");
}

async function main(): Promise<void> {
  const config = loadScanConfig();
  if (!(await storageStateExists())) {
    expiredAndExit();
    process.exitCode = 1;
    return;
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
    const raw = await fetchActueelAanbod(context, config.aanbodPageUrl);
    logger.info(`Received: ${raw.length} unique woningen`);
    const woningen = normalizeWoningen(raw);
    const eligible = filterEligible(woningen);
    logger.info(`Eligible: ${eligible.length}`);
    reportEligible(eligible);
    reportSummary(woningen.length, eligible.length);
  } catch (error: unknown) {
    if (error instanceof SessionExpiredError) {
      expiredAndExit();
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
