import { chromium } from "playwright";
import { STORAGE_STATE_PATH, storageStateExists } from "../auth/storage.js";
import { loadScanConfig } from "../config/env.js";
import { fetchDwellingReactionDetails } from "../reaction/dwellingDetails.js";
import { verifyReactionDetails } from "../reaction/verification.js";
import { findReactionRecord, loadReactionState } from "../state/reactionState.js";

const HELP = `Usage:
  npm run verify-reaction -- <dwellingId>

DEV read-only verification. Uses only the verified getobject data fetch.
No reaction or state-changing request is sent.`;

async function main(): Promise<void> {
  const dwellingId = process.argv[2]?.trim();
  if (dwellingId === "--help" || dwellingId === "-h") return void console.log(HELP);
  if (!dwellingId || !/^\d+$/.test(dwellingId) || process.argv.length > 3) throw new Error(HELP);
  if (!(await storageStateExists())) throw new Error("Authentication state missing. Run: npm run login");
  const config = loadScanConfig();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
    const stateAssignmentId = findReactionRecord(await loadReactionState(), dwellingId)?.assignmentId;
    let assignmentId = stateAssignmentId;
    let verification: ReturnType<typeof verifyReactionDetails> | {
      status: "INDETERMINATE";
      reason: string;
    };
    try {
      const details = await fetchDwellingReactionDetails(context, config.baseUrl, dwellingId);
      assignmentId ??= details.assignmentId === undefined ? undefined : String(details.assignmentId);
      verification = assignmentId
        ? verifyReactionDetails(dwellingId, assignmentId, details)
        : { status: "INDETERMINATE", reason: "MISSING_ASSIGNMENT_ID" };
    } catch {
      verification = { status: "INDETERMINATE", reason: "VERIFICATION_READ_FAILED" };
    }
    console.log("DEV READ-ONLY REACTION VERIFICATION\n");
    console.log(`Dwelling ........ ${dwellingId}`);
    console.log(`Assignment ...... ${assignmentId ?? "UNKNOWN"}`);
    console.log(`Verification .... ${verification.status}`);
    if (verification.status === "INDETERMINATE") console.log(`Reason .......... ${verification.reason}`);
    console.log("\nNo state-changing request sent.");
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
