import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { chromium } from "playwright";
import { loadLoginConfig } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { validateSession } from "./session.js";
import { saveStorageState, STORAGE_STATE_PATH } from "./storage.js";

async function main(): Promise<void> {
  const config = loadLoginConfig();
  const browser = await chromium.launch({ headless: false });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    logger.info("Opening Thuispoort for manual authentication...");
    await page.goto(config.baseUrl, { waitUntil: "domcontentloaded" });

    console.log("\nLog in manually in the browser. Return here only after your account page is visible.");
    const prompt = createInterface({ input: stdin, output: stdout });
    await prompt.question("Press Enter to save the authenticated session... ");
    prompt.close();

    const cookies = await context.cookies();
    if (cookies.length === 0) {
      throw new Error("No browser cookies were found. The login may not have completed.");
    }

    const status = await validateSession(context, config.sessionCheckUrl);
    logger.info(`SESSION: ${status}`);
    if (status === "EXPIRED") {
      throw new Error(
        "Authentication could not be confirmed. Complete login and try again, or configure THUISPOORT_SESSION_CHECK_URL.",
      );
    }

    await saveStorageState(context);
    logger.info(`Session saved to ${STORAGE_STATE_PATH}`);
    logger.info("No credentials were stored by this application.");
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
