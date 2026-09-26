import { chromium } from "playwright";
import { fetchActueelAanbod, SessionExpiredError } from "../api/aanbod.js";
import { STORAGE_STATE_PATH } from "../auth/storage.js";
import type { ScanConfig } from "../config/env.js";
import { reportSummary } from "../dry-run/reporter.js";
import {
  runCoordinatedAutomaticPreparation,
} from "../reaction/automaticCoordinator.js";
import { createAutomaticLiveDependencies } from "../reaction/automaticLiveAdapter.js";
import { createLiveSafetyController, type LiveSafetyController } from "../reaction/liveSafety.js";
import { performStartupSafetyAudit } from "../reaction/reactionSafety.js";
import { fetchDwellingReactionDetails } from "../reaction/dwellingDetails.js";
import { fetchReactionFormConfig } from "../reaction/formConfig.js";
import { formatAmsterdamDateTime } from "../scheduler/scheduler.js";
import { loadKnownWoningen, saveKnownWoningen } from "../state/knownWoningen.js";
import { logger } from "../utils/logger.js";
import { normalizeWoningen } from "../woningen/normalize.js";
import { detectNewWoningen } from "./detectNew.js";
import { processNewWoningen } from "./processNewWoningen.js";
import { createScanSummary } from "./scanSummary.js";
import { isEligible } from "../woningen/filter.js";
import type { AutomaticProcessingOutcome } from "../reaction/automaticCoordinator.js";

function reportExpiredSession(): void {
  logger.error("SESSION/API PROFILE NOT AUTHENTICATED");
  console.error("Run: npm run login");
}

export interface AutomaticLiveRuntime {
  safety: LiveSafetyController;
  startupAudited: boolean;
}

export function createAutomaticLiveRuntime(config: ScanConfig): AutomaticLiveRuntime {
  return {
    safety: createLiveSafetyController({
      maxAttempts: config.maxLiveSubmitsPerRun,
      minIntervalMs: config.minLiveSubmitIntervalMs,
    }),
    startupAudited: false,
  };
}

export type ScanResult =
  | { status: "OK" }
  | { status: "AUTH_REQUIRED" };

export async function scan(
  config: ScanConfig,
  suppliedRuntime?: AutomaticLiveRuntime,
): Promise<ScanResult> {
  // Load state before fetching so corrupted/unreadable state always fails closed.
  const loadedState = await loadKnownWoningen();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
    const runtime = suppliedRuntime ?? createAutomaticLiveRuntime(config);
    const live = config.autoSubmit ? createAutomaticLiveDependencies(context, config.baseUrl) : undefined;
    if (config.autoSubmit && !runtime.startupAudited && live) {
      const audit = await performStartupSafetyAudit(runtime.safety, {
        verify: live.verify,
        staleAfterMs: config.reactionInProgressStaleMs,
      });
      runtime.startupAudited = true;
      logger.info(`CIRCUIT ............ ${audit.circuitOpen ? "OPEN" : "CLOSED"}`);
      if (audit.reason) logger.error(`CIRCUIT REASON ..... ${audit.reason}`);
    }
    const raw = await fetchActueelAanbod(context, config.aanbodPageUrl);
    const woningen = normalizeWoningen(raw);
    const uniqueCurrent = detectNewWoningen(woningen, []).current;
    logger.info(`Received: ${uniqueCurrent.length} unique woningen`);
    const scanAttemptStart = runtime.safety.attemptsUsed;

    if (!loadedState.exists) {
      logger.info("STATE: no baseline found");
      await saveKnownWoningen(uniqueCurrent.map((woning) => woning.id));
      logger.info("BASELINE CREATED");
      logger.info(`Known woningen: ${uniqueCurrent.length}`);
      logger.info("New: 0");
      reportSummary(createScanSummary({
        checked: uniqueCurrent.length,
        newCount: 0,
        eligible: 0,
        liveAttempts: 0,
        outcomes: [],
        circuitOpen: runtime.safety.circuit.open,
        ...(runtime.safety.circuit.reason && { circuitReason: runtime.safety.circuit.reason }),
        runLiveAttempts: runtime.safety.attemptsUsed,
        maxLiveAttempts: runtime.safety.maxAttempts,
      }));
      return { status:"OK" };
    }

    const result = detectNewWoningen(uniqueCurrent, loadedState.state.knownIds);
    logger.info(`Known before scan: ${loadedState.state.knownIds.length}`);
    logger.info(`New: ${result.newWoningen.length}`);

    let outcomes: AutomaticProcessingOutcome[] = [];
    if (result.newWoningen.length > 0) {
      // Persist first: a failed write must never emit repeatable NEW events.
      await saveKnownWoningen(result.updatedKnownIds);
      logger.info(`State updated: ${result.updatedKnownIds.length} known woningen`);
      outcomes = await processNewWoningen(
        result.newWoningen,
        formatAmsterdamDateTime(new Date()),
        async (woning) => {
          const candidateAttemptStart = runtime.safety.attemptsUsed;
          try {
            const coordinated = await runCoordinatedAutomaticPreparation(
              String(woning.id),
              woning.modelCode,
              {
                async isPresentInAanbod(dwellingId) {
                  const freshAanbod = await fetchActueelAanbod(context, config.aanbodPageUrl);
                  return freshAanbod.some((candidate) => String(candidate.id) === dwellingId);
                },
                fetchDetails: (dwellingId) =>
                  fetchDwellingReactionDetails(context, config.baseUrl, dwellingId),
                fetchForm: () => fetchReactionFormConfig(context, config.baseUrl),
              },
              config.autoSubmit,
              {
                staleAfterMs: config.reactionInProgressStaleMs,
                liveSafety: runtime.safety,
                ...(live && { live }),
              },
            );
            return coordinated.outcome;
          } catch (error: unknown) {
            logger.error(
              `Reaction preparation failed for #${woning.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            console.log("REACTION ABORTED\nNo reaction sent.\n");
            return { kind: "UNKNOWN", liveAttempted: runtime.safety.attemptsUsed > candidateAttemptStart };
          }
        },
      );
    }

    reportSummary(createScanSummary({
      checked: result.current.length,
      newCount: result.newWoningen.length,
      eligible: result.newWoningen.filter(isEligible).length,
      liveAttempts: runtime.safety.attemptsUsed - scanAttemptStart,
      outcomes,
      circuitOpen: runtime.safety.circuit.open,
      ...(runtime.safety.circuit.reason && { circuitReason: runtime.safety.circuit.reason }),
      runLiveAttempts: runtime.safety.attemptsUsed,
      maxLiveAttempts: runtime.safety.maxAttempts,
    }));

    return { status: "OK" };
  } catch (error: unknown) {
    if (error instanceof SessionExpiredError) {
      reportExpiredSession();
      return { status: "AUTH_REQUIRED" };
    }
    throw error;
  } finally {
    await browser.close();
  }
}
