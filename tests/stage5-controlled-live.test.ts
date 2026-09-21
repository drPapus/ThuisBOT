import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AutomaticLiveDependencies } from "../src/reaction/automaticLiveAdapter.js";
import { runCoordinatedAutomaticPreparation } from "../src/reaction/automaticCoordinator.js";
import { createLiveSubmitBudget } from "../src/reaction/liveSubmitBudget.js";
import { REACTION_ENDPOINT } from "../src/reaction/reactionEndpoint.js";
import { appendReactionJournalEvent } from "../src/state/reactionJournal.js";
import { loadReactionState, saveReactionState } from "../src/state/reactionState.js";

async function location(): Promise<{ directory: string; state: string; journal: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thuisbot-live-"));
  return { directory, state: path.join(directory, "state.json"), journal: path.join(directory, "journal.jsonl") };
}

function preparation(id: string) {
  return {
    async isPresentInAanbod() { return true; },
    async fetchDetails() {
      return {
        dwellingId: id,
        assignmentId: `A-${id}`,
        isPassend: true,
        kanReageren: true,
        loggedIn: true,
        action: "add",
        reactionUrl: `?add=A-${id}&dwellingID=${id}`,
        closingDate: "2099-01-01T00:00:00Z",
      };
    },
    async fetchForm() { return { formId: "Portal_Form_SubmitOnly", hash: "FRESH-SECRET" }; },
    now: () => new Date("2026-09-21T10:00:00Z"),
  };
}

function live(
  id: string,
  submitCalls: { count: number },
  submission: Awaited<ReturnType<AutomaticLiveDependencies["submit"]>> = { status: "ACCEPTED_RESPONSE", httpStatus: 200 },
  verifications: Array<"CONFIRMED_NOT_REACTED" | "CONFIRMED_REACTED" | "INDETERMINATE"> = ["CONFIRMED_NOT_REACTED", "CONFIRMED_REACTED"],
): AutomaticLiveDependencies {
  let verificationIndex = 0;
  return {
    endpoint: REACTION_ENDPOINT,
    async submit() { submitCalls.count += 1; return submission; },
    async verify(dwellingId, assignmentId) {
      const status = verifications[verificationIndex++] ?? "INDETERMINATE";
      return status === "INDETERMINATE"
        ? { status, dwellingId, assignmentId, reason: "TEST_INDETERMINATE" }
        : { status, dwellingId, assignmentId };
    },
  };
}

async function run(
  state: string,
  journal: string,
  id: string,
  autoSubmit: boolean,
  liveDependencies: AutomaticLiveDependencies | undefined,
  submitBudget = createLiveSubmitBudget(),
  extra: Record<string, unknown> = {},
) {
  return runCoordinatedAutomaticPreparation(id, "random", preparation(id), autoSubmit, {
    statePath: state,
    journalPath: journal,
    liveBudget: submitBudget,
    createAttemptId: () => `attempt-${id}`,
    ...(liveDependencies && { live: liveDependencies }),
    ...extra,
  });
}

test("dry run makes zero live submit calls", async (t) => {
  const files = await location(); t.after(() => rm(files.directory, { recursive: true, force: true }));
  const calls = { count: 0 };
  await run(files.state, files.journal, "15050", false, live("15050", calls));
  assert.equal(calls.count, 0);
  assert.equal((await loadReactionState(files.state)).records[0]?.status, "PREPARED");
});

test("controlled submit calls exactly once and independently verifies SUCCESS", async (t) => {
  const files = await location(); t.after(() => rm(files.directory, { recursive: true, force: true }));
  const calls = { count: 0 };
  await run(files.state, files.journal, "15050", true, live("15050", calls));
  const record = (await loadReactionState(files.state)).records[0];
  assert.equal(calls.count, 1);
  assert.equal(record?.status, "SUCCESS");
  assert.equal(record?.attemptId, "attempt-15050");
});

test("one-per-process budget blocks a second dwelling", async (t) => {
  const files = await location(); t.after(() => rm(files.directory, { recursive: true, force: true }));
  const calls = { count: 0 };
  const budget = createLiveSubmitBudget();
  await run(files.state, files.journal, "15050", true, live("15050", calls), budget);
  await run(files.state, files.journal, "15051", true, live("15051", calls), budget);
  assert.equal(calls.count, 1);
  assert.equal(budget.used, 1);
});

test("timeout evidence plus reacted verification is SUCCESS without retry", async (t) => {
  const files = await location(); t.after(() => rm(files.directory, { recursive: true, force: true }));
  const calls = { count: 0 };
  await run(files.state, files.journal, "15050", true, live(
    "15050", calls, { status: "AMBIGUOUS", reason: "TIMEOUT" },
    ["CONFIRMED_NOT_REACTED", "CONFIRMED_REACTED"],
  ));
  assert.equal(calls.count, 1);
  assert.equal((await loadReactionState(files.state)).records[0]?.status, "SUCCESS");
});

test("timeout with indeterminate verification is terminal UNKNOWN", async (t) => {
  const files = await location(); t.after(() => rm(files.directory, { recursive: true, force: true }));
  const calls = { count: 0 };
  await run(files.state, files.journal, "15050", true, live(
    "15050", calls, { status: "AMBIGUOUS", reason: "TIMEOUT" },
    ["CONFIRMED_NOT_REACTED", "INDETERMINATE"],
  ));
  assert.equal(calls.count, 1);
  assert.equal((await loadReactionState(files.state)).records[0]?.status, "UNKNOWN");
  await run(files.state, files.journal, "15050", true, live("15050", calls));
  assert.equal(calls.count, 1);
});

test("HTTP 200 with confirmed not reacted is UNKNOWN, never SUCCESS", async (t) => {
  const files = await location(); t.after(() => rm(files.directory, { recursive: true, force: true }));
  const calls = { count: 0 };
  await run(files.state, files.journal, "15050", true, live(
    "15050", calls, { status: "ACCEPTED_RESPONSE", httpStatus: 200 },
    ["CONFIRMED_NOT_REACTED", "CONFIRMED_NOT_REACTED"],
  ));
  assert.equal(calls.count, 1);
  assert.equal((await loadReactionState(files.state)).records[0]?.status, "UNKNOWN");
});

test("already reacted before submit becomes SUCCESS with zero POST", async (t) => {
  const files = await location(); t.after(() => rm(files.directory, { recursive: true, force: true }));
  const calls = { count: 0 };
  await run(files.state, files.journal, "15050", true, live(
    "15050", calls, undefined, ["CONFIRMED_REACTED"],
  ));
  const record = (await loadReactionState(files.state)).records[0];
  assert.equal(calls.count, 0);
  assert.equal(record?.status, "SUCCESS");
  assert.equal(record?.reason, "ALREADY_REACTED_BEFORE_SUBMIT");
});

test("indeterminate pre-submit verification blocks with zero POST", async (t) => {
  const files = await location(); t.after(() => rm(files.directory, { recursive: true, force: true }));
  const calls = { count: 0 };
  await run(files.state, files.journal, "15050", true, live(
    "15050", calls, undefined, ["INDETERMINATE"],
  ));
  assert.equal(calls.count, 0);
  assert.equal((await loadReactionState(files.state)).records[0]?.status, "UNKNOWN");
});

test("stale preparation blocks with zero POST", async (t) => {
  const files = await location(); t.after(() => rm(files.directory, { recursive: true, force: true }));
  const calls = { count: 0 };
  let clock = new Date("2026-09-21T10:00:00Z").getTime();
  await run(files.state, files.journal, "15050", true, live("15050", calls), createLiveSubmitBudget(), {
    now: () => new Date(clock),
    appendJournal: async (event: Parameters<typeof appendReactionJournalEvent>[0], file: string) => {
      await appendReactionJournalEvent(event, file);
      if (event.event === "PREPARED") clock += 31_000;
    },
  });
  assert.equal(calls.count, 0);
  assert.equal((await loadReactionState(files.state)).records[0]?.reason, "PREPARATION_STALE");
});

test("journal failure before SUBMIT_STARTED results in zero POST", async (t) => {
  const files = await location(); t.after(() => rm(files.directory, { recursive: true, force: true }));
  const calls = { count: 0 };
  await assert.rejects(run(files.state, files.journal, "15050", true, live("15050", calls), createLiveSubmitBudget(), {
    appendJournal: async (event: Parameters<typeof appendReactionJournalEvent>[0], file: string) => {
      if (event.event === "SUBMIT_STARTED") throw new Error("journal unavailable");
      await appendReactionJournalEvent(event, file);
    },
  }), /journal unavailable/);
  assert.equal(calls.count, 0);
  assert.equal((await loadReactionState(files.state)).records[0]?.status, "UNKNOWN");
});

test("persistent-state failure results in zero POST", async (t) => {
  const files = await location(); t.after(() => rm(files.directory, { recursive: true, force: true }));
  const parentFile = path.join(files.directory, "not-a-directory");
  await writeFile(parentFile, "x", "utf8");
  const calls = { count: 0 };
  await assert.rejects(run(path.join(parentFile, "state.json"), files.journal, "15050", true, live("15050", calls)));
  assert.equal(calls.count, 0);
});

test("SUBMITTING persistence failure results in zero POST", async (t) => {
  const files = await location(); t.after(() => rm(files.directory, { recursive: true, force: true }));
  const calls = { count: 0 };
  await assert.rejects(run(files.state, files.journal, "15050", true, live("15050", calls), createLiveSubmitBudget(), {
    saveState: async (state: Parameters<typeof saveReactionState>[0], file: string) => {
      if (state.records.some((record) => record.status === "SUBMITTING")) {
        throw new Error("simulated SUBMITTING persistence failure");
      }
      await saveReactionState(state, file);
    },
  }), /SUBMITTING persistence failure/);
  assert.equal(calls.count, 0);
});

test("definitive rejection plus confirmed not reacted is FAILED", async (t) => {
  const files = await location(); t.after(() => rm(files.directory, { recursive: true, force: true }));
  const calls = { count: 0 };
  await run(files.state, files.journal, "15050", true, live(
    "15050", calls, { status: "DEFINITIVE_REJECTION", httpStatus: 400 },
    ["CONFIRMED_NOT_REACTED", "CONFIRMED_NOT_REACTED"],
  ));
  assert.equal(calls.count, 1);
  assert.equal((await loadReactionState(files.state)).records[0]?.status, "FAILED");
});

test("SUBMITTING and all terminal states dedup after restart", async (t) => {
  const statuses = ["SUBMITTING", "UNKNOWN", "SUCCESS", "FAILED"] as const;
  for (const status of statuses) {
    const files = await location(); t.after(() => rm(files.directory, { recursive: true, force: true }));
    await saveReactionState({ version: 1, records: [{
      dwellingId: "15050", assignmentId: "A-15050", attemptId: "prior-attempt", status,
      firstSeenAt: "2026-09-21T09:00:00Z", updatedAt: "2026-09-21T09:01:00Z",
    }] }, files.state);
    const calls = { count: 0 };
    const result = await run(files.state, files.journal, "15050", true, live("15050", calls));
    assert.equal(result.status, "SKIPPED");
    assert.equal(calls.count, 0);
  }
});

test("concurrent candidates have submit concurrency and total attempts of one", async (t) => {
  const files = await location(); t.after(() => rm(files.directory, { recursive: true, force: true }));
  const budget = createLiveSubmitBudget();
  let active = 0;
  let maximum = 0;
  let total = 0;
  const liveFor = (id: string): AutomaticLiveDependencies => ({
    endpoint: REACTION_ENDPOINT,
    async submit() { total += 1; active += 1; maximum = Math.max(maximum, active); await new Promise((r) => setTimeout(r, 5)); active -= 1; return { status: "ACCEPTED_RESPONSE", httpStatus: 200 }; },
    async verify(dwelling, assignment) { return total === 0 ? { status: "CONFIRMED_NOT_REACTED", dwellingId: dwelling, assignmentId: assignment } : { status: "CONFIRMED_REACTED", dwellingId: dwelling, assignmentId: assignment }; },
  });
  await Promise.all(["15050", "15051", "15052"].map((id) => run(files.state, files.journal, id, true, liveFor(id), budget)));
  assert.equal(total, 1);
  assert.equal(maximum, 1);
});

test("identity mismatch blocks before POST", async (t) => {
  const files = await location(); t.after(() => rm(files.directory, { recursive: true, force: true }));
  const calls = { count: 0 };
  const mismatched = live("15050", calls);
  mismatched.verify = async () => ({ status: "INDETERMINATE", dwellingId: "WRONG", assignmentId: "WRONG", reason: "ASSIGNMENT_ID_MISMATCH" });
  await run(files.state, files.journal, "15050", true, mismatched);
  assert.equal(calls.count, 0);
});

test("same attemptId cannot consume the irreversible boundary twice", () => {
  const budget = createLiveSubmitBudget();
  budget.consume("attempt-one");
  assert.throws(() => budget.consume("attempt-one"), /ATTEMPT_ID_ALREADY_CONSUMED/);
  assert.equal(budget.used, 1);
});

test("production adapter is the sole automatic invocation of the existing submitter", async () => {
  const adapter = await import("node:fs/promises").then(({ readFile }) =>
    readFile(path.resolve("src/reaction/automaticLiveAdapter.ts"), "utf8"));
  assert.equal((adapter.match(/submitPreparedReactionOnce\s*\(/g) ?? []).length, 1);
  assert.doesNotMatch(adapter, /context\.request\.post\s*\(/);
});
