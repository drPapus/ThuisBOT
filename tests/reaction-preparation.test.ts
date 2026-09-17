import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { BrowserContext } from "playwright";
import {
  DwellingDetailsError,
  fetchDwellingReactionDetails,
  GETOBJECT_PATH,
  parseDwellingReactionDetails,
} from "../src/reaction/dwellingDetails.js";
import { parseReactionFormConfig } from "../src/reaction/formConfig.js";
import { encodePreparedReaction, prepareReaction } from "../src/reaction/prepareReaction.js";
import {
  formatAuthoritativeReactionState,
  formatReactionPreparationReport,
} from "../src/reaction/reporter.js";
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

const detailsJson = {
  result: {
    id: "TEST-DWELLING",
    assignmentID: 7001,
    closingDate: "2099-01-01T00:00:00Z",
    reactionData: {
      isPassend: true,
      kanReageren: true,
      loggedin: true,
      action: "add",
      label: "Reageer",
      url: "?add=7001&dwellingID=TEST-DWELLING",
    },
  },
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

test("aanbod may omit assignmentID while getobject remains authoritative", () => {
  const aanbodRaw = { id: "TEST-DWELLING" };
  assert.equal("assignmentID" in aanbodRaw, false);
  const details = parseDwellingReactionDetails(detailsJson, String(aanbodRaw.id));
  const result = prepareReaction(details, form);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.prepared.assignmentId, "7001");
  assert.equal(result.prepared.isPassend, true);
  assert.equal(result.prepared.kanReageren, true);
});

test("getobject client uses exactly the verified endpoint, headers, and id body", async () => {
  let capturedUrl = "";
  let capturedOptions: Record<string, unknown> | undefined;
  const response = {
    status: () => 200,
    ok: () => true,
    headers: () => ({ "content-type": "application/json" }),
    json: async () => detailsJson,
  };
  const context = {
    request: {
      post: async (url: string, options: Record<string, unknown>) => {
        capturedUrl = url;
        capturedOptions = options;
        return response;
      },
    },
  } as unknown as BrowserContext;

  const details = await fetchDwellingReactionDetails(
    context,
    "https://www.thuispoort.nl/",
    "TEST-DWELLING",
  );
  assert.equal(capturedUrl, `https://www.thuispoort.nl${GETOBJECT_PATH}`);
  assert.equal(capturedOptions?.data, "id=TEST-DWELLING");
  assert.deepEqual(capturedOptions?.headers, {
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    "x-requested-with": "XMLHttpRequest",
  });
  assert.equal(details.assignmentId, 7001);
});

test("getobject response validates ID and shape and reports expired sessions", async () => {
  assert.throws(
    () => parseDwellingReactionDetails(detailsJson, "DIFFERENT-ID"),
    (error: unknown) =>
      error instanceof DwellingDetailsError && error.reason === "DWELLING_ID_MISMATCH",
  );
  assert.throws(
    () => parseDwellingReactionDetails({ result: {} }, "TEST-DWELLING"),
    (error: unknown) =>
      error instanceof DwellingDetailsError && error.reason === "UNEXPECTED_REACTION_STATE",
  );

  const expiredContext = {
    request: {
      post: async () => ({
        status: () => 401,
        ok: () => false,
        headers: () => ({ "content-type": "application/json" }),
      }),
    },
  } as unknown as BrowserContext;
  await assert.rejects(
    fetchDwellingReactionDetails(
      expiredContext,
      "https://www.thuispoort.nl/",
      "TEST-DWELLING",
    ),
    (error: unknown) =>
      error instanceof DwellingDetailsError && error.reason === "SESSION_EXPIRED",
  );

  const invalidJsonContext = {
    request: {
      post: async () => ({
        status: () => 200,
        ok: () => true,
        headers: () => ({ "content-type": "application/json" }),
        json: async () => Promise.reject(new SyntaxError("invalid JSON")),
      }),
    },
  } as unknown as BrowserContext;
  await assert.rejects(
    fetchDwellingReactionDetails(
      invalidJsonContext,
      "https://www.thuispoort.nl/",
      "TEST-DWELLING",
    ),
    (error: unknown) =>
      error instanceof DwellingDetailsError && error.reason === "UNEXPECTED_REACTION_STATE",
  );
});

test("missing assignment and authoritative reaction states fail closed", () => {
  const withoutAssignment = structuredClone(detailsJson);
  delete (withoutAssignment.result as Partial<typeof withoutAssignment.result>).assignmentID;
  assert.equal(
    reason(parseDwellingReactionDetails(withoutAssignment, "TEST-DWELLING")),
    "MISSING_ASSIGNMENT_ID",
  );

  for (const [field, value, expected] of [
    ["action", "remove", "ALREADY_REACTED"],
    ["isPassend", false, "NOT_PASSEND"],
    ["kanReageren", false, "CANNOT_REACT"],
  ] as const) {
    const changed = structuredClone(detailsJson);
    changed.result.reactionData[field] = value as never;
    assert.equal(reason(parseDwellingReactionDetails(changed, "TEST-DWELLING")), expected);
  }

  const mismatch = structuredClone(detailsJson);
  mismatch.result.reactionData.url = "?add=WRONG&dwellingID=TEST-DWELLING";
  assert.equal(
    reason(parseDwellingReactionDetails(mismatch, "TEST-DWELLING")),
    "REACTION_URL_MISMATCH",
  );
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

test("authoritative state debug output selects fields and excludes secrets", () => {
  const detailsWithSecrets = {
    ...reactable,
    formHash: "NEVER-PRINT-FORM-HASH",
    cookies: "NEVER-PRINT-COOKIE",
    authorization: "NEVER-PRINT-AUTHORIZATION",
  } as DwellingReactionInput & {
    formHash: string;
    cookies: string;
    authorization: string;
  };
  const output = formatAuthoritativeReactionState(
    "TEST-DWELLING",
    true,
    detailsWithSecrets,
  );

  assert.match(output, /Requested dwelling: TEST-DWELLING/);
  assert.match(output, /Present in aanbod: YES/);
  assert.match(output, /assignmentId: 7001/);
  assert.match(output, /action: add/);
  assert.doesNotMatch(output, /NEVER-PRINT-FORM-HASH|NEVER-PRINT-COOKIE|NEVER-PRINT-AUTHORIZATION/);
  assert.doesNotMatch(output, /formHash|cookies|authorization/i);
});

test("reaction preparation source contains no submission capability", async () => {
  const directory = path.resolve("src", "reaction");
  const files = [
    "dwellingDetails.ts",
    "formConfig.ts",
    "prepareReaction.ts",
    "reporter.ts",
    "prepareReactionCli.ts",
  ];
  const sources = new Map(
    await Promise.all(
      files.map(async (file) => [file, await readFile(path.join(directory, file), "utf8")] as const),
    ),
  );
  const detailsSource = sources.get("dwellingDetails.ts") ?? "";
  const otherSource = [...sources.entries()]
    .filter(([file]) => file !== "dwellingDetails.ts")
    .map(([, source]) => source)
    .join("\n");

  const forbidden = [
    /context\.request\.(?:post|put|patch|delete)\s*\(/i,
    /page\.request\.(?:post|put|patch|delete)\s*\(/i,
    /\bfetch\s*\(/i,
    /page\.evaluate\s*\(/i,
    /(?:page\.|locator\([^)]*\)\.)click\s*\(/i,
    /(?:function|const|let|var)\s+(?:sendReaction|removeReaction)\b/i,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(otherSource, pattern);

  assert.equal((detailsSource.match(/context\.request\.post\s*\(/g) ?? []).length, 1);
  assert.match(detailsSource, /GETOBJECT_PATH/);
  assert.doesNotMatch(detailsSource, /\/portal\/object\/frontend\/react\/format\/json/i);
  assert.doesNotMatch(detailsSource, /removeReaction|\?remove=/i);
});
