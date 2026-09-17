import type {
  DwellingReactionInput,
  PreparationFailureReason,
  PreparedReaction,
  ReactionFormConfig,
  ReactionPreparationResult,
} from "./types.js";

export const REACTION_ENDPOINT = "/portal/object/frontend/react/format/json" as const;

function presentIdentifier(value: string | number | undefined): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim() !== "") return value;
  return undefined;
}

function failed(
  reason: PreparationFailureReason,
  dwellingId?: string,
): ReactionPreparationResult {
  return { ok: false, reason, ...(dwellingId !== undefined && { dwellingId }) };
}

function isAlreadyReacted(input: DwellingReactionInput): boolean {
  if (input.action?.toLowerCase() === "remove") return true;
  if (input.label?.trim().toLowerCase() === "verwijder reactie") return true;
  if (!input.reactionUrl) return false;
  try {
    return new URL(input.reactionUrl, "https://www.thuispoort.nl/").searchParams.has("remove");
  } catch {
    return false;
  }
}

function reactionUrlMatches(
  reactionUrl: string,
  dwellingId: string,
  assignmentId: string,
): boolean {
  try {
    const parameters = new URL(reactionUrl, "https://www.thuispoort.nl/").searchParams;
    return parameters.get("add") === assignmentId && parameters.get("dwellingID") === dwellingId;
  } catch {
    return false;
  }
}

export function prepareReaction(
  input: DwellingReactionInput,
  form: Partial<ReactionFormConfig>,
  now = new Date(),
): ReactionPreparationResult {
  const dwellingId = presentIdentifier(input.dwellingId);
  if (input.loggedIn === false) return failed("SESSION_EXPIRED", dwellingId);
  if (isAlreadyReacted(input)) return failed("ALREADY_REACTED", dwellingId);
  if (dwellingId === undefined) return failed("MISSING_DWELLING_ID");

  const assignmentId = presentIdentifier(input.assignmentId);
  if (assignmentId === undefined) return failed("MISSING_ASSIGNMENT_ID", dwellingId);
  if (input.isPassend === false) return failed("NOT_PASSEND", dwellingId);
  if (input.isPassend !== true) return failed("UNEXPECTED_REACTION_STATE", dwellingId);
  if (input.kanReageren === false) return failed("CANNOT_REACT", dwellingId);
  if (input.kanReageren !== true) return failed("UNEXPECTED_REACTION_STATE", dwellingId);
  if (input.action !== "add") return failed("UNEXPECTED_REACTION_STATE", dwellingId);

  if (input.closingDate !== undefined) {
    const closingTime = Date.parse(input.closingDate);
    if (!Number.isFinite(closingTime)) return failed("UNEXPECTED_REACTION_STATE", dwellingId);
    if (closingTime <= now.getTime()) return failed("LISTING_CLOSED", dwellingId);
  }
  if (
    input.reactionUrl !== undefined &&
    !reactionUrlMatches(input.reactionUrl, dwellingId, assignmentId)
  ) {
    return failed("REACTION_URL_MISMATCH", dwellingId);
  }

  if (typeof form.formId !== "string" || form.formId.trim() === "") {
    return failed("MISSING_FORM_ID", dwellingId);
  }
  if (typeof form.hash !== "string" || form.hash.trim() === "") {
    return failed("MISSING_FORM_HASH", dwellingId);
  }

  const prepared: PreparedReaction = {
    endpoint: REACTION_ENDPOINT,
    method: "POST",
    contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    dwellingId,
    assignmentId,
    formId: form.formId,
    formHash: form.hash,
    isPassend: true,
    kanReageren: true,
    ...(input.loggedIn !== undefined && { loggedIn: input.loggedIn }),
    action: "add",
  };
  return { ok: true, prepared };
}

export function encodePreparedReaction(prepared: PreparedReaction): string {
  return new URLSearchParams({
    __id__: prepared.formId,
    __hash__: prepared.formHash,
    add: prepared.assignmentId,
    dwellingID: prepared.dwellingId,
  }).toString();
}
