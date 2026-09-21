import assert from "node:assert/strict";
import test from "node:test";
import type { AutomaticProcessingOutcome } from "../src/reaction/automaticCoordinator.js";
import { createLiveSafetyController } from "../src/reaction/liveSafety.js";
import { createScanSummary } from "../src/scanner/scanSummary.js";
import { reportSummary } from "../src/dry-run/reporter.js";

function summary(
  outcomes: AutomaticProcessingOutcome[],
  overrides: Partial<Parameters<typeof createScanSummary>[0]> = {},
) {
  return createScanSummary({
    checked: 24,
    newCount: outcomes.length,
    eligible: outcomes.length,
    liveAttempts: outcomes.filter((outcome) => "liveAttempted" in outcome && outcome.liveAttempted).length,
    outcomes,
    circuitOpen: false,
    runLiveAttempts: 0,
    maxLiveAttempts: 10,
    ...overrides,
  });
}

test("three production successes are reported as three confirmed reactions", () => {
  const outcomes: AutomaticProcessingOutcome[] = [
    { kind: "SUCCESS", liveAttempted: true },
    { kind: "SUCCESS", liveAttempted: true },
    { kind: "SUCCESS", liveAttempted: true },
  ];
  const result = summary(outcomes, { newCount: 10, eligible: 3, liveAttempts: 3, runLiveAttempts: 3 });
  assert.deepEqual({
    checked: result.checked,
    newCount: result.newCount,
    eligible: result.eligible,
    notEligible: result.notEligible,
    liveAttempts: result.liveAttempts,
    confirmedReactions: result.confirmedReactions,
    failed: result.failed,
    unknown: result.unknown,
  }, {
    checked: 24,
    newCount: 10,
    eligible: 3,
    notEligible: 7,
    liveAttempts: 3,
    confirmedReactions: 3,
    failed: 0,
    unknown: 0,
  });
});

test("dry-run prepared dwellings are never counted as attempts or reactions", () => {
  const result = summary([
    { kind: "DRY_RUN_PREPARED" },
    { kind: "DRY_RUN_PREPARED" },
    { kind: "DRY_RUN_PREPARED" },
  ], { liveAttempts: 0 });
  assert.equal(result.liveAttempts, 0);
  assert.equal(result.confirmedReactions, 0);
  assert.equal(result.dryRunPrepared, 3);
});

test("UNKNOWN and the following circuit block have distinct metrics", () => {
  const result = summary([
    { kind: "SUCCESS", liveAttempted: true },
    { kind: "UNKNOWN", liveAttempted: true },
    { kind: "CIRCUIT_BLOCKED" },
  ], {
    liveAttempts: 2,
    circuitOpen: true,
    circuitReason: "UNKNOWN_RESULT",
    runLiveAttempts: 2,
  });
  assert.equal(result.confirmedReactions, 1);
  assert.equal(result.unknown, 1);
  assert.equal(result.circuitBlocked, 1);
  assert.equal(result.liveAttempts, 2);
  assert.equal(result.circuitOpen, true);
});

test("definitive failure and later success remain separate with closed circuit", () => {
  const result = summary([
    { kind: "FAILED", liveAttempted: true },
    { kind: "SUCCESS", liveAttempted: true },
  ], { liveAttempts: 2, runLiveAttempts: 2 });
  assert.equal(result.failed, 1);
  assert.equal(result.confirmedReactions, 1);
  assert.equal(result.circuitOpen, false);
});

test("dedup and run-limit blocks do not count as live attempts", () => {
  const dedup = summary([{ kind: "DEDUP_SKIPPED" }], { liveAttempts: 0 });
  assert.equal(dedup.dedupSkipped, 1);
  assert.equal(dedup.confirmedReactions, 0);

  const capped = summary([
    { kind: "SUCCESS", liveAttempted: true },
    { kind: "SUCCESS", liveAttempted: true },
    { kind: "RUN_LIMIT_BLOCKED" },
  ], { liveAttempts: 2, runLiveAttempts: 2 });
  assert.equal(capped.runLimitBlocked, 1);
  assert.equal(capped.liveAttempts, 2);
  assert.equal(capped.confirmedReactions, 2);
});

test("pre-existing reaction is SUCCESS with zero POST", () => {
  const result = summary([{ kind: "SUCCESS", liveAttempted: false }], { liveAttempts: 0 });
  assert.equal(result.confirmedReactions, 1);
  assert.equal(result.liveAttempts, 0);
});

test("aborted and not-eligible counts are not conflated", () => {
  const result = summary([{ kind: "ABORTED" }], { newCount: 4, eligible: 1 });
  assert.equal(result.aborted, 1);
  assert.equal(result.notEligible, 3);
});

test("concurrent completion order cannot change deterministic totals", async () => {
  const outcomes = await Promise.all([
    Promise.resolve<AutomaticProcessingOutcome>({ kind: "SUCCESS", liveAttempted: true }),
    Promise.resolve<AutomaticProcessingOutcome>({ kind: "FAILED", liveAttempted: true }),
    Promise.resolve<AutomaticProcessingOutcome>({ kind: "ABORTED" }),
  ]);
  const result = summary(outcomes, { liveAttempts: 2 });
  assert.deepEqual(
    { success: result.confirmedReactions, failed: result.failed, aborted: result.aborted },
    { success: 1, failed: 1, aborted: 1 },
  );
});

test("zero-new scans start with fresh zero counters", () => {
  const result = summary([], { newCount: 0, eligible: 0, liveAttempts: 0 });
  assert.equal(result.newCount, 0);
  assert.equal(result.eligible, 0);
  assert.equal(result.liveAttempts, 0);
  assert.equal(result.confirmedReactions, 0);
});

test("scan deltas stay separate while the existing run controller accumulates", async () => {
  const safety = createLiveSafetyController({ maxAttempts: 10, minIntervalMs: 0 });
  const scan1Start = safety.attemptsUsed;
  await safety.reserve("a", "1");
  await safety.reserve("b", "2");
  const scan1Attempts = safety.attemptsUsed - scan1Start;
  const scan2Start = safety.attemptsUsed;
  await safety.reserve("c", "3");
  const scan2Attempts = safety.attemptsUsed - scan2Start;
  assert.equal(scan1Attempts, 2);
  assert.equal(scan2Attempts, 1);
  assert.equal(safety.attemptsUsed, 3);
  assert.equal(safety.maxAttempts, 10);
});

test("summary reporter distinguishes attempts from confirmed reactions", () => {
  const result = summary([
    { kind: "SUCCESS", liveAttempted: true },
    { kind: "UNKNOWN", liveAttempted: true },
  ], { liveAttempts: 2, runLiveAttempts: 2, circuitOpen: true, circuitReason: "UNKNOWN_RESULT" });
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  try {
    reportSummary(result);
  } finally {
    console.log = original;
  }
  const output = lines.join("\n");
  assert.match(output, /Live attempts .* 2/);
  assert.match(output, /Confirmed reactions .* 1/);
  assert.match(output, /Unknown .* 1/);
  assert.match(output, /Circuit .* OPEN/);
  assert.doesNotMatch(output, /reactions sent/i);
});
