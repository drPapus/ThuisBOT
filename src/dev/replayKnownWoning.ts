import { chromium } from "playwright";
import { fetchActueelAanbod, SessionExpiredError } from "../api/aanbod.js";
import { STORAGE_STATE_PATH, storageStateExists } from "../auth/storage.js";
import { loadScanConfig } from "../config/env.js";
import {
  runCoordinatedAutomaticPreparation,
} from "../reaction/automaticCoordinator.js";
import { fetchDwellingReactionDetails } from "../reaction/dwellingDetails.js";
import { fetchReactionFormConfig } from "../reaction/formConfig.js";
import { formatAmsterdamDateTime } from "../scheduler/scheduler.js";
import { processNewWoningen } from "../scanner/processNewWoningen.js";
import { loadKnownWoningen } from "../state/knownWoningen.js";
import { logger } from "../utils/logger.js";
import { normalizeWoning } from "../woningen/normalize.js";

const HELP = `Usage:
  npm run replay-known -- <dwellingId>

Development-only Stage 5.1 replay.
The production known-woningen state is read but never modified.
AUTO_SUBMIT remains OFF and no housing reaction is sent.`;

async function main(): Promise<void> {
  const dwellingId = process.argv[2]?.trim();
  if (dwellingId === "-h" || dwellingId === "--help") {
    console.log(HELP);
    return;
  }
  if (!dwellingId || !/^\d+$/.test(dwellingId) || process.argv.length > 3) {
    throw new Error(HELP);
  }
  if (!(await storageStateExists())) {
    throw new Error("Authentication state is missing. Run: npm run login");
  }

  const known = await loadKnownWoningen();
  if (!known.exists) {
    throw new Error("Production baseline is missing. Run: npm run scan");
  }
  if (!known.state.knownIds.some((id) => String(id) === dwellingId)) {
    throw new Error(`Dwelling ${dwellingId} is not in the production known-woningen baseline.`);
  }

  const config = loadScanConfig(); // Enforces AUTO_SUBMIT=false.
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
    logger.info("DEV REPLAY MODE — production baseline is READ ONLY");
    logger.info(`Replaying exactly one known dwelling as NEW: #${dwellingId}`);

    const aanbod = await fetchActueelAanbod(context, config.aanbodPageUrl);
    const rawIndex = aanbod.findIndex((woning) => String(woning.id) === dwellingId);
    if (rawIndex < 0) {
      throw new Error(`Dwelling ${dwellingId} is known but is not present in current aanbod.`);
    }
    const woning = normalizeWoning(aanbod[rawIndex]!, rawIndex);

    await processNewWoningen(
      [woning],
      formatAmsterdamDateTime(new Date()),
      async (eligible) => {
        await runCoordinatedAutomaticPreparation(
          String(eligible.id),
          eligible.modelCode,
          {
            async isPresentInAanbod(requestedId) {
              const freshAanbod = await fetchActueelAanbod(context, config.aanbodPageUrl);
              return freshAanbod.some((candidate) => String(candidate.id) === requestedId);
            },
            fetchDetails: (requestedId) =>
              fetchDwellingReactionDetails(context, config.baseUrl, requestedId),
            fetchForm: () => fetchReactionFormConfig(context, config.baseUrl),
          },
          false,
          { staleAfterMs: config.reactionInProgressStaleMs },
        );
      },
    );
    logger.info("DEV REPLAY COMPLETE — production baseline was not modified");
    console.log("0 reactions sent");
  } catch (error: unknown) {
    if (error instanceof SessionExpiredError) {
      throw new Error("SESSION_EXPIRED. Run: npm run login");
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
