import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseReactionFormConfig } from "../src/reaction/formConfig.js";
import { encodePreparedReaction, prepareReaction } from "../src/reaction/prepareReaction.js";
import { formatReactionPreparationReport } from "../src/reaction/reporter.js";
import type { DwellingReactionInput, ReactionFormConfig } from "../src/reaction/types.js";

const hash = "test-only-current-form-hash";
const form: ReactionFormConfig = { formId: "Portal_Form_SubmitOnly", hash };
const reactable: DwellingReactionInput = {
  dwellingId: "TEST-DWELLING",
  assignmentId: 7001,
  isPassend: true,
  kanReageren: true,
  loggedIn: true,
  action: "add",
  label: "Reageer",
  reactionUrl: "?add=7001&dwellingID=TEST-DWELLING",
  closingDate: "2099-01-01T00:00:00Z",
};

function reason(input: DwellingReactionInput, customForm: Partial<ReactionFormConfig> = form): string {
  const result = prepareReaction(input, customForm, new Date("2026-09-17T10:00:00Z"));
  assert.equal(result.ok, false);
  return result.ok ? "" : result.reason;
}

test("valid reactable dwelling produces an exact prepared body", () => {
  const result = prepareReaction(reactable, form);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const body = new URLSearchParams(encodePreparedReaction(result.prepared));
  assert.deepEqual([...body.keys()], ["__id__", "__hash__", "add", "dwellingID"]);
  assert.deepEqual(Object.fromEntries(body), {
    __id__: "Portal_Form_SubmitOnly",
    __hash__: hash,
    add: "7001",
    dwellingID: "TEST-DWELLING",
  });
});

test("eligibility and required identifiers fail closed", () => {
  assert.equal(reason({ ...reactable, isPassend: false }), "NOT_PASSEND");
  assert.equal(reason({ ...reactable, kanReageren: false }), "CANNOT_REACT");
  assert.equal(reason({ ...reactable, assignmentId: undefined }), "MISSING_ASSIGNMENT_ID");
  assert.equal(reason(reactable, { formId: form.formId }), "MISSING_FORM_HASH");
});

test("already-reacted states never prepare a duplicate add", () => {
  for (const input of [
    { ...reactable, action: "remove" },
    { ...reactable, label: "Verwijder reactie" },
    { ...reactable, reactionUrl: "?remove=123&dwellingID=TEST-DWELLING" },
  ]) {
    assert.equal(reason(input), "ALREADY_REACTED");
    assert.equal(prepareReaction(input, form).ok, false);
  }
});

test("reaction URL assignment and dwelling mismatches fail closed", () => {
  assert.equal(
    reason({ ...reactable, reactionUrl: "?add=WRONG&dwellingID=TEST-DWELLING" }),
    "REACTION_URL_MISMATCH",
  );
  assert.equal(
    reason({ ...reactable, reactionUrl: "?add=7001&dwellingID=WRONG" }),
    "REACTION_URL_MISMATCH",
  );
});

test("form configuration parsing accepts the verified shape", () => {
  assert.deepEqual(
    parseReactionFormConfig({
      form: {
        id: "Portal_Form_SubmitOnly",
        elements: { __id__: [], __hash__: { type: "hash", initialData: hash }, submit: [] },
      },
    }),
    form,
  );
});

test("malformed form configurations fail closed", () => {
  assert.throws(() => parseReactionFormConfig({}), /MISSING_FORM_ID/);
  assert.throws(
    () => parseReactionFormConfig({ form: { id: "Portal_Form_SubmitOnly", elements: {} } }),
    /MISSING_FORM_HASH/,
  );
});

test("reporter never reveals the complete form hash", () => {
  const result = prepareReaction(reactable, form);
  const report = formatReactionPreparationReport(result);
  assert.doesNotMatch(report, new RegExp(hash));
  assert.match(report, /__hash__=\[REDACTED\]/);
  assert.match(report, /DRY RUN → REQUEST NOT SENT/);
});

test("reaction preparation source contains no submission capability", async () => {
  const directory = path.resolve("src", "reaction");
  const files = ["formConfig.ts", "prepareReaction.ts", "reporter.ts", "prepareReactionCli.ts"];
  const source = (await Promise.all(files.map((file) => readFile(path.join(directory, file), "utf8")))).join("\n");

  const forbidden = [
    /context\.request\.(?:post|put|patch|delete)\s*\(/i,
    /page\.request\.(?:post|put|patch|delete)\s*\(/i,
    /\bfetch\s*\(/i,
    /page\.evaluate\s*\(/i,
    /(?:page\.|locator\([^)]*\)\.)click\s*\(/i,
    /function\s+sendReaction\b/i,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(source, pattern);
});
