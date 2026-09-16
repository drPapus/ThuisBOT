import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext } from "playwright";

export const AUTH_DIRECTORY = path.resolve(".auth");
export const STORAGE_STATE_PATH = path.join(AUTH_DIRECTORY, "thuispoort.json");

export async function storageStateExists(): Promise<boolean> {
  try {
    await access(STORAGE_STATE_PATH);
    return true;
  } catch {
    return false;
  }
}

export async function saveStorageState(context: BrowserContext): Promise<void> {
  await mkdir(AUTH_DIRECTORY, { recursive: true, mode: 0o700 });
  await context.storageState({ path: STORAGE_STATE_PATH });
}
