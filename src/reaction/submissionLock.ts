import { mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

export const REACTION_LOCK_PATH = path.resolve(".state", "reaction-submit.lock");

export class ReactionSubmissionLockedError extends Error {
  constructor() {
    super("REACTION_SUBMISSION_LOCKED");
    this.name = "ReactionSubmissionLockedError";
  }
}

export interface ReactionSubmissionLock {
  release(): Promise<void>;
}

export async function acquireReactionSubmissionLock(
  lockPath = REACTION_LOCK_PATH,
): Promise<ReactionSubmissionLock> {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ReactionSubmissionLockedError();
    }
    throw error;
  }
  await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);

  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await handle.close();
      await unlink(lockPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    },
  };
}
