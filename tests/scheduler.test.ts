import assert from "node:assert/strict";
import test from "node:test";
import { loadPollingIntervals } from "../src/config/env.js";
import {
  calculateNextDelay,
  determinePollingMode,
  getNextBoundary,
  type PollingIntervals,
} from "../src/scheduler/scheduler.js";

const intervals: PollingIntervals = {
  NORMAL: 300_000,
  PRE_WINDOW: 60_000,
  HOT: 20_000,
  POST_WINDOW: 60_000,
};

// Explicit +02:00 dates make these Amsterdam summer wall-clock cases independent of host TZ.
const summer = (time: string): Date => new Date(`2026-09-17T${time}+02:00`);

test("selects each mode at its exact Amsterdam boundaries", () => {
  const cases: Array<[string, ReturnType<typeof determinePollingMode>]> = [
    ["11:00:00", "NORMAL"],
    ["11:49:59", "NORMAL"],
    ["11:50:00", "PRE_WINDOW"],
    ["11:59:59", "PRE_WINDOW"],
    ["12:00:00", "HOT"],
    ["12:19:59", "HOT"],
    ["12:20:00", "POST_WINDOW"],
    ["12:39:59", "POST_WINDOW"],
    ["12:40:00", "NORMAL"],
    ["15:00:00", "NORMAL"],
  ];
  for (const [time, expected] of cases) {
    assert.equal(determinePollingMode(summer(time)), expected, time);
  }
});

test("caps sleeps at upcoming scheduler boundaries", () => {
  assert.equal(calculateNextDelay(summer("11:49:50"), intervals).delayMs, 10_000);
  assert.equal(calculateNextDelay(summer("11:59:50"), intervals).delayMs, 10_000);
  assert.equal(calculateNextDelay(summer("12:19:50"), intervals).delayMs, 10_000);
  assert.equal(calculateNextDelay(summer("12:00:05"), intervals).delayMs, 20_000);
});

test("next boundary reports the mode entered", () => {
  const boundary = getNextBoundary(summer("11:49:50"));
  assert.equal(boundary.nextMode, "PRE_WINDOW");
  assert.equal(boundary.at.toISOString(), "2026-09-17T09:50:00.000Z");
});

test("Europe/Amsterdam conversion handles both CET and CEST", () => {
  // The same UTC hour maps to different Amsterdam wall-clock hours by season.
  assert.equal(determinePollingMode(new Date("2026-01-15T10:50:00Z")), "PRE_WINDOW");
  assert.equal(determinePollingMode(new Date("2026-07-15T09:50:00Z")), "PRE_WINDOW");

  const winterBoundary = getNextBoundary(new Date("2026-01-15T10:49:50Z"));
  const summerBoundary = getNextBoundary(new Date("2026-07-15T09:49:50Z"));
  assert.equal(winterBoundary.at.toISOString(), "2026-01-15T10:50:00.000Z");
  assert.equal(summerBoundary.at.toISOString(), "2026-07-15T09:50:00.000Z");
});

test("poll interval defaults and overrides are validated", () => {
  assert.deepEqual(loadPollingIntervals({}), intervals);
  assert.equal(loadPollingIntervals({ POLL_HOT_MS: "25000" }).HOT, 25_000);
  for (const value of ["0", "-100", "abc", "9999", "NaN"]) {
    assert.throws(() => loadPollingIntervals({ POLL_HOT_MS: value }), /POLL_HOT_MS/);
  }
});
