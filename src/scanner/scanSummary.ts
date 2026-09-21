import type { LiveCircuitReason } from "../reaction/liveSafety.js";
import type { AutomaticProcessingOutcome } from "../reaction/automaticCoordinator.js";

export interface ScanSummary {
  checked: number;
  newCount: number;
  eligible: number;
  notEligible: number;
  liveAttempts: number;
  confirmedReactions: number;
  failed: number;
  unknown: number;
  aborted: number;
  dedupSkipped: number;
  circuitBlocked: number;
  runLimitBlocked: number;
  dryRunPrepared: number;
  circuitOpen: boolean;
  circuitReason?: LiveCircuitReason;
  runLiveAttempts: number;
  maxLiveAttempts: number;
}

export interface ScanSummaryInput {
  checked: number;
  newCount: number;
  eligible: number;
  liveAttempts: number;
  outcomes: readonly AutomaticProcessingOutcome[];
  circuitOpen: boolean;
  circuitReason?: LiveCircuitReason;
  runLiveAttempts: number;
  maxLiveAttempts: number;
}

function count(outcomes: readonly AutomaticProcessingOutcome[], kind: AutomaticProcessingOutcome["kind"]): number {
  return outcomes.filter((outcome) => outcome.kind === kind).length;
}

export function createScanSummary(input: ScanSummaryInput): ScanSummary {
  return {
    checked: input.checked,
    newCount: input.newCount,
    eligible: input.eligible,
    notEligible: input.newCount - input.eligible,
    liveAttempts: input.liveAttempts,
    confirmedReactions: count(input.outcomes, "SUCCESS"),
    failed: count(input.outcomes, "FAILED"),
    unknown: count(input.outcomes, "UNKNOWN"),
    aborted: count(input.outcomes, "ABORTED"),
    dedupSkipped: count(input.outcomes, "DEDUP_SKIPPED"),
    circuitBlocked: count(input.outcomes, "CIRCUIT_BLOCKED"),
    runLimitBlocked: count(input.outcomes, "RUN_LIMIT_BLOCKED"),
    dryRunPrepared: count(input.outcomes, "DRY_RUN_PREPARED"),
    circuitOpen: input.circuitOpen,
    ...(input.circuitReason && { circuitReason: input.circuitReason }),
    runLiveAttempts: input.runLiveAttempts,
    maxLiveAttempts: input.maxLiveAttempts,
  };
}
