import type { BrowserContext } from "playwright";
import { encodePreparedReaction } from "./prepareReaction.js";
import type { SubmissionResult } from "./liveTypes.js";
import type { PreparedReaction } from "./types.js";

const REACTION_ENDPOINT = "/portal/object/frontend/react/format/json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exactly one state-changing request. There is deliberately no retry path. */
export async function submitPreparedReactionOnce(
  context: BrowserContext,
  baseUrl: string,
  prepared: PreparedReaction,
): Promise<SubmissionResult> {
  let response;
  try {
    response = await context.request.post(new URL(REACTION_ENDPOINT, baseUrl).toString(), {
      data: encodePreparedReaction(prepared),
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
      },
      failOnStatusCode: false,
      maxRedirects: 0,
    });
  } catch {
    return { ok: false, outcome: "REACTION_OUTCOME_UNKNOWN" };
  }

  if (!response.ok()) return { ok: false, outcome: "REACTION_OUTCOME_UNKNOWN" };

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, outcome: "REACTION_OUTCOME_UNKNOWN" };
  }
  if (!isRecord(json) || json.success !== true) {
    return { ok: false, outcome: "REACTION_REJECTED" };
  }
  if (typeof json.reactionId !== "string" && typeof json.reactionId !== "number") {
    return { ok: false, outcome: "REACTION_OUTCOME_UNKNOWN" };
  }

  const reactionData = json.reactionData;
  if (reactionData !== undefined) {
    if (!isRecord(reactionData) || reactionData.action !== "remove") {
      return { ok: false, outcome: "REACTION_OUTCOME_UNKNOWN" };
    }
  }
  return {
    ok: true,
    reactionId: json.reactionId,
    ...(isRecord(reactionData) && typeof reactionData.action === "string"
      ? { serverAction: reactionData.action }
      : {}),
  };
}
