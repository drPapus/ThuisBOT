import { chromium } from "playwright";
import { fetchActueelAanbod, SessionExpiredError } from "../api/aanbod.js";
import { STORAGE_STATE_PATH, storageStateExists } from "../auth/storage.js";
import { loadScanConfig } from "../config/env.js";
import { runCoordinatedAutomaticPreparation } from "../reaction/automaticCoordinator.js";
import { createAutomaticLiveDependencies } from "../reaction/automaticLiveAdapter.js";
import { fetchDwellingReactionDetails } from "../reaction/dwellingDetails.js";
import { fetchReactionFormConfig } from "../reaction/formConfig.js";
import { createLiveSafetyController } from "../reaction/liveSafety.js";
import { performStartupSafetyAudit } from "../reaction/reactionSafety.js";
import { findReactionRecord, loadReactionState } from "../state/reactionState.js";
import { normalizeWoningen } from "../woningen/normalize.js";
import { parseAutoReactOnceArgs, runAutoReactOnceSelection } from "./autoReactOnceFlow.js";

async function main(): Promise<void> {
  const dwellingId = parseAutoReactOnceArgs(process.argv.slice(2));
  const config = loadScanConfig();
  if (!(await storageStateExists())) throw new Error("Authentication state is missing. Run: npm run login");

  console.log("AUTO-REACT-ONCE\n");
  console.log(`Dwelling ........ ${dwellingId}`);
  console.log(`AUTO_SUBMIT ...... ${config.autoSubmit ? "ON" : "OFF"}`);
  console.log("MAX DWELLINGS .... 1");
  console.log("MAX LIVE POSTS ... 1\n");

  // The operator CLI still selects one dwelling, while sharing Stage 5.5 global safety policy.
  const liveSafety = createLiveSafetyController({
    maxAttempts: 1,
    minIntervalMs: config.minLiveSubmitIntervalMs,
  });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
    const live = config.autoSubmit ? createAutomaticLiveDependencies(context, config.baseUrl) : undefined;
    if (live) await performStartupSafetyAudit(liveSafety, {
      verify: live.verify,
      staleAfterMs: config.reactionInProgressStaleMs,
    });
    await runAutoReactOnceSelection(dwellingId, {
      async fetchCurrentAanbod() {
        return normalizeWoningen(await fetchActueelAanbod(context, config.aanbodPageUrl));
      },
      coordinate: (woning) => runCoordinatedAutomaticPreparation(
        String(woning.id),
        woning.modelCode,
        {
          async isPresentInAanbod(requestedId) {
            const fresh = await fetchActueelAanbod(context, config.aanbodPageUrl);
            return fresh.some((candidate) => String(candidate.id) === requestedId);
          },
          fetchDetails: (requestedId) =>
            fetchDwellingReactionDetails(context, config.baseUrl, requestedId),
          fetchForm: () => fetchReactionFormConfig(context, config.baseUrl),
        },
        config.autoSubmit,
        {
          staleAfterMs: config.reactionInProgressStaleMs,
          liveSafety,
          ...(live && { live }),
        },
      ),
    });

    const final = findReactionRecord(await loadReactionState(), dwellingId);
    console.log("\nAUTO-REACT-ONCE COMPLETE");
    console.log(`Dwelling ........ ${dwellingId}`);
    console.log(`Final state ..... ${final?.status ?? "NO_STATE"}`);
    console.log(`Live attempts ... ${liveSafety.attemptsUsed}`);
  } catch (error: unknown) {
    if (error instanceof SessionExpiredError) {
      throw new Error("SESSION/API PROFILE NOT AUTHENTICATED\nRun: npm run login");
    }
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
