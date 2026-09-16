import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type WoningId = string | number;

export interface KnownWoningenState {
  version: 1;
  knownIds: WoningId[];
}

export type LoadStateResult =
  | { exists: false }
  | { exists: true; state: KnownWoningenState };

export const KNOWN_WONINGEN_PATH = path.resolve("data", "known-woningen.json");

export function woningIdKey(id: WoningId): string {
  return `${typeof id}:${String(id)}`;
}

function isWoningId(value: unknown): value is WoningId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function parseState(value: unknown): KnownWoningenState {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== 1 ||
    !("knownIds" in value) ||
    !Array.isArray(value.knownIds) ||
    !value.knownIds.every(isWoningId)
  ) {
    throw new Error("Known-woningen state has an invalid structure.");
  }

  const unique = new Map<string, WoningId>();
  for (const id of value.knownIds) {
    unique.set(woningIdKey(id), id);
  }
  return { version: 1, knownIds: [...unique.values()] };
}

export async function loadKnownWoningen(
  filePath = KNOWN_WONINGEN_PATH,
): Promise<LoadStateResult> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw new Error(`Could not read known-woningen state: ${String(error)}`);
  }

  try {
    return { exists: true, state: parseState(JSON.parse(contents) as unknown) };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Known-woningen state is corrupted; refusing to classify listings as new. ${reason}`);
  }
}

export async function saveKnownWoningen(
  knownIds: WoningId[],
  filePath = KNOWN_WONINGEN_PATH,
): Promise<void> {
  const state = parseState({ version: 1, knownIds });
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(directory, { recursive: true });

  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, filePath);
  } catch (error: unknown) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new Error(`Could not safely save known-woningen state: ${String(error)}`);
  }
}
