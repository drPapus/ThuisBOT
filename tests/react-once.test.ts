import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { BrowserContext } from "playwright";
import { formatLiveConfirmation } from "../src/reaction/liveReporter.js";
import type {
  LiveReactionDependencies,
  SubmissionResult,
} from "../src/reaction/liveTypes.js";
import { runReactOnceFlow } from "../src/reaction/reactOnceFlow.js";
import { submitPreparedReactionOnce } from "../src/reaction/submitReaction.js";
import {
  acquireReactionSubmissionLock,
  ReactionSubmissionLockedError,
} from "../src/reaction/submissionLock.js";
import type {
  DwellingReactionInput,
  PreparedReaction,
  ReactionFormConfig,
} from "../src/reaction/types.js";

const dwellingId = "TEST-LIVE-DWELLING";
const addDetails: DwellingReactionInput = {
  dwellingId,
  assignmentId: "TEST-ASSIGNMENT",
  isPassend: true,
  kanReageren: true,
  loggedIn: true,
  action: "add",
  label: "Reageer",
  reactionUrl: `?add=TEST-ASSIGNMENT&dwellingID=${dwellingId}`,
  closingDate: "2099-01-01T00:00:00Z",
};
const removeDetails: DwellingReactionInput = {
  ...addDetails,
  action: "remove",
  label: "Verwijder reactie",
  reactionUrl: `?remove=TEST-REACTION&dwellingID=${dwellingId}`,
};
const formOne: ReactionFormConfig = { formId: "Portal_Form_SubmitOnly", hash: "fresh-hash-one" };
const formTwo: ReactionFormConfig = { formId: "Portal_Form_SubmitOnly", hash: "fresh-hash-two" };

interface Harness {
  dependencies: LiveReactionDependencies;
  counts: { details: number; forms: number; confirmations: number; submissions: number };
  submitted: PreparedReaction[];
}

function harness(options: {
  present?: boolean;
  details?: DwellingReactionInput[];
  confirmation?: string;
  submission?: SubmissionResult;
} = {}): Harness {
  const details = [...(options.details ?? [addDetails, addDetails, removeDetails])];
  const counts = { details: 0, forms: 0, confirmations: 0, submissions: 0 };
  const submitted: PreparedReaction[] = [];
  return {
    counts,
    submitted,
    dependencies: {
      isPresentInAanbod: async () => options.present ?? true,
      fetchDetails: async () => {
        counts.details += 1;
        return details.shift() ?? details.at(-1) ?? addDetails;
      },
      fetchForm: async () => {
        counts.forms += 1;
        return counts.forms === 1 ? formOne : formTwo;
      },
      confirm: async () => {
        counts.confirmations += 1;
        return options.confirmation ?? `REACT ${dwellingId}`;
      },
      submit: async (prepared) => {
        counts.submissions += 1;
        submitted.push(prepared);
        return options.submission ?? { ok: true, reactionId: "TEST-REACTION" };
      },
      now: () => new Date("2026-09-17T10:00:00Z"),
    },
  };
}

test("missing or absent dwelling never reaches submission", async () => {
  for (const [id, present] of [["", true], [dwellingId, false]] as const) {
    const testHarness = harness({ present });
    const result = await runReactOnceFlow(id, testHarness.dependencies);
    assert.deepEqual(result, { status: "PREPARATION_FAILED", reason: "MISSING_DWELLING_ID" });
    assert.equal(testHarness.counts.submissions, 0);
  }
});

test("all pre-confirmation safety failures prevent submission", async () => {
  const cases: Array<[Partial<DwellingReactionInput>, string]> = [
    [{ isPassend: false }, "NOT_PASSEND"],
    [{ kanReageren: false }, "CANNOT_REACT"],
    [{ action: "remove", label: "Verwijder reactie" }, "ALREADY_REACTED"],
    [{ assignmentId: undefined }, "MISSING_ASSIGNMENT_ID"],
    [{ reactionUrl: `?add=WRONG&dwellingID=${dwellingId}` }, "REACTION_URL_MISMATCH"],
  ];
  for (const [change, expected] of cases) {
    const testHarness = harness({ details: [{ ...addDetails, ...change }] });
    const result = await runReactOnceFlow(dwellingId, testHarness.dependencies);
    assert.equal(result.status, "PREPARATION_FAILED");
    if (result.status === "PREPARATION_FAILED") assert.equal(result.reason, expected);
    assert.equal(testHarness.counts.submissions, 0);
  }
});

test("incorrect confirmation cancels, exact ID-bound phrase permits progression", async () => {
  for (const phrase of ["", "y", "yes", "REACT", "REACT WRONG-ID", ` REACT ${dwellingId}`, `REACT ${dwellingId} `]) {
    const testHarness = harness({ confirmation: phrase });
    assert.deepEqual(await runReactOnceFlow(dwellingId, testHarness.dependencies), {
      status: "REACTION_CANCELLED",
    });
    assert.equal(testHarness.counts.submissions, 0);
  }

  const accepted = harness();
  const result = await runReactOnceFlow(dwellingId, accepted.dependencies);
  assert.equal(result.status, "REACTION_PLACED");
  assert.equal(accepted.counts.submissions, 1);
});

test("live flow requires an explicitly authenticated authoritative state", async () => {
  for (const loggedIn of [false, undefined]) {
    const details = { ...addDetails };
    if (loggedIn === undefined) delete details.loggedIn;
    else details.loggedIn = loggedIn;
    const testHarness = harness({ details: [details] });
    const result = await runReactOnceFlow(dwellingId, testHarness.dependencies);
    assert.equal(result.status, "PREPARATION_FAILED");
    assert.equal(testHarness.counts.submissions, 0);
  }
});

test("final state is revalidated and fresh form hash is used", async () => {
  for (const finalChange of [
    { action: "remove", label: "Verwijder reactie" },
    { isPassend: false },
    { kanReageren: false },
  ]) {
    const testHarness = harness({ details: [addDetails, { ...addDetails, ...finalChange }] });
    const result = await runReactOnceFlow(dwellingId, testHarness.dependencies);
    assert.equal(result.status, "PREPARATION_FAILED");
    assert.equal(testHarness.counts.submissions, 0);
  }

  const success = harness();
  await runReactOnceFlow(dwellingId, success.dependencies);
  assert.equal(success.counts.forms, 2);
  assert.equal(success.submitted[0]?.formHash, "fresh-hash-two");
});

test("successful submit verifies remove state; add state fails verification without retry", async () => {
  const success = harness();
  assert.deepEqual(await runReactOnceFlow(dwellingId, success.dependencies), {
    status: "REACTION_PLACED",
    reactionId: "TEST-REACTION",
    authoritativeAction: "remove",
  });
  assert.equal(success.counts.submissions, 1);

  const failed = harness({ details: [addDetails, addDetails, addDetails] });
  assert.deepEqual(await runReactOnceFlow(dwellingId, failed.dependencies), {
    status: "REACTION_VERIFICATION_FAILED",
    reactionId: "TEST-REACTION",
  });
  assert.equal(failed.counts.submissions, 1);
});

function prepared(): PreparedReaction {
  return {
    method: "POST",
    contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    dwellingId,
    assignmentId: "TEST-ASSIGNMENT",
    formId: "Portal_Form_SubmitOnly",
    formHash: "TEST-FRESH-HASH",
    isPassend: true,
    kanReageren: true,
    loggedIn: true,
    action: "add",
  };
}

function submissionContext(responseFactory: () => unknown): { context: BrowserContext; calls: Array<{ url: string; options: Record<string, unknown> }> } {
  const calls: Array<{ url: string; options: Record<string, unknown> }> = [];
  return {
    calls,
    context: {
      request: {
        post: async (url: string, options: Record<string, unknown>) => {
          calls.push({ url, options });
          const response = responseFactory();
          if (response instanceof Error) throw response;
          return response;
        },
      },
    } as unknown as BrowserContext,
  };
}

test("submission sends exact body once and validates success", async () => {
  const mock = submissionContext(() => ({
    ok: () => true,
    json: async () => ({ success: true, reactionId: 123, reactionData: { action: "remove" } }),
  }));
  assert.deepEqual(
    await submitPreparedReactionOnce(mock.context, "https://www.thuispoort.nl/", prepared()),
    { ok: true, reactionId: 123, serverAction: "remove" },
  );
  assert.equal(mock.calls.length, 1);
  assert.equal(
    mock.calls[0]?.url,
    "https://www.thuispoort.nl/portal/object/frontend/react/format/json",
  );
  const body = new URLSearchParams(String(mock.calls[0]?.options.data));
  assert.deepEqual([...body.keys()], ["__id__", "__hash__", "add", "dwellingID"]);
});

test("rejected, missing ID, malformed JSON, HTTP failure, and network errors never retry", async () => {
  const factories = [
    () => ({ ok: () => true, json: async () => ({ success: false }) }),
    () => ({ ok: () => true, json: async () => ({ success: true }) }),
    () => ({ ok: () => true, json: async () => Promise.reject(new SyntaxError("bad JSON")) }),
    () => ({ ok: () => false, json: async () => ({}) }),
    () => new Error("connection reset"),
  ];
  for (const factory of factories) {
    const mock = submissionContext(factory);
    const result = await submitPreparedReactionOnce(
      mock.context,
      "https://www.thuispoort.nl/",
      prepared(),
    );
    assert.equal(result.ok, false);
    assert.equal(mock.calls.length, 1);
  }
});

test("live preview never exposes the form hash", () => {
  const output = formatLiveConfirmation(prepared());
  assert.doesNotMatch(output, /TEST-FRESH-HASH/);
  assert.match(output, /__hash__=\[REDACTED\]/);
  assert.match(output, new RegExp(`REACT ${dwellingId}`));
});

test("local submission lock blocks a concurrent process", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "thuispoort-reaction-lock-"));
  const lockPath = path.join(directory, "reaction.lock");
  const first = await acquireReactionSubmissionLock(lockPath);
  await assert.rejects(
    acquireReactionSubmissionLock(lockPath),
    (error: unknown) => error instanceof ReactionSubmissionLockedError,
  );
  await first.release();
  const next = await acquireReactionSubmissionLock(lockPath);
  await next.release();
});

test("live submission remains isolated from scanner, poller, and dry-run CLI", async () => {
  const reactionDirectory = path.resolve("src", "reaction");
  const reactionFiles = [
    "submitReaction.ts",
    "prepareReaction.ts",
    "prepareReactionCli.ts",
    "reactOnceCli.ts",
    "reactOnceFlow.ts",
    "submissionLock.ts",
  ];
  const sources = new Map(
    await Promise.all(
      reactionFiles.map(async (file) => [file, await readFile(path.join(reactionDirectory, file), "utf8")] as const),
    ),
  );
  const endpoint = "/portal/object/frontend/react/format/json";
  const endpointOwners = [...sources.entries()].filter(([, source]) => source.includes(endpoint));
  assert.deepEqual(endpointOwners.map(([file]) => file), ["submitReaction.ts"]);
  assert.equal((sources.get("submitReaction.ts")?.match(/context\.request\.post\s*\(/g) ?? []).length, 1);
  assert.doesNotMatch(sources.get("submitReaction.ts") ?? "", /\b(?:for|while)\s*\(/);
  assert.doesNotMatch(sources.get("prepareReactionCli.ts") ?? "", /submitReaction|reactOnce/i);
  assert.doesNotMatch([...sources.values()].join("\n"), /removeReaction|cancelReaction|withdrawReaction/i);

  for (const file of ["src/scanner/scan.ts", "src/index.ts", "src/poller/poller.ts"]) {
    assert.doesNotMatch(await readFile(path.resolve(file), "utf8"), /submitReaction|react-once|reactOnce/i);
  }
});
