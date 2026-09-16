import "dotenv/config";

export interface LoginConfig {
  baseUrl: string;
  sessionCheckUrl: string;
}

export interface ScanConfig extends LoginConfig {
  aanbodPageUrl: string;
}

function requiredUrl(name: string, value: string | undefined): string {
  if (!value || value.startsWith("<")) {
    throw new Error(`${name} is not configured. Copy .env.example to .env and set it.`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL.`);
  }

  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error(`${name} must use HTTPS (except for localhost development).`);
  }
  return url.toString();
}

export function loadLoginConfig(): LoginConfig {
  const baseUrl = requiredUrl("THUISPOORT_BASE_URL", process.env.THUISPOORT_BASE_URL);
  const sessionCheckUrl = process.env.THUISPOORT_SESSION_CHECK_URL
    ? requiredUrl("THUISPOORT_SESSION_CHECK_URL", process.env.THUISPOORT_SESSION_CHECK_URL)
    : baseUrl;
  return { baseUrl, sessionCheckUrl };
}

export function loadScanConfig(): ScanConfig {
  const { baseUrl, sessionCheckUrl } = loadLoginConfig();
  return {
    baseUrl,
    sessionCheckUrl,
    aanbodPageUrl: process.env.THUISPOORT_AANBOD_PAGE_URL
      ? requiredUrl("THUISPOORT_AANBOD_PAGE_URL", process.env.THUISPOORT_AANBOD_PAGE_URL)
      : new URL("/aanbod/te-huur", baseUrl).toString(),
  };
}
