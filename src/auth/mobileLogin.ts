import { chromium } from "playwright";
import {
  fetchActueelAanbod,
  SessionExpiredError,
} from "../api/aanbod.js";
import { loadScanConfig } from "../config/env.js";
import { logger } from "../utils/logger.js";
import {
  saveStorageState,
  STORAGE_STATE_PATH,
} from "./storage.js";

const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const AUTHENTICATED_PATH = "/mijn-omgeving/mijn-overzicht";

async function main(): Promise<void> {
  const config = loadScanConfig();

  logger.info("Starting mobile authentication browser...");
  logger.info(`DISPLAY ............. ${process.env.DISPLAY ?? "not set"}`);
  logger.info("LOGIN TIMEOUT ....... 15 minutes");

  const browser = await chromium.launch({
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,800",
    ],
  });

  try {
    const context = await browser.newContext({
      viewport: {
        width: 1280,
        height: 800,
      },
    });

    const page = await context.newPage();

    logger.info("Opening Thuispoort for mobile authentication...");
    await page.goto(config.baseUrl, {
      waitUntil: "domcontentloaded",
    });

    console.log("");
    console.log("Use the mobile noVNC browser to log in to Thuispoort.");
    console.log("The browser will NOT be refreshed automatically.");
    console.log("Waiting for successful login...");
    console.log("");

    await page.waitForURL(
      (url) =>
        url.origin === new URL(config.baseUrl).origin &&
        url.pathname === AUTHENTICATED_PATH,
      {
        timeout: LOGIN_TIMEOUT_MS,
      },
    );

    logger.info("Authenticated account page detected.");
    logger.info("Verifying authenticated API profile...");

    try {
      await fetchActueelAanbod(
        context,
        config.aanbodPageUrl,
      );
    } catch (error: unknown) {
      if (error instanceof SessionExpiredError) {
        throw new Error(
          "Authentication was not confirmed by the API. Session was NOT saved.",
        );
      }

      throw error;
    }

    await saveStorageState(context);

    logger.info("LOGIN SESSION: VALID");
    logger.info("MOBILE LOGIN SUCCESS");
    logger.info(`Session saved to ${STORAGE_STATE_PATH}`);
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  logger.error(
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
