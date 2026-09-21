import { mkdir, open, readFile, stat, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

const localTails = new Map<string, Promise<void>>();

export class ReactionLockIntegrityError extends Error {
  constructor(cause: unknown) {
    super(`Reaction lock integrity failure: ${String(cause)}`);
    this.name = "ReactionLockIntegrityError";
  }
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function removeIfStale(lockPath: string, staleAfterMs: number): Promise<boolean> {
  try {
    const metadata = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
    const age = Date.now() - (await stat(lockPath)).mtimeMs;
    const pid = typeof metadata.pid === "number" ? metadata.pid : undefined;
    if ((pid === undefined || !processIsAlive(pid)) && age >= staleAfterMs) {
      await unlink(lockPath);
      return true;
    }
    return false;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    const age = Date.now() - (await stat(lockPath)).mtimeMs;
    if (age < staleAfterMs) return false;
    await unlink(lockPath);
    return true;
  }
}

async function acquireFileLock(lockPath: string, staleAfterMs: number): Promise<FileHandle> {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (;;) {
    let handle: FileHandle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await removeIfStale(lockPath, staleAfterMs))) await wait(100);
      continue;
    }
    try {
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      await handle.sync();
      return handle;
    } catch (error: unknown) {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
  }
}

export async function withGlobalReactionLock<T>(
  operation: () => Promise<T>,
  lockPath: string,
  staleAfterMs: number,
): Promise<T> {
  const previous = localTails.get(lockPath) ?? Promise.resolve();
  let releaseLocal!: () => void;
  const current = new Promise<void>((resolve) => { releaseLocal = resolve; });
  localTails.set(lockPath, current);
  await previous;

  let handle: FileHandle | undefined;
  try {
    try {
      handle = await acquireFileLock(lockPath, staleAfterMs);
    } catch (error: unknown) {
      throw new ReactionLockIntegrityError(error);
    }
    return await operation();
  } finally {
    try {
      if (handle) {
        try {
          await handle.close();
          await unlink(lockPath);
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new ReactionLockIntegrityError(error);
          }
        }
      }
    } finally {
      releaseLocal();
      if (localTails.get(lockPath) === current) localTails.delete(lockPath);
    }
  }
}
