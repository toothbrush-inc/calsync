export const MANAGED_PROPERTY = "calsyncManaged";
export const MAPPING_PROPERTY = "calsyncMapping";

export interface GoogleEventDateTime {
  date?: string | null;
  dateTime?: string | null;
  timeZone?: string | null;
}

export interface GoogleEventAttendee {
  self?: boolean | null;
  responseStatus?: string | null;
}

export interface GoogleCalendarEvent {
  id?: string | null;
  etag?: string | null;
  summary?: string | null;
  visibility?: string | null;
  status?: string | null;
  transparency?: string | null;
  iCalUID?: string | null;
  recurringEventId?: string | null;
  originalStartTime?: GoogleEventDateTime | null;
  start?: GoogleEventDateTime | null;
  end?: GoogleEventDateTime | null;
  attendees?: GoogleEventAttendee[] | null;
  reminders?: {
    useDefault?: boolean | null;
    overrides?: unknown[] | null;
  } | null;
  extendedProperties?: {
    private?: Record<string, string> | null;
  } | null;
}

export type NormalizedEventTime =
  | {
      kind: "all-day";
      startDate: string;
      endDate: string;
    }
  | {
      kind: "timed";
      startDateTime: string;
      endDateTime: string;
      startTimeZone?: string;
      endTimeZone?: string;
    };

export interface NormalizedSourceEvent {
  id: string;
  etag?: string;
  iCalUID?: string;
  sourceTitle?: string;
  occurrenceKey: string;
  seriesKey: string;
  isRecurring: boolean;
  duplicateMatchKey?: string;
  time: NormalizedEventTime;
}

export type SourceEventExclusion = "cancelled" | "declined" | "transparent" | "managed" | "invalid";

export type NormalizeSourceEventResult =
  | { included: true; event: NormalizedSourceEvent }
  | { included: false; reason: SourceEventExclusion };

function nonEmpty(value: string | null | undefined): string | undefined {
  return value === undefined || value === null || value.length === 0 ? undefined : value;
}

function timeIdentity(value: GoogleEventDateTime | null | undefined): string | undefined {
  const date = nonEmpty(value?.date);
  if (date !== undefined) {
    return `date:${date}`;
  }

  const dateTime = nonEmpty(value?.dateTime);
  if (dateTime !== undefined) {
    return `dateTime:${canonicalDateTime(dateTime)}`;
  }

  return undefined;
}

export function canonicalDateTime(value: string): string {
  // Google normally returns RFC3339 values with an explicit offset. Comparing
  // their instants avoids duplicate mirrors when two accounts render the same
  // event in different zones, while preserving unusual floating values.
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    return value;
  }
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? value : new Date(milliseconds).toISOString();
}

function normalizeTime(
  start: GoogleEventDateTime | null | undefined,
  end: GoogleEventDateTime | null | undefined,
): NormalizedEventTime | undefined {
  const startDate = nonEmpty(start?.date);
  const endDate = nonEmpty(end?.date);
  if (startDate !== undefined || endDate !== undefined) {
    if (startDate === undefined || endDate === undefined) {
      return undefined;
    }
    return { kind: "all-day", startDate, endDate };
  }

  const startDateTime = nonEmpty(start?.dateTime);
  const endDateTime = nonEmpty(end?.dateTime);
  if (startDateTime === undefined || endDateTime === undefined) {
    return undefined;
  }

  const result: NormalizedEventTime = {
    kind: "timed",
    startDateTime,
    endDateTime,
  };
  const startTimeZone = nonEmpty(start?.timeZone);
  const endTimeZone = nonEmpty(end?.timeZone);
  if (startTimeZone !== undefined) {
    result.startTimeZone = startTimeZone;
  }
  if (endTimeZone !== undefined) {
    result.endTimeZone = endTimeZone;
  }
  return result;
}

export function isManagedEvent(event: GoogleCalendarEvent): boolean {
  return event.extendedProperties?.private?.[MANAGED_PROPERTY] === "true";
}

export function normalizeSourceEvent(event: GoogleCalendarEvent): NormalizeSourceEventResult {
  if (event.status === "cancelled") {
    return { included: false, reason: "cancelled" };
  }
  if (event.transparency === "transparent") {
    return { included: false, reason: "transparent" };
  }
  if (
    event.attendees?.some(
      (attendee) => attendee.self === true && attendee.responseStatus === "declined",
    ) === true
  ) {
    return { included: false, reason: "declined" };
  }
  if (isManagedEvent(event)) {
    return { included: false, reason: "managed" };
  }

  const id = nonEmpty(event.id);
  const time = normalizeTime(event.start, event.end);
  if (id === undefined || time === undefined) {
    return { included: false, reason: "invalid" };
  }

  const recurringEventId = nonEmpty(event.recurringEventId);
  const originalStartIdentity = timeIdentity(event.originalStartTime);
  const startIdentity = timeIdentity(event.start);
  const occurrenceKey =
    recurringEventId !== undefined
      ? `${recurringEventId}/${originalStartIdentity ?? startIdentity ?? id}`
      : id;
  const seriesKey = recurringEventId ?? id;

  const iCalUID = nonEmpty(event.iCalUID);
  const duplicateIdentity = originalStartIdentity ?? startIdentity;
  const normalized: NormalizedSourceEvent = {
    id,
    occurrenceKey,
    seriesKey,
    isRecurring: recurringEventId !== undefined,
    time,
  };
  const sourceTitle = nonEmpty(event.summary);
  if (sourceTitle !== undefined) {
    normalized.sourceTitle = sourceTitle;
  }
  const etag = nonEmpty(event.etag);
  if (etag !== undefined) {
    normalized.etag = etag;
  }
  if (iCalUID !== undefined) {
    normalized.iCalUID = iCalUID;
    if (duplicateIdentity !== undefined) {
      normalized.duplicateMatchKey = `${iCalUID}/${duplicateIdentity}`;
    }
  }

  return { included: true, event: normalized };
}

export function normalizeSourceEvents(
  events: readonly GoogleCalendarEvent[],
): NormalizedSourceEvent[] {
  const normalized: NormalizedSourceEvent[] = [];
  for (const event of events) {
    const result = normalizeSourceEvent(event);
    if (result.included) {
      normalized.push(result.event);
    }
  }
  return normalized;
}
