import assert from "node:assert/strict";
import test from "node:test";
import { runPoller } from "../src/poller/poller.js";

const FAST_INTERVALS = {
  NORMAL: 1,
  PRE_WINDOW: 1,
  HOT: 1,
  POST_WINDOW: 1,
};

test("poller retries errors, never overlaps, and stops after abort", async () => {
  const shutdown = new AbortController();

  let calls = 0;
  let active = 0;
  let maximumActive = 0;

  await runPoller(
    async () => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);

      await new Promise((resolve) => setTimeout(resolve, 5));

      active -= 1;

      if (calls === 1) {
        throw new Error("temporary test error");
      }

      shutdown.abort();
      return { status: "OK" as const };
    },
    {
      intervals: FAST_INTERVALS,
      signal: shutdown.signal,
    },
  );

  assert.equal(calls, 2);
  assert.equal(maximumActive, 1);
  assert.equal(active, 0);
});

test("AUTH_REQUIRED enters AUTH-WAIT and does not run normal scans while expired", async () => {
  const shutdown = new AbortController();

  let scanCalls = 0;
  let authChecks = 0;
  let authRequiredCalls = 0;

  await runPoller(
    async () => {
      scanCalls += 1;
      return { status: "AUTH_REQUIRED" as const };
    },
    {
      intervals: FAST_INTERVALS,
      signal: shutdown.signal,
      authRetryIntervalMs: 1,

      onAuthRequired: async () => {
        authRequiredCalls += 1;
      },

      checkAuth: async () => {
        authChecks += 1;

        if (authChecks === 3) {
          shutdown.abort();
        }

        return "EXPIRED";
      },
    },
  );

  assert.equal(scanCalls, 1);
  assert.equal(authChecks, 3);
  assert.equal(authRequiredCalls, 1);
});

test("AUTH_REQUIRED notifies once, restores once, then resumes normal scanning", async () => {
  const shutdown = new AbortController();

  let scanCalls = 0;
  let authChecks = 0;
  let authRequiredCalls = 0;
  let authRestoredCalls = 0;

  await runPoller(
    async () => {
      scanCalls += 1;

      if (scanCalls === 1) {
        return { status: "AUTH_REQUIRED" as const };
      }

      shutdown.abort();
      return { status: "OK" as const };
    },
    {
      intervals: FAST_INTERVALS,
      signal: shutdown.signal,
      authRetryIntervalMs: 1,

      onAuthRequired: async () => {
        authRequiredCalls += 1;
      },

      checkAuth: async () => {
        authChecks += 1;

        if (authChecks < 3) {
          return "EXPIRED";
        }

        return "VALID";
      },

      onAuthRestored: async () => {
        authRestoredCalls += 1;
      },
    },
  );

  assert.equal(scanCalls, 2);
  assert.equal(authChecks, 3);
  assert.equal(authRequiredCalls, 1);
  assert.equal(authRestoredCalls, 1);
});

test("session checker errors stay fail-closed in AUTH-WAIT", async () => {
  const shutdown = new AbortController();

  let scanCalls = 0;
  let authChecks = 0;
  let authRequiredCalls = 0;

  await runPoller(
    async () => {
      scanCalls += 1;
      return { status: "AUTH_REQUIRED" as const };
    },
    {
      intervals: FAST_INTERVALS,
      signal: shutdown.signal,
      authRetryIntervalMs: 1,

      onAuthRequired: async () => {
        authRequiredCalls += 1;
      },

      checkAuth: async () => {
        authChecks += 1;

        if (authChecks === 3) {
          shutdown.abort();
        }

        throw new Error("temporary session-check failure");
      },
    },
  );

  assert.equal(scanCalls, 1);
  assert.equal(authChecks, 3);
  assert.equal(authRequiredCalls, 1);
});

test("abort during AUTH-WAIT stops without another session check", async () => {
  const shutdown = new AbortController();

  let scanCalls = 0;
  let authChecks = 0;

  await runPoller(
    async () => {
      scanCalls += 1;
      return { status: "AUTH_REQUIRED" as const };
    },
    {
      intervals: FAST_INTERVALS,
      signal: shutdown.signal,
      authRetryIntervalMs: 50,

      onAuthRequired: async () => {
        shutdown.abort();
      },

      checkAuth: async () => {
        authChecks += 1;
        return "EXPIRED";
      },
    },
  );

  assert.equal(scanCalls, 1);
  assert.equal(authChecks, 0);
});
