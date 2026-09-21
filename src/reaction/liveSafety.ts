export const DEFAULT_MAX_LIVE_ATTEMPTS_PER_RUN = 10;
export const HARD_MAX_LIVE_ATTEMPTS_PER_RUN = 20;
export const DEFAULT_MIN_LIVE_SUBMIT_INTERVAL_MS = 2_000;

export type LiveCircuitReason =
  | "UNRESOLVED_SUBMITTING"
  | "UNRESOLVED_POST_SUBMIT_UNKNOWN"
  | "UNKNOWN_RESULT"
  | "REACTION_STATE_CORRUPT"
  | "JOURNAL_CORRUPT"
  | "AUDIT_PERSISTENCE_FAILED"
  | "STATE_PERSISTENCE_FAILED"
  | "LOCK_INTEGRITY_FAILURE"
  | "ILLEGAL_STATE_TRANSITION"
  | "DUPLICATE_SUBMIT_BOUNDARY"
  | "INFRASTRUCTURE_CONTRADICTION";

export interface LiveCircuitStatus {
  open: boolean;
  reason?: LiveCircuitReason;
  dwellingId?: string;
  attemptId?: string;
}

export interface LiveAttemptReservation {
  allowed: boolean;
  reason?: "CIRCUIT_OPEN" | "RUN_LIMIT_EXHAUSTED";
}

export interface LiveSafetyController {
  readonly attemptsUsed: number;
  readonly maxAttempts: number;
  readonly minIntervalMs: number;
  readonly circuit: LiveCircuitStatus;
  open(reason: LiveCircuitReason, dwellingId?: string, attemptId?: string): void;
  reserve(attemptId: string, dwellingId: string): Promise<LiveAttemptReservation>;
}

export interface LiveSafetyOptions {
  maxAttempts?: number;
  minIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export function createLiveSafetyController(options: LiveSafetyOptions = {}): LiveSafetyController {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_LIVE_ATTEMPTS_PER_RUN;
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_LIVE_SUBMIT_INTERVAL_MS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > HARD_MAX_LIVE_ATTEMPTS_PER_RUN) {
    throw new Error(`MAX_LIVE_SUBMITS_PER_RUN must be between 1 and ${HARD_MAX_LIVE_ATTEMPTS_PER_RUN}.`);
  }
  if (!Number.isInteger(minIntervalMs) || minIntervalMs < 0) {
    throw new Error("MIN_LIVE_SUBMIT_INTERVAL_MS must be a non-negative whole number.");
  }
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const consumed = new Set<string>();
  let attemptsUsed = 0;
  let lastAttemptAt: number | undefined;
  let circuit: LiveCircuitStatus = { open: false };

  return {
    get attemptsUsed() { return attemptsUsed; },
    get maxAttempts() { return maxAttempts; },
    get minIntervalMs() { return minIntervalMs; },
    get circuit() { return { ...circuit }; },
    open(reason, dwellingId, attemptId) {
      if (!circuit.open) circuit = {
        open: true,
        reason,
        ...(dwellingId && { dwellingId }),
        ...(attemptId && { attemptId }),
      };
    },
    async reserve(attemptId, dwellingId) {
      if (circuit.open) return { allowed: false, reason: "CIRCUIT_OPEN" };
      if (consumed.has(attemptId)) {
        this.open("DUPLICATE_SUBMIT_BOUNDARY", dwellingId, attemptId);
        return { allowed: false, reason: "CIRCUIT_OPEN" };
      }
      if (attemptsUsed >= maxAttempts) return { allowed: false, reason: "RUN_LIMIT_EXHAUSTED" };
      if (lastAttemptAt !== undefined) {
        const remaining = minIntervalMs - (now() - lastAttemptAt);
        if (remaining > 0) await sleep(remaining);
      }
      // Recheck after the asynchronous spacing wait.
      if (circuit.open) return { allowed: false, reason: "CIRCUIT_OPEN" };
      if (consumed.has(attemptId)) {
        this.open("DUPLICATE_SUBMIT_BOUNDARY", dwellingId, attemptId);
        return { allowed: false, reason: "CIRCUIT_OPEN" };
      }
      if (attemptsUsed >= maxAttempts) return { allowed: false, reason: "RUN_LIMIT_EXHAUSTED" };
      consumed.add(attemptId);
      attemptsUsed += 1;
      lastAttemptAt = now();
      return { allowed: true };
    },
  };
}
