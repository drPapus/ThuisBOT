import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { chromium, type Browser } from "playwright";
import { fetchActueelAanbod, SessionExpiredError } from "../api/aanbod.js";
import { STORAGE_STATE_PATH, storageStateExists } from "../auth/storage.js";
import { loadScanConfig } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { fetchDwellingReactionDetails } from "./dwellingDetails.js";
import { DwellingDetailsError } from "./dwellingDetails.js";
import { fetchReactionFormConfig } from "./formConfig.js";
import { formatLiveConfirmation, formatLiveReactionResult } from "./liveReporter.js";
import { runReactOnceFlow } from "./reactOnceFlow.js";
import { submitPreparedReactionOnce } from "./submitReaction.js";
import {
  acquireReactionSubmissionLock,
  ReactionSubmissionLockedError,
} from "./submissionLock.js";

const HELP = `Usage:
  npm run react-once -- <dwellingId>

This command can place exactly one REAL housing reaction.
Interactive confirmation is mandatory.`;

async function main(): Promise<void> {
  const dwellingId = process.argv[2]?.trim();
  if (dwellingId === "-h" || dwellingId === "--help") {
    console.log(HELP);
    return;
  }
  if (!dwellingId) throw new Error(HELP);
  if (process.argv.length > 3) throw new Error(`Unexpected argument.\n\n${HELP}`);
  if (!/^\d+$/.test(dwellingId)) throw new Error(`Invalid dwelling ID.\n\n${HELP}`);
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Interactive TTY required. No reaction request sent.");
  }
  if (!(await storageStateExists())) {
    throw new Error("Authentication state is missing. Run: npm run login");
  }

  const lock = await acquireReactionSubmissionLock();
  let browser: Browser | undefined;
  try {
    const config = loadScanConfig();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      const result = await runReactOnceFlow(dwellingId, {
        async isPresentInAanbod(requestedId) {
          const aanbod = await fetchActueelAanbod(context, config.aanbodPageUrl);
          return aanbod.some((woning) => String(woning.id) === requestedId);
        },
        fetchDetails: (requestedId) =>
          fetchDwellingReactionDetails(context, config.baseUrl, requestedId),
        fetchForm: () => fetchReactionFormConfig(context, config.baseUrl),
        async confirm(prepared) {
          console.log(formatLiveConfirmation(prepared));
          return prompt.question("Confirmation: ");
        },
        submit: (prepared) => submitPreparedReactionOnce(context, config.baseUrl, prepared),
      });
      console.log(formatLiveReactionResult(result, dwellingId));
      if (result.status !== "REACTION_PLACED" && result.status !== "REACTION_CANCELLED") {
        process.exitCode = 2;
      }
    } finally {
      prompt.close();
    }
  } catch (error: unknown) {
    if (error instanceof SessionExpiredError) {
      console.log("SESSION_EXPIRED\nNo request sent.");
      process.exitCode = 2;
      return;
    }
    if (error instanceof DwellingDetailsError) {
      console.log(`REACTION SKIPPED\nDwelling: ${dwellingId}\nReason: ${error.reason}\nNo request sent.`);
      process.exitCode = 2;
      return;
    }
    throw error;
  } finally {
    await browser?.close();
    await lock.release();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ReactionSubmissionLockedError) {
    logger.error("REACTION_SUBMISSION_LOCKED");
  } else {
    logger.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
