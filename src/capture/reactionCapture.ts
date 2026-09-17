import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { chromium, type Browser, type Request } from "playwright";
import { STORAGE_STATE_PATH, storageStateExists } from "../auth/storage.js";
import { logger } from "../utils/logger.js";
import {
  mayCaptureResponseBody,
  sanitizeBody,
  sanitizeHeaders,
  sanitizeUrl,
} from "./sanitize.js";
import type { CaptureRecord, CaptureRequestRecord, CaptureResponseRecord } from "./types.js";

const START_URL = "https://www.thuispoort.nl/";
const CAPTURES_DIRECTORY = path.resolve("captures");
const OBSERVED_RESOURCE_TYPES = new Set(["fetch", "xhr", "document"]);
const NOISE_URL = /(?:google-analytics|googletagmanager|doubleclick|analytics|clarity\.ms|hotjar|facebook\.com\/tr)/i;

function captureFileName(): string {
  return `reaction-capture-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
}

function shouldObserve(request: Request): boolean {
  return OBSERVED_RESOURCE_TYPES.has(request.resourceType()) && !NOISE_URL.test(request.url());
}

function printRecord(record: CaptureRecord): void {
  console.log(`\n[${new Date(record.timestamp).toLocaleTimeString("nl-NL", {
    timeZone: "Europe/Amsterdam",
    hour12: false,
  })}] ${record.kind.toUpperCase()}`);

  if (record.kind === "request") {
    console.log(`${record.method} ${record.url}`);
    console.log(`Resource: ${record.resourceType}`);
    if (record.contentType) console.log(`Content-Type: ${record.contentType}`);
  } else {
    console.log(record.url);
    console.log(`Status: ${record.status}`);
    if (record.contentType) console.log(`Content-Type: ${record.contentType}`);
  }
  if (Object.keys(record.headers).length > 0) {
    console.log("Headers:");
    console.dir(record.headers, { depth: 3 });
  }
  if (record.body !== undefined) {
    console.log("Body:");
    console.dir(record.body, { depth: 8, maxArrayLength: 100 });
  }
}

async function waitForManualStop(browser: Browser): Promise<void> {
  const prompt = createInterface({ input: stdin, output: stdout });
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const onSignal = (): void => {
    logger.info("Capture shutdown requested...");
    finish();
  };
  browser.once("disconnected", finish);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  void prompt.question("Press Enter when manual capture is complete... ").then(finish).catch(finish);

  await stopped;
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  prompt.close();
}

async function main(): Promise<void> {
  if (!(await storageStateExists())) {
    throw new Error("Authentication state is missing. Run: npm run login");
  }

  await mkdir(CAPTURES_DIRECTORY, { recursive: true, mode: 0o700 });
  const capturePath = path.join(CAPTURES_DIRECTORY, captureFileName());
  const browser = await chromium.launch({ headless: false });
  let writeQueue = Promise.resolve();
  let nextRequestId = 1;
  const observedRequests = new WeakMap<Request, number>();
  const pendingCaptures = new Set<Promise<void>>();

  const track = (task: Promise<void>, label: string): void => {
    pendingCaptures.add(task);
    void task
      .catch((error: unknown) => logger.error(`${label} capture failed: ${String(error)}`))
      .finally(() => pendingCaptures.delete(task));
  };

  const write = (record: CaptureRecord): void => {
    printRecord(record);
    writeQueue = writeQueue
      .then(() => appendFile(capturePath, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      }))
      .catch((error: unknown) => {
        logger.error(`Could not write sanitized capture: ${String(error)}`);
      });
  };

  try {
    const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });

    context.on("request", (request) => {
      if (!shouldObserve(request)) return;
      const id = nextRequestId;
      nextRequestId += 1;
      observedRequests.set(request, id);

      const task = (async () => {
        const headers = sanitizeHeaders(await request.allHeaders());
        const contentType = headers["content-type"];
        const postData = request.postData();
        const record: CaptureRequestRecord = {
          kind: "request",
          id,
          timestamp: new Date().toISOString(),
          method: request.method(),
          url: sanitizeUrl(request.url()),
          resourceType: request.resourceType(),
          headers,
          ...(contentType !== undefined && { contentType }),
          ...(postData !== null && { body: sanitizeBody(postData, contentType ?? "text/plain") }),
        };
        write(record);
      })();
      track(task, "Request");
    });

    context.on("response", (response) => {
      const requestId = observedRequests.get(response.request());
      if (requestId === undefined) return;

      const task = (async () => {
        const rawHeaders = await response.allHeaders();
        const headers = sanitizeHeaders(rawHeaders);
        const contentType = headers["content-type"] ?? "";
        const contentLengthHeader = rawHeaders["content-length"];
        const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
        let body: unknown;
        if (mayCaptureResponseBody(contentType, contentLength)) {
          try {
            body = sanitizeBody(await response.text(), contentType);
          } catch {
            body = "[RESPONSE BODY UNAVAILABLE]";
          }
        }

        const record: CaptureResponseRecord = {
          kind: "response",
          requestId,
          timestamp: new Date().toISOString(),
          url: sanitizeUrl(response.url()),
          status: response.status(),
          headers,
          ...(contentType !== "" && { contentType }),
          ...(body !== undefined && { body }),
        };
        write(record);
      })();
      track(task, "Response");
    });

    logger.info("MANUAL CAPTURE MODE");
    logger.info("HUMAN SENDS → BOT OBSERVES");
    logger.info("Navigate and react manually. This script performs no clicks or submissions.");
    logger.info(`Sanitized capture file: ${capturePath}`);
    const page = await context.newPage();
    await page.goto(START_URL, { waitUntil: "domcontentloaded" });
    await waitForManualStop(browser);
  } finally {
    await browser.close().catch(() => undefined);
    await Promise.allSettled([...pendingCaptures]);
    await writeQueue;
    logger.info(`Capture stopped. Sanitized output: ${capturePath}`);
  }
}

main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
