import assert from "node:assert/strict";
import test from "node:test";
import {
  mayCaptureResponseBody,
  sanitizeBody,
  sanitizeHeaders,
  sanitizeUrl,
} from "../src/capture/sanitize.js";

test("capture headers redact authentication and anti-forgery secrets", () => {
  const sanitized = sanitizeHeaders({
    cookie: "session=raw-secret",
    authorization: "Bearer raw-secret",
    "proxy-authorization": "Basic raw-secret",
    "x-csrf-token": "csrf-secret",
    "content-type": "application/json",
    "user-agent": "not selected",
  });

  assert.match(sanitized.cookie ?? "", /^\[REDACTED length=\d+\]$/);
  assert.match(sanitized.authorization ?? "", /^\[REDACTED length=\d+\]$/);
  assert.match(sanitized["proxy-authorization"] ?? "", /^\[REDACTED length=\d+\]$/);
  assert.match(sanitized["x-csrf-token"] ?? "", /^\[REDACTED length=\d+\]$/);
  assert.equal(sanitized["content-type"], "application/json");
  assert.equal(sanitized["user-agent"], undefined);
});

test("capture bodies recursively redact suspicious fields but retain identifiers", () => {
  const sanitized = sanitizeBody(
    JSON.stringify({
      advertentieId: "15001",
      nested: { csrfToken: "secret", password: "secret-password" },
    }),
    "application/json",
  );

  assert.deepEqual(sanitized, {
    advertentieId: "15001",
    nested: {
      csrfToken: "[REDACTED length=6]",
      password: "[REDACTED length=15]",
    },
  });
});

test("capture URLs redact secret query values", () => {
  const sanitized = sanitizeUrl("https://example.test/action?id=15001&access_token=secret");
  assert.match(sanitized, /id=15001/);
  assert.doesNotMatch(sanitized, /access_token=secret/);
  assert.match(sanitized, /REDACTED/);
});

test("URL-valued headers cannot leak query-string secrets", () => {
  const sanitized = sanitizeHeaders({
    referer: "https://example.test/page?id=15001&csrfToken=secret",
    location: "https://example.test/next?session=secret",
  });
  assert.match(sanitized.referer ?? "", /id=15001/);
  assert.doesNotMatch(sanitized.referer ?? "", /csrfToken=secret/);
  assert.doesNotMatch(sanitized.location ?? "", /session=secret/);
});

test("response body capture permits small JSON/text and rejects binary or large bodies", () => {
  assert.equal(mayCaptureResponseBody("application/json", 100), true);
  assert.equal(mayCaptureResponseBody("text/plain; charset=utf-8", 100), true);
  assert.equal(mayCaptureResponseBody("text/html", 100), false);
  assert.equal(mayCaptureResponseBody("application/octet-stream", 100), false);
  assert.equal(mayCaptureResponseBody("application/json", 1_000_000), false);
});
