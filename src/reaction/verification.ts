import type { DwellingReactionInput } from "./types.js";

export type ReactionVerification =
  | { status: "CONFIRMED_REACTED"; dwellingId: string; assignmentId: string }
  | { status: "CONFIRMED_NOT_REACTED"; dwellingId: string; assignmentId: string }
  | { status: "INDETERMINATE"; dwellingId: string; assignmentId: string; reason: string };

function indeterminate(dwellingId: string, assignmentId: string, reason: string): ReactionVerification {
  return { status: "INDETERMINATE", dwellingId, assignmentId, reason };
}

export function verifyReactionDetails(
  requestedDwellingId: string,
  requestedAssignmentId: string,
  details: DwellingReactionInput,
): ReactionVerification {
  if (String(details.dwellingId ?? "") !== requestedDwellingId) {
    return indeterminate(requestedDwellingId, requestedAssignmentId, "DWELLING_ID_MISMATCH");
  }
  if (String(details.assignmentId ?? "") !== requestedAssignmentId) {
    return indeterminate(requestedDwellingId, requestedAssignmentId, "ASSIGNMENT_ID_MISMATCH");
  }
  if (details.loggedIn !== true) {
    return indeterminate(requestedDwellingId, requestedAssignmentId, "SESSION_NOT_AUTHENTICATED");
  }

  let parameters: URLSearchParams | undefined;
  if (details.reactionUrl) {
    try {
      parameters = new URL(details.reactionUrl, "https://www.thuispoort.nl/").searchParams;
    } catch {
      return indeterminate(requestedDwellingId, requestedAssignmentId, "MALFORMED_REACTION_URL");
    }
  }
  const urlDwellingMatches = parameters?.get("dwellingID") === requestedDwellingId;
  const removeEvidence = parameters?.has("remove") === true && urlDwellingMatches;
  const removeLabel = details.label?.trim().toLowerCase() === "verwijder reactie";
  if (details.action === "remove" && (removeLabel || removeEvidence)) {
    return { status: "CONFIRMED_REACTED", dwellingId: requestedDwellingId, assignmentId: requestedAssignmentId };
  }

  const exactAddEvidence = parameters?.get("add") === requestedAssignmentId && urlDwellingMatches;
  if (details.action === "add" && exactAddEvidence) {
    return {
      status: "CONFIRMED_NOT_REACTED",
      dwellingId: requestedDwellingId,
      assignmentId: requestedAssignmentId,
    };
  }
  return indeterminate(requestedDwellingId, requestedAssignmentId, "INCONSISTENT_REACTION_STATE");
}

export async function verifyReactionReadOnly(
  dwellingId: string,
  assignmentId: string,
  fetchDetails: (dwellingId: string) => Promise<DwellingReactionInput>,
): Promise<ReactionVerification> {
  try {
    return verifyReactionDetails(dwellingId, assignmentId, await fetchDetails(dwellingId));
  } catch {
    return indeterminate(dwellingId, assignmentId, "VERIFICATION_READ_FAILED");
  }
}
