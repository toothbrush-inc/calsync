import { createHash } from "node:crypto";

import { systemClock } from "./clock.js";
import { googleApiErrorInfo, isRetryableGoogleError } from "./errors.js";
import type {
  CalendarAPI,
  CalendarConfig,
  CalendarKey,
  CalendarWindow,
  Clock,
  EventMapping,
  MappingStore,
  SyncConfig,
} from "./types.js";
import {
  isTitleExcludedByKeyword,
  matchingSourceExclusion,
  sourceExclusionKeys,
  type SourceExclusionKeys,
  type SourceExclusionScope,
} from "./exclusion.js";
import {
  canonicalDateTime,
  isManagedEvent,
  MAPPING_PROPERTY,
  normalizeSourceEvents,
  type GoogleCalendarEvent,
  type NormalizedEventTime,
  type NormalizedSourceEvent,
} from "./normalize.js";
import {
  managedGoogleEventId,
  matchesManagedProjection,
  projectBusyEvent,
  projectBusyEventInsert,
} from "./project.js";

export type ReconcileOperation = "create" | "update" | "delete" | "repair";

export type ReconcileReason =
  | "destination-missing"
  | "destination-cancelled"
  | "destination-drifted"
  | "source-no-longer-desired"
  | "duplicate-destination"
  | "duplicate-busy-block"
  | "phantom-busy-block"
  | "mapping-missing"
  | "rebuild-mapping"
  | "cleanup-managed-event";

export type ReconcileTimeRange =
  { kind: "timed"; start: string; end: string } | { kind: "all-day"; start: string; end: string };

export interface ReconcileLog {
  operation: ReconcileOperation;
  /** Calendar holding the block. */
  destinationKey: CalendarKey;
  /** Calendars whose events merged into the block, when they are still known. */
  sourceKeys?: CalendarKey[];
  reason: ReconcileReason;
  timeRange?: ReconcileTimeRange;
  /** Titles of every source merged into the block, in start order; untitled sources are left out. */
  sourceTitles?: string[];
  dryRun: boolean;
}

export interface ReconcileSourceDetail {
  sourceKey: CalendarKey;
  sourceTitle?: string;
  timeRange: ReconcileTimeRange;
  exclusionKeys: SourceExclusionKeys;
  exclusionReason?: SourceExclusionScope | "keyword";
  isRecurring: boolean;
}

export interface ReconcileResult {
  created: number;
  updated: number;
  deleted: number;
  repaired: number;
}

/** What one destination holds after a pass. */
export interface DestinationSummary {
  /** Busy blocks on the calendar. */
  active: number;
  /** Source events left out because the same meeting is already on this calendar. */
  duplicateSuppressed: number;
}

/** What one source calendar contributed. */
export interface SourceSummary {
  /** Events an exclusion holds back from every destination. */
  excluded: number;
}

export interface SyncReconcileResult extends ReconcileResult {
  failed: number;
  converged: boolean;
  destinations: Record<CalendarKey, DestinationSummary>;
  sources: Record<CalendarKey, SourceSummary>;
}

/**
 * Outcome of a stray-block cleanup. `deleted` counts every removed block;
 * the per-calendar fields say where they sat and why they went: a duplicate
 * shared its slot with a block that stays, a phantom had no live source and
 * nothing else in its slot.
 */
export interface DedupeResult extends ReconcileResult {
  /** Active managed busy blocks inspected on each calendar. */
  inspected: Record<CalendarKey, number>;
  /** Removed from each calendar — or, in a dry run, that would be. */
  duplicates: Record<CalendarKey, number>;
  phantoms: Record<CalendarKey, number>;
  failed: number;
}

export type StrayBlockKind = "duplicate" | "phantom";

/** Timer seams for the prune's pacing and backoff; tests swap in fakes. */
export interface ReconcilePacing {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

export interface ReconcileOptions {
  dryRun?: boolean;
  now?: Date;
  pacing?: ReconcilePacing;
  log?: (entry: ReconcileLog) => void;
  onSourceEvent?: (entry: ReconcileSourceDetail) => void;
  onProgress?: (progress: ReconcileProgress) => void;
  /**
   * Each managed block a sync pass deleted. Google reports the deletion back
   * as a cancelled change; the caller remembers these to tell its own
   * deletions from someone else's.
   */
  onDestinationDeleted?: (destinationKey: CalendarKey, eventId: string) => void;
}

export interface ReconcileProgress {
  phase: "discovering" | "planning" | "applying" | "finalizing";
  label: string;
  completed: number;
  total?: number;
  succeeded: number;
  failed: number;
}

type Clients = Readonly<Record<CalendarKey, CalendarAPI>>;
type EventSets = Map<CalendarKey, GoogleCalendarEvent[]>;
type ManagedBlock = GoogleCalendarEvent & { id: string };

/** A source event and the calendar it came from. */
interface Sourced {
  calendarKey: CalendarKey;
  event: NormalizedSourceEvent;
}

/**
 * One merged busy interval for a destination calendar: the union of every
 * desired source event that overlaps or abuts it. Identity comes from the
 * interval itself, so the same slot always maps to the same block however
 * many sources stand behind it.
 */
interface BusyBlock {
  time: NormalizedEventTime;
  sources: Sourced[];
}

interface EvaluatedSource {
  source: NormalizedSourceEvent;
  exclusionReason: SourceExclusionScope | "keyword" | undefined;
}

/** Every calendar read once: raw events, and each calendar's own (native) events. */
interface Discovery {
  events: EventSets;
  natives: Map<CalendarKey, NormalizedSourceEvent[]>;
  /** Per source calendar, its events with exclusions applied. */
  evaluated: Map<CalendarKey, EvaluatedSource[]>;
}

interface DestinationPlan {
  blocks: Map<string, BusyBlock>;
  duplicateSuppressed: number;
}

const EMPTY_RESULT: ReconcileResult = { created: 0, updated: 0, deleted: 0, repaired: 0 };
/**
 * Stray-block deletes: a few in flight, and never started closer together
 * than the spacing. Google's default per-user quota is about ten requests a
 * second; five unpaced deletes at typical latency blew through it in
 * production, and the retries only made it worse. Three in flight at one
 * start per 150 ms tops out near seven a second, quota left over for the
 * daemon's own passes.
 *
 * Google also limits sustained writes to one calendar, well below the
 * per-user quota: a 540-block prune at seven a second tripped it near the
 * end. So a long prune starts at half the rate, and any throttled reply
 * pauses every worker, doubles the pause and the spacing for next time, and
 * puts the block back in line instead of failing it.
 */
const DELETE_CONCURRENCY = 3;
const DELETE_SPACING_MS = 150;
const LONG_PRUNE_BLOCKS = 100;
const LONG_PRUNE_SPACING_MS = 300;
const MAX_DELETE_SPACING_MS = 1_200;
const INITIAL_COOLDOWN_MS = 5_000;
const MAX_COOLDOWN_MS = 60_000;
/**
 * Replacement IDs tried when a returning slot's ID belongs to a deleted block.
 * Each return of the same slot consumes one; a slot vacated and refilled this
 * often within Google's tombstone retention is not plausible.
 */
const MAX_TOMBSTONE_LINKS = 32;
/** Tries per block across cooldowns, on top of the adapter's own quick retries. */
const MAX_DELETE_ATTEMPTS = 6;

export class ReconcilePassError extends Error {
  override readonly name = "ReconcilePassError";

  constructor(
    readonly result: SyncReconcileResult,
    cause: unknown,
  ) {
    super(
      `${String(result.failed)} reconciliation ${result.failed === 1 ? "operation" : "operations"} failed`,
      { cause },
    );
  }
}

export class CleanupPassError extends Error {
  override readonly name = "CleanupPassError";

  constructor(
    readonly result: ReconcileResult,
    readonly failed: number,
    cause: unknown,
  ) {
    super(
      `Cleanup incomplete: ${String(result.deleted)} deleted, ${String(failed)} failed; retry cleanup before syncing`,
      { cause },
    );
  }
}

export class DedupePassError extends Error {
  override readonly name = "DedupePassError";

  constructor(
    readonly result: DedupeResult,
    cause: unknown,
  ) {
    super(
      `Stray-block cleanup incomplete: ${String(result.deleted)} removed, ${String(result.failed)} failed; run it again`,
      { cause },
    );
  }
}

export class Reconciler {
  constructor(
    private readonly config: SyncConfig,
    private readonly mappings: MappingStore,
    private readonly clients: Clients,
    private readonly clock: Clock = systemClock,
  ) {
    for (const calendar of config.calendars) {
      if (clients[calendar.key] === undefined) {
        throw new Error(`No calendar client for "${calendar.key}"`);
      }
    }
  }

  async reconcile(options: ReconcileOptions = {}): Promise<SyncReconcileResult> {
    const now = options.now ?? this.clock.now();
    const discovery = await this.discover(
      calendarWindow(this.config, now),
      options,
      "Planning reconciliation",
    );
    const result: SyncReconcileResult = {
      ...EMPTY_RESULT,
      failed: 0,
      converged: true,
      destinations: {},
      sources: {},
    };
    const failures: unknown[] = [];

    for (const [sourceKey, evaluated] of discovery.evaluated) {
      for (const { source, exclusionReason } of evaluated) {
        options.onSourceEvent?.({
          sourceKey,
          ...(source.sourceTitle === undefined ? {} : { sourceTitle: source.sourceTitle }),
          timeRange: normalizedTimeRange(source),
          exclusionKeys: sourceExclusionKeys(sourceKey, source),
          ...(exclusionReason === undefined ? {} : { exclusionReason }),
          isRecurring: source.isRecurring,
        });
      }
      result.sources[sourceKey] = {
        excluded: evaluated.filter(({ exclusionReason }) => exclusionReason !== undefined).length,
      };
    }
    for (const calendar of this.config.calendars) {
      // A calendar that stopped receiving blocks is reconciled against an
      // empty plan until the blocks it still holds are gone.
      if (
        !calendar.destination &&
        this.mappings.listMappings(calendar.key, this.config.tenantId).length === 0
      ) {
        continue;
      }
      const summary = await this.reconcileDestination(
        calendar,
        discovery,
        result,
        options,
        now,
        failures,
      );
      if (calendar.destination) {
        result.destinations[calendar.key] = summary;
      }
    }
    result.converged = result.failed === 0;
    reportProgress(options, {
      phase: "finalizing",
      label: "Finalizing reconciliation",
      completed: 1,
      total: 1,
      succeeded: result.created + result.updated + result.deleted + result.repaired,
      failed: result.failed,
    });
    if (!result.converged) {
      throw new ReconcilePassError(result, failures[0]);
    }
    return result;
  }

  async rebuild(options: ReconcileOptions = {}): Promise<ReconcileResult> {
    const now = options.now ?? this.clock.now();
    const discovery = await this.discover(
      calendarWindow(this.config, now),
      options,
      "Planning mapping rebuild",
    );
    const result = { ...EMPTY_RESULT };

    if (!options.dryRun) {
      for (const mapping of this.mappings.listMappings(undefined, this.config.tenantId)) {
        this.mappings.deleteMapping(mapping.mappingKey, this.config.tenantId);
      }
    }
    for (const destination of this.destinations()) {
      const { blocks } = this.planDestination(destination.key, discovery);
      for (const event of activeManagedEvents(discovery.events.get(destination.key) ?? [])) {
        const key = managedMappingKey(event);
        const block = key === undefined ? undefined : blocks.get(key);
        if (key === undefined || block === undefined || event.id == null) {
          continue;
        }
        if (!options.dryRun) {
          this.mappings.putMapping(toMapping(key, destination.key, event, now));
        }
        record(result, "repair", destination.key, "rebuild-mapping", options, {
          timeRange: blockTimeRange(block),
          block,
        });
      }
    }
    return result;
  }

  async cleanup(options: ReconcileOptions = {}): Promise<ReconcileResult> {
    const events = await this.listManaged(options);
    const result = { ...EMPTY_RESULT };
    const managed = [...events].map(
      ([key, calendarEvents]) => [key, activeManagedEvents(calendarEvents).filter(hasId)] as const,
    );
    const total = managed.reduce((sum, [, blocks]) => sum + blocks.length, 0);
    let completed = 0;
    let failed = 0;
    const progress = (): void => {
      reportProgress(options, {
        phase: "applying",
        label: "Deleting managed mirrors",
        completed,
        total,
        succeeded: result.deleted,
        failed,
      });
    };
    progress();
    for (const [calendarKey, blocks] of managed) {
      for (const event of blocks) {
        try {
          if (!options.dryRun) {
            await this.clients[calendarKey]?.deleteEvent(this.calendarId(calendarKey), event.id);
          }
          record(result, "delete", calendarKey, "cleanup-managed-event", options, {
            timeRange: eventTimeRange(event),
          });
        } catch (error) {
          failed += 1;
          completed += 1;
          progress();
          throw new CleanupPassError(result, failed, error);
        }
        completed += 1;
        progress();
      }
    }
    if (!options.dryRun) {
      for (const mapping of this.mappings.listMappings(undefined, this.config.tenantId)) {
        this.mappings.deleteMapping(mapping.mappingKey, this.config.tenantId);
      }
    }
    reportProgress(options, {
      phase: "finalizing",
      label: "Clearing local mappings",
      completed: 1,
      total: 1,
      succeeded: result.deleted,
      failed,
    });
    return result;
  }

  /**
   * Removes managed busy blocks that nothing stands behind. The sync pass
   * only ever sees a block through its mapping key, so a mirror left behind
   * by a reinstall, a key-format change, or a source Google re-created under
   * a new identity is never reclaimed: it sits beside its replacement as a
   * duplicate, or alone as a phantom once the source moves or goes. Every
   * block whose source is live (the next pass would mirror it) is kept, one
   * per key; every other managed block goes, including any that sits outside
   * the sync window, which the sync pass would never mirror and already
   * deletes when it can see it. Real events are never candidates, only
   * calsync's own blocks. A calendar that no longer receives blocks keeps
   * none: every managed block on it is a phantom.
   */
  async dedupe(options: ReconcileOptions = {}): Promise<DedupeResult> {
    const now = options.now ?? this.clock.now();
    const discovery = await this.discover(
      calendarWindow(this.config, now),
      options,
      "Planning stray-block cleanup",
    );
    const managed = await this.listManaged(options);
    const result: DedupeResult = {
      ...EMPTY_RESULT,
      inspected: {},
      duplicates: {},
      phantoms: {},
      failed: 0,
    };
    const removals: {
      calendarKey: CalendarKey;
      block: ManagedBlock;
      kind: StrayBlockKind;
      mappingKey?: string;
    }[] = [];
    for (const calendar of this.config.calendars) {
      const desired = calendar.destination
        ? this.planDestination(calendar.key, discovery).blocks
        : new Map<string, BusyBlock>();
      const mappedIds = new Map(
        this.mappings
          .listMappings(calendar.key, this.config.tenantId)
          .map((mapping) => [mapping.destinationEventId, mapping.mappingKey]),
      );
      const blocks = activeManagedEvents(discovery.events.get(calendar.key) ?? []).filter(hasId);
      const inWindow = new Set(blocks.map((block) => block.id));
      // Managed blocks the window read did not return lie outside it: nothing
      // there can be desired, so every one of them is a phantom.
      const outside = activeManagedEvents(managed.get(calendar.key) ?? [])
        .filter(hasId)
        .filter((block) => !inWindow.has(block.id));
      result.inspected[calendar.key] = blocks.length + outside.length;
      result.duplicates[calendar.key] = 0;
      result.phantoms[calendar.key] = 0;
      const strays = [
        ...[...groupByTimeRange(blocks).values()].flatMap((group) =>
          strayBlocks(group, desired, mappedIds),
        ),
        ...outside.map((block) => ({ block, kind: "phantom" as const })),
      ];
      for (const { block, kind } of strays) {
        const mappingKey = mappedIds.get(block.id);
        removals.push({
          calendarKey: calendar.key,
          block,
          kind,
          ...(mappingKey === undefined ? {} : { mappingKey }),
        });
      }
    }

    const failures: unknown[] = [];
    let completed = 0;
    const progress = (): void => {
      reportProgress(options, {
        phase: "applying",
        label: "Removing stray busy blocks",
        completed,
        total: removals.length,
        succeeded: result.deleted,
        failed: result.failed,
      });
    };
    progress();
    const pacer = new DeletePacer(
      removals.length > LONG_PRUNE_BLOCKS ? LONG_PRUNE_SPACING_MS : DELETE_SPACING_MS,
      options.pacing ?? SYSTEM_PACING,
      (pauseMs) => {
        reportProgress(options, {
          phase: "applying",
          label: `Google asked us to slow down; pausing ${String(Math.ceil(pauseMs / 1000))}s`,
          completed,
          total: removals.length,
          succeeded: result.deleted,
          failed: result.failed,
        });
      },
    );
    await forEachConcurrently(removals, DELETE_CONCURRENCY, async (removal) => {
      const { calendarKey, block, kind, mappingKey } = removal;
      // A dry run deletes nothing, so it has nothing to pace.
      const deleted =
        options.dryRun === true ||
        (await this.deleteWithBackoff(calendarKey, block.id, pacer, result, failures));
      if (deleted) {
        if (options.dryRun !== true && mappingKey !== undefined) {
          this.mappings.deleteMapping(mappingKey, this.config.tenantId);
        }
        const counts = kind === "duplicate" ? result.duplicates : result.phantoms;
        counts[calendarKey] = (counts[calendarKey] ?? 0) + 1;
        record(
          result,
          "delete",
          calendarKey,
          kind === "duplicate" ? "duplicate-busy-block" : "phantom-busy-block",
          options,
          { timeRange: eventTimeRange(block) },
        );
      }
      completed += 1;
      progress();
    });
    reportProgress(options, {
      phase: "finalizing",
      label: "Finalizing stray-block cleanup",
      completed: 1,
      total: 1,
      succeeded: result.deleted,
      failed: result.failed,
    });
    if (result.failed > 0) {
      throw new DedupePassError(result, failures[0]);
    }
    return result;
  }

  /**
   * One paced delete. A throttled or transient reply cools every worker down
   * through the shared pacer and tries this block again; anything else, or
   * running out of tries, counts as a failure the caller reports at the end.
   */
  private async deleteWithBackoff(
    calendarKey: CalendarKey,
    eventId: string,
    pacer: DeletePacer,
    result: { failed: number },
    failures: unknown[],
  ): Promise<boolean> {
    for (let attempt = 1; ; attempt += 1) {
      const startedAt = await pacer.turn();
      try {
        await this.client(calendarKey).deleteEvent(this.calendarId(calendarKey), eventId);
        return true;
      } catch (error) {
        if (attempt >= MAX_DELETE_ATTEMPTS || !isRetryableGoogleError(error)) {
          result.failed += 1;
          failures.push(error);
          return false;
        }
        pacer.throttled(startedAt, googleApiErrorInfo(error).retryAfterMs);
      }
    }
  }

  private destinations(): CalendarConfig[] {
    return this.config.calendars.filter((calendar) => calendar.destination);
  }

  private client(key: CalendarKey): CalendarAPI {
    const client = this.clients[key];
    if (client === undefined) {
      throw new Error(`No calendar client for "${key}"`);
    }
    return client;
  }

  private calendarId(key: CalendarKey): string {
    const calendar = this.config.calendars.find((candidate) => candidate.key === key);
    if (calendar === undefined) {
      throw new Error(`Unknown calendar "${key}"`);
    }
    return calendar.calendarId;
  }

  /** Every managed block on every calendar, whatever its date. */
  private async listManaged(options: ReconcileOptions): Promise<EventSets> {
    return this.readAll(options, "Finding managed mirrors", (calendar, onProgress) =>
      this.client(calendar.key).listManagedEvents(calendar.calendarId, onProgress),
    );
  }

  /**
   * Reads every calendar once and separates each one's own events from the
   * blocks calsync wrote to it, then applies each source's exclusions.
   */
  private async discover(
    window: CalendarWindow,
    options: ReconcileOptions,
    label: string,
  ): Promise<Discovery> {
    const events = await this.readAll(options, "Reading calendar events", (calendar, onProgress) =>
      this.client(calendar.key).listEvents(calendar.calendarId, window, onProgress),
    );
    const discovered = [...events.values()].reduce((sum, list) => sum + list.length, 0);
    reportProgress(options, {
      phase: "planning",
      label,
      completed: discovered,
      total: discovered,
      succeeded: 0,
      failed: 0,
    });
    const natives = new Map<CalendarKey, NormalizedSourceEvent[]>();
    const evaluated = new Map<CalendarKey, EvaluatedSource[]>();
    for (const calendar of this.config.calendars) {
      const knownBlockIds = new Set(
        this.mappings
          .listMappings(calendar.key, this.config.tenantId)
          .map((mapping) => mapping.destinationEventId),
      );
      const own = normalizeSourceEvents(
        (events.get(calendar.key) ?? []).filter(
          (event) => event.id == null || !knownBlockIds.has(event.id),
        ),
      );
      natives.set(calendar.key, own);
      if (calendar.source) {
        evaluated.set(calendar.key, this.evaluateSource(calendar.key, own));
      }
    }
    return { events, natives, evaluated };
  }

  /** Applies one source calendar's exclusions to its events. */
  private evaluateSource(
    sourceKey: CalendarKey,
    sourceEvents: readonly NormalizedSourceEvent[],
  ): EvaluatedSource[] {
    const keys = this.config.exclusions.keys[sourceKey] ?? [];
    const keywords = this.config.exclusions.keywords[sourceKey] ?? [];
    return sourceEvents.map((source): EvaluatedSource => {
      const keyExclusion = matchingSourceExclusion(keys, sourceKey, source);
      return {
        source,
        exclusionReason:
          keyExclusion ??
          (isTitleExcludedByKeyword(source.sourceTitle, keywords)
            ? ("keyword" as const)
            : undefined),
      };
    });
  }

  /**
   * The busy blocks one destination should hold: every other source
   * calendar's desired events, merged into disjoint intervals. An event whose
   * meeting is already on the destination is left out: that is one
   * commitment, not two. The destination's other events never suppress a
   * block, even one they cover in full: the block says another calendar is
   * busy too.
   */
  private planDestination(destinationKey: CalendarKey, discovery: Discovery): DestinationPlan {
    const nativeMeetings = new Set(
      (discovery.natives.get(destinationKey) ?? []).flatMap(
        (event) => event.duplicateMatchKey ?? [],
      ),
    );
    const desired: Sourced[] = [];
    let duplicateSuppressed = 0;
    for (const [sourceKey, evaluated] of discovery.evaluated) {
      if (sourceKey === destinationKey) {
        continue;
      }
      for (const { source, exclusionReason } of evaluated) {
        if (exclusionReason !== undefined) {
          continue;
        }
        if (
          source.duplicateMatchKey !== undefined &&
          nativeMeetings.has(source.duplicateMatchKey)
        ) {
          duplicateSuppressed += 1;
          continue;
        }
        desired.push({ calendarKey: sourceKey, event: source });
      }
    }
    const blocks = new Map(
      mergeBusyBlocks(desired).map((block) => [
        busyBlockKey(destinationKey, block.time, this.config.tenantId),
        block,
      ]),
    );
    return { blocks, duplicateSuppressed };
  }

  /** Runs one read per calendar concurrently, reporting the running total. */
  private async readAll(
    options: ReconcileOptions,
    label: string,
    read: (
      calendar: CalendarConfig,
      onProgress: (progress: { fetched: number }) => void,
    ) => Promise<GoogleCalendarEvent[]>,
  ): Promise<EventSets> {
    const fetched = new Map<CalendarKey, number>();
    const report = (total?: number): void => {
      reportProgress(options, {
        phase: "discovering",
        label,
        completed: [...fetched.values()].reduce((sum, count) => sum + count, 0),
        ...(total === undefined ? {} : { total }),
        succeeded: 0,
        failed: 0,
      });
    };
    report();
    const lists = await Promise.all(
      this.config.calendars.map(async (calendar) => {
        const events = await read(calendar, (progress) => {
          fetched.set(calendar.key, progress.fetched);
          report();
        });
        return [calendar.key, events] as const;
      }),
    );
    const events: EventSets = new Map(lists);
    for (const [key, list] of events) {
      fetched.set(key, list.length);
    }
    report([...fetched.values()].reduce((sum, count) => sum + count, 0));
    return events;
  }

  private async reconcileDestination(
    destinationCalendar: CalendarConfig,
    discovery: Discovery,
    result: SyncReconcileResult,
    options: ReconcileOptions,
    now: Date,
    failures: unknown[],
  ): Promise<DestinationSummary> {
    const destinationKey = destinationCalendar.key;
    const destinationCalendarId = destinationCalendar.calendarId;
    const client = this.client(destinationKey);
    const destinationEvents = discovery.events.get(destinationKey) ?? [];
    const { blocks, duplicateSuppressed } = destinationCalendar.destination
      ? this.planDestination(destinationKey, discovery)
      : { blocks: new Map<string, BusyBlock>(), duplicateSuppressed: 0 };
    const summary: DestinationSummary = {
      active: options.dryRun === true ? blocks.size : 0,
      duplicateSuppressed,
    };
    const managedByKey = indexManagedEvents(destinationEvents);
    const mappings = new Map(
      this.mappings
        .listMappings(destinationKey, this.config.tenantId)
        .map((mapping) => [mapping.mappingKey, mapping]),
    );
    const total = blocks.size + [...mappings.keys()].filter((key) => !blocks.has(key)).length;
    let completed = 0;
    let succeeded = 0;
    let failed = 0;
    const progress = (): void => {
      reportProgress(options, {
        phase: "applying",
        label: `Applying busy blocks to ${destinationKey}`,
        completed,
        total,
        succeeded,
        failed,
      });
    };
    const finishItem = (failuresBefore: number, operationsBefore: number): void => {
      completed += 1;
      if (result.failed > failuresBefore) {
        failed += 1;
      } else if (operationCount(result) > operationsBefore) {
        succeeded += 1;
      }
      progress();
    };
    progress();

    for (const mapping of mappings.values()) {
      if (blocks.has(mapping.mappingKey)) {
        continue;
      }
      const failuresBefore = result.failed;
      const operationsBefore = operationCount(result);
      const destination =
        destinationEvents.find((event) => event.id === mapping.destinationEventId) ??
        managedByKey.get(mapping.mappingKey)?.[0];
      if (
        options.dryRun !== true &&
        !(await attemptOperation(
          () => client.deleteEvent(destinationCalendarId, mapping.destinationEventId),
          result,
          failures,
        ))
      ) {
        finishItem(failuresBefore, operationsBefore);
        continue;
      }
      if (options.dryRun !== true) {
        options.onDestinationDeleted?.(destinationKey, mapping.destinationEventId);
      }
      record(result, "delete", destinationKey, "source-no-longer-desired", options, {
        timeRange: destination === undefined ? undefined : eventTimeRange(destination),
      });
      if (options.dryRun !== true) {
        this.mappings.deleteMapping(mapping.mappingKey, this.config.tenantId);
      }
      finishItem(failuresBefore, operationsBefore);
    }

    for (const [key, block] of blocks) {
      const failuresBefore = result.failed;
      const operationsBefore = operationCount(result);
      const knownMapping = mappings.get(key);
      const candidates = managedByKey.get(key) ?? [];
      let destination =
        destinationEvents.find((event) => event.id === knownMapping?.destinationEventId) ??
        candidates.find((event) => event.id === knownMapping?.destinationEventId) ??
        candidates.find((event) => event.status !== "cancelled");
      const adoptedExisting =
        knownMapping === undefined &&
        destination !== undefined &&
        destination.status !== "cancelled" &&
        destination.id != null;
      const extras = candidates.filter(
        (event) => event !== destination && event.status !== "cancelled" && event.id != null,
      );
      if (
        options.dryRun !== true &&
        destination !== undefined &&
        destination.status !== "cancelled" &&
        destination.id != null
      ) {
        summary.active += 1;
      }
      for (const extra of extras) {
        const extraId = extra.id;
        if (extraId == null) {
          continue;
        }
        if (
          options.dryRun !== true &&
          !(await attemptOperation(
            () => client.deleteEvent(destinationCalendarId, extraId),
            result,
            failures,
          ))
        ) {
          finishItem(failuresBefore, operationsBefore);
          continue;
        }
        if (options.dryRun !== true) {
          options.onDestinationDeleted?.(destinationKey, extraId);
        }
        record(result, "delete", destinationKey, "duplicate-destination", options, {
          timeRange: eventTimeRange(extra),
          block,
        });
      }

      if (
        destination === undefined ||
        destination.status === "cancelled" ||
        destination.id == null
      ) {
        const reason =
          destination?.status === "cancelled" ? "destination-cancelled" : "destination-missing";
        const insert = projectBusyEventInsert(block, key);
        if (knownMapping !== undefined || destination?.status === "cancelled") {
          const tombstone = destination?.id ?? knownMapping?.destinationEventId ?? insert.id;
          insert.id = managedGoogleEventId(`${key}:replacement:${tombstone}`);
        }
        let inserted: GoogleCalendarEvent | undefined;
        if (
          options.dryRun !== true &&
          !(await attemptOperation(
            async () => {
              inserted = await client.insertEvent(destinationCalendarId, insert);
              // A slot that comes back reuses its interval key, and the ID it
              // derives may belong to a block deleted earlier. Google keeps
              // that tombstone and answers the insert with a conflict, so
              // follow the chain of IDs derived from each tombstone until one
              // is free: every return of the slot used up one link.
              for (
                let link = 0;
                inserted?.status === "cancelled" && link < MAX_TOMBSTONE_LINKS;
                link += 1
              ) {
                insert.id = managedGoogleEventId(`${key}:replacement:${insert.id}`);
                inserted = await client.insertEvent(destinationCalendarId, insert);
              }
              if (inserted?.status === "cancelled") {
                throw new Error("Every replacement ID for this busy block is a deleted event");
              }
            },
            result,
            failures,
          ))
        ) {
          finishItem(failuresBefore, operationsBefore);
          continue;
        }
        destination = { ...insert, ...(inserted ?? {}) };
        if (options.dryRun !== true) {
          summary.active += 1;
        }
        record(result, "create", destinationKey, reason, options, {
          timeRange: blockTimeRange(block),
          block,
        });
      } else if (!matchesManagedProjection(destination, projectBusyEvent(block, key))) {
        const destinationId = destination.id;
        const destinationEtag = destination.etag;
        let patched: GoogleCalendarEvent | undefined;
        if (
          options.dryRun !== true &&
          !(await attemptOperation(
            async () => {
              patched = await client.patchEvent(
                destinationCalendarId,
                destinationId,
                projectBusyEvent(block, key),
                destinationEtag ?? undefined,
              );
            },
            result,
            failures,
          ))
        ) {
          continue;
        }
        destination = { ...destination, ...(patched ?? {}) };
        record(result, "update", destinationKey, "destination-drifted", options, {
          timeRange: blockTimeRange(block),
          block,
        });
      }

      if (options.dryRun !== true) {
        this.mappings.putMapping(toMapping(key, destinationKey, destination, now));
      }
      if (adoptedExisting) {
        record(result, "repair", destinationKey, "mapping-missing", options, {
          timeRange: blockTimeRange(block),
          block,
        });
      }
      finishItem(failuresBefore, operationsBefore);
    }
    return summary;
  }
}

/**
 * Identity of a merged busy block on one destination. Keys feed managed
 * Google event IDs, so they hash the interval rather than any source event:
 * the slot is the identity, and source event IDs never reach the destination.
 */
export function busyBlockKey(
  destinationKey: CalendarKey,
  time: NormalizedEventTime,
  tenantId?: string,
): string {
  const { start, end } = timeBounds(time);
  return createHash("sha256")
    .update(`block:v2\0${tenantId ?? "default"}\0${destinationKey}\0${time.kind}\0${start}\0${end}`)
    .digest("hex");
}

export function calendarWindow(config: SyncConfig, now: Date): CalendarWindow {
  return {
    timeMin: new Date(now.getTime() - config.window.pastDays * 86_400_000).toISOString(),
    timeMax: new Date(now.getTime() + config.window.futureDays * 86_400_000).toISOString(),
    timeZone: config.timezone,
  };
}

async function attemptOperation(
  operation: () => Promise<void>,
  result: { failed: number },
  failures: unknown[],
): Promise<boolean> {
  try {
    await operation();
    return true;
  } catch (error) {
    result.failed += 1;
    failures.push(error);
    return false;
  }
}

function activeManagedEvents(events: readonly GoogleCalendarEvent[]): GoogleCalendarEvent[] {
  return events.filter((event) => isManagedEvent(event) && event.status !== "cancelled");
}

function managedMappingKey(event: GoogleCalendarEvent): string | undefined {
  const value = event.extendedProperties?.private?.[MAPPING_PROPERTY];
  return value === undefined || value.length === 0 ? undefined : value;
}

function indexManagedEvents(
  events: readonly GoogleCalendarEvent[],
): Map<string, GoogleCalendarEvent[]> {
  const indexed = new Map<string, GoogleCalendarEvent[]>();
  for (const event of events) {
    const key = managedMappingKey(event);
    if (key === undefined) {
      continue;
    }
    const existing = indexed.get(key) ?? [];
    existing.push(event);
    indexed.set(key, existing);
  }
  return indexed;
}

const SYSTEM_PACING: ReconcilePacing = {
  now: () => Date.now(),
  sleep: (milliseconds) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
};

/**
 * Shared by every delete worker: hands out start times no closer together
 * than the spacing, so a burst can never exceed `1000 / spacing` a second
 * however fast the calls return, and holds all of them back during a
 * cooldown. Each new throttle doubles the next cooldown and the spacing, up
 * to their caps. A throttled reply to a request that was sent before the
 * current cooldown ended belongs to that same episode, however late it
 * lands, and does not escalate it again.
 */
class DeletePacer {
  #spacingMs: number;
  #cooldownMs = INITIAL_COOLDOWN_MS;
  #nextStartAt = 0;
  #cooldownUntil = 0;

  constructor(
    spacingMs: number,
    private readonly pacing: ReconcilePacing,
    private readonly onPause: (pauseMs: number) => void,
  ) {
    this.#spacingMs = spacingMs;
  }

  /** Waits for this caller's slot and returns when its request starts. */
  async turn(): Promise<number> {
    const now = this.pacing.now();
    const startAt = Math.max(now, this.#nextStartAt);
    this.#nextStartAt = startAt + this.#spacingMs;
    if (startAt > now) {
      await this.pacing.sleep(startAt - now);
    }
    return startAt;
  }

  throttled(requestStartedAt: number, retryAfterMs: number | undefined): void {
    if (requestStartedAt < this.#cooldownUntil) {
      return;
    }
    const now = this.pacing.now();
    const pauseMs = Math.max(retryAfterMs ?? 0, this.#cooldownMs);
    this.#cooldownUntil = now + pauseMs;
    this.#nextStartAt = Math.max(this.#nextStartAt, this.#cooldownUntil);
    this.#cooldownMs = Math.min(MAX_COOLDOWN_MS, this.#cooldownMs * 2);
    this.#spacingMs = Math.min(MAX_DELETE_SPACING_MS, this.#spacingMs * 2);
    this.onPause(pauseMs);
  }
}

/** Runs `work` over `items` in order with at most `limit` in flight. */
async function forEachConcurrently<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) {
        await work(item);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function hasId(event: GoogleCalendarEvent): event is ManagedBlock {
  return event.id != null && event.id.length > 0;
}

/** Same calendar slot: identical dates for all-day blocks, identical instants otherwise. */
function timeRangeIdentity(event: GoogleCalendarEvent): string | undefined {
  const range = eventTimeRange(event);
  if (range === undefined) {
    return undefined;
  }
  return range.kind === "all-day"
    ? `all-day:${range.start}/${range.end}`
    : `timed:${canonicalDateTime(range.start)}/${canonicalDateTime(range.end)}`;
}

function groupByTimeRange(blocks: readonly ManagedBlock[]): Map<string, ManagedBlock[]> {
  const groups = new Map<string, ManagedBlock[]>();
  for (const block of blocks) {
    const identity = timeRangeIdentity(block);
    if (identity === undefined) {
      continue;
    }
    const group = groups.get(identity) ?? [];
    group.push(block);
    groups.set(identity, group);
  }
  return groups;
}

/**
 * Which blocks in one time slot go, and why. One block per live key stays
 * (the one a mapping still points at, else the lowest id, so the choice is
 * stable across runs); everything else is stray. A stray is a duplicate when
 * a block stays in the slot and a phantom when nothing does.
 */
function strayBlocks(
  group: readonly ManagedBlock[],
  desired: ReadonlyMap<string, BusyBlock>,
  mappedIds: ReadonlyMap<string, string>,
): { block: ManagedBlock; kind: StrayBlockKind }[] {
  const ranked = [...group].sort(
    (left, right) =>
      Number(mappedIds.has(right.id)) - Number(mappedIds.has(left.id)) ||
      left.id.localeCompare(right.id),
  );
  const keptKeys = new Set<string>();
  const strays: ManagedBlock[] = [];
  for (const block of ranked) {
    const key = managedMappingKey(block);
    if (key !== undefined && desired.has(key) && !keptKeys.has(key)) {
      keptKeys.add(key);
      continue;
    }
    strays.push(block);
  }
  const kind: StrayBlockKind = keptKeys.size > 0 ? "duplicate" : "phantom";
  return strays.map((block) => ({ block, kind }));
}

/**
 * Unions overlapping or abutting sources into disjoint blocks. Timed and
 * all-day events merge separately: an all-day date has no instant to compare
 * against. A timed value without an offset cannot be placed on the timeline,
 * so it stays a block of its own.
 */
function mergeBusyBlocks(sources: readonly Sourced[]): BusyBlock[] {
  const intervals: {
    kind: NormalizedEventTime["kind"];
    start: number;
    end: number;
    source: Sourced;
  }[] = [];
  const unplaced: BusyBlock[] = [];
  for (const source of sources) {
    const bounds = instantBounds(source.event.time);
    if (bounds === undefined) {
      unplaced.push({ time: source.event.time, sources: [source] });
    } else {
      intervals.push({ kind: source.event.time.kind, ...bounds, source });
    }
  }
  intervals.sort((left, right) => left.start - right.start || left.end - right.end);

  const merged: BusyBlock[] = [];
  for (const kind of ["timed", "all-day"] as const) {
    let current: { start: number; end: number; sources: Sourced[] } | undefined;
    for (const interval of intervals.filter((candidate) => candidate.kind === kind)) {
      if (current !== undefined && interval.start <= current.end) {
        current.end = Math.max(current.end, interval.end);
        current.sources.push(interval.source);
        continue;
      }
      if (current !== undefined) {
        merged.push(blockFromInstants(kind, current));
      }
      current = { start: interval.start, end: interval.end, sources: [interval.source] };
    }
    if (current !== undefined) {
      merged.push(blockFromInstants(kind, current));
    }
  }
  return [...merged, ...unplaced];
}

function blockFromInstants(
  kind: NormalizedEventTime["kind"],
  interval: { start: number; end: number; sources: Sourced[] },
): BusyBlock {
  const time: NormalizedEventTime =
    kind === "all-day"
      ? {
          kind,
          startDate: new Date(interval.start).toISOString().slice(0, 10),
          endDate: new Date(interval.end).toISOString().slice(0, 10),
        }
      : {
          kind,
          startDateTime: rfc3339(interval.start),
          endDateTime: rfc3339(interval.end),
        };
  return { time, sources: interval.sources };
}

function rfc3339(milliseconds: number): string {
  return new Date(milliseconds).toISOString().replace(/\.000Z$/u, "Z");
}

/** Comparable bounds: UTC midnight for all-day dates, the instant for timed values. */
function instantBounds(time: NormalizedEventTime): { start: number; end: number } | undefined {
  const { start, end } = timeBounds(time);
  if (time.kind === "timed" && !(hasOffset(start) && hasOffset(end))) {
    return undefined;
  }
  const startMs = Date.parse(time.kind === "all-day" ? `${start}T00:00:00Z` : start);
  const endMs = Date.parse(time.kind === "all-day" ? `${end}T00:00:00Z` : end);
  return Number.isNaN(startMs) || Number.isNaN(endMs) ? undefined : { start: startMs, end: endMs };
}

function hasOffset(value: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/iu.test(value);
}

function timeBounds(time: NormalizedEventTime): { start: string; end: string } {
  return time.kind === "all-day"
    ? { start: time.startDate, end: time.endDate }
    : { start: time.startDateTime, end: time.endDateTime };
}

function blockTimeRange(block: BusyBlock): ReconcileTimeRange {
  const { start, end } = timeBounds(block.time);
  return { kind: block.time.kind, start, end };
}

/** Every titled source merged into the block, for private dry-run detail. */
function blockTitles(block: BusyBlock): string[] {
  return block.sources.flatMap(({ event }) =>
    event.sourceTitle === undefined ? [] : [event.sourceTitle],
  );
}

/** The calendars whose events merged into the block, each once, in order of first appearance. */
function blockSourceKeys(block: BusyBlock): CalendarKey[] {
  return [...new Set(block.sources.map(({ calendarKey }) => calendarKey))];
}

/** A block has no single source, so the store keeps no source event identifiers at all. */
function toMapping(
  key: string,
  destinationKey: CalendarKey,
  destination: GoogleCalendarEvent,
  now: Date,
): EventMapping {
  return {
    mappingKey: key,
    destinationKey,
    destinationEventId: destination.id ?? managedGoogleEventId(key),
    destinationEtag: destination.etag ?? null,
    updatedAt: now.toISOString(),
  };
}

function record(
  result: ReconcileResult,
  operation: ReconcileOperation,
  destinationKey: CalendarKey,
  reason: ReconcileReason,
  options: ReconcileOptions,
  detail: { timeRange?: ReconcileTimeRange | undefined; block?: BusyBlock } = {},
): void {
  const field = `${operation}${operation === "repair" ? "ed" : "d"}` as
    "created" | "updated" | "deleted" | "repaired";
  result[field] += 1;
  const titles = detail.block === undefined ? [] : blockTitles(detail.block);
  options.log?.({
    operation,
    destinationKey,
    ...(detail.block === undefined ? {} : { sourceKeys: blockSourceKeys(detail.block) }),
    reason,
    ...(detail.timeRange === undefined ? {} : { timeRange: detail.timeRange }),
    ...(titles.length === 0 ? {} : { sourceTitles: titles }),
    dryRun: options.dryRun ?? false,
  });
}

function operationCount(result: ReconcileResult): number {
  return result.created + result.updated + result.deleted + result.repaired;
}

function reportProgress(options: ReconcileOptions, progress: ReconcileProgress): void {
  options.onProgress?.(progress);
}

function normalizedTimeRange(source: NormalizedSourceEvent): ReconcileTimeRange {
  return source.time.kind === "all-day"
    ? { kind: "all-day", start: source.time.startDate, end: source.time.endDate }
    : { kind: "timed", start: source.time.startDateTime, end: source.time.endDateTime };
}

function eventTimeRange(event: GoogleCalendarEvent): ReconcileTimeRange | undefined {
  const startDate = event.start?.date;
  const endDate = event.end?.date;
  if (startDate != null && startDate.length > 0 && endDate != null && endDate.length > 0) {
    return { kind: "all-day", start: startDate, end: endDate };
  }
  const startDateTime = event.start?.dateTime;
  const endDateTime = event.end?.dateTime;
  if (
    startDateTime != null &&
    startDateTime.length > 0 &&
    endDateTime != null &&
    endDateTime.length > 0
  ) {
    return { kind: "timed", start: startDateTime, end: endDateTime };
  }
  return undefined;
}
