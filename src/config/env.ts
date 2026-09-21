import "dotenv/config";
import type { PollingIntervals } from "../scheduler/scheduler.js";
import {
  DEFAULT_MAX_LIVE_ATTEMPTS_PER_RUN,
  DEFAULT_MIN_LIVE_SUBMIT_INTERVAL_MS,
  HARD_MAX_LIVE_ATTEMPTS_PER_RUN,
} from "../reaction/liveSafety.js";

export interface LoginConfig {
  baseUrl: string;
  sessionCheckUrl: string;
}

export interface ScanConfig extends LoginConfig {
  aanbodPageUrl: string;
  pollingIntervals: PollingIntervals;
  autoSubmit: boolean;
  reactionInProgressStaleMs: number;
  maxLiveSubmitsPerRun: number;
  minLiveSubmitIntervalMs: number;
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

export function loadAutoSubmit(value = process.env.AUTO_SUBMIT): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "" || normalized === "false") return false;
  if (normalized === "true") return true;
  throw new Error("AUTO_SUBMIT must be true or false.");
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

function boundedWholeNumber(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum?: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a whole number.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || (maximum !== undefined && parsed > maximum)) {
    throw new Error(`${name} must be between ${minimum} and ${maximum ?? "the safe integer limit"}.`);
  }
  return parsed;
}

export function loadMaxLiveSubmitsPerRun(value = process.env.MAX_LIVE_SUBMITS_PER_RUN): number {
  return boundedWholeNumber(
    "MAX_LIVE_SUBMITS_PER_RUN", value, DEFAULT_MAX_LIVE_ATTEMPTS_PER_RUN, 1,
    HARD_MAX_LIVE_ATTEMPTS_PER_RUN,
  );
}

export function loadMinLiveSubmitIntervalMs(value = process.env.MIN_LIVE_SUBMIT_INTERVAL_MS): number {
  return boundedWholeNumber(
    "MIN_LIVE_SUBMIT_INTERVAL_MS", value, DEFAULT_MIN_LIVE_SUBMIT_INTERVAL_MS, 0,
  );
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
    maxLiveSubmitsPerRun: loadMaxLiveSubmitsPerRun(),
    minLiveSubmitIntervalMs: loadMinLiveSubmitIntervalMs(),
  };
}
