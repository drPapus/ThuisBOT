import type { ReactionVerification } from "./verification.js";

export type FutureSubmissionEvidence =
  | { status: "ACCEPTED_RESPONSE"; httpStatus: number }
  // Only use when the request is known to have been rejected before server acceptance.
  | { status: "DEFINITIVE_REJECTION"; httpStatus?: number }
  | { status: "AMBIGUOUS"; reason: "TIMEOUT" | "NETWORK_ERROR" | "MALFORMED_RESPONSE" | "OTHER" };

export type FinalReactionOutcome =
  | { status: "SUCCESS" }
  | { status: "FAILED"; reason: "DEFINITIVE_REJECTION_AND_CONFIRMED_NOT_REACTED" }
  | { status: "UNKNOWN"; reason: string };

export function classifyReactionOutcome(
  submission: FutureSubmissionEvidence,
  verification: ReactionVerification,
): FinalReactionOutcome {
  if (verification.status === "CONFIRMED_REACTED") return { status: "SUCCESS" };
  if (
    submission.status === "DEFINITIVE_REJECTION" &&
    verification.status === "CONFIRMED_NOT_REACTED"
  ) {
    return { status: "FAILED", reason: "DEFINITIVE_REJECTION_AND_CONFIRMED_NOT_REACTED" };
  }
  return {
    status: "UNKNOWN",
    reason: verification.status === "INDETERMINATE"
      ? verification.reason
      : "REACTION_NOT_INDEPENDENTLY_CONFIRMED",
  };
}
