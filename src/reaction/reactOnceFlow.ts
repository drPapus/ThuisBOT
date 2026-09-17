import { prepareReaction } from "./prepareReaction.js";
import type { LiveReactionDependencies, LiveReactionResult } from "./liveTypes.js";
import type { DwellingReactionInput, PreparedReaction } from "./types.js";

function isConfirmedAlreadyReacted(details: DwellingReactionInput): boolean {
  const actionMatches = details.action === "remove";
  const labelMatches = details.label?.trim().toLowerCase() === "verwijder reactie";
  let urlMatches = false;
  if (details.reactionUrl) {
    try {
      urlMatches = new URL(details.reactionUrl, "https://www.thuispoort.nl/").searchParams.has("remove");
    } catch {
      return false;
    }
  }
  return actionMatches && (labelMatches || urlMatches);
}

async function prepareFresh(
  dwellingId: string,
  dependencies: LiveReactionDependencies,
): Promise<{ ok: true; prepared: PreparedReaction } | LiveReactionResult> {
  const details = await dependencies.fetchDetails(dwellingId);
  if (details.loggedIn !== true) {
    return {
      status: "PREPARATION_FAILED",
      reason: details.loggedIn === false ? "SESSION_EXPIRED" : "UNEXPECTED_REACTION_STATE",
    };
  }
  const preflight = prepareReaction(details, {}, dependencies.now?.() ?? new Date());
  if (!preflight.ok && !["MISSING_FORM_ID", "MISSING_FORM_HASH"].includes(preflight.reason)) {
    return { status: "PREPARATION_FAILED", reason: preflight.reason };
  }
  const form = await dependencies.fetchForm();
  const prepared = prepareReaction(details, form, dependencies.now?.() ?? new Date());
  return prepared.ok
    ? { ok: true, prepared: prepared.prepared }
    : { status: "PREPARATION_FAILED", reason: prepared.reason };
}

export async function runReactOnceFlow(
  dwellingId: string,
  dependencies: LiveReactionDependencies,
): Promise<LiveReactionResult> {
  if (!dwellingId || !(await dependencies.isPresentInAanbod(dwellingId))) {
    return { status: "PREPARATION_FAILED", reason: "MISSING_DWELLING_ID" };
  }

  const preview = await prepareFresh(dwellingId, dependencies);
  if (!("ok" in preview)) return preview;

  const confirmation = await dependencies.confirm(preview.prepared);
  if (confirmation !== `REACT ${dwellingId}`) return { status: "REACTION_CANCELLED" };

  // Re-fetch both authoritative state and form hash after human confirmation.
  const finalPreparation = await prepareFresh(dwellingId, dependencies);
  if (!("ok" in finalPreparation)) return finalPreparation;

  const submission = await dependencies.submit(finalPreparation.prepared);
  if (!submission.ok) return { status: submission.outcome };

  let verified: DwellingReactionInput;
  try {
    verified = await dependencies.fetchDetails(dwellingId);
  } catch {
    return { status: "REACTION_VERIFICATION_FAILED", reactionId: submission.reactionId };
  }
  if (!isConfirmedAlreadyReacted(verified)) {
    return { status: "REACTION_VERIFICATION_FAILED", reactionId: submission.reactionId };
  }
  return {
    status: "REACTION_PLACED",
    reactionId: submission.reactionId,
    authoritativeAction: verified.action ?? "remove",
  };
}
