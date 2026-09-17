import type { DwellingReactionInput, ReactionPreparationResult } from "./types.js";

function yesNo(value: boolean | undefined): string {
  return value === undefined ? "UNKNOWN" : value ? "YES" : "NO";
}

function debugValue(value: string | number | boolean | undefined): string {
  return value === undefined ? "MISSING" : String(value);
}

export function reactionEndpointForDisplay(): string {
  return `/${["portal", "object", "frontend", "react", "format", "json"].join("/")}`;
}

export function formatAuthoritativeReactionState(
  requestedDwellingId: string,
  presentInAanbod: boolean,
  details?: DwellingReactionInput,
): string {
  return [
    "------------------------------------------------",
    "AUTHORITATIVE REACTION STATE",
    "------------------------------------------------",
    "",
    `Requested dwelling: ${requestedDwellingId}`,
    `Present in aanbod: ${presentInAanbod ? "YES" : "NO"}`,
    "",
    `dwellingId: ${debugValue(details?.dwellingId)}`,
    `assignmentId: ${debugValue(details?.assignmentId)}`,
    `closingDate: ${debugValue(details?.closingDate)}`,
    `isPassend: ${debugValue(details?.isPassend)}`,
    `kanReageren: ${debugValue(details?.kanReageren)}`,
    `loggedIn: ${debugValue(details?.loggedIn)}`,
    `action: ${debugValue(details?.action)}`,
    `label: ${debugValue(details?.label)}`,
    `reactionUrl: ${debugValue(details?.reactionUrl)}`,
    "------------------------------------------------",
  ].join("\n");
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
    `Endpoint: ${reactionEndpointForDisplay()}`,
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
