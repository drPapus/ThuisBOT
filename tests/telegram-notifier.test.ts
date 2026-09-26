import assert from "node:assert/strict";
import test from "node:test";
import {
  loadTelegramNotifierConfig,
  sendTelegramNotification,
} from "../src/notifications/telegramNotifier.js";

test("loads Telegram configuration from supplied environment", () => {
  const config = loadTelegramNotifierConfig({
    TELEGRAM_BOT_TOKEN: " test-token ",
    TELEGRAM_CHAT_ID: " 123456 ",
  });

  assert.deepEqual(config, {
    token: "test-token",
    chatId: "123456",
  });
});

test("missing Telegram configuration fails closed without calling fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;

  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("fetch must not be called");
  };

  try {
    const sent = await sendTelegramNotification("test", {
      token: undefined,
      chatId: undefined,
    });

    assert.equal(sent, false);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Telegram network failure does not throw", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    throw new Error("simulated network failure");
  };

  try {
    const sent = await sendTelegramNotification("test", {
      token: "fake-token",
      chatId: "123456",
    });

    assert.equal(sent, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("successful Telegram response returns true", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });

  try {
    const sent = await sendTelegramNotification("test", {
      token: "fake-token",
      chatId: "123456",
    });

    assert.equal(sent, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
