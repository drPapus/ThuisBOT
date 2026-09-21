import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCoordinatedAutomaticPreparation } from "../src/reaction/automaticCoordinator.js";
import { classifyReactionOutcome, type FutureSubmissionEvidence } from "../src/reaction/resultClassifier.js";
import { verifyReactionDetails, verifyReactionReadOnly, type ReactionVerification } from "../src/reaction/verification.js";
import {
  appendReactionJournalEvent,
  loadReactionJournal,
} from "../src/state/reactionJournal.js";
import {
  loadReactionState,
  transitionReactionRecord,
  type AutomaticReactionRecord,
  type AutomaticReactionStatus,
} from "../src/state/reactionState.js";

const dwellingId = "15020";
const assignmentId = "15154";
const reacted = {
  dwellingId,
  assignmentId,
  loggedIn: true,
  action: "remove",
  label: "Verwijder reactie",
  reactionUrl: `?remove=9001&dwellingID=${dwellingId}`,
};
const notReacted = {
  dwellingId,
  assignmentId,
  loggedIn: true,
  action: "add",
  label: "Reageer",
  reactionUrl: `?add=${assignmentId}&dwellingID=${dwellingId}`,
};

test("strict getobject evidence confirms reacted and not reacted states", () => {
  assert.equal(verifyReactionDetails(dwellingId, assignmentId, reacted).status, "CONFIRMED_REACTED");
  assert.equal(verifyReactionDetails(dwellingId, assignmentId, notReacted).status, "CONFIRMED_NOT_REACTED");
  for (const details of [
    { ...reacted, loggedIn: false },
    { ...reacted, assignmentId: "WRONG" },
    { ...reacted, action: "remove", label: undefined, reactionUrl: undefined },
    { ...notReacted, reactionUrl: `?add=WRONG&dwellingID=${dwellingId}` },
  ]) {
    assert.equal(verifyReactionDetails(dwellingId, assignmentId, details).status, "INDETERMINATE");
  }
});

test("verification read failures are INDETERMINATE", async () => {
  const result = await verifyReactionReadOnly(dwellingId, assignmentId, async () => {
    throw new Error("session expired with sensitive response");
  });
  assert.deepEqual(result, {
    status: "INDETERMINATE", dwellingId, assignmentId, reason: "VERIFICATION_READ_FAILED",
  });
});

test("future outcome classifier is independent and conservative", () => {
  const accepted: FutureSubmissionEvidence = { status: "ACCEPTED_RESPONSE", httpStatus: 200 };
  const timeout: FutureSubmissionEvidence = { status: "AMBIGUOUS", reason: "TIMEOUT" };
  const rejected: FutureSubmissionEvidence = { status: "DEFINITIVE_REJECTION", httpStatus: 400 };
  const yes: ReactionVerification = { status: "CONFIRMED_REACTED", dwellingId, assignmentId };
  const no: ReactionVerification = { status: "CONFIRMED_NOT_REACTED", dwellingId, assignmentId };
  const unknown: ReactionVerification = { status: "INDETERMINATE", dwellingId, assignmentId, reason: "READ_FAILED" };
  assert.deepEqual(classifyReactionOutcome(accepted, yes), { status: "SUCCESS" });
  assert.deepEqual(classifyReactionOutcome(timeout, yes), { status: "SUCCESS" });
  assert.equal(classifyReactionOutcome(accepted, no).status, "UNKNOWN");
  assert.equal(classifyReactionOutcome(timeout, unknown).status, "UNKNOWN");
  assert.equal(classifyReactionOutcome({ status: "AMBIGUOUS", reason: "OTHER" }, no).status, "UNKNOWN");
  assert.deepEqual(classifyReactionOutcome(rejected, no), {
    status: "FAILED", reason: "DEFINITIVE_REJECTION_AND_CONFIRMED_NOT_REACTED",
  });
});

test("central transition validation permits only the documented state graph", () => {
  const initial: AutomaticReactionRecord = {
    dwellingId, status: "IN_PROGRESS", firstSeenAt: "2026-09-21T09:00:00Z", updatedAt: "2026-09-21T09:00:00Z",
  };
  for (const target of ["PREPARED", "ABORTED", "UNKNOWN"] as AutomaticReactionStatus[]) {
    assert.equal(transitionReactionRecord(initial, target, "2026-09-21T09:01:00Z").status, target);
  }
  const prepared = transitionReactionRecord(initial, "PREPARED", "2026-09-21T09:01:00Z");
  for (const target of ["SUCCESS", "FAILED", "UNKNOWN"] as AutomaticReactionStatus[]) {
    assert.equal(transitionReactionRecord(prepared, target, "2026-09-21T09:02:00Z").status, target);
  }
  for (const terminal of ["SUCCESS", "UNKNOWN", "ABORTED"] as AutomaticReactionStatus[]) {
    const record = { ...initial, status: terminal };
    assert.throws(() => transitionReactionRecord(record, "IN_PROGRESS", "2026-09-21T09:03:00Z"), /Illegal/);
    assert.throws(() => transitionReactionRecord(record, "PREPARED", "2026-09-21T09:03:00Z"), /Illegal/);
  }
});

test("journal appends durably in order and survives a new loader", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thuisbot-journal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "journal.jsonl");
  await appendReactionJournalEvent({ timestamp: "2026-09-21T09:00:00Z", dwellingId, event: "PREPARATION_STARTED" }, file);
  await appendReactionJournalEvent({ timestamp: "2026-09-21T09:00:01Z", dwellingId, assignmentId, event: "PREPARED", result: "WOULD_SUBMIT" }, file);
  const loaded = await loadReactionJournal(file);
  assert.deepEqual(loaded.map((event) => event.event), ["PREPARATION_STARTED", "PREPARED"]);
  assert.equal((await loadReactionJournal(file)).length, 2);
  assert.doesNotMatch(await readFile(file, "utf8"), /hash|cookie|authorization|csrf/i);
  await assert.rejects(
    appendReactionJournalEvent({ timestamp: "2026-09-21T09:00:02Z", dwellingId, event: "UNKNOWN", formHash: "SECRET" } as never, file),
    /invalid structure/,
  );
});

test("malformed journal lines are surfaced and not discarded", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thuisbot-journal-broken-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "journal.jsonl");
  await writeFile(file, '{"broken":true}\nnot-json\n', "utf8");
  await assert.rejects(loadReactionJournal(file), /line 1 is malformed/);
  assert.match(await readFile(file, "utf8"), /not-json/);
});

test("journal failure changes preparation to UNKNOWN and blocks retry", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thuisbot-journal-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, "reaction-state.json");
  let preparationCalls = 0;
  const dependencies = {
    async isPresentInAanbod() { preparationCalls += 1; return true; },
    async fetchDetails() { return notReacted; },
    async fetchForm() { return { formId: "Portal_Form_SubmitOnly", hash: "SECRET" }; },
    now: () => new Date("2026-09-21T10:00:00Z"),
  };
  await assert.rejects(
    runCoordinatedAutomaticPreparation(dwellingId, undefined, dependencies, false, {
      statePath,
      appendJournal: async () => { throw new Error("journal unavailable"); },
    }),
    /journal unavailable/,
  );
  assert.equal(preparationCalls, 0);
  assert.equal((await loadReactionState(statePath)).records[0]?.status, "UNKNOWN");
  const retry = await runCoordinatedAutomaticPreparation(dwellingId, undefined, dependencies, false, { statePath });
  assert.equal(retry.status, "SKIPPED");
  assert.equal(preparationCalls, 0);
});

test("journal and verification production sources contain no submission capability", async () => {
  const sources = await Promise.all([
    readFile(path.resolve("src/reaction/verification.ts"), "utf8"),
    readFile(path.resolve("src/state/reactionJournal.ts"), "utf8"),
    readFile(path.resolve("src/dev/verifyReactionCli.ts"), "utf8"),
    readFile(path.resolve("src/dev/reactionJournalCli.ts"), "utf8"),
  ]);
  for (const source of sources) {
    assert.doesNotMatch(source, /submitPreparedReactionOnce|submitReaction|reactOnceCli/i);
    assert.doesNotMatch(source, /\/portal\/object\/frontend\/react\/format\/json/i);
    assert.doesNotMatch(source, /saveKnownWoningen|known-woningen\.json/);
  }
});
