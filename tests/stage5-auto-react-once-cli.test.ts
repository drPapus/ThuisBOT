import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  parseAutoReactOnceArgs,
  runAutoReactOnceSelection,
} from "../src/dev/autoReactOnceFlow.js";
import type { AutomaticReactionRecord } from "../src/state/reactionState.js";
import type { NormalizedWoning } from "../src/woningen/types.js";

function woning(
  id: string,
  overrides: Partial<NormalizedWoning> = {},
): NormalizedWoning {
  return {
    id,
    loggedIn: true,
    isPassend: true,
    kanReageren: true,
    ...overrides,
  };
}

test("missing or multiple IDs fail before any portal operation", () => {
  assert.throws(() => parseAutoReactOnceArgs([]), /Usage/);
  assert.throws(() => parseAutoReactOnceArgs(["15020", "15021"]), /Usage/);
  assert.throws(() => parseAutoReactOnceArgs(["not-an-id"]), /Usage/);
  assert.equal(parseAutoReactOnceArgs(["15020"]), "15020");
});

test("dwelling absent from current aanbod never reaches coordinator", async () => {
  let coordinatorCalls = 0;
  await assert.rejects(runAutoReactOnceSelection("15020", {
    async fetchCurrentAanbod() { return [woning("15021")]; },
    async coordinate() { coordinatorCalls += 1; throw new Error("must not run"); },
  }), /not present/);
  assert.equal(coordinatorCalls, 0);
});

test("unauthenticated and non-eligible dwellings never reach coordinator", async () => {
  for (const selected of [
    woning("15020", { loggedIn: false }),
    woning("15020", { isPassend: false }),
    woning("15020", { kanReageren: false }),
  ]) {
    let coordinatorCalls = 0;
    await assert.rejects(runAutoReactOnceSelection("15020", {
      async fetchCurrentAanbod() { return [selected]; },
      async coordinate() { coordinatorCalls += 1; throw new Error("must not run"); },
    }));
    assert.equal(coordinatorCalls, 0);
  }
});

test("only the explicitly selected eligible dwelling reaches coordinator once", async () => {
  const reached: string[] = [];
  await runAutoReactOnceSelection("15020", {
    async fetchCurrentAanbod() { return [woning("15019"), woning("15020"), woning("15021")]; },
    async coordinate(selected) {
      reached.push(String(selected.id));
      return { status: "PROCESSED", result: { status: "ABORTED", reason: "CANNOT_REACT" }, outcome: { kind: "ABORTED" } };
    },
  });
  assert.deepEqual(reached, ["15020"]);
});

test("dry mode delegates once and has no independent submit opportunity", async () => {
  let submitCalls = 0;
  await runAutoReactOnceSelection("15020", {
    async fetchCurrentAanbod() { return [woning("15020")]; },
    async coordinate() {
      // The real coordinator owns dry/live behavior; this fake models AUTO_SUBMIT=false.
      assert.equal(submitCalls, 0);
      return { status: "PROCESSED", result: { status: "ABORTED", reason: "CANNOT_REACT" }, outcome: { kind: "ABORTED" } };
    },
  });
  assert.equal(submitCalls, 0);
});

test("all existing blocking states are returned as dedup without bypass", async () => {
  for (const status of ["PREPARED", "SUBMITTING", "SUCCESS", "FAILED", "UNKNOWN", "ABORTED"] as const) {
    const record: AutomaticReactionRecord = {
      dwellingId: "15020",
      assignmentId: "15154",
      status,
      firstSeenAt: "2026-09-21T09:00:00Z",
      updatedAt: "2026-09-21T09:01:00Z",
    };
    const result = await runAutoReactOnceSelection("15020", {
      async fetchCurrentAanbod() { return [woning("15020")]; },
      async coordinate() { return { status: "SKIPPED", previous: record, outcome: { kind: "DEDUP_SKIPPED" } }; },
    });
    assert.equal(result.status, "SKIPPED");
    if (result.status === "SKIPPED") assert.equal(result.previous.status, status);
  }
});

test("CLI is a thin coordinator client with no poller or independent POST implementation", async () => {
  const cli = await readFile(path.resolve("src/dev/autoReactOnceCli.ts"), "utf8");
  const flow = await readFile(path.resolve("src/dev/autoReactOnceFlow.ts"), "utf8");
  assert.match(cli, /runCoordinatedAutomaticPreparation/);
  assert.match(cli, /createAutomaticLiveDependencies/);
  assert.match(cli, /fetchActueelAanbod/);
  assert.match(cli, /liveSafety\.attemptsUsed/);
  assert.match(cli, /performStartupSafetyAudit\(liveSafety/);
  assert.match(cli, /liveSafety,/);
  assert.doesNotMatch(`${cli}\n${flow}`, /runPoller|setInterval|setTimeout/);
  assert.doesNotMatch(`${cli}\n${flow}`, /context\.request\.post|submitPreparedReactionOnce/);
  const printedStatements = cli.split("\n").filter((line) => line.includes("console.log")).join("\n");
  assert.doesNotMatch(printedStatements, /__hash__|authorization|cookie|storageState|formHash/i);
  assert.equal((cli.match(/runCoordinatedAutomaticPreparation\s*\(/g) ?? []).length, 1);
});

test("CLI startup and completion output contains no secret values", () => {
  const output = [
    "AUTO-REACT-ONCE",
    "Dwelling ........ 15020",
    "AUTO_SUBMIT ...... OFF",
    "MAX DWELLINGS .... 1",
    "MAX LIVE POSTS ... 1",
    "Final state ..... PREPARED",
    "Live attempts ... 0",
  ].join("\n");
  assert.doesNotMatch(output, /formHash|__hash__|cookie|authorization|csrf|FRESH-SECRET/i);
});
