import type { APIResponse, BrowserContext } from "playwright";
import type { DwellingReactionInput, PreparationFailureReason } from "./types.js";

export const GETOBJECT_PATH = "/portal/object/frontend/getobject/format/json" as const;

export class DwellingDetailsError extends Error {
  constructor(public readonly reason: PreparationFailureReason) {
    super(reason);
    this.name = "DwellingDetailsError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown): string | number | undefined {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
    ? value
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function parseDwellingReactionDetails(
  value: unknown,
  requestedDwellingId: string,
): DwellingReactionInput {
  if (!isRecord(value) || !isRecord(value.result)) {
    throw new DwellingDetailsError("UNEXPECTED_REACTION_STATE");
  }

  const result = value.result;
  const reaction = result.reactionData;
  if (!isRecord(reaction)) {
    throw new DwellingDetailsError("UNEXPECTED_REACTION_STATE");
  }
  const dwellingId = identifier(result.id);
  if (dwellingId === undefined) {
    throw new DwellingDetailsError("UNEXPECTED_REACTION_STATE");
  }
  if (String(dwellingId) !== requestedDwellingId) {
    throw new DwellingDetailsError("DWELLING_ID_MISMATCH");
  }

  const assignmentId = identifier(result.assignmentID);
  const closingDate = text(result.closingDate);
  const isPassend = boolean(reaction.isPassend);
  const kanReageren = boolean(reaction.kanReageren);
  const loggedIn = boolean(reaction.loggedin);
  const action = text(reaction.action);
  const label = text(reaction.label);
  const reactionUrl = text(reaction.url);
  return {
    dwellingId,
    ...(assignmentId !== undefined && { assignmentId }),
    ...(closingDate !== undefined && { closingDate }),
    ...(isPassend !== undefined && { isPassend }),
    ...(kanReageren !== undefined && { kanReageren }),
    ...(loggedIn !== undefined && { loggedIn }),
    ...(action !== undefined && { action }),
    ...(label !== undefined && { label }),
    ...(reactionUrl !== undefined && { reactionUrl }),
  };
}

async function parseJsonResponse(
  response: APIResponse,
  requestedDwellingId: string,
): Promise<DwellingReactionInput> {
  const location = response.headers()["location"] ?? "";
  if (
    [401, 403].includes(response.status()) ||
    /(?:login|inloggen|signin|auth)/i.test(location)
  ) {
    throw new DwellingDetailsError("SESSION_EXPIRED");
  }
  if (!response.ok()) {
    throw new DwellingDetailsError("UNEXPECTED_REACTION_STATE");
  }
  const contentType = response.headers()["content-type"]?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    throw new DwellingDetailsError(
      contentType.includes("html") ? "SESSION_EXPIRED" : "UNEXPECTED_REACTION_STATE",
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new DwellingDetailsError("UNEXPECTED_REACTION_STATE");
  }
  return parseDwellingReactionDetails(json, requestedDwellingId);
}

export async function fetchDwellingReactionDetails(
  context: BrowserContext,
  baseUrl: string,
  dwellingId: string,
): Promise<DwellingReactionInput> {
  const endpoint = new URL(GETOBJECT_PATH, baseUrl).toString();

  // VERIFIED READ-ONLY DATA FETCH.
  // This POST retrieves dwelling details. It is NOT the reaction submission endpoint.
  const response = await context.request.post(endpoint, {
    data: new URLSearchParams({ id: dwellingId }).toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
    },
    failOnStatusCode: false,
    maxRedirects: 0,
  });
  return parseJsonResponse(response, dwellingId);
}
