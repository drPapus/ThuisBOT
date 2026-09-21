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

export const DEFAULT_IN_PROGRESS_STALE_MS = 15 * 60 * 1000;

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
  autoSubmit: false,
  options: AutomaticCoordinatorOptions = {},
): Promise<CoordinatedAutomaticResult> {
  // The literal false type preserves the Stage 5 automatic no-submit boundary.
  if (autoSubmit !== false) throw new Error("AUTO_SUBMIT=true is forbidden in Stage 5.2; ABORT");
  const statePath = options.statePath ?? REACTION_STATE_PATH;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_IN_PROGRESS_STALE_MS;
  const now = options.now ?? (() => new Date());
  const lock = options.withLock ?? withGlobalReactionLock;
  const journalPath = options.journalPath ??
    (options.statePath ? `${statePath}.journal.jsonl` : REACTION_JOURNAL_PATH);
  const appendJournal = options.appendJournal ?? appendReactionJournalEvent;

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
      await saveReactionState(state, statePath);
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
        console.log(`\n${formatAutomaticPreparationReport(result)}\n`);
        const completedAt = now().toISOString();
        const finalRecord = result.status === "READY"
          ? transitionReactionRecord(inProgress, "PREPARED", completedAt, {
              assignmentId: result.prepared.assignmentId,
            })
          : transitionReactionRecord(inProgress, "ABORTED", completedAt, { reason: result.reason });
        state = await loadReactionState(statePath);
        await saveReactionState(replaceReactionRecord(state, finalRecord), statePath);
        currentRecord = finalRecord;
        logger.info(`STATE: ${finalRecord.status}`);
        await journal(result.status === "READY"
          ? { event: "PREPARED", assignmentId: result.prepared.assignmentId, result: "WOULD_SUBMIT" }
          : { event: "PREPARATION_ABORTED", reasonCode: result.reason });
        return { status: "PROCESSED", result };
      } catch (error: unknown) {
        if (currentRecord.status === "IN_PROGRESS" || currentRecord.status === "PREPARED") {
          const unknown = transitionReactionRecord(
            currentRecord,
            "UNKNOWN",
            now().toISOString(),
            { reason: "UNEXPECTED_EXCEPTION" },
          );
          state = await loadReactionState(statePath);
          await saveReactionState(replaceReactionRecord(state, unknown), statePath);
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
