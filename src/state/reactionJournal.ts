import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

export type ReactionJournalEventName =
  | "PREPARATION_STARTED"
  | "PREPARED"
  | "PREPARATION_ABORTED"
  | "SUBMIT_STARTED"
  | "SUBMIT_RESPONSE"
  | "VERIFICATION_STARTED"
  | "VERIFICATION_RESULT"
  | "SUCCESS"
  | "FAILED"
  | "UNKNOWN";

export interface ReactionJournalEvent {
  timestamp: string;
  dwellingId: string;
  assignmentId?: string;
  event: ReactionJournalEventName;
  result?: string;
  reasonCode?: string;
  httpStatus?: number;
}

export const REACTION_JOURNAL_PATH = path.resolve("data", "reaction-journal.jsonl");

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function validateJournalEvent(value: unknown): ReactionJournalEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("journal event must be an object");
  }
  const event = value as Record<string, unknown>;
  const allowedKeys = new Set(["timestamp", "dwellingId", "assignmentId", "event", "result", "reasonCode", "httpStatus"]);
  const names: ReactionJournalEventName[] = [
    "PREPARATION_STARTED", "PREPARED", "PREPARATION_ABORTED", "SUBMIT_STARTED",
    "SUBMIT_RESPONSE", "VERIFICATION_STARTED", "VERIFICATION_RESULT", "SUCCESS", "FAILED", "UNKNOWN",
  ];
  if (
    !nonEmpty(event.timestamp) || Number.isNaN(Date.parse(event.timestamp)) ||
    !nonEmpty(event.dwellingId) || !names.includes(event.event as ReactionJournalEventName) ||
    Object.keys(event).some((key) => !allowedKeys.has(key)) ||
    (event.assignmentId !== undefined && !nonEmpty(event.assignmentId)) ||
    (event.result !== undefined && (!nonEmpty(event.result) || !/^[A-Z0-9_]+$/.test(event.result))) ||
    (event.reasonCode !== undefined && (!nonEmpty(event.reasonCode) || !/^[A-Z0-9_]+$/.test(event.reasonCode))) ||
    (event.httpStatus !== undefined && (!Number.isInteger(event.httpStatus) || Number(event.httpStatus) < 100 || Number(event.httpStatus) > 599))
  ) {
    throw new Error("journal event has an invalid structure");
  }
  return event as unknown as ReactionJournalEvent;
}

export async function appendReactionJournalEvent(
  event: ReactionJournalEvent,
  filePath = REACTION_JOURNAL_PATH,
): Promise<void> {
  const validated = validateJournalEvent(event);
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const handle = await open(filePath, "a", 0o600);
  try {
    await handle.write(`${JSON.stringify(validated)}\n`, undefined, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

export async function loadReactionJournal(
  filePath = REACTION_JOURNAL_PATH,
): Promise<ReactionJournalEvent[]> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Could not read reaction journal: ${String(error)}`);
  }
  if (contents === "") return [];
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, index) => {
    try {
      return validateJournalEvent(JSON.parse(line) as unknown);
    } catch (error: unknown) {
      throw new Error(`Reaction journal line ${index + 1} is malformed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
