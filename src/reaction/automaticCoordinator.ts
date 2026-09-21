import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";
import {
  findReactionRecord,
  loadReactionState,
  REACTION_STATE_PATH,
  replaceReactionRecord,
  saveReactionState,
  transitionReactionRecord,
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
import { withGlobalReactionLock } from "./reactionLock.js";
import type { AutomaticLiveDependencies } from "./automaticLiveAdapter.js";
import {
  processLiveSubmitBudget,
  type LiveSubmitBudget,
} from "./liveSubmitBudget.js";
import { classifyReactionOutcome } from "./resultClassifier.js";
import { REACTION_ENDPOINT } from "./reactionEndpoint.js";

export const DEFAULT_IN_PROGRESS_STALE_MS = 15 * 60 * 1000;
export const MAX_PREPARED_AGE_MS = 30_000;

export type CoordinatedAutomaticResult =
  | { status: "SKIPPED"; previous: AutomaticReactionRecord }
  | { status: "PROCESSED"; result: AutomaticPreparationResult };

export interface AutomaticCoordinatorOptions {
  statePath?: string;
  staleAfterMs?: number;
  now?: () => Date;
  withLock?: typeof withGlobalReactionLock;
  journalPath?: string;
  appendJournal?: typeof appendReactionJournalEvent;
  live?: AutomaticLiveDependencies;
  liveBudget?: LiveSubmitBudget;
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
  const liveBudget = options.liveBudget ?? processLiveSubmitBudget;
  const createAttemptId = options.createAttemptId ?? randomUUID;
  const saveState = options.saveState ?? saveReactionState;

  logger.info(`NEW ELIGIBLE: #${dwellingId}`);
  const initial = await blockingRecord(dwellingId, statePath, now(), staleAfterMs);
  if (initial) {
    reportDedupHit(initial);
    return { status: "SKIPPED", previous: initial };
  }
  logger.info("DEDUP: CLEAR");
  logger.info("Waiting for reaction lock...");

  return lock(async () => {
    logger.info(`REACTION LOCK ACQUIRED: #${dwellingId}`);
    try {
      const afterLock = await blockingRecord(dwellingId, statePath, now(), staleAfterMs);
      if (afterLock) {
        logger.info("DEDUP RECHECK: HIT");
        reportDedupHit(afterLock);
        return { status: "SKIPPED", previous: afterLock };
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

        if (result.status !== "READY" || !autoSubmit) return { status: "PROCESSED", result };

        const prepared = result.prepared;
        const preparedAt = new Date(completedAt);
        const blockLive = async (reason: string): Promise<void> => {
          logger.error(`LIVE SUBMIT BLOCKED: ${reason}`);
          const unknown = transitionReactionRecord(
            currentRecord,
            "UNKNOWN",
            now().toISOString(),
            { reason },
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
          age >= 0 && age <= MAX_PREPARED_AGE_MS &&
          liveBudget.used < 1;
        if (!gateValid) {
          await blockLive(age > MAX_PREPARED_AGE_MS ? "PREPARATION_STALE" : "FINAL_SAFETY_GATE_FAILED");
          return { status: "PROCESSED", result };
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
          return { status: "PROCESSED", result };
        }
        if (preSubmitVerification.status !== "CONFIRMED_NOT_REACTED") {
          await blockLive("PRE_SUBMIT_VERIFICATION_INDETERMINATE");
          return { status: "PROCESSED", result };
        }

        const attemptId = createAttemptId();
        const submitting = transitionReactionRecord(
          currentRecord,
          "SUBMITTING",
          now().toISOString(),
          { attemptId },
        );
        state = await loadReactionState(statePath);
        await saveState(replaceReactionRecord(state, submitting), statePath);
        currentRecord = submitting;
        logger.info("STATE: SUBMITTING");
        await journal({ event: "SUBMIT_STARTED", assignmentId: prepared.assignmentId, attemptId });

        // The irreversible boundary: consume the one-per-process budget before exactly one call.
        liveBudget.consume(attemptId);
        logger.info("LIVE BUDGET ...... 1/1");
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

        const outcome = auditFailed
          ? { status: "UNKNOWN" as const, reason: "AUDIT_PERSISTENCE_FAILED" }
          : classifyReactionOutcome(submission, postSubmitVerification);
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
        await journal({
          event: outcome.status,
          assignmentId: prepared.assignmentId,
          attemptId,
          ...(terminal.reason && { reasonCode: terminal.reason }),
        }).catch(() => undefined);
        logger.info("LIVE BUDGET EXHAUSTED");
        return { status: "PROCESSED", result };
      } catch (error: unknown) {
        if (["IN_PROGRESS", "PREPARED", "SUBMITTING"].includes(currentRecord.status)) {
          const unknown = transitionReactionRecord(
            currentRecord,
            "UNKNOWN",
            now().toISOString(),
            { reason: "UNEXPECTED_EXCEPTION" },
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
  }, `${statePath}.lock`, staleAfterMs);
}
