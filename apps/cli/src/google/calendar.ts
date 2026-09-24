import {
  googleApiErrorInfo,
  isRetryableGoogleError,
  type CalendarAPI,
  type CalendarChangeSet,
  type CalendarListProgress,
  type CalendarWindow,
  type GoogleCalendarEvent,
  type ManagedBusyEvent,
  type ManagedBusyEventInsert,
} from "@calsync/engine";
import type { calendar_v3 } from "googleapis";

export type {
  CalendarAPI,
  CalendarChangeSet,
  CalendarListProgress,
  CalendarWindow,
} from "@calsync/engine";
export {
  googleApiErrorInfo,
  isInvalidSyncTokenError,
  isRetryableGoogleError,
  type GoogleApiErrorInfo,
} from "@calsync/engine";

interface ApiResponse<T> {
  data: T;
}

interface EventListData {
  items?: GoogleCalendarEvent[] | null;
  nextPageToken?: string | null;
  nextSyncToken?: string | null;
}

export interface EventListParameters {
  calendarId: string;
  timeMin?: string;
  timeMax?: string;
  singleEvents?: true;
  showDeleted?: boolean;
  maxResults: number;
  orderBy?: "startTime";
  timeZone?: string;
  pageToken?: string;
  syncToken?: string;
  fields?: string;
  privateExtendedProperty?: string[];
}

export interface EventInsertParameters {
  calendarId: string;
  requestBody: ManagedBusyEventInsert;
  sendUpdates: "none";
}

export interface EventPatchParameters {
  calendarId: string;
  eventId: string;
  requestBody: ManagedBusyEvent;
  sendUpdates: "none";
}

export interface EventDeleteParameters {
  calendarId: string;
  eventId: string;
  sendUpdates: "none";
}

export interface GoogleCalendarApi {
  events: {
    list(parameters: EventListParameters): Promise<ApiResponse<EventListData>>;
    insert(parameters: EventInsertParameters): Promise<ApiResponse<GoogleCalendarEvent>>;
    patch(
      parameters: EventPatchParameters,
      options?: { headers?: Record<string, string> },
    ): Promise<ApiResponse<GoogleCalendarEvent>>;
    delete(parameters: EventDeleteParameters): Promise<ApiResponse<unknown>>;
  };
}

export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  random: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  initialDelayMs: 250,
  maxDelayMs: 4_000,
  random: Math.random,
  sleep: async (milliseconds) => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  },
};

function isTransient(error: unknown): boolean {
  return isRetryableGoogleError(error);
}

export async function withRetries<T>(operation: () => Promise<T>, policy: RetryPolicy): Promise<T> {
  let attempt = 1;
  for (;;) {
    try {
      return await operation();
    } catch (error: unknown) {
      if (attempt >= policy.maxAttempts || !isTransient(error)) {
        throw error;
      }

      const exponentialDelay = Math.min(
        policy.maxDelayMs,
        policy.initialDelayMs * 2 ** (attempt - 1),
      );
      const jitteredDelay = Math.floor(exponentialDelay * policy.random());
      const retryAfterMs = googleApiErrorInfo(error).retryAfterMs;
      await policy.sleep(retryAfterMs ?? jitteredDelay);
      attempt += 1;
    }
  }
}

export function isStatus(error: unknown, status: number): boolean {
  return googleApiErrorInfo(error).status === status;
}

export class CalendarClient implements CalendarAPI {
  readonly #api: GoogleCalendarApi;
  readonly #retryPolicy: RetryPolicy;

  constructor(api: GoogleCalendarApi, retryPolicy: Partial<RetryPolicy> = {}) {
    this.#api = api;
    this.#retryPolicy = { ...DEFAULT_RETRY_POLICY, ...retryPolicy };
    if (this.#retryPolicy.maxAttempts < 1) {
      throw new Error("Retry policy maxAttempts must be at least one");
    }
  }

  async listEvents(
    calendarId: string,
    window: CalendarWindow,
    onProgress?: (progress: CalendarListProgress) => void,
  ): Promise<GoogleCalendarEvent[]> {
    const events: GoogleCalendarEvent[] = [];
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;

    do {
      const parameters: EventListParameters = {
        calendarId,
        timeMin: window.timeMin,
        timeMax: window.timeMax,
        singleEvents: true,
        showDeleted: true,
        maxResults: 2_500,
        orderBy: "startTime",
      };
      if (window.timeZone !== undefined) {
        parameters.timeZone = window.timeZone;
      }
      if (pageToken !== undefined) {
        parameters.pageToken = pageToken;
      }

      const response = await withRetries(
        async () => this.#api.events.list(parameters),
        this.#retryPolicy,
      );
      events.push(...(response.data.items ?? []));
      onProgress?.({ fetched: events.length, complete: false });

      const nextPageToken = response.data.nextPageToken ?? undefined;
      if (nextPageToken !== undefined) {
        if (seenPageTokens.has(nextPageToken)) {
          throw new Error("Google Calendar returned a repeated page token");
        }
        seenPageTokens.add(nextPageToken);
      }
      pageToken = nextPageToken;
    } while (pageToken !== undefined);

    onProgress?.({ fetched: events.length, complete: true });
    return events;
  }

  async listManagedEvents(
    calendarId: string,
    onProgress?: (progress: CalendarListProgress) => void,
  ): Promise<GoogleCalendarEvent[]> {
    const events: GoogleCalendarEvent[] = [];
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const parameters: EventListParameters = {
        calendarId,
        showDeleted: false,
        maxResults: 2_500,
        privateExtendedProperty: ["calsyncManaged=true"],
      };
      if (pageToken !== undefined) {
        parameters.pageToken = pageToken;
      }
      const response = await withRetries(
        async () => this.#api.events.list(parameters),
        this.#retryPolicy,
      );
      events.push(...(response.data.items ?? []));
      onProgress?.({ fetched: events.length, complete: false });
      const nextPageToken = response.data.nextPageToken ?? undefined;
      if (nextPageToken !== undefined) {
        if (seenPageTokens.has(nextPageToken)) {
          throw new Error("Google Calendar returned a repeated page token");
        }
        seenPageTokens.add(nextPageToken);
      }
      pageToken = nextPageToken;
    } while (pageToken !== undefined);
    onProgress?.({ fetched: events.length, complete: true });
    return events;
  }

  async listChanges(
    calendarId: string,
    options: { syncToken?: string } = {},
    onProgress?: (progress: CalendarListProgress) => void,
  ): Promise<CalendarChangeSet> {
    const events: GoogleCalendarEvent[] = [];
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;
    do {
      const parameters: EventListParameters = {
        calendarId,
        showDeleted: true,
        maxResults: 2_500,
        fields: "items(id,status,etag,extendedProperties/private),nextPageToken,nextSyncToken",
      };
      if (options.syncToken !== undefined) {
        parameters.syncToken = options.syncToken;
      }
      if (pageToken !== undefined) {
        parameters.pageToken = pageToken;
      }

      const response = await withRetries(
        async () => this.#api.events.list(parameters),
        this.#retryPolicy,
      );
      events.push(...(response.data.items ?? []));
      onProgress?.({ fetched: events.length, complete: false });
      const returnedPageToken = response.data.nextPageToken ?? undefined;
      if (returnedPageToken !== undefined) {
        if (seenPageTokens.has(returnedPageToken)) {
          throw new Error("Google Calendar returned a repeated page token");
        }
        seenPageTokens.add(returnedPageToken);
      } else {
        nextSyncToken = response.data.nextSyncToken ?? undefined;
      }
      pageToken = returnedPageToken;
    } while (pageToken !== undefined);

    if (nextSyncToken === undefined) {
      throw new Error("Google Calendar response ended without a next sync token");
    }
    onProgress?.({ fetched: events.length, complete: true });
    return { events, nextSyncToken };
  }

  async insertEvent(
    calendarId: string,
    event: ManagedBusyEventInsert,
  ): Promise<GoogleCalendarEvent | undefined> {
    try {
      const response = await withRetries(
        async () =>
          this.#api.events.insert({
            calendarId,
            requestBody: event,
            sendUpdates: "none",
          }),
        this.#retryPolicy,
      );
      return response.data;
    } catch (error: unknown) {
      // The deterministic event ID makes a conflict equivalent to success,
      // including when a prior insert succeeded but its response was lost.
      if (!isStatus(error, 409)) {
        throw error;
      }
      return undefined;
    }
  }

  async patchEvent(
    calendarId: string,
    eventId: string,
    event: ManagedBusyEvent,
    etag?: string,
  ): Promise<GoogleCalendarEvent> {
    const options = etag === undefined ? undefined : { headers: { "If-Match": etag } };
    const response = await withRetries(
      async () =>
        this.#api.events.patch(
          {
            calendarId,
            eventId,
            requestBody: event,
            sendUpdates: "none",
          },
          options,
        ),
      this.#retryPolicy,
    );
    return response.data;
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    try {
      await withRetries(
        async () =>
          this.#api.events.delete({
            calendarId,
            eventId,
            sendUpdates: "none",
          }),
        this.#retryPolicy,
      );
    } catch (error: unknown) {
      // Desired state is already achieved if Google no longer has the event.
      if (!isStatus(error, 404) && !isStatus(error, 410)) {
        throw error;
      }
    }
  }
}

export function createGoogleCalendarClient(
  api: calendar_v3.Calendar,
  retryPolicy: Partial<RetryPolicy> = {},
): CalendarClient {
  return new CalendarClient(api, retryPolicy);
}
