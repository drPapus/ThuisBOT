import { chromium } from "playwright";
import { fetchActueelAanbod, SessionExpiredError } from "../api/aanbod.js";
import { STORAGE_STATE_PATH, storageStateExists } from "../auth/storage.js";
import { loadScanConfig } from "../config/env.js";
import { logger } from "../utils/logger.js";
import type { RawWoning } from "../woningen/types.js";
import { fetchReactionFormConfig } from "./formConfig.js";
import { prepareReaction } from "./prepareReaction.js";
import { formatReactionPreparationReport } from "./reporter.js";
import type {
  DwellingReactionInput,
  PreparationFailureReason,
  ReactionPreparationResult,
} from "./types.js";

function identifier(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function toReactionInput(raw: RawWoning): DwellingReactionInput {
  const reaction = raw.reactionData;
  const dwellingId = identifier(raw.id);
  const assignmentId = identifier(raw.assignmentID);
  const isPassend = boolean(reaction?.isPassend);
  const kanReageren = boolean(reaction?.kanReageren);
  const loggedIn = boolean(reaction?.loggedin);
  const action = text(reaction?.action);
  const label = text(reaction?.label);
  const reactionUrl = text(reaction?.url);
  const closingDate = text(raw.closingDate);
  return {
    ...(dwellingId !== undefined && { dwellingId }),
    ...(assignmentId !== undefined && { assignmentId }),
    ...(isPassend !== undefined && { isPassend }),
    ...(kanReageren !== undefined && { kanReageren }),
    ...(loggedIn !== undefined && { loggedIn }),
    ...(action !== undefined && { action }),
    ...(label !== undefined && { label }),
    ...(reactionUrl !== undefined && { reactionUrl }),
    ...(closingDate !== undefined && { closingDate }),
  };
}

function failure(
  reason: PreparationFailureReason,
  dwellingId?: string,
): ReactionPreparationResult {
  return { ok: false, reason, ...(dwellingId !== undefined && { dwellingId }) };
}

async function main(): Promise<void> {
  const requestedId = process.argv[2]?.trim();
  if (!requestedId) {
    throw new Error("Usage: npm run prepare-reaction -- <dwellingId>");
  }
  if (!(await storageStateExists())) {
    throw new Error("Authentication state is missing. Run: npm run login");
  }

  const config = loadScanConfig();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
    const aanbod = await fetchActueelAanbod(context, config.aanbodPageUrl);
    const raw = aanbod.find((woning) => String(woning.id) === requestedId);
    if (!raw) {
      console.log(formatReactionPreparationReport(failure("MISSING_DWELLING_ID", requestedId)));
      process.exitCode = 2;
      return;
    }

    const input = toReactionInput(raw);
    let result: ReactionPreparationResult;
    try {
      const form = await fetchReactionFormConfig(context, config.baseUrl);
      result = prepareReaction(input, form);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const knownReasons = new Set<PreparationFailureReason>([
        "SESSION_EXPIRED",
        "MISSING_FORM_ID",
        "MISSING_FORM_HASH",
      ]);
      if (!knownReasons.has(message as PreparationFailureReason)) throw error;
      result = failure(message as PreparationFailureReason, requestedId);
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
