import "dotenv/config";
import type { PollingIntervals } from "../scheduler/scheduler.js";

export interface LoginConfig {
  baseUrl: string;
  sessionCheckUrl: string;
}

export interface ScanConfig extends LoginConfig {
  aanbodPageUrl: string;
  pollingIntervals: PollingIntervals;
  autoSubmit: false;
  reactionInProgressStaleMs: number;
}

const MIN_POLL_INTERVAL_MS = 10_000;

function pollInterval(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a whole number of milliseconds.`);
  }

  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < MIN_POLL_INTERVAL_MS) {
    throw new Error(`${name} must be at least ${MIN_POLL_INTERVAL_MS}.`);
  }
  return milliseconds;
}

export function loadPollingIntervals(
  environment: NodeJS.ProcessEnv = process.env,
): PollingIntervals {
  return {
    NORMAL: pollInterval("POLL_NORMAL_MS", environment.POLL_NORMAL_MS, 300_000),
    PRE_WINDOW: pollInterval("POLL_PRE_WINDOW_MS", environment.POLL_PRE_WINDOW_MS, 60_000),
    HOT: pollInterval("POLL_HOT_MS", environment.POLL_HOT_MS, 20_000),
    POST_WINDOW: pollInterval("POLL_POST_WINDOW_MS", environment.POLL_POST_WINDOW_MS, 60_000),
  };
}

export function loadAutoSubmit(value = process.env.AUTO_SUBMIT): false {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "" || normalized === "false") return false;
  if (normalized === "true") {
    throw new Error(
      "AUTO_SUBMIT=true detected\nAutomatic submission is not enabled in Stage 5.2\nABORT",
    );
  }
  throw new Error("AUTO_SUBMIT must be false in Stage 5.2.");
}

export function loadReactionInProgressStaleMs(
  value = process.env.REACTION_IN_PROGRESS_STALE_MS,
): number {
  if (value === undefined || value.trim() === "") return 15 * 60 * 1000;
  if (!/^\d+$/.test(value)) throw new Error("REACTION_IN_PROGRESS_STALE_MS must be milliseconds.");
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 60_000) {
    throw new Error("REACTION_IN_PROGRESS_STALE_MS must be at least 60000.");
  }
  return milliseconds;
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
    pollingIntervals: loadPollingIntervals(),
    autoSubmit: loadAutoSubmit(),
    reactionInProgressStaleMs: loadReactionInProgressStaleMs(),
  };
}
