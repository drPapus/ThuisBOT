import type { BrowserContext } from "playwright";
import type { PreparedReaction } from "./types.js";
import type { FutureSubmissionEvidence } from "./resultClassifier.js";
import type { ReactionVerification } from "./verification.js";
import { verifyReactionReadOnly } from "./verification.js";
import { fetchDwellingReactionDetails } from "./dwellingDetails.js";
import { submitPreparedReactionOnce } from "./submitReaction.js";
import { REACTION_ENDPOINT } from "./reactionEndpoint.js";

export interface AutomaticLiveDependencies {
  readonly endpoint: string;
  submit(prepared: PreparedReaction): Promise<FutureSubmissionEvidence>;
  verify(dwellingId: string, assignmentId: string): Promise<ReactionVerification>;
}

export function createAutomaticLiveDependencies(
  context: BrowserContext,
  baseUrl: string,
): AutomaticLiveDependencies {
  return {
    endpoint: REACTION_ENDPOINT,
    async submit(prepared) {
      const result = await submitPreparedReactionOnce(context, baseUrl, prepared);
      if (result.ok) return { status: "ACCEPTED_RESPONSE", httpStatus: result.httpStatus };
      return result.outcome === "REACTION_REJECTED"
        ? { status: "DEFINITIVE_REJECTION", ...(result.httpStatus !== undefined && { httpStatus: result.httpStatus }) }
        : { status: "AMBIGUOUS", reason: "OTHER" };
    },
    verify: (dwellingId, assignmentId) => verifyReactionReadOnly(
      dwellingId,
      assignmentId,
      (requestedId) => fetchDwellingReactionDetails(context, baseUrl, requestedId),
    ),
  };
}
