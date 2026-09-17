export interface ReactionFormConfig {
  formId: string;
  hash: string;
}

export interface DwellingReactionInput {
  dwellingId?: string | number;
  assignmentId?: string | number;
  isPassend?: boolean;
  kanReageren?: boolean;
  loggedIn?: boolean;
  action?: string;
  label?: string;
  reactionUrl?: string;
  closingDate?: string;
}

export interface PreparedReaction {
  endpoint: "/portal/object/frontend/react/format/json";
  method: "POST";
  contentType: "application/x-www-form-urlencoded; charset=UTF-8";
  dwellingId: string;
  assignmentId: string;
  formId: string;
  formHash: string;
  isPassend: true;
  kanReageren: true;
  loggedIn?: boolean;
  action: "add";
}

export type PreparationFailureReason =
  | "SESSION_EXPIRED"
  | "MISSING_DWELLING_ID"
  | "NOT_PASSEND"
  | "CANNOT_REACT"
  | "ALREADY_REACTED"
  | "MISSING_ASSIGNMENT_ID"
  | "MISSING_FORM_ID"
  | "MISSING_FORM_HASH"
  | "REACTION_URL_MISMATCH"
  | "LISTING_CLOSED"
  | "UNEXPECTED_REACTION_STATE";

export type ReactionPreparationResult =
  | { ok: true; prepared: PreparedReaction }
  | { ok: false; reason: PreparationFailureReason; dwellingId?: string };
