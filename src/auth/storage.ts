import { access, chmod, mkdir, rename } from "node:fs/promises";
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

export async function saveStorageState(
  context: BrowserContext,
): Promise<void> {
  await mkdir(AUTH_DIRECTORY, {
    recursive: true,
    mode: 0o700,
  });

  const temporaryPath = path.join(
    AUTH_DIRECTORY,
    `.thuispoort.${process.pid}.${Date.now()}.tmp`,
  );

  try {
    await context.storageState({
      path: temporaryPath,
    });

    await chmod(temporaryPath, 0o600);

    // rename() on the same filesystem is atomic:
    // readers see either the old complete state or the new complete state.
    await rename(temporaryPath, STORAGE_STATE_PATH);
  } catch (error) {
    // If writing failed before rename(), the existing session file remains intact.
    throw error;
  }
}
