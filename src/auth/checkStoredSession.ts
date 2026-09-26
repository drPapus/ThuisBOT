import { chromium } from "playwright";
import {
  fetchActueelAanbod,
  SessionExpiredError,
} from "../api/aanbod.js";
import {
  STORAGE_STATE_PATH,
  storageStateExists,
} from "./storage.js";

export type StoredSessionStatus = "VALID" | "EXPIRED";

export async function checkStoredSession(
  aanbodPageUrl: string,
): Promise<StoredSessionStatus> {
  if (!(await storageStateExists())) {
    return "EXPIRED";
  }

  const browser = await chromium.launch({
    headless: true,
  });

  try {
    const context = await browser.newContext({
      storageState: STORAGE_STATE_PATH,
    });

    try {
      await fetchActueelAanbod(
        context,
        aanbodPageUrl,
      );

      return "VALID";
    } catch (error: unknown) {
      if (error instanceof SessionExpiredError) {
        return "EXPIRED";
      }

      // Network/API/format errors are NOT proof that authentication
      // is valid. Let the poller catch this and remain fail-closed
      // in AUTH-WAIT.
      throw error;
    }
  } finally {
    await browser.close();
  }
}
