import type { ReactionPreparationResult } from "./types.js";

function yesNo(value: boolean | undefined): string {
  return value === undefined ? "UNKNOWN" : value ? "YES" : "NO";
}

export function formatReactionPreparationReport(result: ReactionPreparationResult): string {
  const line = "------------------------------------------------";
  if (!result.ok) {
    return [
      line,
      "REACTION SKIPPED",
      line,
      "",
      `Dwelling: ${result.dwellingId ?? "UNKNOWN"}`,
      `Reason: ${result.reason}`,
      "",
      "No request prepared.",
      line,
    ].join("\n");
  }

  const reaction = result.prepared;
  return [
    line,
    "REACTION PREPARED — DRY RUN",
    line,
    "",
    `Dwelling: ${reaction.dwellingId}`,
    `Assignment: ${reaction.assignmentId}`,
    `Passend: ${yesNo(reaction.isPassend)}`,
    `Can react: ${yesNo(reaction.kanReageren)}`,
    `Logged in: ${yesNo(reaction.loggedIn)}`,
    `Action: ${reaction.action}`,
    "",
    `Form: ${reaction.formId}`,
    "Hash: PRESENT",
    "",
    `Endpoint: ${reaction.endpoint}`,
    "",
    "Would send:",
    `__id__=${reaction.formId}`,
    "__hash__=[REDACTED]",
    `add=${reaction.assignmentId}`,
    `dwellingID=${reaction.dwellingId}`,
    "",
    "DRY RUN → REQUEST NOT SENT",
    line,
  ].join("\n");
}
