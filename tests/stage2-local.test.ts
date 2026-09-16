import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { reportNewWoningen } from "../src/dry-run/reporter.js";
import { detectNewWoningen } from "../src/scanner/detectNew.js";
import {
  KNOWN_WONINGEN_PATH,
  loadKnownWoningen,
  saveKnownWoningen,
} from "../src/state/knownWoningen.js";
import type { NormalizedWoning } from "../src/woningen/types.js";

const eligibleFake: NormalizedWoning = {
  id: "TEST-15001",
  street: "Teststraat",
  houseNumber: "1",
  city: "Teststad",
  modelCode: "random",
  loggedIn: true,
  isPassend: true,
  kanReageren: true,
};

const ineligibleFake: NormalizedWoning = {
  id: "TEST-15002",
  street: "Teststraat",
  houseNumber: "2",
  city: "Teststad",
  modelCode: "random",
  loggedIn: true,
  isPassend: false,
  kanReageren: true,
};

async function captureOutput(action: () => void): Promise<string> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    lines.push(values.map(String).join(" "));
  };
  try {
    action();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

test("fake eligible and skipped listings are each emitted exactly once", async () => {
  const production = await loadKnownWoningen(KNOWN_WONINGEN_PATH);
  assert.equal(
    production.exists,
    true,
    "Production baseline is missing. Run `npm run scan` once before this local test.",
  );
  if (!production.exists) return;

  const testDirectory = await mkdtemp(path.join(tmpdir(), "thuispoort-stage2-local-"));
  const testStatePath = path.join(testDirectory, "known-woningen.json");
  await saveKnownWoningen(production.state.knownIds, testStatePath);
  console.log(`Loaded production baseline: ${production.state.knownIds.length} known woningen`);
  console.log(`Temporary test state: ${testStatePath}`);

  const runFake = async (fake: NormalizedWoning): Promise<{ newCount: number; output: string }> => {
    const loaded = await loadKnownWoningen(testStatePath);
    assert.equal(loaded.exists, true);
    if (!loaded.exists) return { newCount: 0, output: "" };

    const detected = detectNewWoningen([fake], loaded.state.knownIds);
    console.log(`New: ${detected.newWoningen.length}`);
    if (detected.newWoningen.length > 0) {
      await saveKnownWoningen(detected.updatedKnownIds, testStatePath);
    }
    const output = await captureOutput(() =>
      reportNewWoningen(detected.newWoningen, "2026-09-17 12:03:24 Europe/Amsterdam"),
    );
    if (output) console.log(output);
    return { newCount: detected.newWoningen.length, output };
  };

  const eligibleFirst = await runFake(eligibleFake);
  assert.equal(eligibleFirst.newCount, 1);
  assert.match(eligibleFirst.output, /NEW: #TEST-15001/);
  assert.match(
    eligibleFirst.output,
    /First detected: 2026-09-17 12:03:24 Europe\/Amsterdam/,
  );
  assert.match(eligibleFirst.output, /Passend: YES/);
  assert.match(eligibleFirst.output, /Can react: YES/);
  assert.match(eligibleFirst.output, /NEW ELIGIBLE/);
  assert.match(eligibleFirst.output, /DRY RUN → WOULD REACT/);

  const afterEligible = await loadKnownWoningen(testStatePath);
  assert.equal(afterEligible.exists, true);
  if (!afterEligible.exists) return;
  assert.ok(afterEligible.state.knownIds.includes("TEST-15001"));

  const eligibleSecond = await runFake(eligibleFake);
  assert.equal(eligibleSecond.newCount, 0);
  assert.doesNotMatch(eligibleSecond.output, /NEW: #TEST-15001/);

  const ineligibleFirst = await runFake(ineligibleFake);
  assert.equal(ineligibleFirst.newCount, 1);
  assert.match(ineligibleFirst.output, /NEW: #TEST-15002/);
  assert.match(ineligibleFirst.output, /Passend: NO/);
  assert.match(ineligibleFirst.output, /Can react: YES/);
  assert.match(ineligibleFirst.output, /NEW BUT NOT ELIGIBLE/);
  assert.match(ineligibleFirst.output, /SKIP/);
  assert.doesNotMatch(ineligibleFirst.output, /DRY RUN → WOULD REACT/);

  const afterIneligible = await loadKnownWoningen(testStatePath);
  assert.equal(afterIneligible.exists, true);
  if (!afterIneligible.exists) return;
  assert.ok(afterIneligible.state.knownIds.includes("TEST-15002"));

  const ineligibleSecond = await runFake(ineligibleFake);
  assert.equal(ineligibleSecond.newCount, 0);
  assert.doesNotMatch(ineligibleSecond.output, /NEW: #TEST-15002/);
});
