import assert from "node:assert/strict";
import test from "node:test";
import { runPoller } from "../src/poller/poller.js";

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

      if (calls === 1) throw new Error("temporary test error");
      shutdown.abort();
    },
    {
      intervals: { NORMAL: 1, PRE_WINDOW: 1, HOT: 1, POST_WINDOW: 1 },
      signal: shutdown.signal,
    },
  );

  assert.equal(calls, 2);
  assert.equal(maximumActive, 1);
  assert.equal(active, 0);
});
