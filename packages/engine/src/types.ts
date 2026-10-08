import type { GoogleCalendarEvent } from "./normalize.js";
import type { ManagedBusyEvent, ManagedBusyEventInsert } from "./project.js";

/**
 * Stable internal identity of one connected calendar. People see a calendar
 * as its Google account and name; the key never changes once assigned, since
 * block keys, sync state and stored tokens are scoped by it. Installs from the
 * two-calendar era keep "personal" and "work" as their keys.
 */
export type CalendarKey = string;

/** The two calendar keys every two-calendar install started with. */
export const legacyCalendarKeys = ["personal", "work"] as const;

export interface CalendarConfig {
  key: CalendarKey;
  calendarId: string;
  /** Its busy time is mirrored to the other calendars. */
  source: boolean;
  /** It receives busy blocks for the other calendars' busy time. */
  destination: boolean;
}

/** Exclusions belong to the source calendar whose events they hold back. */
export interface SyncExclusions {
  keys: Readonly<Record<CalendarKey, readonly string[]>>;
  keywords: Readonly<Record<CalendarKey, readonly string[]>>;
}

/**
 * Engine-facing sync configuration. CLI `AppConfig` extends this with poll
 * interval and logging; hosted callers can supply the same subset.
 */
export interface SyncConfig {
  tenantId: string;
  calendars: readonly CalendarConfig[];
  window: {
    pastDays: number;
    futureDays: number;
  };
  timezone: string;
  exclusions: SyncExclusions;
  fullSyncIntervalMs?: number;
}

export interface Clock {
  now(): Date;
}

/** One busy block calsync wrote, by the destination calendar that holds it. */
export interface EventMapping {
  mappingKey: string;
  destinationKey: CalendarKey;
  destinationEventId: string;
  destinationEtag: string | null;
  updatedAt: string;
}

export interface MappingStore {
  putMapping(mapping: EventMapping): void;
  getMapping(mappingKey: string): EventMapping | null;
  listMappings(destinationKey?: CalendarKey, tenantId?: string): EventMapping[];
  deleteMapping(mappingKey: string, tenantId?: string): void;
}

export interface SyncStateStore {
  getState(key: string): string | null;
  setState(key: string, value: string, now?: Date): void;
  setStates(values: Readonly<Record<string, string>>, now?: Date): void;
  deleteState(key: string): void;
}

export interface StoredExclusionKey {
  sourceKey: CalendarKey;
  value: string;
  createdAt: string;
}

export interface StoredExclusionKeyword {
  sourceKey: CalendarKey;
  keyword: string;
  createdAt: string;
}

export interface ExclusionSource {
  listExclusionKeys(): readonly StoredExclusionKey[];
  listExclusionKeywords(): readonly StoredExclusionKeyword[];
}

export interface CalendarWindow {
  timeMin: string;
  timeMax: string;
  timeZone?: string;
}

export interface CalendarListProgress {
  fetched: number;
  complete: boolean;
}

export interface CalendarChangeSet {
  events: GoogleCalendarEvent[];
  nextSyncToken: string;
}

/**
 * Calendar adapter port. HTTP, retries, and googleapis stay outside the engine.
 * `listChanges` is optional so in-memory fakes can force a full window scan.
 */
export interface CalendarAPI {
  listEvents(
    calendarId: string,
    window: CalendarWindow,
    onProgress?: (progress: CalendarListProgress) => void,
  ): Promise<GoogleCalendarEvent[]>;
  listManagedEvents(
    calendarId: string,
    onProgress?: (progress: CalendarListProgress) => void,
  ): Promise<GoogleCalendarEvent[]>;
  listChanges?(
    calendarId: string,
    options?: { syncToken?: string },
    onProgress?: (progress: CalendarListProgress) => void,
  ): Promise<CalendarChangeSet>;
  insertEvent(
    calendarId: string,
    event: ManagedBusyEventInsert,
  ): Promise<GoogleCalendarEvent | undefined>;
  patchEvent(
    calendarId: string,
    eventId: string,
    event: ManagedBusyEvent,
    etag?: string,
  ): Promise<GoogleCalendarEvent>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
}

export type IncrementalCalendarAPI = CalendarAPI & Required<Pick<CalendarAPI, "listChanges">>;
