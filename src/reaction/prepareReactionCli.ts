import { chromium } from "playwright";
import { fetchActueelAanbod, SessionExpiredError } from "../api/aanbod.js";
import { STORAGE_STATE_PATH, storageStateExists } from "../auth/storage.js";
import { loadScanConfig } from "../config/env.js";
import { logger } from "../utils/logger.js";
import {
  DwellingDetailsError,
  fetchDwellingReactionDetails,
} from "./dwellingDetails.js";
import { fetchReactionFormConfig } from "./formConfig.js";
import { prepareReaction } from "./prepareReaction.js";
import {
  formatAuthoritativeReactionState,
  formatReactionPreparationReport,
} from "./reporter.js";
import type {
  PreparationFailureReason,
  ReactionPreparationResult,
} from "./types.js";

const HELP = `Usage:
  npm run prepare-reaction -- <dwellingId> [--debug-state]

Stage 4.2 is READ-ONLY.
No housing reaction will be sent.`;

function failure(
  reason: PreparationFailureReason,
  dwellingId?: string,
): ReactionPreparationResult {
  return { ok: false, reason, ...(dwellingId !== undefined && { dwellingId }) };
}

async function main(): Promise<void> {
  const requestedId = process.argv[2]?.trim();
  const options = process.argv.slice(3);
  if (requestedId === "-h" || requestedId === "--help") {
    console.log(HELP);
    return;
  }
  if (!requestedId) throw new Error(HELP);
  const unknownOption = options.find((option) => option !== "--debug-state");
  if (unknownOption) throw new Error(`Unknown option: ${unknownOption}\n\n${HELP}`);
  const debugState = options.includes("--debug-state");
  if (!(await storageStateExists())) {
    throw new Error("Authentication state is missing. Run: npm run login");
  }

  const config = loadScanConfig();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
    const aanbod = await fetchActueelAanbod(context, config.aanbodPageUrl);
    const isPresent = aanbod.some((woning) => String(woning.id) === requestedId);
    if (!isPresent) {
      if (debugState) {
        console.log(formatAuthoritativeReactionState(requestedId, false));
      }
      console.log(formatReactionPreparationReport(failure("MISSING_DWELLING_ID", requestedId)));
      process.exitCode = 2;
      return;
    }

    let result: ReactionPreparationResult;
    try {
      const details = await fetchDwellingReactionDetails(context, config.baseUrl, requestedId);
      if (debugState) {
        console.log(formatAuthoritativeReactionState(requestedId, true, details));
      }

      // Preflight without a form avoids fetching a fresh hash for known failure states.
      const preflight = prepareReaction(details, {});
      if (!preflight.ok && !["MISSING_FORM_ID", "MISSING_FORM_HASH"].includes(preflight.reason)) {
        result = preflight;
      } else {
        const form = await fetchReactionFormConfig(context, config.baseUrl);
        result = prepareReaction(details, form);
      }
    } catch (error: unknown) {
      if (error instanceof DwellingDetailsError) {
        result = failure(error.reason, requestedId);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        const knownReasons = new Set<PreparationFailureReason>([
          "SESSION_EXPIRED",
          "MISSING_FORM_ID",
          "MISSING_FORM_HASH",
        ]);
        if (!knownReasons.has(message as PreparationFailureReason)) throw error;
        result = failure(message as PreparationFailureReason, requestedId);
      }
    }

    console.log(formatReactionPreparationReport(result));
    if (!result.ok) process.exitCode = 2;
  } catch (error: unknown) {
    if (error instanceof SessionExpiredError) {
      console.log(formatReactionPreparationReport(failure("SESSION_EXPIRED", requestedId)));
      process.exitCode = 2;
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
