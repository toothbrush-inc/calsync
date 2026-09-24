import { MANAGED_PROPERTY } from "./normalize.js";
import type { GoogleCalendarEvent } from "./normalize.js";
import type { ManagedBusyEvent, ManagedBusyEventInsert } from "./project.js";
import type {
  AccountRole,
  CalendarAPI,
  CalendarChangeSet,
  EventMapping,
  ExclusionSource,
  MappingStore,
  StoredExclusionKey,
  StoredExclusionKeyword,
  SyncStateStore,
} from "./types.js";

export class MemoryCalendar implements CalendarAPI {
  readonly events: GoogleCalendarEvent[];
  readonly insertedIds: string[] = [];
  readonly patchedIds: string[] = [];
  readonly deletedIds: string[] = [];
  failNextInsert = false;
  failNextDelete = false;

  constructor(events: GoogleCalendarEvent[] = []) {
    this.events = events;
  }

  listEvents(): Promise<GoogleCalendarEvent[]> {
    return Promise.resolve(structuredClone(this.events));
  }

  listManagedEvents(): Promise<GoogleCalendarEvent[]> {
    return Promise.resolve(
      structuredClone(
        this.events.filter(
          (event) => event.extendedProperties?.private?.[MANAGED_PROPERTY] === "true",
        ),
      ),
    );
  }

  insertEvent(
    _calendarId: string,
    event: ManagedBusyEventInsert,
  ): Promise<GoogleCalendarEvent | undefined> {
    if (this.failNextInsert) {
      this.failNextInsert = false;
      return Promise.reject(new Error("partial Google API failure"));
    }
    this.insertedIds.push(event.id);
    const inserted = { ...structuredClone(event), etag: `"inserted-${event.id}"` };
    this.events.push(inserted);
    return Promise.resolve(structuredClone(inserted));
  }

  patchEvent(
    _calendarId: string,
    eventId: string,
    event: ManagedBusyEvent,
  ): Promise<GoogleCalendarEvent> {
    const index = this.events.findIndex((candidate) => candidate.id === eventId);
    if (index < 0) {
      return Promise.reject(new Error("missing event"));
    }
    this.patchedIds.push(eventId);
    const patched = { id: eventId, ...structuredClone(event) };
    this.events[index] = patched;
    return Promise.resolve(structuredClone(patched));
  }

  deleteEvent(_calendarId: string, eventId: string): Promise<void> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      return Promise.reject(new Error("partial Google API failure"));
    }
    this.deletedIds.push(eventId);
    const index = this.events.findIndex((candidate) => candidate.id === eventId);
    if (index >= 0) {
      this.events.splice(index, 1);
    }
    return Promise.resolve();
  }
}

export class MemoryMappingStore implements MappingStore {
  private readonly mappings = new Map<string, EventMapping>();

  putMapping(mapping: EventMapping): void {
    this.mappings.set(mapping.mappingKey, { ...mapping });
  }

  getMapping(mappingKey: string): EventMapping | null {
    const mapping = this.mappings.get(mappingKey);
    return mapping === undefined ? null : { ...mapping };
  }

  listMappings(sourceRole?: AccountRole): EventMapping[] {
    const mappings = [...this.mappings.values()]
      .filter((mapping) => sourceRole === undefined || mapping.sourceRole === sourceRole)
      .sort((left, right) => left.mappingKey.localeCompare(right.mappingKey));
    return mappings.map((mapping) => ({ ...mapping }));
  }

  deleteMapping(mappingKey: string): void {
    this.mappings.delete(mappingKey);
  }
}

export class MemorySyncStateStore implements SyncStateStore {
  private readonly values = new Map<string, string>();

  getState(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setState(key: string, value: string): void {
    this.values.set(key, value);
  }

  setStates(values: Readonly<Record<string, string>>): void {
    for (const [key, value] of Object.entries(values)) {
      this.setState(key, value);
    }
  }

  deleteState(key: string): void {
    this.values.delete(key);
  }
}

export class MemoryExclusionSource implements ExclusionSource {
  constructor(
    private readonly keys: readonly StoredExclusionKey[] = [],
    private readonly keywords: readonly StoredExclusionKeyword[] = [],
  ) {}

  listExclusionKeys(): readonly StoredExclusionKey[] {
    return this.keys;
  }

  listExclusionKeywords(): readonly StoredExclusionKeyword[] {
    return this.keywords;
  }
}

export class IncrementalMemoryCalendar extends MemoryCalendar {
  readonly changeQueue: (CalendarChangeSet | Error)[] = [];
  fullReads = 0;
  private token = 0;

  constructor(
    private readonly name: string,
    events: GoogleCalendarEvent[] = [],
  ) {
    super(events);
  }

  override listEvents(): Promise<GoogleCalendarEvent[]> {
    this.fullReads += 1;
    return super.listEvents();
  }

  listChanges(): Promise<CalendarChangeSet> {
    const queued = this.changeQueue.shift();
    if (queued instanceof Error) {
      return Promise.reject(queued);
    }
    if (queued !== undefined) {
      return Promise.resolve(structuredClone(queued));
    }
    this.token += 1;
    return Promise.resolve({
      events: [],
      nextSyncToken: `${this.name}-token-${String(this.token)}`,
    });
  }
}
