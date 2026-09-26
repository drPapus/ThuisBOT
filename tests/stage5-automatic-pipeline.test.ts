import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadAutoSubmit } from "../src/config/env.js";
import {
  formatAutomaticPreparationReport,
  runAndReportAutomaticPreparation,
  runAutomaticPreparationPipeline,
} from "../src/reaction/automaticPipeline.js";
import type { ReactionPreparationDependencies } from "../src/reaction/liveTypes.js";
import { processNewWoningen } from "../src/scanner/processNewWoningen.js";
import type { NormalizedWoning } from "../src/woningen/types.js";

const dwellingId = "TEST-AUTO-DWELLING";
const freshDetails = {
  dwellingId,
  assignmentId: "TEST-AUTO-ASSIGNMENT",
  isPassend: true,
  kanReageren: true,
  loggedIn: true,
  action: "add",
  label: "Reageer",
  reactionUrl: `?add=TEST-AUTO-ASSIGNMENT&dwellingID=${dwellingId}`,
  closingDate: "2099-01-01T00:00:00Z",
} as const;

function dependencies(
  details = freshDetails,
): ReactionPreparationDependencies & { calls: { present: number; details: number; form: number } } {
  const calls = { present: 0, details: 0, form: 0 };
  return {
    calls,
    async isPresentInAanbod() {
      calls.present += 1;
      return true;
    },
    async fetchDetails() {
      calls.details += 1;
      return details;
    },
    async fetchForm() {
      calls.form += 1;
      return { formId: "Portal_Form_SubmitOnly", hash: "TEST-FRESH-AUTO-HASH" };
    },
    now: () => new Date("2026-09-17T10:00:00Z"),
  };
}

function woning(isPassend: boolean, kanReageren: boolean): NormalizedWoning {
  return { id: dwellingId, loggedIn: true, isPassend, kanReageren };
}

test("NEW but not eligible never enters the reaction pipeline", async () => {
  let pipelineCalls = 0;
  await processNewWoningen([woning(false, true)], "test time", async () => {
    pipelineCalls += 1;
    return { kind: "ABORTED" };
  });
  assert.equal(pipelineCalls, 0);
});

test("NEW ELIGIBLE performs fresh preparation and reports WOULD SUBMIT only", async () => {
  const deps = dependencies();
  const result = await runAutomaticPreparationPipeline(dwellingId, "loting", deps, false);
  assert.equal(result.status, "READY");
  assert.deepEqual(deps.calls, { present: 1, details: 1, form: 1 });
  const output = formatAutomaticPreparationReport(result);
  assert.match(output, /AUTO_SUBMIT \.\.\.\.\. OFF/);
  assert.match(output, /WOULD SUBMIT #TEST-AUTO-DWELLING/);
  assert.match(output, /No reaction sent\./);
  assert.doesNotMatch(output, /TEST-FRESH-AUTO-HASH/);
});

test("NEW ELIGIBLE dispatcher reaches and prints the preparation pipeline", async () => {
  const deps = dependencies();
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  try {
    await processNewWoningen([woning(true, true)], "test time", async (eligible) => {
      await runAndReportAutomaticPreparation(
        String(eligible.id),
        "loting",
        deps,
        false,
      );
      return { kind: "DRY_RUN_PREPARED" };
    });
  } finally {
    console.log = originalLog;
  }
  const output = lines.join("\n");
  console.log(`\n--- STAGE 5.1 WIRING PROOF ---\n${output}\n--- END WIRING PROOF ---`);
  assert.match(output, /NEW ELIGIBLE: #TEST-AUTO-DWELLING/);
  assert.match(output, /Starting reaction pipeline/);
  assert.match(output, /SESSION \.\.\.\.\.\.\.\. VALID/);
  assert.match(output, /AUTO_SUBMIT \.\.\.\.\. OFF/);
  assert.match(output, /WOULD SUBMIT #TEST-AUTO-DWELLING/);
  assert.match(output, /No reaction sent\./);
  assert.deepEqual(deps.calls, { present: 1, details: 1, form: 1 });
});

test("stale fresh eligibility aborts before form retrieval", async () => {
  const deps = dependencies({ ...freshDetails, kanReageren: false });
  const result = await runAutomaticPreparationPipeline(dwellingId, "loting", deps, false);
  assert.deepEqual(result, { status: "ABORTED", reason: "CANNOT_REACT", model: "loting" });
  assert.deepEqual(deps.calls, { present: 1, details: 1, form: 0 });
  assert.match(
    formatAutomaticPreparationReport(result),
    /REACTION ABORTED[\s\S]*Reason: dwelling is no longer reactable[\s\S]*No reaction sent/,
  );
});

test("AUTO_SUBMIT defaults off and requires explicit true", () => {
  const previous = process.env.AUTO_SUBMIT;

  try {
    delete process.env.AUTO_SUBMIT;

    assert.equal(loadAutoSubmit(), false);
    assert.equal(loadAutoSubmit("false"), false);
    assert.equal(loadAutoSubmit("true"), true);
    assert.throws(() => loadAutoSubmit("yes"), /must be true or false/);
  } finally {
    if (previous === undefined) {
      delete process.env.AUTO_SUBMIT;
    } else {
      process.env.AUTO_SUBMIT = previous;
    }
  }
});

test("preparation-only pipeline has no path to the live submitter", async () => {
  const automaticSource = await readFile(path.resolve("src/reaction/automaticPipeline.ts"), "utf8");
  const dryRunSource = await readFile(path.resolve("src/reaction/prepareReactionCli.ts"), "utf8");
  for (const source of [automaticSource, dryRunSource]) {
    assert.doesNotMatch(source, /submitPreparedReactionOnce|submitReaction|reactOnceCli/i);
    assert.doesNotMatch(source, /\/portal\/object\/frontend\/react\/format\/json/i);
  }
});

test("dev replay is single-ID, state-read-only, and has no live submit path", async () => {
  const source = await readFile(path.resolve("src/dev/replayKnownWoning.ts"), "utf8");
  assert.match(source, /loadKnownWoningen/);
  assert.match(source, /processNewWoningen/);
  assert.match(source, /runCoordinatedAutomaticPreparation/);
  assert.match(source, /\[woning\]/);
  assert.doesNotMatch(source, /saveKnownWoningen|writeFile|rename\s*\(/);
  assert.doesNotMatch(source, /submitPreparedReactionOnce|submitReaction|reactOnceCli/i);
  assert.doesNotMatch(source, /context\.request\.(?:post|put|patch|delete)/i);
  assert.match(source, /runCoordinatedAutomaticPreparation\([\s\S]*?false,/);
});
