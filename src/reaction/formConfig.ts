import type { BrowserContext } from "playwright";
import type { ReactionFormConfig } from "./types.js";

const FORM_CONFIG_PATH = "/portal/core/frontend/getformsubmitonlyconfiguration/format/json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReactionFormConfig(value: unknown): ReactionFormConfig {
  if (!isRecord(value) || !isRecord(value.form)) {
    throw new Error("MISSING_FORM_ID");
  }
  const formId = value.form.id;
  if (typeof formId !== "string" || formId.trim() === "") {
    throw new Error("MISSING_FORM_ID");
  }
  const elements = value.form.elements;
  if (!isRecord(elements) || !isRecord(elements.__hash__)) {
    throw new Error("MISSING_FORM_HASH");
  }
  const hash = elements.__hash__.initialData;
  if (typeof hash !== "string" || hash.trim() === "") {
    throw new Error("MISSING_FORM_HASH");
  }
  return { formId, hash };
}

export async function fetchReactionFormConfig(
  context: BrowserContext,
  baseUrl: string,
): Promise<ReactionFormConfig> {
  const endpoint = new URL(FORM_CONFIG_PATH, baseUrl).toString();
  const response = await context.request.get(endpoint, {
    failOnStatusCode: false,
    maxRedirects: 0,
  });
  if ([401, 403].includes(response.status())) {
    throw new Error("SESSION_EXPIRED");
  }
  if (!response.ok()) {
    throw new Error(`Form configuration GET failed with HTTP ${response.status()}.`);
  }
  const contentType = response.headers()["content-type"]?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    throw new Error("Form configuration GET did not return JSON.");
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error("Form configuration response contains invalid JSON.");
  }
  return parseReactionFormConfig(json);
}
