import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { detectNewWoningen } from "../src/scanner/detectNew.js";
import { loadKnownWoningen, saveKnownWoningen } from "../src/state/knownWoningen.js";
import type { NormalizedWoning } from "../src/woningen/types.js";

function woning(id: string | number, isPassend = true, kanReageren = true): NormalizedWoning {
  return { id, loggedIn: true, isPassend, kanReageren };
}

async function statePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "thuispoort-stage2-"));
  return path.join(directory, "known-woningen.json");
}

test("first run creates a baseline and second run detects nothing", async () => {
  const file = await statePath();
  const missing = await loadKnownWoningen(file);
  assert.deepEqual(missing, { exists: false });

  await saveKnownWoningen([1, 2], file);
  const loaded = await loadKnownWoningen(file);
  assert.equal(loaded.exists, true);
  if (!loaded.exists) return;

  const result = detectNewWoningen([woning(1), woning(2)], loaded.state.knownIds);
  assert.equal(result.newWoningen.length, 0);
});

test("a simulated new ID is detected once and then remembered", async () => {
  const file = await statePath();
  await saveKnownWoningen([1, 2], file);
  const initial = await loadKnownWoningen(file);
  assert.equal(initial.exists, true);
  if (!initial.exists) return;

  const thirdScan = detectNewWoningen([woning(1), woning(2), woning(3)], initial.state.knownIds);
  assert.deepEqual(thirdScan.newWoningen.map(({ id }) => id), [3]);
  await saveKnownWoningen(thirdScan.updatedKnownIds, file);

  const updated = await loadKnownWoningen(file);
  assert.equal(updated.exists, true);
  if (!updated.exists) return;
  const fourthScan = detectNewWoningen([woning(1), woning(2), woning(3)], updated.state.knownIds);
  assert.equal(fourthScan.newWoningen.length, 0);
});

test("a non-eligible new listing is still remembered", async () => {
  const skipped = woning(5, false, true);
  const detected = detectNewWoningen([skipped], []);
  assert.deepEqual(detected.newWoningen, [skipped]);
  assert.deepEqual(detected.updatedKnownIds, [5]);
  assert.equal(detectNewWoningen([skipped], detected.updatedKnownIds).newWoningen.length, 0);
});

test("corrupted state fails closed", async () => {
  const file = await statePath();
  await writeFile(file, "{ definitely not JSON", "utf8");
  await assert.rejects(
    loadKnownWoningen(file),
    /state is corrupted; refusing to classify listings as new/,
  );
});

test("duplicate API IDs create only one NEW event", () => {
  const result = detectNewWoningen([woning(9), woning(9), woning(10)], []);
  assert.deepEqual(result.newWoningen.map(({ id }) => id), [9, 10]);
  assert.equal(result.current.length, 2);
});

test("state writes valid JSON without losing existing IDs", async () => {
  const file = await statePath();
  await saveKnownWoningen([1, 2, 2, "3"], file);
  const onDisk = JSON.parse(await readFile(file, "utf8")) as { knownIds: unknown[] };
  assert.deepEqual(onDisk.knownIds, [1, 2, "3"]);
});
