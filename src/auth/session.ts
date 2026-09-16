import type { APIResponse, BrowserContext } from "playwright";

export type SessionStatus = "VALID" | "EXPIRED";

const AUTH_PATH_PATTERN = /\/(?:login|inloggen|signin|auth)(?:[/?#]|$)/i;

function redirectIsAuthentication(response: APIResponse): boolean {
  const location = response.headers()["location"];
  return Boolean(location && AUTH_PATH_PATTERN.test(location));
}

export async function validateSession(
  context: BrowserContext,
  sessionCheckUrl: string,
): Promise<SessionStatus> {
  const response = await context.request.get(sessionCheckUrl, {
    failOnStatusCode: false,
    maxRedirects: 0,
  });

  if ([401, 403].includes(response.status()) || redirectIsAuthentication(response)) {
    return "EXPIRED";
  }

  if (!response.ok()) {
    throw new Error(`Session check failed with HTTP ${response.status()}.`);
  }

  const contentType = response.headers()["content-type"]?.toLowerCase() ?? "";
  if (contentType.includes("text/html")) {
    const body = (await response.text()).slice(0, 20_000);
    if (AUTH_PATH_PATTERN.test(response.url()) || /(?:name=["']password|inloggen)/i.test(body)) {
      return "EXPIRED";
    }
  }

  return "VALID";
}
