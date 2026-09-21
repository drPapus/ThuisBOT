import {
  appendReactionJournalEvent,
  loadReactionJournal,
  REACTION_JOURNAL_PATH,
  type ReactionJournalEvent,
} from "../state/reactionJournal.js";
import {
  hasCrossedSubmitBoundary,
  loadReactionState,
  REACTION_STATE_PATH,
  replaceReactionRecord,
  saveReactionState,
  transitionReactionRecord,
  type AutomaticReactionRecord,
} from "../state/reactionState.js";
import type { ReactionVerification } from "./verification.js";
import type { LiveCircuitReason, LiveSafetyController } from "./liveSafety.js";
import { withGlobalReactionLock } from "./reactionLock.js";

export interface ReactionSafetyStatus {
  circuitOpen: boolean;
  reason?: LiveCircuitReason;
  dwellingId?: string;
  unresolvedSubmits: number;
  unknownRecords: number;
  submittingRecords: number;
}

export interface StartupAuditOptions {
  statePath?: string;
  journalPath?: string;
  now?: () => Date;
  verify?: (dwellingId: string, assignmentId: string) => Promise<ReactionVerification>;
  appendJournal?: typeof appendReactionJournalEvent;
  saveState?: typeof saveReactionState;
  staleAfterMs?: number;
  withLock?: typeof withGlobalReactionLock;
}

function dangerousRecord(records: AutomaticReactionRecord[]): AutomaticReactionRecord | undefined {
  return records.find((record) =>
    record.status === "SUBMITTING" ||
    (record.status === "UNKNOWN" && hasCrossedSubmitBoundary(record))
  );
}

export async function inspectReactionSafety(
  statePath = REACTION_STATE_PATH,
  journalPath = REACTION_JOURNAL_PATH,
): Promise<ReactionSafetyStatus> {
  let records: AutomaticReactionRecord[];
  try {
    records = (await loadReactionState(statePath)).records;
  } catch {
    return { circuitOpen: true, reason: "REACTION_STATE_CORRUPT", unresolvedSubmits: 0, unknownRecords: 0, submittingRecords: 0 };
  }
  try {
    await loadReactionJournal(journalPath);
  } catch {
    return { circuitOpen: true, reason: "JOURNAL_CORRUPT", unresolvedSubmits: 0, unknownRecords: records.filter((r) => r.status === "UNKNOWN").length, submittingRecords: records.filter((r) => r.status === "SUBMITTING").length };
  }
  const dangerous = dangerousRecord(records);
  const submittingRecords = records.filter((record) => record.status === "SUBMITTING").length;
  const unknownRecords = records.filter((record) => record.status === "UNKNOWN").length;
  return {
    circuitOpen: dangerous !== undefined,
    ...(dangerous && {
      reason: dangerous.status === "SUBMITTING"
        ? "UNRESOLVED_SUBMITTING" as const
        : "UNRESOLVED_POST_SUBMIT_UNKNOWN" as const,
      dwellingId: dangerous.dwellingId,
    }),
    unresolvedSubmits: records.filter(hasCrossedSubmitBoundary).filter((record) =>
      record.status === "SUBMITTING" || record.status === "UNKNOWN").length,
    unknownRecords,
    submittingRecords,
  };
}

async function performStartupSafetyAuditUnlocked(
  controller: LiveSafetyController,
  options: StartupAuditOptions = {},
): Promise<ReactionSafetyStatus> {
  const statePath = options.statePath ?? REACTION_STATE_PATH;
  const journalPath = options.journalPath ?? REACTION_JOURNAL_PATH;
  const now = options.now ?? (() => new Date());
  const append = options.appendJournal ?? appendReactionJournalEvent;
  const save = options.saveState ?? saveReactionState;

  // Recovery is read-only with respect to Thuispoort. It never invokes submit.
  if (options.verify) {
    let state;
    try {
      state = await loadReactionState(statePath);
    } catch {
      controller.open("REACTION_STATE_CORRUPT");
      return inspectReactionSafety(statePath, journalPath);
    }
    for (const record of state.records.filter((candidate) => candidate.status === "SUBMITTING")) {
      const event = (partial: Omit<ReactionJournalEvent, "timestamp" | "dwellingId">) =>
        append({ timestamp: now().toISOString(), dwellingId: record.dwellingId, ...partial }, journalPath);
      try {
        await event({ event: "RECOVERY_STARTED", ...(record.assignmentId && { assignmentId: record.assignmentId }), ...(record.attemptId && { attemptId: record.attemptId }) });
        const verification = record.assignmentId
          ? await options.verify(record.dwellingId, record.assignmentId)
          : { status: "INDETERMINATE" as const, dwellingId: record.dwellingId, assignmentId: "UNKNOWN", reason: "MISSING_ASSIGNMENT_ID" };
        const resolved = verification.status === "CONFIRMED_REACTED"
          ? transitionReactionRecord(record, "SUCCESS", now().toISOString(), { reason: "RECOVERY_CONFIRMED_REACTED", submitBoundaryCrossed: true })
          : transitionReactionRecord(record, "UNKNOWN", now().toISOString(), {
              reason: verification.status === "CONFIRMED_NOT_REACTED"
                ? "RECOVERY_CONFIRMED_NOT_REACTED_NO_RESUBMIT"
                : verification.reason,
              submitBoundaryCrossed: true,
            });
        state = replaceReactionRecord(state, resolved);
        await save(state, statePath);
        await event({ event: "RECOVERY_RESULT", ...(record.assignmentId && { assignmentId: record.assignmentId }), ...(record.attemptId && { attemptId: record.attemptId }), result: resolved.status });
      } catch {
        controller.open("AUDIT_PERSISTENCE_FAILED", record.dwellingId, record.attemptId);
        break;
      }
    }
  }

  const status = await inspectReactionSafety(statePath, journalPath);
  if (status.circuitOpen && status.reason) controller.open(status.reason, status.dwellingId);
  return controller.circuit.open
    ? {
        ...status,
        circuitOpen: true,
        ...(controller.circuit.reason && { reason: controller.circuit.reason }),
        ...(controller.circuit.dwellingId && { dwellingId: controller.circuit.dwellingId }),
      }
    : status;
}

export async function performStartupSafetyAudit(
  controller: LiveSafetyController,
  options: StartupAuditOptions = {},
): Promise<ReactionSafetyStatus> {
  const statePath = options.statePath ?? REACTION_STATE_PATH;
  const lock = options.withLock ?? withGlobalReactionLock;
  try {
    return await lock(
      () => performStartupSafetyAuditUnlocked(controller, options),
      `${statePath}.lock`,
      options.staleAfterMs ?? 15 * 60 * 1000,
    );
  } catch (error: unknown) {
    controller.open("LOCK_INTEGRITY_FAILURE");
    throw error;
  }
}
