import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export type AutomaticReactionStatus =
  | "IN_PROGRESS"
  | "PREPARED"
  | "SUBMITTING"
  | "ABORTED"
  | "UNKNOWN"
  | "SUCCESS"
  | "FAILED";

export interface AutomaticReactionRecord {
  dwellingId: string;
  assignmentId?: string;
  status: AutomaticReactionStatus;
  firstSeenAt: string;
  updatedAt: string;
  reason?: string;
  attemptId?: string;
}

export interface AutomaticReactionState {
  version: 1;
  records: AutomaticReactionRecord[];
}

export const REACTION_STATE_PATH = path.resolve("data", "reaction-state.json");

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseRecord(value: unknown): AutomaticReactionRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("record must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    !isNonEmptyString(record.dwellingId) ||
    (record.assignmentId !== undefined && !isNonEmptyString(record.assignmentId)) ||
    !["IN_PROGRESS", "PREPARED", "SUBMITTING", "ABORTED", "UNKNOWN", "SUCCESS", "FAILED"].includes(String(record.status)) ||
    !isNonEmptyString(record.firstSeenAt) ||
    !isNonEmptyString(record.updatedAt) ||
    Number.isNaN(Date.parse(record.firstSeenAt)) ||
    Number.isNaN(Date.parse(record.updatedAt)) ||
    (record.reason !== undefined && typeof record.reason !== "string") ||
    (record.attemptId !== undefined && !isNonEmptyString(record.attemptId))
  ) {
    throw new Error("record has an invalid structure");
  }
  return {
    dwellingId: record.dwellingId,
    ...(record.assignmentId !== undefined && { assignmentId: record.assignmentId as string }),
    status: record.status as AutomaticReactionStatus,
    firstSeenAt: record.firstSeenAt,
    updatedAt: record.updatedAt,
    ...(record.reason !== undefined && { reason: record.reason as string }),
    ...(record.attemptId !== undefined && { attemptId: record.attemptId as string }),
  };
}

function parseState(value: unknown): AutomaticReactionState {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== 1 ||
    !("records" in value) ||
    !Array.isArray(value.records)
  ) {
    throw new Error("state has an invalid structure");
  }
  const records = value.records.map(parseRecord);
  const identities = new Set<string>();
  for (const record of records) {
    const identity = `${record.dwellingId}:${record.assignmentId ?? "pending"}`;
    if (identities.has(identity)) throw new Error(`duplicate reaction identity ${identity}`);
    identities.add(identity);
  }
  return { version: 1, records };
}

export async function loadReactionState(
  filePath = REACTION_STATE_PATH,
): Promise<AutomaticReactionState> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, records: [] };
    throw new Error(`Could not read automatic reaction state: ${String(error)}`);
  }
  try {
    return parseState(JSON.parse(contents) as unknown);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Automatic reaction state is corrupted; FAIL SAFE. ${reason}`);
  }
}

export async function saveReactionState(
  state: AutomaticReactionState,
  filePath = REACTION_STATE_PATH,
): Promise<void> {
  const validated = parseState(state);
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(directory, { recursive: true });
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error: unknown) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new Error(`Could not safely save automatic reaction state: ${String(error)}`);
  }
}

export function findReactionRecord(
  state: AutomaticReactionState,
  dwellingId: string,
): AutomaticReactionRecord | undefined {
  return state.records.find((record) => record.dwellingId === dwellingId);
}

export function replaceReactionRecord(
  state: AutomaticReactionState,
  record: AutomaticReactionRecord,
): AutomaticReactionState {
  return {
    version: 1,
    records: [...state.records.filter((candidate) => candidate.dwellingId !== record.dwellingId), record],
  };
}

export function removeReactionRecord(
  state: AutomaticReactionState,
  dwellingId: string,
): AutomaticReactionState {
  return { version: 1, records: state.records.filter((record) => record.dwellingId !== dwellingId) };
}

const LEGAL_TRANSITIONS: Readonly<Record<AutomaticReactionStatus, readonly AutomaticReactionStatus[]>> = {
  IN_PROGRESS: ["PREPARED", "ABORTED", "UNKNOWN"],
  PREPARED: ["SUBMITTING", "SUCCESS", "UNKNOWN"],
  SUBMITTING: ["SUCCESS", "FAILED", "UNKNOWN"],
  ABORTED: [],
  UNKNOWN: [],
  SUCCESS: [],
  FAILED: [],
};

export function transitionReactionRecord(
  current: AutomaticReactionRecord,
  status: AutomaticReactionStatus,
  updatedAt: string,
  updates: Pick<AutomaticReactionRecord, "assignmentId" | "reason" | "attemptId"> = {},
): AutomaticReactionRecord {
  if (!LEGAL_TRANSITIONS[current.status].includes(status)) {
    throw new Error(`Illegal automatic reaction state transition: ${current.status} -> ${status}`);
  }
  return {
    ...current,
    ...updates,
    status,
    updatedAt,
  };
}
