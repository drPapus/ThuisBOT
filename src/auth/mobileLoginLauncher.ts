import {
  execFile,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

const MOBILE_LOGIN_URL_PREFIX = "MOBILE_LOGIN_URL=";

let mobileLoginProcess: ChildProcess | undefined;

async function stopMobileLoginInfrastructure(): Promise<void> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "./scripts/stop-mobile-login.sh",
      [],
      {
        cwd: process.cwd(),
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );

    if (stdout.trim()) {
      logger.info(stdout.trim());
    }

    if (stderr.trim()) {
      logger.error(stderr.trim());
    }

    logger.info("Mobile login infrastructure stopped.");
  } catch (error: unknown) {
    logger.error(
      `Failed to stop mobile login infrastructure: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function prepareMobileLogin(): Promise<string> {
  const { stdout } = await execFileAsync(
    "./scripts/start-mobile-login.sh",
    [],
    {
      cwd: process.cwd(),
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    },
  );

  const line = stdout
    .split(/\r?\n/)
    .find((value) => value.startsWith(MOBILE_LOGIN_URL_PREFIX));

  if (!line) {
    throw new Error(
      "Mobile login infrastructure started, but no MOBILE_LOGIN_URL was returned.",
    );
  }

  const url = line.slice(MOBILE_LOGIN_URL_PREFIX.length).trim();

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Mobile login launcher returned an invalid URL.");
  }

  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname.endsWith(".trycloudflare.com")
  ) {
    throw new Error(
      "Mobile login launcher returned an unexpected URL.",
    );
  }

  return parsed.toString();
}

export function startMobileLoginProcess(): boolean {
  if (
    mobileLoginProcess &&
    mobileLoginProcess.exitCode === null &&
    mobileLoginProcess.signalCode === null
  ) {
    logger.info("Mobile login process already running.");
    return false;
  }

  logger.info("Starting mobile login process...");

  const child = spawn(
    process.execPath,
    ["dist/auth/mobileLogin.js"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DISPLAY: ":99",
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );

  mobileLoginProcess = child;

  child.once("error", (error) => {
    logger.error(`Mobile login process error: ${error.message}`);

    if (mobileLoginProcess === child) {
      mobileLoginProcess = undefined;
    }

    void stopMobileLoginInfrastructure();
  });

  child.once("exit", (code, signal) => {
    if (code === 0) {
      logger.info("Mobile login process completed successfully.");
    } else {
      logger.error(
        `Mobile login process exited with code ${String(code)}, signal ${String(signal)}.`,
      );
    }

    if (mobileLoginProcess === child) {
      mobileLoginProcess = undefined;
    }

    void stopMobileLoginInfrastructure();
  });

  return true;
}
