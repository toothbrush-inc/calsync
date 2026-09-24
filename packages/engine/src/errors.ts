export interface GoogleApiErrorInfo {
  status?: number;
  reason?: string;
  message?: string;
  retryAfterMs?: number;
}

const RETRYABLE_403_REASONS = new Set([
  "calendarUsageLimitsExceeded",
  "quotaExceeded",
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorStatus(error: unknown): number | undefined {
  const record = asRecord(error);
  const response = asRecord(record?.["response"]);
  const responseData = asRecord(response?.["data"]);
  const responseError = asRecord(responseData?.["error"]);
  const candidates = [
    record?.["code"],
    record?.["status"],
    response?.["status"],
    responseError?.["code"],
    asRecord(record?.["errors"])?.["code"],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number") {
      return candidate;
    }
    if (typeof candidate === "string" && /^\d{3}$/.test(candidate)) {
      return Number(candidate);
    }
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function errorReason(error: unknown): string | undefined {
  const record = asRecord(error);
  const response = asRecord(record?.["response"]);
  const data = asRecord(response?.["data"]);
  const dataError = asRecord(data?.["error"]);
  const responseErrors = Array.isArray(dataError?.["errors"])
    ? dataError["errors"]
    : Array.isArray(data?.["errors"])
      ? data["errors"]
      : [];
  const directErrors = Array.isArray(record?.["errors"]) ? record["errors"] : [];
  const firstError = asRecord(responseErrors[0] ?? directErrors[0]);
  return firstString(firstError?.["reason"], record?.["reason"]);
}

function errorMessage(error: unknown): string | undefined {
  const record = asRecord(error);
  const response = asRecord(record?.["response"]);
  const data = asRecord(response?.["data"]);
  const dataError = asRecord(data?.["error"]);
  const responseErrors = Array.isArray(dataError?.["errors"])
    ? dataError["errors"]
    : Array.isArray(data?.["errors"])
      ? data["errors"]
      : [];
  const firstError = asRecord(responseErrors[0]);
  return firstString(dataError?.["message"], firstError?.["message"], record?.["message"]);
}

function retryAfterMilliseconds(error: unknown): number | undefined {
  const response = asRecord(asRecord(error)?.["response"]);
  const rawHeaders = response?.["headers"];
  const headers = asRecord(rawHeaders);
  const getHeader = asRecord(rawHeaders)?.["get"];
  const raw =
    headers?.["retry-after"] ??
    headers?.["Retry-After"] ??
    (typeof getHeader === "function"
      ? (getHeader as (name: string) => unknown).call(rawHeaders, "retry-after")
      : undefined);
  if (typeof raw !== "string" && typeof raw !== "number") {
    return undefined;
  }

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const date = Date.parse(String(raw));
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function googleApiErrorInfo(error: unknown): GoogleApiErrorInfo {
  const status = errorStatus(error);
  const reason = errorReason(error);
  const message = errorMessage(error);
  const retryAfterMs = retryAfterMilliseconds(error);
  return {
    ...(status === undefined ? {} : { status }),
    ...(reason === undefined ? {} : { reason }),
    ...(message === undefined ? {} : { message }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

export function isRetryableGoogleError(error: unknown): boolean {
  const info = googleApiErrorInfo(error);
  return (
    info.status === 408 ||
    info.status === 429 ||
    (info.status === 403 && info.reason !== undefined && RETRYABLE_403_REASONS.has(info.reason)) ||
    (info.status !== undefined && info.status >= 500 && info.status <= 599)
  );
}

export function isInvalidSyncTokenError(error: unknown): boolean {
  const info = googleApiErrorInfo(error);
  return info.status === 410 || info.reason === "fullSyncRequired";
}
