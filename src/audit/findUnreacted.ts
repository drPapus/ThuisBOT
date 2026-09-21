import { DwellingDetailsError } from "../reaction/dwellingDetails.js";
import { verifyReactionDetails, type ReactionVerification } from "../reaction/verification.js";
import type { DwellingReactionInput } from "../reaction/types.js";
import type { NormalizedWoning } from "../woningen/types.js";

export interface DwellingIdRange {
  min: number;
  max: number;
}

export type FindUnreactedVerification = ReactionVerification | {
  status: "INDETERMINATE";
  dwellingId: string;
  assignmentId?: string;
  reason: string;
};

export interface FindUnreactedResult {
  woning: NormalizedWoning;
  assignmentId?: string;
  verification: FindUnreactedVerification;
}

type IndeterminateAuditResult = FindUnreactedResult & {
  verification: Extract<FindUnreactedVerification, { status: "INDETERMINATE" }>;
};

export interface FindUnreactedAudit {
  currentCount: number;
  range?: DwellingIdRange;
  candidates: FindUnreactedResult[];
}

export interface FindUnreactedDependencies {
  fetchCurrentAanbod(): Promise<NormalizedWoning[]>;
  fetchDetails(dwellingId: string): Promise<DwellingReactionInput>;
}

export class FindUnreactedSessionError extends Error {
  constructor() {
    super("authenticated session is not valid. No classifications were trusted.");
    this.name = "FindUnreactedSessionError";
  }
}

export function assertFindUnreactedReadOnlyMode(autoSubmit: boolean): void {
  if (autoSubmit) {
    throw new Error("find-unreacted is READ ONLY.\nRun with AUTO_SUBMIT=false or omit AUTO_SUBMIT.");
  }
}

const HELP = `Usage:
npm run find-unreacted
npm run find-unreacted -- 14903 15034`;

export function parseFindUnreactedArgs(args: string[]): DwellingIdRange | undefined {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args.some((value) => !/^\d+$/.test(value))) throw new Error(HELP);
  const min = Number(args[0]);
  const max = Number(args[1]);
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min <= 0 || max <= 0 || min > max) {
    throw new Error(HELP);
  }
  return { min, max };
}

export function isFindUnreactedCandidate(woning: NormalizedWoning): boolean {
  // Deliberately does not require kanReageren: that field may change after reacting.
  return woning.isPassend === true;
}

function inRange(woning: NormalizedWoning, range: DwellingIdRange | undefined): boolean {
  if (!range) return true;
  const id = typeof woning.id === "number" ? woning.id : Number(woning.id);
  return Number.isSafeInteger(id) && id >= range.min && id <= range.max;
}

function indeterminate(
  dwellingId: string,
  reason: string,
  assignmentId?: string,
): FindUnreactedVerification {
  return {
    status: "INDETERMINATE",
    dwellingId,
    ...(assignmentId && { assignmentId }),
    reason,
  };
}

function errorReason(error: unknown): string {
  return error instanceof DwellingDetailsError ? error.reason : "VERIFICATION_READ_FAILED";
}

function assertAuthenticated(details: DwellingReactionInput): void {
  if (details.loggedIn !== true) throw new FindUnreactedSessionError();
}

export async function findUnreacted(
  dependencies: FindUnreactedDependencies,
  range?: DwellingIdRange,
): Promise<FindUnreactedAudit> {
  const current = await dependencies.fetchCurrentAanbod();
  const candidates = current.filter((woning) => inRange(woning, range) && isFindUnreactedCandidate(woning));
  const results: FindUnreactedResult[] = [];

  for (const woning of candidates) {
    const dwellingId = String(woning.id);
    let assignmentId: string | undefined;
    try {
      const identityDetails = await dependencies.fetchDetails(dwellingId);
      assertAuthenticated(identityDetails);
      assignmentId = identityDetails.assignmentId === undefined
        ? undefined
        : String(identityDetails.assignmentId);
    } catch (error: unknown) {
      if (error instanceof FindUnreactedSessionError ||
          (error instanceof DwellingDetailsError && error.reason === "SESSION_EXPIRED")) {
        throw new FindUnreactedSessionError();
      }
      results.push({ woning, verification: indeterminate(dwellingId, errorReason(error)) });
      continue;
    }

    if (!assignmentId) {
      results.push({ woning, verification: indeterminate(dwellingId, "MISSING_ASSIGNMENT_ID") });
      continue;
    }

    try {
      const verificationDetails = await dependencies.fetchDetails(dwellingId);
      assertAuthenticated(verificationDetails);
      results.push({
        woning,
        assignmentId,
        verification: verifyReactionDetails(dwellingId, assignmentId, verificationDetails),
      });
    } catch (error: unknown) {
      if (error instanceof FindUnreactedSessionError ||
          (error instanceof DwellingDetailsError && error.reason === "SESSION_EXPIRED")) {
        throw new FindUnreactedSessionError();
      }
      results.push({
        woning,
        assignmentId,
        verification: indeterminate(dwellingId, errorReason(error), assignmentId),
      });
    }
  }

  return { currentCount: current.length, ...(range && { range }), candidates: results };
}

function address(woning: NormalizedWoning): string {
  const number = [woning.houseNumber, woning.houseNumberAddition].filter(Boolean).join("");
  return [woning.street, number].filter(Boolean).join(" ") || "Unknown";
}

function line(label: string, value: string | number): void {
  console.log(`${label.padEnd(27, ".")} ${value}`);
}

function rangeLabel(range: DwellingIdRange | undefined): string {
  return range ? `${range.min}–${range.max}` : "ALL CURRENT";
}

export function reportFindUnreacted(audit: FindUnreactedAudit): void {
  const unreacted = audit.candidates.filter((result) =>
    result.verification.status === "CONFIRMED_NOT_REACTED");
  const indeterminateResults = audit.candidates.filter(
    (result): result is IndeterminateAuditResult => result.verification.status === "INDETERMINATE",
  );
  const reacted = audit.candidates.length - unreacted.length - indeterminateResults.length;

  console.log("FIND UNREACTED — READ ONLY\n");
  line("Current aanbod ", audit.currentCount);
  line("Range ", rangeLabel(audit.range));
  line("Candidates ", audit.candidates.length);

  console.log("\nCURRENT SUITABLE WITHOUT REACTION\n");
  if (unreacted.length === 0) console.log("None.");
  for (const result of unreacted) {
    console.log(`#${result.woning.id} — ${address(result.woning)}, ${result.woning.city ?? "Unknown"} — ${result.woning.modelCode ?? "Unknown"}`);
  }
  if (unreacted.length > 0) console.log(`\n${unreacted.length} dwellings need action.`);

  if (indeterminateResults.length > 0) {
    console.log("\nREVIEW REQUIRED\n");
    for (const result of indeterminateResults) {
      console.log(`#${result.woning.id} — ${result.verification.reason}`);
    }
  }

  console.log("\nDETAILS");
  for (const result of audit.candidates) {
    console.log(`\n#${result.woning.id}`);
    line("Address ", address(result.woning));
    line("City ", result.woning.city ?? "Unknown");
    line("Model ", result.woning.modelCode ?? "Unknown");
    line("Passend ", result.woning.isPassend ? "YES" : "NO");
    line("Assignment ", result.assignmentId ?? "UNKNOWN");
    line("Verification ", result.verification.status);
    if (result.verification.status === "INDETERMINATE") line("Reason ", result.verification.reason);
    line("Action ", result.verification.status === "CONFIRMED_NOT_REACTED"
      ? "ACTION NEEDED"
      : result.verification.status === "CONFIRMED_REACTED" ? "SKIP" : "REVIEW");
  }

  console.log("\nSUMMARY\n");
  line("Current aanbod ", audit.currentCount);
  line("Range ", rangeLabel(audit.range));
  line("Candidates checked ", audit.candidates.length);
  line("Already reacted ", reacted);
  line("Without reaction ", unreacted.length);
  line("Indeterminate ", indeterminateResults.length);
  console.log("\nREAD ONLY");
  console.log("0 reactions sent");
  console.log("0 reactions removed");
  console.log("0 state records modified");
}
