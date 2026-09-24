const FORBIDDEN_KEYS = new Set([
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "token",
  "tokens",
  "authorization",
  "attendees",
  "attendee",
  "description",
  "summary",
  "location",
  "hangoutlink",
  "conferencedata",
  "htmllink",
  "organizer",
  "creator",
  "email",
  "clientsecret",
  "clientid",
  "calendarid",
  "credentials",
  "oauth",
]);

const TITLE_KEYS = new Set(["sourcetitle", "sourcetitles", "title"]);

const TOKEN_LIKE = /\b(?:ya29\.|1\/\/[0-9A-Za-z_-]{8,}|refresh_token|access_token|id_token)\b/i;

export interface SanitizeOptions {
  allowTitles?: boolean;
}

export function sanitizeToolPayload(value: unknown, options: SanitizeOptions = {}): unknown {
  return sanitizeValue(value, options);
}

function sanitizeValue(value: unknown, options: SanitizeOptions): unknown {
  if (typeof value === "string") {
    return TOKEN_LIKE.test(value) ? "[redacted]" : value;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, options));
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizeKey(key);
    if (FORBIDDEN_KEYS.has(normalized)) {
      continue;
    }
    if (TITLE_KEYS.has(normalized) && options.allowTitles !== true) {
      continue;
    }
    result[key] = sanitizeValue(entry, options);
  }
  return result;
}

function normalizeKey(key: string): string {
  return key.replaceAll(/[^A-Za-z0-9]/g, "").toLowerCase();
}
