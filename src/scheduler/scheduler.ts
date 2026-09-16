export const AMSTERDAM_TIME_ZONE = "Europe/Amsterdam";

export type PollingMode = "NORMAL" | "PRE_WINDOW" | "HOT" | "POST_WINDOW";

export type PollingIntervals = Record<PollingMode, number>;

interface AmsterdamParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface SchedulerBoundary {
  at: Date;
  nextMode: PollingMode;
}

const formatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: AMSTERDAM_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function getAmsterdamParts(date: Date): AmsterdamParts {
  const values = new Map(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.get("year")!,
    month: values.get("month")!,
    day: values.get("day")!,
    hour: values.get("hour")!,
    minute: values.get("minute")!,
    second: values.get("second")!,
  };
}

export function determinePollingMode(date: Date): PollingMode {
  const { hour, minute } = getAmsterdamParts(date);
  const minutes = hour * 60 + minute;
  if (minutes >= 11 * 60 + 50 && minutes < 12 * 60) return "PRE_WINDOW";
  if (minutes >= 12 * 60 && minutes < 12 * 60 + 20) return "HOT";
  if (minutes >= 12 * 60 + 20 && minutes < 12 * 60 + 40) return "POST_WINDOW";
  return "NORMAL";
}

function timeZoneOffsetMs(date: Date): number {
  const parts = getAmsterdamParts(date);
  const representedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return representedAsUtc - Math.floor(date.getTime() / 1_000) * 1_000;
}

function amsterdamDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const wallClockUtc = Date.UTC(year, month - 1, day, hour, minute);
  let result = new Date(wallClockUtc);
  // Iteration resolves the applicable CET/CEST offset without assuming UTC+1/+2.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    result = new Date(wallClockUtc - timeZoneOffsetMs(result));
  }
  return result;
}

function nextLocalDay(parts: AmsterdamParts): { year: number; month: number; day: number } {
  const calendar = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return {
    year: calendar.getUTCFullYear(),
    month: calendar.getUTCMonth() + 1,
    day: calendar.getUTCDate(),
  };
}

export function getNextBoundary(date: Date): SchedulerBoundary {
  const parts = getAmsterdamParts(date);
  const seconds = parts.hour * 3_600 + parts.minute * 60 + parts.second;
  const boundaries: Array<{ seconds: number; hour: number; minute: number; mode: PollingMode }> = [
    { seconds: 11 * 3_600 + 50 * 60, hour: 11, minute: 50, mode: "PRE_WINDOW" },
    { seconds: 12 * 3_600, hour: 12, minute: 0, mode: "HOT" },
    { seconds: 12 * 3_600 + 20 * 60, hour: 12, minute: 20, mode: "POST_WINDOW" },
    { seconds: 12 * 3_600 + 40 * 60, hour: 12, minute: 40, mode: "NORMAL" },
  ];
  const today = boundaries.find((boundary) => boundary.seconds > seconds);
  if (today) {
    return {
      at: amsterdamDate(parts.year, parts.month, parts.day, today.hour, today.minute),
      nextMode: today.mode,
    };
  }

  const tomorrow = nextLocalDay(parts);
  return {
    at: amsterdamDate(tomorrow.year, tomorrow.month, tomorrow.day, 11, 50),
    nextMode: "PRE_WINDOW",
  };
}

export function calculateNextDelay(
  date: Date,
  intervals: PollingIntervals,
): { delayMs: number; mode: PollingMode; boundary: SchedulerBoundary } {
  const mode = determinePollingMode(date);
  const boundary = getNextBoundary(date);
  const timeUntilBoundary = Math.max(0, boundary.at.getTime() - date.getTime());
  return {
    delayMs: Math.min(intervals[mode], timeUntilBoundary),
    mode,
    boundary,
  };
}

export function formatAmsterdamDateTime(date: Date): string {
  const parts = getAmsterdamParts(date);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)} ${AMSTERDAM_TIME_ZONE}`;
}

export function formatAmsterdamTime(date: Date): string {
  const parts = getAmsterdamParts(date);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}
