import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCoordinatedAutomaticPreparation } from "../src/reaction/automaticCoordinator.js";
import type { ReactionPreparationDependencies } from "../src/reaction/liveTypes.js";
import {
  loadReactionState,
  saveReactionState,
  type AutomaticReactionRecord,
} from "../src/state/reactionState.js";

async function statePath(): Promise<{ directory: string; file: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thuisbot-reaction-state-"));
  return { directory, file: path.join(directory, "reaction-state.json") };
}

function dependencies(
  dwellingId: string,
  calls: { count: number },
  hooks: { enter?: () => void; leave?: () => void; throwPresent?: boolean } = {},
): ReactionPreparationDependencies {
  return {
    async isPresentInAanbod() {
      calls.count += 1;
      hooks.enter?.();
      if (hooks.throwPresent) throw new Error("simulated preparation failure");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return true;
    },
    async fetchDetails() {
      return {
        dwellingId,
        assignmentId: `A-${dwellingId}`,
        isPassend: true,
        kanReageren: true,
        loggedIn: true,
        action: "add",
        reactionUrl: `?add=A-${dwellingId}&dwellingID=${dwellingId}`,
        closingDate: "2099-01-01T00:00:00Z",
      };
    },
    async fetchForm() {
      hooks.leave?.();
      return { formId: "Portal_Form_SubmitOnly", hash: "SECRET-NOT-PERSISTED" };
    },
    now: () => new Date("2026-09-21T10:00:00Z"),
  };
}

test("one dwelling becomes PREPARED with assignment identity and no secrets", async (t) => {
  const location = await statePath();
  t.after(() => rm(location.directory, { recursive: true, force: true }));
  const calls = { count: 0 };
  const result = await runCoordinatedAutomaticPreparation(
    "15001", "random", dependencies("15001", calls), false, { statePath: location.file },
  );
  assert.equal(result.status, "PROCESSED");
  assert.equal(calls.count, 1);
  const state = await loadReactionState(location.file);
  assert.deepEqual(state.records[0] && {
    dwellingId: state.records[0].dwellingId,
    assignmentId: state.records[0].assignmentId,
    status: state.records[0].status,
  }, { dwellingId: "15001", assignmentId: "A-15001", status: "PREPARED" });
  assert.doesNotMatch(await readFile(location.file, "utf8"), /SECRET|hash|cookie|authorization/i);
});

test("duplicate and restart-persistent PREPARED records skip preparation", async (t) => {
  const location = await statePath();
  t.after(() => rm(location.directory, { recursive: true, force: true }));
  const calls = { count: 0 };
  await runCoordinatedAutomaticPreparation(
    "15001", undefined, dependencies("15001", calls), false, { statePath: location.file },
  );
  const second = await runCoordinatedAutomaticPreparation(
    "15001", undefined, dependencies("15001", calls), false, { statePath: location.file },
  );
  assert.equal(second.status, "SKIPPED");
  assert.equal(calls.count, 1);
  assert.equal((await loadReactionState(location.file)).records[0]?.status, "PREPARED");
});

test("ABORTED is persisted with its reason and blocks automatic retry", async (t) => {
  const location = await statePath();
  t.after(() => rm(location.directory, { recursive: true, force: true }));
  const calls = { count: 0 };
  const cannotReact = dependencies("15001", calls);
  cannotReact.fetchDetails = async () => ({
    dwellingId: "15001",
    assignmentId: "A-15001",
    isPassend: true,
    kanReageren: false,
    loggedIn: true,
    action: "add",
  });
  const first = await runCoordinatedAutomaticPreparation(
    "15001", undefined, cannotReact, false, { statePath: location.file },
  );
  assert.equal(first.status, "PROCESSED");
  const record = (await loadReactionState(location.file)).records[0];
  assert.equal(record?.status, "ABORTED");
  assert.equal(record?.reason, "CANNOT_REACT");
  const second = await runCoordinatedAutomaticPreparation(
    "15001", undefined, dependencies("15001", calls), false, { statePath: location.file },
  );
  assert.equal(second.status, "SKIPPED");
  assert.equal(calls.count, 1);
});

test("concurrent duplicate passes double-check exactly once", async (t) => {
  const location = await statePath();
  t.after(() => rm(location.directory, { recursive: true, force: true }));
  const calls = { count: 0 };
  const run = () => runCoordinatedAutomaticPreparation(
    "15002", undefined, dependencies("15002", calls), false, { statePath: location.file },
  );
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["PROCESSED", "SKIPPED"]);
  assert.equal(calls.count, 1);
});

test("different dwellings have maximum preparation concurrency one", async (t) => {
  const location = await statePath();
  t.after(() => rm(location.directory, { recursive: true, force: true }));
  let active = 0;
  let maximum = 0;
  const run = (id: string) => runCoordinatedAutomaticPreparation(
    id,
    undefined,
    dependencies(id, { count: 0 }, {
      enter: () => { active += 1; maximum = Math.max(maximum, active); },
      leave: () => { active -= 1; },
    }),
    false,
    { statePath: location.file },
  );
  await Promise.all([run("15001"), run("15002"), run("15003")]);
  assert.equal(maximum, 1);
});

test("exception persists UNKNOWN, releases lock, and UNKNOWN blocks retry", async (t) => {
  const location = await statePath();
  t.after(() => rm(location.directory, { recursive: true, force: true }));
  await assert.rejects(
    runCoordinatedAutomaticPreparation(
      "15001", undefined, dependencies("15001", { count: 0 }, { throwPresent: true }), false,
      { statePath: location.file },
    ),
    /simulated preparation failure/,
  );
  assert.equal((await loadReactionState(location.file)).records[0]?.status, "UNKNOWN");
  const blockedCalls = { count: 0 };
  const blocked = await runCoordinatedAutomaticPreparation(
    "15001", undefined, dependencies("15001", blockedCalls), false, { statePath: location.file },
  );
  assert.equal(blocked.status, "SKIPPED");
  assert.equal(blockedCalls.count, 0);

  const later = await runCoordinatedAutomaticPreparation(
    "15002", undefined, dependencies("15002", { count: 0 }), false, { statePath: location.file },
  );
  assert.equal(later.status, "PROCESSED");
});

test("stale IN_PROGRESS is explicitly recovered", async (t) => {
  const location = await statePath();
  t.after(() => rm(location.directory, { recursive: true, force: true }));
  const stale: AutomaticReactionRecord = {
    dwellingId: "15001",
    status: "IN_PROGRESS",
    firstSeenAt: "2026-09-21T09:00:00.000Z",
    updatedAt: "2026-09-21T09:00:00.000Z",
  };
  await saveReactionState({ version: 1, records: [stale] }, location.file);
  const result = await runCoordinatedAutomaticPreparation(
    "15001", undefined, dependencies("15001", { count: 0 }), false,
    { statePath: location.file, staleAfterMs: 60_000, now: () => new Date("2026-09-21T10:00:00Z") },
  );
  assert.equal(result.status, "PROCESSED");
  assert.equal((await loadReactionState(location.file)).records[0]?.status, "PREPARED");
});

test("corrupted state fails safely without preparation or reset", async (t) => {
  const location = await statePath();
  t.after(() => rm(location.directory, { recursive: true, force: true }));
  await writeFile(location.file, "{broken", "utf8");
  const calls = { count: 0 };
  await assert.rejects(
    runCoordinatedAutomaticPreparation(
      "15001", undefined, dependencies("15001", calls), false, { statePath: location.file },
    ),
    /corrupted; FAIL SAFE/,
  );
  assert.equal(calls.count, 0);
  assert.equal(await readFile(location.file, "utf8"), "{broken");
});

test("AUTO_SUBMIT=true without live dependencies blocks before submit", async (t) => {
  const location = await statePath();
  t.after(() => rm(location.directory, { recursive: true, force: true }));
  const calls = { count: 0 };
  await runCoordinatedAutomaticPreparation(
    "15001", undefined, dependencies("15001", calls), true, { statePath: location.file },
  );
  assert.equal(calls.count, 1);
  assert.equal((await loadReactionState(location.file)).records[0]?.status, "UNKNOWN");
});

test("automatic coordination is isolated from baseline and has only an injected submit boundary", async () => {
  const sources = await Promise.all([
    readFile(path.resolve("src/reaction/automaticCoordinator.ts"), "utf8"),
    readFile(path.resolve("src/state/reactionState.ts"), "utf8"),
    readFile(path.resolve("src/dev/replayKnownWoning.ts"), "utf8"),
  ]);
  for (const source of sources) {
    assert.doesNotMatch(source, /saveKnownWoningen|known-woningen\.json/);
    assert.doesNotMatch(source, /\/portal\/object\/frontend\/react\/format\/json/i);
  }
  assert.doesNotMatch(sources[1]!, /submitPreparedReactionOnce|submitReaction|reactOnceCli/i);
  assert.doesNotMatch(sources[2]!, /submitPreparedReactionOnce|submitReaction|reactOnceCli/i);
  const manual = await readFile(path.resolve("src/reaction/reactOnceCli.ts"), "utf8");
  assert.doesNotMatch(manual, /reactionState|automaticCoordinator/i);
});
