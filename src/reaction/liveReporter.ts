import { reactionEndpointForDisplay } from "./reporter.js";
import type { LiveReactionResult } from "./liveTypes.js";
import type { PreparedReaction } from "./types.js";

export function formatLiveConfirmation(prepared: PreparedReaction): string {
  const line = "================================================";
  return [
    line,
    "LIVE REACTION — CONFIRMATION REQUIRED",
    line,
    "",
    `Dwelling: ${prepared.dwellingId}`,
    `Assignment: ${prepared.assignmentId}`,
    "",
    "Passend: YES",
    "Can react: YES",
    `Logged in: ${prepared.loggedIn === true ? "YES" : "UNKNOWN"}`,
    "Action: add",
    "",
    `Form: ${prepared.formId}`,
    "Hash: PRESENT",
    "",
    `Endpoint: ${reactionEndpointForDisplay()}`,
    "",
    "Request body:",
    `__id__=${prepared.formId}`,
    "__hash__=[REDACTED]",
    `add=${prepared.assignmentId}`,
    `dwellingID=${prepared.dwellingId}`,
    "",
    "WARNING:",
    "This will place a REAL housing reaction.",
    "",
    "Type exactly:",
    `REACT ${prepared.dwellingId}`,
    "",
    "to continue. Anything else cancels.",
    line,
  ].join("\n");
}

export function formatLiveReactionResult(result: LiveReactionResult, dwellingId: string): string {
  const line = "================================================";
  if (result.status === "REACTION_PLACED") {
    return [
      line,
      "REACTION PLACED",
      line,
      "",
      `Dwelling: ${dwellingId}`,
      `Reaction ID: ${result.reactionId}`,
      "Server success: YES",
      "Post-submit verification: PASSED",
      `Authoritative action: ${result.authoritativeAction}`,
      "",
      "Exactly 1 reaction request sent.",
      line,
    ].join("\n");
  }
  if (result.status === "REACTION_CANCELLED") {
    return "REACTION CANCELLED\nNo request sent.";
  }
  if (result.status === "PREPARATION_FAILED") {
    return `REACTION SKIPPED\nDwelling: ${dwellingId}\nReason: ${result.reason}\nNo request sent.`;
  }
  if (result.status === "REACTION_VERIFICATION_FAILED") {
    return `REACTION_VERIFICATION_FAILED\nDwelling: ${dwellingId}\nReaction ID: ${result.reactionId}\nNo retry attempted.`;
  }
  return `${result.status}\nDwelling: ${dwellingId}\nNo retry attempted.`;
}
