import type { PreparationFailureReason, PreparedReaction } from "./types.js";

export interface SuccessfulSubmission {
  ok: true;
  reactionId: string | number;
  serverAction?: string;
}

export interface FailedSubmission {
  ok: false;
  outcome: "REACTION_REJECTED" | "REACTION_OUTCOME_UNKNOWN";
}

export type SubmissionResult = SuccessfulSubmission | FailedSubmission;

export type LiveReactionResult =
  | { status: "REACTION_CANCELLED" }
  | { status: "PREPARATION_FAILED"; reason: PreparationFailureReason }
  | { status: "REACTION_REJECTED" }
  | { status: "REACTION_OUTCOME_UNKNOWN" }
  | { status: "REACTION_VERIFICATION_FAILED"; reactionId: string | number }
  | {
      status: "REACTION_PLACED";
      reactionId: string | number;
      authoritativeAction: string;
    };

export interface LiveReactionDependencies {
  isPresentInAanbod(dwellingId: string): Promise<boolean>;
  fetchDetails(dwellingId: string): Promise<import("./types.js").DwellingReactionInput>;
  fetchForm(): Promise<import("./types.js").ReactionFormConfig>;
  confirm(prepared: PreparedReaction): Promise<string>;
  submit(prepared: PreparedReaction): Promise<SubmissionResult>;
  now?: () => Date;
}
