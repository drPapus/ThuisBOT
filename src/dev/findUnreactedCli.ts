import { chromium } from "playwright";
import { fetchActueelAanbod, SessionExpiredError } from "../api/aanbod.js";
import { STORAGE_STATE_PATH, storageStateExists } from "../auth/storage.js";
import { loadAutoSubmit, loadScanConfig } from "../config/env.js";
import {
  findUnreacted,
  FindUnreactedSessionError,
  assertFindUnreactedReadOnlyMode,
  parseFindUnreactedArgs,
  reportFindUnreacted,
} from "../audit/findUnreacted.js";
import { fetchDwellingReactionDetails } from "../reaction/dwellingDetails.js";
import { normalizeWoningen } from "../woningen/normalize.js";

async function main(): Promise<void> {
  const range = parseFindUnreactedArgs(process.argv.slice(2));
  assertFindUnreactedReadOnlyMode(loadAutoSubmit());
  if (!(await storageStateExists())) throw new Error("Authentication state missing. Run: npm run login");
  const config = loadScanConfig();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
    const audit = await findUnreacted({
      async fetchCurrentAanbod() {
        return normalizeWoningen(await fetchActueelAanbod(context, config.aanbodPageUrl));
      },
      fetchDetails: (dwellingId) =>
        fetchDwellingReactionDetails(context, config.baseUrl, dwellingId),
    }, range);
    reportFindUnreacted(audit);
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  const sessionFailure = error instanceof SessionExpiredError || error instanceof FindUnreactedSessionError;
  console.error(sessionFailure
    ? "ERROR: authenticated session is not valid.\nNo classifications were trusted."
    : error instanceof Error ? error.message : String(error));
  console.error("\nREAD ONLY\n0 reactions sent\n0 reactions removed\n0 state records modified");
  process.exitCode = 1;
});
