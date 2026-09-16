import type { APIResponse, BrowserContext, Request, Response } from "playwright";
import { logger } from "../utils/logger.js";
import type { RawWoning } from "../woningen/types.js";

const AANBOD_API_PATH = "thuispoort-aanbodapi.zig365.nl/api/v1/actueel-aanbod";

export class SessionExpiredError extends Error {
  constructor(message = "SESSION/API PROFILE NOT AUTHENTICATED") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

interface AanbodPage {
  data: RawWoning[];
  metadata: { page: number; pageCount: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAanbodRequest(request: Request): boolean {
  return request.method() === "POST" && request.url().includes(AANBOD_API_PATH);
}

function isAuthenticated(data: RawWoning[]): boolean {
  return data.some((woning) => woning.reactionData?.loggedin === true);
}

async function parsePage(response: APIResponse | Response): Promise<AanbodPage> {
  if ([401, 403].includes(response.status())) {
    throw new SessionExpiredError();
  }
  if (!response.ok()) {
    throw new Error(`Actueel-aanbod request failed with HTTP ${response.status()}.`);
  }

  const contentType = response.headers()["content-type"]?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    if (contentType.includes("html")) {
      throw new SessionExpiredError();
    }
    throw new Error(`Expected a JSON response, received Content-Type: ${contentType || "unknown"}.`);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error("The actueel-aanbod response could not be parsed as JSON.");
  }

  if (!isRecord(json) || !Array.isArray(json.data)) {
    throw new Error("Unexpected actueel-aanbod response: data is not an array.");
  }
  const metadata = json._metadata;
  if (!isRecord(metadata)) {
    throw new Error("Unexpected actueel-aanbod response: _metadata is missing.");
  }

  const page = metadata.page;
  const pageCount = metadata.page_count;
  if (!Number.isInteger(page) || !Number.isInteger(pageCount) || Number(page) < 0 || Number(pageCount) < 1) {
    throw new Error("Unexpected actueel-aanbod response: invalid pagination metadata.");
  }

  return {
    data: json.data as RawWoning[],
    metadata: { page: Number(page), pageCount: Number(pageCount) },
  };
}

function nextPageUrl(capturedUrl: string, page: number): string {
  const url = new URL(capturedUrl);
  url.searchParams.set("page", String(page));
  return url.toString();
}

async function reusableHeaders(request: Request): Promise<Record<string, string>> {
  const headers = await request.allHeaders();
  delete headers["content-length"];
  delete headers.host;
  return headers;
}

function deduplicateById(woningen: RawWoning[]): RawWoning[] {
  const unique = new Map<string, RawWoning>();
  const missingId: RawWoning[] = [];

  for (const woning of woningen) {
    if (typeof woning.id === "string" || typeof woning.id === "number") {
      unique.set(String(woning.id), woning);
    } else {
      missingId.push(woning);
    }
  }
  return [...unique.values(), ...missingId];
}

/**
 * Consumes the frontend's initial search response, then repeats only that
 * read-only search POST for remaining pages. It never submits a reaction.
 */
export async function fetchActueelAanbod(
  context: BrowserContext,
  aanbodPageUrl: string,
): Promise<RawWoning[]> {
  const page = await context.newPage();
  try {
    const responsePromise = page.waitForResponse(
      (response) => isAanbodRequest(response.request()),
      { timeout: 45_000 },
    );

    logger.info("Opening Actueel aanbod...");
    await page.goto(aanbodPageUrl, { waitUntil: "domcontentloaded" });
    const frontendResponse = await responsePromise;
    const capturedRequest = frontendResponse.request();
    const postBody = capturedRequest.postData();
    if (postBody === null) {
      throw new Error("Captured actueel-aanbod POST request has no request body.");
    }
    try {
      JSON.parse(postBody);
    } catch {
      throw new Error("Captured actueel-aanbod POST body is not valid JSON.");
    }
    logger.info("Captured authenticated aanbod request");

    const first = await parsePage(frontendResponse);
    if (!isAuthenticated(first.data)) {
      throw new SessionExpiredError();
    }
    logger.info("API PROFILE: AUTHENTICATED");
    logger.info("SESSION: VALID");
    logger.info(`Fetching page ${first.metadata.page + 1}/${first.metadata.pageCount}...`);

    const all = [...first.data];
    const headers = await reusableHeaders(capturedRequest);
    for (
      let pageNumber = first.metadata.page + 1;
      pageNumber < first.metadata.pageCount;
      pageNumber += 1
    ) {
      logger.info(`Fetching page ${pageNumber + 1}/${first.metadata.pageCount}...`);
      const response = await context.request.post(nextPageUrl(capturedRequest.url(), pageNumber), {
        data: postBody,
        headers,
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      const result = await parsePage(response);
      if (result.data.length > 0 && !isAuthenticated(result.data)) {
        throw new SessionExpiredError();
      }
      all.push(...result.data);
    }

    return deduplicateById(all);
  } finally {
    await page.close();
  }
}
