import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  assertFindUnreactedReadOnlyMode,
  findUnreacted,
  FindUnreactedSessionError,
  parseFindUnreactedArgs,
  reportFindUnreacted,
} from "../src/audit/findUnreacted.js";
import type { DwellingReactionInput } from "../src/reaction/types.js";
import { DwellingDetailsError } from "../src/reaction/dwellingDetails.js";
import type { NormalizedWoning } from "../src/woningen/types.js";

function woning(id: string, overrides: Partial<NormalizedWoning> = {}): NormalizedWoning {
  return { id, loggedIn: true, isPassend: true, kanReageren: true, ...overrides };
}

function details(id: string, assignmentId: string, reacted: boolean): DwellingReactionInput {
  return reacted
    ? {
        dwellingId: id, assignmentId, loggedIn: true, isPassend: true, kanReageren: false,
        action: "remove", label: "Verwijder reactie", reactionUrl: `?remove=9001&dwellingID=${id}`,
      }
    : {
        dwellingId: id, assignmentId, loggedIn: true, isPassend: true, kanReageren: true,
        action: "add", label: "Reageer", reactionUrl: `?add=${assignmentId}&dwellingID=${id}`,
      };
}

function outputFor(audit: Awaited<ReturnType<typeof findUnreacted>>): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  try { reportFindUnreacted(audit); } finally { console.log = original; }
  return lines.join("\n");
}

test("reacted and unreacted suitable dwellings are classified independently", async () => {
  const audit = await findUnreacted({
    async fetchCurrentAanbod() { return [woning("14905"), woning("15031")]; },
    async fetchDetails(id) { return details(id, id === "14905" ? "15123" : "15180", id === "14905"); },
  });
  const output = outputFor(audit);
  assert.match(output, /Already reacted .* 1/);
  assert.match(output, /Without reaction .* 1/);
  const actionable = output.split("REVIEW REQUIRED")[0]!.split("DETAILS")[0]!;
  assert.doesNotMatch(actionable, /#14905/);
  assert.match(actionable, /#15031/);
});

test("INDETERMINATE is review-only and never actionable", async () => {
  let calls = 0;
  const audit = await findUnreacted({
    async fetchCurrentAanbod() { return [woning("15032")]; },
    async fetchDetails(id) {
      calls += 1;
      return calls === 1 ? details(id, "15180", false) : details(id, "WRONG", false);
    },
  });
  assert.equal(audit.candidates[0]?.verification.status, "INDETERMINATE");
  if (audit.candidates[0]?.verification.status === "INDETERMINATE") {
    assert.equal(audit.candidates[0].verification.reason, "ASSIGNMENT_ID_MISMATCH");
  }
  const output = outputFor(audit);
  assert.match(output, /Indeterminate .* 1/);
  assert.match(output, /Action .* REVIEW/);
  assert.doesNotMatch(output.split("REVIEW REQUIRED")[0]!, /#15032/);
});

test("range filters only actual current IDs and never generates IDs", async () => {
  const fetched: string[] = [];
  const audit = await findUnreacted({
    async fetchCurrentAanbod() { return ["14900", "14950", "15000", "15040"].map((id) => woning(id)); },
    async fetchDetails(id) { fetched.push(id); return details(id, `A-${id}`, false); },
  }, { min: 14903, max: 15034 });
  assert.deepEqual(audit.candidates.map((result) => result.woning.id), ["14950", "15000"]);
  assert.deepEqual(fetched, ["14950", "14950", "15000", "15000"]);
});

test("missing reaction-state is irrelevant; fresh details supply assignment identity", async () => {
  const audit = await findUnreacted({
    async fetchCurrentAanbod() { return [woning("15031")]; },
    async fetchDetails(id) { return details(id, "15180", false); },
  });
  assert.equal(audit.candidates[0]?.assignmentId, "15180");
  assert.equal(audit.candidates[0]?.verification.status, "CONFIRMED_NOT_REACTED");
});

test("reacted passend dwelling remains auditable when kanReageren is false", async () => {
  const audit = await findUnreacted({
    async fetchCurrentAanbod() { return [woning("14905", { kanReageren: false })]; },
    async fetchDetails(id) { return details(id, "15123", true); },
  });
  assert.equal(audit.candidates.length, 1);
  assert.equal(audit.candidates[0]?.verification.status, "CONFIRMED_REACTED");
});

test("not passend dwellings are excluded without details fetch", async () => {
  let detailsCalls = 0;
  const audit = await findUnreacted({
    async fetchCurrentAanbod() { return [woning("15031", { isPassend: false })]; },
    async fetchDetails() { detailsCalls += 1; return details("15031", "15180", false); },
  });
  assert.equal(audit.candidates.length, 0);
  assert.equal(detailsCalls, 0);
});

test("dwelling and assignment identity mismatches are never not-reacted", async () => {
  let assignmentCalls = 0;
  const assignmentAudit = await findUnreacted({
    async fetchCurrentAanbod() { return [woning("15031")]; },
    async fetchDetails(id) {
      assignmentCalls += 1;
      return assignmentCalls === 1 ? details(id, "15180", false) : details(id, "WRONG", false);
    },
  });
  const assignmentVerification = assignmentAudit.candidates[0]?.verification;
  assert.equal(assignmentVerification?.status, "INDETERMINATE");
  if (assignmentVerification?.status === "INDETERMINATE") {
    assert.equal(assignmentVerification.reason, "ASSIGNMENT_ID_MISMATCH");
  }

  const dwellingAudit = await findUnreacted({
    async fetchCurrentAanbod() { return [woning("15031")]; },
    async fetchDetails() { throw new DwellingDetailsError("DWELLING_ID_MISMATCH"); },
  });
  const dwellingVerification = dwellingAudit.candidates[0]?.verification;
  assert.equal(dwellingVerification?.status, "INDETERMINATE");
  if (dwellingVerification?.status === "INDETERMINATE") {
    assert.equal(dwellingVerification.reason, "DWELLING_ID_MISMATCH");
  }
});

test("global unauthenticated details fail the audit", async () => {
  await assert.rejects(findUnreacted({
    async fetchCurrentAanbod() { return [woning("15031")]; },
    async fetchDetails(id) { return { ...details(id, "15180", false), loggedIn: false }; },
  }), FindUnreactedSessionError);
});

test("AUTO_SUBMIT=true is rejected by the read-only gate", () => {
  assert.doesNotThrow(() => assertFindUnreactedReadOnlyMode(false));
  assert.throws(() => assertFindUnreactedReadOnlyMode(true), /READ ONLY/);
});

test("CLI arguments accept no range or an inclusive positive range", () => {
  assert.equal(parseFindUnreactedArgs([]), undefined);
  assert.deepEqual(parseFindUnreactedArgs(["14903", "15034"]), { min: 14903, max: 15034 });
  for (const args of [["14903"], ["1", "2", "3"], ["x", "2"], ["0", "2"], ["3", "2"], ["-1", "2"]]) {
    assert.throws(() => parseFindUnreactedArgs(args), /Usage/);
  }
});

test("implementation has no state writers, poller, coordinator, or submitter path", async () => {
  const sources = await Promise.all([
    readFile(path.resolve("src/audit/findUnreacted.ts"), "utf8"),
    readFile(path.resolve("src/dev/findUnreactedCli.ts"), "utf8"),
  ]);
  const source = sources.join("\n");
  assert.doesNotMatch(source, /saveKnownWoningen|saveReactionState|appendReactionJournal|runPoller/);
  assert.doesNotMatch(source, /automaticCoordinator|submitPreparedReactionOnce|submitReaction|reactOnce/);
  assert.doesNotMatch(source, /removeReactionRecord|reactionStateCli|reactionJournalCli/);
  assert.doesNotMatch(source, /context\.request\.post/);
});
