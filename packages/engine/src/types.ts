import type { GoogleCalendarEvent } from "./normalize.js";
import type { ManagedBusyEvent, ManagedBusyEventInsert } from "./project.js";

export const accountRoles = ["personal", "work"] as const;
export type AccountRole = (typeof accountRoles)[number];

export interface AccountConfig {
  tenantId: string;
  role: AccountRole;
  calendarId: string;
}

export interface SyncExclusions {
  personalToWork: readonly string[];
  workToPersonal: readonly string[];
  personalToWorkKeywords: readonly string[];
  workToPersonalKeywords: readonly string[];
}

/**
 * Engine-facing sync configuration. CLI `AppConfig` extends this with poll
 * interval and logging; hosted callers can supply the same subset.
 */
export interface SyncConfig {
  tenantId: string;
  accounts: Record<AccountRole, AccountConfig>;
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

export interface EventMapping {
  mappingKey: string;
  sourceRole: AccountRole;
  sourceEventId: string;
  destinationEventId: string;
  sourceEtag: string | null;
  destinationEtag: string | null;
  updatedAt: string;
}

export interface MappingStore {
  putMapping(mapping: EventMapping): void;
  getMapping(mappingKey: string): EventMapping | null;
  listMappings(sourceRole?: AccountRole, tenantId?: string): EventMapping[];
  deleteMapping(mappingKey: string, tenantId?: string): void;
}

export interface SyncStateStore {
  getState(key: string): string | null;
  setState(key: string, value: string, now?: Date): void;
  setStates(values: Readonly<Record<string, string>>, now?: Date): void;
  deleteState(key: string): void;
}

export type ExclusionDirection = "personalToWork" | "workToPersonal";

export interface StoredExclusionKey {
  direction: ExclusionDirection;
  value: string;
  createdAt: string;
}

export interface StoredExclusionKeyword {
  direction: ExclusionDirection;
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
