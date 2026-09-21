import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createLiveSafetyController,
  HARD_MAX_LIVE_ATTEMPTS_PER_RUN,
} from "../src/reaction/liveSafety.js";
import {
  inspectReactionSafety,
  performStartupSafetyAudit,
} from "../src/reaction/reactionSafety.js";
import { loadReactionJournal } from "../src/state/reactionJournal.js";
import {
  loadReactionState,
  saveReactionState,
  type AutomaticReactionRecord,
} from "../src/state/reactionState.js";

async function files() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thuisbot-stage55-"));
  return {
    directory,
    state: path.join(directory, "state.json"),
    journal: path.join(directory, "journal.jsonl"),
  };
}

function record(
  status: AutomaticReactionRecord["status"],
  overrides: Partial<AutomaticReactionRecord> = {},
): AutomaticReactionRecord {
  return {
    dwellingId: "15050",
    assignmentId: "A-15050",
    status,
    firstSeenAt: "2026-09-21T09:00:00.000Z",
    updatedAt: "2026-09-21T09:01:00.000Z",
    ...overrides,
  };
}

test("run cap counts attempts and blocks the next reservation", async () => {
  const safety = createLiveSafetyController({ maxAttempts: 2, minIntervalMs: 0 });
  assert.equal((await safety.reserve("a", "1")).allowed, true);
  assert.equal((await safety.reserve("b", "2")).allowed, true);
  assert.deepEqual(await safety.reserve("c", "3"), { allowed: false, reason: "RUN_LIMIT_EXHAUSTED" });
  assert.equal(safety.attemptsUsed, 2);
  assert.equal(safety.circuit.open, false);
});

test("configured cap cannot exceed the hard maximum", () => {
  assert.throws(
    () => createLiveSafetyController({ maxAttempts: HARD_MAX_LIVE_ATTEMPTS_PER_RUN + 1 }),
    /must be between/,
  );
});

test("fake clock verifies minimum spacing without real sleep", async () => {
  let clock = 1_000;
  const sleeps: number[] = [];
  const safety = createLiveSafetyController({
    maxAttempts: 3,
    minIntervalMs: 2_000,
    now: () => clock,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; },
  });
  await safety.reserve("a", "1");
  clock += 500;
  await safety.reserve("b", "2");
  assert.deepEqual(sleeps, [1_500]);
  assert.equal(safety.attemptsUsed, 2);
});

test("duplicate attempt opens circuit and circuit never auto-closes", async () => {
  const safety = createLiveSafetyController({ minIntervalMs: 0 });
  await safety.reserve("same", "15050");
  assert.equal((await safety.reserve("same", "15050")).allowed, false);
  assert.equal(safety.circuit.reason, "DUPLICATE_SUBMIT_BOUNDARY");
  assert.equal((await safety.reserve("different", "15051")).allowed, false);
});

test("legacy pre-submit UNKNOWN stays distinguishable from post-submit UNKNOWN", async (t) => {
  const location = await files();
  t.after(() => rm(location.directory, { recursive: true, force: true }));
  await saveReactionState({ version: 1, records: [record("UNKNOWN")] }, location.state);
  assert.equal((await inspectReactionSafety(location.state, location.journal)).circuitOpen, false);

  await saveReactionState({ version: 1, records: [record("UNKNOWN", { attemptId: "legacy-attempt" })] }, location.state);
  const status = await inspectReactionSafety(location.state, location.journal);
  assert.equal(status.circuitOpen, true);
  assert.equal(status.reason, "UNRESOLVED_POST_SUBMIT_UNKNOWN");
});

test("explicit post-submit UNKNOWN starts live circuit open", async (t) => {
  const location = await files();
  t.after(() => rm(location.directory, { recursive: true, force: true }));
  await saveReactionState({ version: 1, records: [record("UNKNOWN", {
    attemptId: "attempt-1", submitBoundaryCrossed: true,
  })] }, location.state);
  const safety = createLiveSafetyController({ minIntervalMs: 0 });
  await performStartupSafetyAudit(safety, { statePath: location.state, journalPath: location.journal });
  assert.equal(safety.circuit.reason, "UNRESOLVED_POST_SUBMIT_UNKNOWN");
  assert.equal((await safety.reserve("new", "15051")).allowed, false);
});

test("SUBMITTING restart recovery verifies read-only and never reserves a POST", async (t) => {
  const location = await files();
  t.after(() => rm(location.directory, { recursive: true, force: true }));
  await saveReactionState({ version: 1, records: [record("SUBMITTING", {
    attemptId: "attempt-1", submitBoundaryCrossed: true,
  })] }, location.state);
  const safety = createLiveSafetyController({ minIntervalMs: 0 });
  let verifies = 0;
  await performStartupSafetyAudit(safety, {
    statePath: location.state,
    journalPath: location.journal,
    async verify(dwellingId, assignmentId) {
      verifies += 1;
      return { status: "CONFIRMED_REACTED", dwellingId, assignmentId };
    },
  });
  assert.equal(verifies, 1);
  assert.equal(safety.attemptsUsed, 0);
  assert.equal((await loadReactionState(location.state)).records[0]?.status, "SUCCESS");
  assert.equal(safety.circuit.open, false);
  assert.deepEqual((await loadReactionJournal(location.journal)).map((event) => event.event), [
    "RECOVERY_STARTED", "RECOVERY_RESULT",
  ]);
});

test("SUBMITTING confirmed not reacted is never resubmitted and opens circuit", async (t) => {
  const location = await files();
  t.after(() => rm(location.directory, { recursive: true, force: true }));
  await saveReactionState({ version: 1, records: [record("SUBMITTING", {
    attemptId: "attempt-1", submitBoundaryCrossed: true,
  })] }, location.state);
  const safety = createLiveSafetyController({ minIntervalMs: 0 });
  await performStartupSafetyAudit(safety, {
    statePath: location.state,
    journalPath: location.journal,
    async verify(dwellingId, assignmentId) {
      return { status: "CONFIRMED_NOT_REACTED", dwellingId, assignmentId };
    },
  });
  const current = (await loadReactionState(location.state)).records[0];
  assert.equal(current?.status, "UNKNOWN");
  assert.equal(current?.submitBoundaryCrossed, true);
  assert.equal(safety.circuit.reason, "UNRESOLVED_POST_SUBMIT_UNKNOWN");
  assert.equal(safety.attemptsUsed, 0);
});

test("corrupt state or journal fails closed", async (t) => {
  const location = await files();
  t.after(() => rm(location.directory, { recursive: true, force: true }));
  await writeFile(location.state, "{broken", "utf8");
  assert.equal((await inspectReactionSafety(location.state, location.journal)).reason, "REACTION_STATE_CORRUPT");
  await saveReactionState({ version: 1, records: [] }, location.state);
  await writeFile(location.journal, "{broken\n", "utf8");
  assert.equal((await inspectReactionSafety(location.state, location.journal)).reason, "JOURNAL_CORRUPT");
});
