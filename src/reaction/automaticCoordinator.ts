import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";
import {
  findReactionRecord,
  loadReactionState,
  REACTION_STATE_PATH,
  replaceReactionRecord,
  saveReactionState,
  transitionReactionRecord,
  IllegalReactionTransitionError,
  type AutomaticReactionRecord,
} from "../state/reactionState.js";
import {
  appendReactionJournalEvent,
  REACTION_JOURNAL_PATH,
  type ReactionJournalEvent,
} from "../state/reactionJournal.js";
import type { ReactionPreparationDependencies } from "./liveTypes.js";
import {
  formatAutomaticPreparationReport,
  runAutomaticPreparationPipeline,
  type AutomaticPreparationResult,
} from "./automaticPipeline.js";
import { ReactionLockIntegrityError, withGlobalReactionLock } from "./reactionLock.js";
import type { AutomaticLiveDependencies } from "./automaticLiveAdapter.js";
import { createLiveSafetyController, type LiveSafetyController, type LiveCircuitReason } from "./liveSafety.js";
import { classifyReactionOutcome } from "./resultClassifier.js";
import { REACTION_ENDPOINT } from "./reactionEndpoint.js";

export const DEFAULT_IN_PROGRESS_STALE_MS = 15 * 60 * 1000;
export const MAX_PREPARED_AGE_MS = 30_000;

export type AutomaticProcessingOutcome =
  | { kind: "DEDUP_SKIPPED" }
  | { kind: "ABORTED" }
  | { kind: "DRY_RUN_PREPARED" }
  | { kind: "CIRCUIT_BLOCKED" }
  | { kind: "RUN_LIMIT_BLOCKED" }
  | { kind: "SUCCESS"; liveAttempted: boolean }
  | { kind: "FAILED"; liveAttempted: true }
  | { kind: "UNKNOWN"; liveAttempted: boolean };

export type CoordinatedAutomaticResult =
  | { status: "SKIPPED"; previous: AutomaticReactionRecord; outcome: { kind: "DEDUP_SKIPPED" } }
  | { status: "PROCESSED"; result: AutomaticPreparationResult; outcome: Exclude<AutomaticProcessingOutcome, { kind: "DEDUP_SKIPPED" }> };

export interface AutomaticCoordinatorOptions {
  statePath?: string;
  staleAfterMs?: number;
  now?: () => Date;
  withLock?: typeof withGlobalReactionLock;
  journalPath?: string;
  appendJournal?: typeof appendReactionJournalEvent;
  live?: AutomaticLiveDependencies;
  liveSafety?: LiveSafetyController;
  createAttemptId?: () => string;
  saveState?: typeof saveReactionState;
}

function isStale(record: AutomaticReactionRecord, now: Date, staleAfterMs: number): boolean {
  return record.status === "IN_PROGRESS" &&
    now.getTime() - Date.parse(record.updatedAt) >= staleAfterMs;
}

function reportDedupHit(record: AutomaticReactionRecord): void {
  logger.info("DEDUP HIT");
  console.log(`Status: ${record.status}`);
  console.log("Automatic processing skipped.");
}

async function blockingRecord(
  dwellingId: string,
  statePath: string,
  now: Date,
  staleAfterMs: number,
): Promise<AutomaticReactionRecord | undefined> {
  const state = await loadReactionState(statePath);
  const record = findReactionRecord(state, dwellingId);
  if (!record) return undefined;
  if (isStale(record, now, staleAfterMs)) {
    logger.info(`STALE IN_PROGRESS RECOVERED: #${dwellingId}`);
    return undefined;
  }
  return record;
}

export async function runCoordinatedAutomaticPreparation(
  dwellingId: string,
  model: string | undefined,
  dependencies: ReactionPreparationDependencies,
  autoSubmit: boolean,
  options: AutomaticCoordinatorOptions = {},
): Promise<CoordinatedAutomaticResult> {
  const statePath = options.statePath ?? REACTION_STATE_PATH;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_IN_PROGRESS_STALE_MS;
  const now = options.now ?? (() => new Date());
  const lock = options.withLock ?? withGlobalReactionLock;
  const journalPath = options.journalPath ??
    (options.statePath ? `${statePath}.journal.jsonl` : REACTION_JOURNAL_PATH);
  const appendJournal = options.appendJournal ?? appendReactionJournalEvent;
  const liveSafety = options.liveSafety ?? createLiveSafetyController();
  const createAttemptId = options.createAttemptId ?? randomUUID;
  const saveState = options.saveState ?? saveReactionState;

  logger.info(`NEW ELIGIBLE: #${dwellingId}`);
  const initial = await blockingRecord(dwellingId, statePath, now(), staleAfterMs);
  if (initial) {
    reportDedupHit(initial);
    return { status: "SKIPPED", previous: initial, outcome: { kind: "DEDUP_SKIPPED" } };
  }
  logger.info("DEDUP: CLEAR");
  logger.info("Waiting for reaction lock...");

  return lock<CoordinatedAutomaticResult>(async (): Promise<CoordinatedAutomaticResult> => {
    logger.info(`REACTION LOCK ACQUIRED: #${dwellingId}`);
    try {
      const afterLock = await blockingRecord(dwellingId, statePath, now(), staleAfterMs);
      if (afterLock) {
        logger.info("DEDUP RECHECK: HIT");
        reportDedupHit(afterLock);
        return { status: "SKIPPED", previous: afterLock, outcome: { kind: "DEDUP_SKIPPED" } };
      }
      logger.info("DEDUP RECHECK: CLEAR");

      const startedAt = now().toISOString();
      let state = await loadReactionState(statePath);
      const previous = findReactionRecord(state, dwellingId);
      const inProgress: AutomaticReactionRecord = {
        dwellingId,
        status: "IN_PROGRESS",
        firstSeenAt: previous?.firstSeenAt ?? startedAt,
        updatedAt: startedAt,
      };
      state = replaceReactionRecord(state, inProgress);
      await saveState(state, statePath);
      logger.info("STATE: IN_PROGRESS");

      let currentRecord = inProgress;
      const openCircuit = async (
        reason: LiveCircuitReason,
        assignmentId?: string,
        attemptId?: string,
      ): Promise<void> => {
        liveSafety.open(reason, dwellingId, attemptId);
        logger.error("LIVE CIRCUIT OPEN");
        console.log(`\nReason ............. ${reason}`);
        console.log(`Dwelling ........... #${dwellingId}`);
        if (attemptId) console.log(`Attempt ............ ${attemptId}`);
        console.log("\nFurther automatic live submissions are blocked.");
        console.log("Read-only scanning may continue.\n");
        await appendJournal({
          timestamp: now().toISOString(), dwellingId,
          ...(assignmentId && { assignmentId }), ...(attemptId && { attemptId }),
          event: "CIRCUIT_OPENED", reasonCode: reason,
        }, journalPath).catch(() => undefined);
      };
      try {
        const journal = (event: Omit<ReactionJournalEvent, "timestamp" | "dwellingId">) =>
          appendJournal({ timestamp: now().toISOString(), dwellingId, ...event }, journalPath);
        await journal({ event: "PREPARATION_STARTED" });
        logger.info("Starting reaction pipeline...");
        const result = await runAutomaticPreparationPipeline(
          dwellingId,
          model,
          dependencies,
          false,
        );
        if (!autoSubmit || result.status === "ABORTED") {
          console.log(`\n${formatAutomaticPreparationReport(result)}\n`);
        } else {
          logger.info("Fresh preparation complete");
        }
        const completedAt = now().toISOString();
        const finalRecord = result.status === "READY"
          ? transitionReactionRecord(inProgress, "PREPARED", completedAt, {
              assignmentId: result.prepared.assignmentId,
            })
          : transitionReactionRecord(inProgress, "ABORTED", completedAt, { reason: result.reason });
        state = await loadReactionState(statePath);
        await saveState(replaceReactionRecord(state, finalRecord), statePath);
        currentRecord = finalRecord;
        logger.info(`STATE: ${finalRecord.status}`);
        await journal(result.status === "READY"
          ? { event: "PREPARED", assignmentId: result.prepared.assignmentId, result: autoSubmit ? "LIVE_CANDIDATE" : "WOULD_SUBMIT" }
          : { event: "PREPARATION_ABORTED", reasonCode: result.reason });

        if (autoSubmit && result.status === "ABORTED" && [
          "SESSION_EXPIRED",
          "DWELLING_ID_MISMATCH",
          "MISSING_ASSIGNMENT_ID",
          "MISSING_FORM_ID",
          "MISSING_FORM_HASH",
          "REACTION_URL_MISMATCH",
          "UNEXPECTED_REACTION_STATE",
        ].includes(result.reason)) {
          await openCircuit("INFRASTRUCTURE_CONTRADICTION");
        }

        if (result.status !== "READY") {
          return { status: "PROCESSED", result, outcome: { kind: "ABORTED" } };
        }
        if (!autoSubmit) {
          return { status: "PROCESSED", result, outcome: { kind: "DRY_RUN_PREPARED" } };
        }

        const prepared = result.prepared;
        const preparedAt = new Date(completedAt);
        const blockLive = async (reason: string): Promise<void> => {
          logger.error(`LIVE SUBMIT BLOCKED: ${reason}`);
          const unknown = transitionReactionRecord(
            currentRecord,
            "UNKNOWN",
            now().toISOString(),
            { reason, submitBoundaryCrossed: false },
          );
          state = await loadReactionState(statePath);
          await saveState(replaceReactionRecord(state, unknown), statePath);
          currentRecord = unknown;
          await journal({
            event: "UNKNOWN",
            assignmentId: prepared.assignmentId,
            reasonCode: reason,
          });
        };

        logger.info("FINAL PRE-SUBMIT CHECK");
        const age = now().getTime() - preparedAt.getTime();
        const live = options.live;
        const gateValid =
          live !== undefined &&
          live.endpoint === REACTION_ENDPOINT &&
          currentRecord.status === "PREPARED" &&
          prepared.dwellingId === dwellingId &&
          prepared.assignmentId === currentRecord.assignmentId &&
          prepared.loggedIn === true &&
          prepared.isPassend === true &&
          prepared.kanReageren === true &&
          prepared.action === "add" &&
          prepared.method === "POST" &&
          prepared.formId === "Portal_Form_SubmitOnly" &&
          prepared.formHash.trim() !== "" &&
          age >= 0 && age <= MAX_PREPARED_AGE_MS;
        if (!gateValid) {
          await blockLive(age > MAX_PREPARED_AGE_MS ? "PREPARATION_STALE" : "FINAL_SAFETY_GATE_FAILED");
          return { status: "PROCESSED", result, outcome: { kind: "UNKNOWN", liveAttempted: false } };
        }

        if (liveSafety.circuit.open) {
          logger.error(`LIVE SUBMIT BLOCKED: ${liveSafety.circuit.reason ?? "CIRCUIT_OPEN"}`);
          await journal({
            event: "LIVE_ATTEMPT_BLOCKED", assignmentId: prepared.assignmentId,
            reasonCode: liveSafety.circuit.reason ?? "CIRCUIT_OPEN",
          });
          return { status: "PROCESSED", result, outcome: { kind: "CIRCUIT_BLOCKED" } };
        }

        const preSubmitVerification = await live.verify(dwellingId, prepared.assignmentId);
        await journal({
          event: "VERIFICATION_RESULT",
          assignmentId: prepared.assignmentId,
          result: preSubmitVerification.status,
          ...(preSubmitVerification.status === "INDETERMINATE" && { reasonCode: preSubmitVerification.reason }),
        });
        if (preSubmitVerification.status === "CONFIRMED_REACTED") {
          const success = transitionReactionRecord(
            currentRecord,
            "SUCCESS",
            now().toISOString(),
            { reason: "ALREADY_REACTED_BEFORE_SUBMIT" },
          );
          state = await loadReactionState(statePath);
          await saveState(replaceReactionRecord(state, success), statePath);
          currentRecord = success;
          await journal({
            event: "SUCCESS",
            assignmentId: prepared.assignmentId,
            reasonCode: "ALREADY_REACTED_BEFORE_SUBMIT",
          });
          logger.info("Existing reaction independently verified; live POST skipped.");
          return { status: "PROCESSED", result, outcome: { kind: "SUCCESS", liveAttempted: false } };
        }
        if (preSubmitVerification.status !== "CONFIRMED_NOT_REACTED") {
          await blockLive("PRE_SUBMIT_VERIFICATION_INDETERMINATE");
          return { status: "PROCESSED", result, outcome: { kind: "UNKNOWN", liveAttempted: false } };
        }

        const attemptId = createAttemptId();
        const reservation = await liveSafety.reserve(attemptId, dwellingId);
        if (!reservation.allowed) {
          const reason = reservation.reason ?? "CIRCUIT_OPEN";
          logger.error(reason === "RUN_LIMIT_EXHAUSTED" ? "LIVE RUN LIMIT EXHAUSTED" : "LIVE SUBMIT BLOCKED");
          await journal({
            event: reason === "RUN_LIMIT_EXHAUSTED" ? "RUN_LIMIT_EXHAUSTED" : "LIVE_ATTEMPT_BLOCKED",
            assignmentId: prepared.assignmentId, attemptId, reasonCode: reason,
          });
          return {
            status: "PROCESSED",
            result,
            outcome: { kind: reason === "RUN_LIMIT_EXHAUSTED" ? "RUN_LIMIT_BLOCKED" : "CIRCUIT_BLOCKED" },
          };
        }
        const submitting = transitionReactionRecord(
          currentRecord,
          "SUBMITTING",
          now().toISOString(),
          { attemptId, submitBoundaryCrossed: true },
        );
        state = await loadReactionState(statePath);
        await saveState(replaceReactionRecord(state, submitting), statePath);
        currentRecord = submitting;
        logger.info("STATE: SUBMITTING");
        await journal({ event: "SUBMIT_STARTED", assignmentId: prepared.assignmentId, attemptId });

        logger.info(`LIVE ATTEMPTS .... ${liveSafety.attemptsUsed}/${liveSafety.maxAttempts}`);
        logger.info("Sending ONE reaction POST...");
        const submission = await live.submit(prepared);
        let auditFailed = false;
        await journal({
          event: "SUBMIT_RESPONSE",
          assignmentId: prepared.assignmentId,
          attemptId,
          result: submission.status,
          ...(submission.status === "ACCEPTED_RESPONSE" && { httpStatus: submission.httpStatus }),
          ...(submission.status === "DEFINITIVE_REJECTION" && submission.httpStatus !== undefined && { httpStatus: submission.httpStatus }),
          ...(submission.status === "AMBIGUOUS" && { reasonCode: submission.reason }),
        }).catch(() => { auditFailed = true; });

        await journal({ event: "VERIFICATION_STARTED", assignmentId: prepared.assignmentId, attemptId })
          .catch(() => { auditFailed = true; });
        const postSubmitVerification = await live.verify(dwellingId, prepared.assignmentId);
        await journal({
          event: "VERIFICATION_RESULT",
          assignmentId: prepared.assignmentId,
          attemptId,
          result: postSubmitVerification.status,
          ...(postSubmitVerification.status === "INDETERMINATE" && { reasonCode: postSubmitVerification.reason }),
        }).catch(() => { auditFailed = true; });

        let outcome = auditFailed
          ? { status: "UNKNOWN" as const, reason: "AUDIT_PERSISTENCE_FAILED" }
          : classifyReactionOutcome(submission, postSubmitVerification);
        try {
          await journal({
            event: outcome.status,
            assignmentId: prepared.assignmentId,
            attemptId,
            ...(outcome.status !== "SUCCESS" && { reasonCode: outcome.reason }),
          });
        } catch {
          auditFailed = true;
          outcome = { status: "UNKNOWN", reason: "AUDIT_PERSISTENCE_FAILED" };
          await journal({
            event: "UNKNOWN", assignmentId: prepared.assignmentId, attemptId,
            reasonCode: "AUDIT_PERSISTENCE_FAILED",
          }).catch(() => undefined);
        }
        const terminal = transitionReactionRecord(
          currentRecord,
          outcome.status,
          now().toISOString(),
          outcome.status === "SUCCESS" ? {} : { reason: outcome.reason },
        );
        state = await loadReactionState(statePath);
        await saveState(replaceReactionRecord(state, terminal), statePath);
        currentRecord = terminal;
        logger.info(`STATE: ${terminal.status}`);
        if (auditFailed) {
          await openCircuit("AUDIT_PERSISTENCE_FAILED", prepared.assignmentId, attemptId);
        } else if (outcome.status === "UNKNOWN") {
          await openCircuit("UNKNOWN_RESULT", prepared.assignmentId, attemptId);
        }
        return {
          status: "PROCESSED",
          result,
          outcome: outcome.status === "SUCCESS"
            ? { kind: "SUCCESS", liveAttempted: true }
            : outcome.status === "FAILED"
              ? { kind: "FAILED", liveAttempted: true }
              : { kind: "UNKNOWN", liveAttempted: true },
        };
      } catch (error: unknown) {
        const crossedBoundary = currentRecord.status === "SUBMITTING" || currentRecord.submitBoundaryCrossed === true;
        if (autoSubmit) {
          const reason: LiveCircuitReason = error instanceof IllegalReactionTransitionError
            ? "ILLEGAL_STATE_TRANSITION"
            : crossedBoundary
              ? "UNKNOWN_RESULT"
              : "STATE_PERSISTENCE_FAILED";
          await openCircuit(reason, currentRecord.assignmentId, currentRecord.attemptId);
        }
        if (["IN_PROGRESS", "PREPARED", "SUBMITTING"].includes(currentRecord.status)) {
          const unknown = transitionReactionRecord(
            currentRecord,
            "UNKNOWN",
            now().toISOString(),
            {
              reason: "UNEXPECTED_EXCEPTION",
              submitBoundaryCrossed: crossedBoundary,
            },
          );
          state = await loadReactionState(statePath);
          await saveState(replaceReactionRecord(state, unknown), statePath);
          currentRecord = unknown;
          logger.info("STATE: UNKNOWN");
          await appendJournal({
            timestamp: now().toISOString(),
            dwellingId,
            ...(unknown.assignmentId && { assignmentId: unknown.assignmentId }),
            event: "UNKNOWN",
            reasonCode: "UNEXPECTED_EXCEPTION",
          }, journalPath).catch(() => undefined);
        }
        throw error;
      }
    } finally {
      logger.info(`REACTION LOCK RELEASED: #${dwellingId}`);
    }
  }, `${statePath}.lock`, staleAfterMs).catch(async (error: unknown) => {
    if (autoSubmit && error instanceof ReactionLockIntegrityError) {
      liveSafety.open("LOCK_INTEGRITY_FAILURE", dwellingId);
    }
    throw error;
  });
}
