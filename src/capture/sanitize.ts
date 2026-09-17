const MAX_BODY_CHARACTERS = 32_000;
const SENSITIVE_NAME = /(?:cookie|authorization|token|csrf|xsrf|secret|session|password|passwd|credential|api[-_]?key|jwt|bearer|(?:^|[-_])auth(?:$|[-_]))/i;
const SELECTED_HEADER = /^(?:accept|content-type|origin|referer|x-requested-with|location|x-[\w-]+)$/i;

function redacted(value: string): string {
  return `[REDACTED length=${value.length}]`;
}

function truncate(value: string): string {
  if (value.length <= MAX_BODY_CHARACTERS) return value;
  return `${value.slice(0, MAX_BODY_CHARACTERS)}\n[TRUNCATED originalLength=${value.length}]`;
}

export function sanitizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.username) url.username = redacted(url.username);
    if (url.password) url.password = redacted(url.password);
    for (const [name, value] of url.searchParams) {
      if (SENSITIVE_NAME.test(name)) url.searchParams.set(name, redacted(value));
    }
    if (SENSITIVE_NAME.test(url.hash)) url.hash = "#[REDACTED]";
    return url.toString();
  } catch {
    return "[INVALID URL OMITTED]";
  }
}

export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [originalName, value] of Object.entries(headers)) {
    const name = originalName.toLowerCase();
    if (!SELECTED_HEADER.test(name) && !SENSITIVE_NAME.test(name)) continue;
    if (SENSITIVE_NAME.test(name)) {
      sanitized[name] = redacted(value);
    } else if (["origin", "referer", "location"].includes(name)) {
      sanitized[name] = sanitizeUrl(value);
    } else {
      sanitized[name] = truncate(value);
    }
  }
  return sanitized;
}

export function sanitizeValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_NAME.test(key)) {
    const length = typeof value === "string" ? value.length : JSON.stringify(value)?.length ?? 0;
    return `[REDACTED length=${length}]`;
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeValue(entryValue, entryKey),
      ]),
    );
  }
  if (typeof value === "string") return truncate(value);
  return value;
}

function sanitizeFormBody(body: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(body)) {
    const sanitized = sanitizeValue(value, key);
    const existing = values[key];
    values[key] = existing === undefined ? sanitized : [existing, sanitized].flat();
  }
  return values;
}

export function sanitizeBody(body: string, contentType: string): unknown {
  if (body.length > MAX_BODY_CHARACTERS * 4) {
    return `[BODY OMITTED length=${body.length}]`;
  }

  const normalizedType = contentType.toLowerCase();
  if (normalizedType.includes("application/json") || normalizedType.includes("+json")) {
    try {
      return sanitizeValue(JSON.parse(body) as unknown);
    } catch {
      return "[INVALID JSON BODY OMITTED]";
    }
  }
  if (normalizedType.includes("application/x-www-form-urlencoded")) {
    return sanitizeFormBody(body);
  }
  if (normalizedType.includes("multipart/form-data")) {
    return `[MULTIPART BODY OMITTED length=${body.length}]`;
  }
  return truncate(
    body.replace(
      /((?:token|csrf|xsrf|secret|session|authorization|cookie)["'\s:=]+)([^&\s"']+)/gi,
      (_match, prefix: string, secret: string) => `${prefix}${redacted(secret)}`,
    ),
  );
}

export function mayCaptureResponseBody(contentType: string, contentLength?: number): boolean {
  if (contentLength !== undefined && contentLength > MAX_BODY_CHARACTERS * 4) return false;
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes("application/json") ||
    normalized.includes("+json") ||
    normalized.startsWith("text/plain")
  );
}
