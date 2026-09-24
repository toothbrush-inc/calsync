import { createHash } from "node:crypto";

import {
  MANAGED_PROPERTY,
  MAPPING_PROPERTY,
  type GoogleCalendarEvent,
  type NormalizedSourceEvent,
} from "./normalize.js";

export interface GoogleEventDateTimeInput {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface ManagedBusyEvent {
  summary: "Busy";
  visibility: "private";
  transparency: "opaque";
  start: GoogleEventDateTimeInput;
  end: GoogleEventDateTimeInput;
  reminders: {
    useDefault: false;
    overrides: [];
  };
  extendedProperties: {
    private: {
      [MANAGED_PROPERTY]: "true";
      [MAPPING_PROPERTY]: string;
    };
  };
}

export interface ManagedBusyEventInsert extends ManagedBusyEvent {
  id: string;
}

export type ManagedProjectionField =
  "summary" | "visibility" | "transparency" | "start" | "end" | "reminders" | "managed-metadata";

function requireMappingKey(mappingKey: string): void {
  if (mappingKey.length === 0) {
    throw new Error("A non-empty calsync mapping key is required");
  }
}

export function projectBusyEvent(
  source: NormalizedSourceEvent,
  mappingKey: string,
): ManagedBusyEvent {
  requireMappingKey(mappingKey);

  const start: GoogleEventDateTimeInput =
    source.time.kind === "all-day"
      ? { date: source.time.startDate }
      : { dateTime: source.time.startDateTime };
  const end: GoogleEventDateTimeInput =
    source.time.kind === "all-day"
      ? { date: source.time.endDate }
      : { dateTime: source.time.endDateTime };

  if (source.time.kind === "timed") {
    if (source.time.startTimeZone !== undefined) {
      start.timeZone = source.time.startTimeZone;
    }
    if (source.time.endTimeZone !== undefined) {
      end.timeZone = source.time.endTimeZone;
    }
  }

  return {
    summary: "Busy",
    visibility: "private",
    transparency: "opaque",
    start,
    end,
    reminders: {
      useDefault: false,
      overrides: [],
    },
    extendedProperties: {
      private: {
        [MANAGED_PROPERTY]: "true",
        [MAPPING_PROPERTY]: mappingKey,
      },
    },
  };
}

/**
 * Google Calendar event IDs use base32hex characters. A stable hexadecimal
 * digest makes retried inserts idempotent without disclosing source IDs.
 */
export function managedGoogleEventId(mappingKey: string): string {
  requireMappingKey(mappingKey);
  return createHash("sha256").update(mappingKey).digest("hex");
}

export function projectBusyEventInsert(
  source: NormalizedSourceEvent,
  mappingKey: string,
): ManagedBusyEventInsert {
  return {
    id: managedGoogleEventId(mappingKey),
    ...projectBusyEvent(source, mappingKey),
  };
}

/**
 * Compare only fields owned by calsync, using their Calendar API semantics.
 * Google may rewrite RFC3339 offsets, omit the default opaque transparency,
 * omit an empty reminder override list, and add unrelated response fields.
 */
export function managedProjectionDrift(
  actual: GoogleCalendarEvent,
  desired: ManagedBusyEvent,
): ManagedProjectionField[] {
  const drift: ManagedProjectionField[] = [];
  if (actual.summary !== desired.summary) {
    drift.push("summary");
  }
  if (actual.visibility !== desired.visibility) {
    drift.push("visibility");
  }
  if ((actual.transparency ?? "opaque") !== desired.transparency) {
    drift.push("transparency");
  }
  if (!sameEventTime(actual.start, desired.start)) {
    drift.push("start");
  }
  if (!sameEventTime(actual.end, desired.end)) {
    drift.push("end");
  }
  if (actual.reminders?.useDefault !== false || (actual.reminders.overrides?.length ?? 0) !== 0) {
    drift.push("reminders");
  }

  const privateProperties = actual.extendedProperties?.private;
  if (
    privateProperties?.[MANAGED_PROPERTY] !== "true" ||
    privateProperties[MAPPING_PROPERTY] !== desired.extendedProperties.private[MAPPING_PROPERTY]
  ) {
    drift.push("managed-metadata");
  }
  return drift;
}

export function matchesManagedProjection(
  actual: GoogleCalendarEvent,
  desired: ManagedBusyEvent,
): boolean {
  return managedProjectionDrift(actual, desired).length === 0;
}

function sameEventTime(
  actual: GoogleCalendarEvent["start"],
  desired: GoogleEventDateTimeInput,
): boolean {
  if (desired.date !== undefined) {
    return actual?.date === desired.date && nonEmpty(actual.dateTime) === undefined;
  }
  const actualDateTime = nonEmpty(actual?.dateTime);
  if (desired.dateTime === undefined || actualDateTime === undefined) {
    return false;
  }
  if (nonEmpty(actual?.date) !== undefined) {
    return false;
  }

  const actualInstant = instantMilliseconds(actualDateTime);
  const desiredInstant = instantMilliseconds(desired.dateTime);
  if (actualInstant !== undefined && desiredInstant !== undefined) {
    return actualInstant === desiredInstant;
  }

  return (
    actualDateTime === desired.dateTime && nonEmpty(actual?.timeZone) === nonEmpty(desired.timeZone)
  );
}

function instantMilliseconds(value: string): number | undefined {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    return undefined;
  }
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? undefined : milliseconds;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return value == null || value.length === 0 ? undefined : value;
}
