import { createHash } from "node:crypto";

import { systemClock } from "./clock.js";
import { googleApiErrorInfo, isRetryableGoogleError } from "./errors.js";
import type {
  AccountRole,
  CalendarAPI,
  CalendarWindow,
  Clock,
  EventMapping,
  MappingStore,
  SyncConfig,
} from "./types.js";
import { accountRoles } from "./types.js";
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
  sourceRole: AccountRole;
  destinationRole: AccountRole;
  reason: ReconcileReason;
  timeRange?: ReconcileTimeRange;
  sourceTitle?: string;
  dryRun: boolean;
}

export interface ReconcileSourceDetail {
  sourceRole: AccountRole;
  destinationRole: AccountRole;
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

export interface MirrorDirectionSummary {
  active: number;
  excluded: number;
  duplicateSuppressed: number;
}

export interface SyncReconcileResult extends ReconcileResult {
  failed: number;
  converged: boolean;
  mirrors: {
    personalToWork: MirrorDirectionSummary;
    workToPersonal: MirrorDirectionSummary;
  };
}

/**
 * Outcome of a stray-block cleanup. `deleted` counts every removed block;
 * the per-calendar fields say where they sat and why they went: a duplicate
 * shared its slot with a block that stays, a phantom had no live source and
 * nothing else in its slot.
 */
export interface DedupeResult extends ReconcileResult {
  /** Active managed busy blocks inspected on each calendar. */
  inspected: Record<AccountRole, number>;
  /** Removed from each calendar — or, in a dry run, that would be. */
  duplicates: Record<AccountRole, number>;
  phantoms: Record<AccountRole, number>;
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
}

export interface ReconcileProgress {
  phase: "discovering" | "planning" | "applying" | "finalizing";
  label: string;
  completed: number;
  total?: number;
  succeeded: number;
  failed: number;
}

type Clients = Record<AccountRole, CalendarAPI>;
type EventSets = Record<AccountRole, GoogleCalendarEvent[]>;
type SourceSets = Record<AccountRole, NormalizedSourceEvent[]>;
type ManagedBlock = GoogleCalendarEvent & { id: string };

interface EvaluatedSource {
  source: NormalizedSourceEvent;
  exclusionReason: SourceExclusionScope | "keyword" | undefined;
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
  ) {}

  async reconcile(options: ReconcileOptions = {}): Promise<SyncReconcileResult> {
    const now = options.now ?? this.clock.now();
    const { events, normalized, duplicateKeys } = await this.discover(
      calendarWindow(this.config, now),
      options,
      "Planning reconciliation",
    );
    const result: SyncReconcileResult = {
      ...EMPTY_RESULT,
      failed: 0,
      converged: true,
      mirrors: {
        personalToWork: emptyMirrorSummary(),
        workToPersonal: emptyMirrorSummary(),
      },
    };
    const failures: unknown[] = [];

    result.mirrors.personalToWork = await this.reconcileDirection(
      "personal",
      events.work,
      normalized.personal,
      duplicateKeys,
      result,
      options,
      now,
      failures,
    );
    result.mirrors.workToPersonal = await this.reconcileDirection(
      "work",
      events.personal,
      normalized.work,
      duplicateKeys,
      result,
      options,
      now,
      failures,
    );
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
    const events = await this.listBoth(calendarWindow(this.config, now), options);
    const sources = {
      personal: normalizeSourceEvents(events.personal),
      work: normalizeSourceEvents(events.work),
    };
    const result = { ...EMPTY_RESULT };

    if (!options.dryRun) {
      for (const mapping of this.mappings.listMappings(undefined, this.config.tenantId)) {
        this.mappings.deleteMapping(mapping.mappingKey, this.config.tenantId);
      }
    }
    for (const destinationRole of roles()) {
      const sourceRole = opposite(destinationRole);
      const sourceByKey = new Map(
        sources[sourceRole].map((source) => [
          mappingKey(sourceRole, source, this.config.tenantId),
          source,
        ]),
      );
      for (const destination of activeManagedEvents(events[destinationRole])) {
        const key = managedMappingKey(destination);
        const source = key === undefined ? undefined : sourceByKey.get(key);
        if (key === undefined || source === undefined || destination.id == null) {
          continue;
        }
        if (!options.dryRun) {
          this.mappings.putMapping(toMapping(key, sourceRole, source, destination, now));
        }
        record(
          result,
          "repair",
          sourceRole,
          "rebuild-mapping",
          options,
          normalizedTimeRange(source),
          source.sourceTitle,
        );
      }
    }
    return result;
  }

  async cleanup(options: ReconcileOptions = {}): Promise<ReconcileResult> {
    const fetched = { personal: 0, work: 0 };
    const onListProgress = (role: AccountRole, count: number): void => {
      fetched[role] = count;
      reportProgress(options, {
        phase: "discovering",
        label: "Finding managed mirrors",
        completed: fetched.personal + fetched.work,
        succeeded: 0,
        failed: 0,
      });
    };
    reportProgress(options, {
      phase: "discovering",
      label: "Finding managed mirrors",
      completed: 0,
      succeeded: 0,
      failed: 0,
    });
    const [personal, work] = await Promise.all([
      this.clients.personal.listManagedEvents(
        this.config.accounts.personal.calendarId,
        (progress) => {
          onListProgress("personal", progress.fetched);
        },
      ),
      this.clients.work.listManagedEvents(this.config.accounts.work.calendarId, (progress) => {
        onListProgress("work", progress.fetched);
      }),
    ]);
    const events = { personal, work };
    const result = { ...EMPTY_RESULT };
    const managed = {
      personal: activeManagedEvents(events.personal).filter((event) => event.id != null),
      work: activeManagedEvents(events.work).filter((event) => event.id != null),
    };
    const total = managed.personal.length + managed.work.length;
    let completed = 0;
    let failed = 0;
    reportProgress(options, {
      phase: "applying",
      label: "Deleting managed mirrors",
      completed,
      total,
      succeeded: result.deleted,
      failed,
    });
    for (const destinationRole of roles()) {
      for (const event of managed[destinationRole]) {
        const eventId = event.id;
        if (eventId == null) {
          throw new Error("Managed event ID disappeared during cleanup");
        }
        try {
          if (!options.dryRun) {
            await this.clients[destinationRole].deleteEvent(
              this.config.accounts[destinationRole].calendarId,
              eventId,
            );
          }
          record(
            result,
            "delete",
            opposite(destinationRole),
            "cleanup-managed-event",
            options,
            eventTimeRange(event),
          );
        } catch (error) {
          failed += 1;
          completed += 1;
          reportProgress(options, {
            phase: "applying",
            label: "Deleting managed mirrors",
            completed,
            total,
            succeeded: result.deleted,
            failed,
          });
          throw new CleanupPassError(result, failed, error);
        }
        completed += 1;
        reportProgress(options, {
          phase: "applying",
          label: "Deleting managed mirrors",
          completed,
          total,
          succeeded: result.deleted,
          failed,
        });
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
   * calsync's own blocks.
   */
  async dedupe(options: ReconcileOptions = {}): Promise<DedupeResult> {
    const now = options.now ?? this.clock.now();
    const { events, normalized, duplicateKeys } = await this.discover(
      calendarWindow(this.config, now),
      options,
      "Planning stray-block cleanup",
    );
    const managed = await this.listManaged(options);
    const result: DedupeResult = {
      ...EMPTY_RESULT,
      inspected: { personal: 0, work: 0 },
      duplicates: { personal: 0, work: 0 },
      phantoms: { personal: 0, work: 0 },
      failed: 0,
    };
    const removals: {
      destinationRole: AccountRole;
      block: ManagedBlock;
      kind: StrayBlockKind;
      mappingKey?: string;
    }[] = [];
    for (const destinationRole of roles()) {
      const sourceRole = opposite(destinationRole);
      const { desired } = this.evaluateDirection(sourceRole, normalized[sourceRole], duplicateKeys);
      const mappedIds = new Map(
        this.mappings
          .listMappings(sourceRole, this.config.tenantId)
          .map((mapping) => [mapping.destinationEventId, mapping.mappingKey]),
      );
      const blocks = activeManagedEvents(events[destinationRole]).filter(hasId);
      const inWindow = new Set(blocks.map((block) => block.id));
      // Managed blocks the window read did not return lie outside it: nothing
      // there can be desired, so every one of them is a phantom.
      const outside = activeManagedEvents(managed[destinationRole])
        .filter(hasId)
        .filter((block) => !inWindow.has(block.id));
      result.inspected[destinationRole] = blocks.length + outside.length;
      const strays = [
        ...[...groupByTimeRange(blocks).values()].flatMap((group) =>
          strayBlocks(group, desired, mappedIds),
        ),
        ...outside.map((block) => ({ block, kind: "phantom" as const })),
      ];
      for (const { block, kind } of strays) {
        const mappingKey = mappedIds.get(block.id);
        removals.push({
          destinationRole,
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
      const { destinationRole, block, kind, mappingKey } = removal;
      // A dry run deletes nothing, so it has nothing to pace.
      const deleted =
        options.dryRun === true ||
        (await this.deleteWithBackoff(destinationRole, block.id, pacer, result, failures));
      if (deleted) {
        if (options.dryRun !== true && mappingKey !== undefined) {
          this.mappings.deleteMapping(mappingKey, this.config.tenantId);
        }
        result[kind === "duplicate" ? "duplicates" : "phantoms"][destinationRole] += 1;
        record(
          result,
          "delete",
          opposite(destinationRole),
          kind === "duplicate" ? "duplicate-busy-block" : "phantom-busy-block",
          options,
          eventTimeRange(block),
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
    role: AccountRole,
    eventId: string,
    pacer: DeletePacer,
    result: { failed: number },
    failures: unknown[],
  ): Promise<boolean> {
    for (let attempt = 1; ; attempt += 1) {
      const startedAt = await pacer.turn();
      try {
        await this.clients[role].deleteEvent(this.config.accounts[role].calendarId, eventId);
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

  /** Every managed block on both calendars, whatever its date. */
  private async listManaged(options: ReconcileOptions): Promise<EventSets> {
    const fetched = { personal: 0, work: 0 };
    const update = (role: AccountRole, count: number): void => {
      fetched[role] = count;
      reportProgress(options, {
        phase: "discovering",
        label: "Finding managed mirrors",
        completed: fetched.personal + fetched.work,
        succeeded: 0,
        failed: 0,
      });
    };
    const [personal, work] = await Promise.all(
      roles().map((role) =>
        this.clients[role].listManagedEvents(this.config.accounts[role].calendarId, (progress) => {
          update(role, progress.fetched);
        }),
      ),
    );
    if (personal === undefined || work === undefined) {
      throw new Error("Managed event listing returned no result");
    }
    return { personal, work };
  }

  /** Reads both calendars and separates source events from our own mirrors. */
  private async discover(
    window: CalendarWindow,
    options: ReconcileOptions,
    label: string,
  ): Promise<{ events: EventSets; normalized: SourceSets; duplicateKeys: Set<string> }> {
    const events = await this.listBoth(window, options);
    const discovered = events.personal.length + events.work.length;
    reportProgress(options, {
      phase: "planning",
      label,
      completed: discovered,
      total: discovered,
      succeeded: 0,
      failed: 0,
    });
    const knownDestinationIds = {
      personal: new Set(
        this.mappings.listMappings("work").map((mapping) => mapping.destinationEventId),
      ),
      work: new Set(
        this.mappings.listMappings("personal").map((mapping) => mapping.destinationEventId),
      ),
    };
    const normalized: SourceSets = {
      personal: normalizeSourceEvents(
        events.personal.filter(
          (event) => event.id == null || !knownDestinationIds.personal.has(event.id),
        ),
      ),
      work: normalizeSourceEvents(
        events.work.filter((event) => event.id == null || !knownDestinationIds.work.has(event.id)),
      ),
    };
    return {
      events,
      normalized,
      duplicateKeys: intersectDuplicateKeys(normalized.personal, normalized.work),
    };
  }

  /** Applies exclusions and duplicate suppression: which sources want a mirror. */
  private evaluateDirection(
    sourceRole: AccountRole,
    sourceEvents: readonly NormalizedSourceEvent[],
    duplicateKeys: ReadonlySet<string>,
  ): { evaluatedSources: EvaluatedSource[]; desired: Map<string, NormalizedSourceEvent> } {
    const exclusions = this.config.exclusions;
    const keys = sourceRole === "personal" ? exclusions.personalToWork : exclusions.workToPersonal;
    const keywords =
      sourceRole === "personal"
        ? exclusions.personalToWorkKeywords
        : exclusions.workToPersonalKeywords;
    const evaluatedSources = sourceEvents.map((source): EvaluatedSource => {
      const keyExclusion = matchingSourceExclusion(keys, sourceRole, source);
      return {
        source,
        exclusionReason:
          keyExclusion ??
          (isTitleExcludedByKeyword(source.sourceTitle, keywords)
            ? ("keyword" as const)
            : undefined),
      };
    });
    const desired = new Map(
      evaluatedSources
        .filter(
          ({ source, exclusionReason }) =>
            exclusionReason === undefined &&
            (source.duplicateMatchKey === undefined ||
              !duplicateKeys.has(source.duplicateMatchKey)),
        )
        .map(({ source }) => [mappingKey(sourceRole, source, this.config.tenantId), source]),
    );
    return { evaluatedSources, desired };
  }

  private async listBoth(window: CalendarWindow, options: ReconcileOptions): Promise<EventSets> {
    const fetched = { personal: 0, work: 0 };
    const update = (role: AccountRole, count: number): void => {
      fetched[role] = count;
      reportProgress(options, {
        phase: "discovering",
        label: "Reading calendar events",
        completed: fetched.personal + fetched.work,
        succeeded: 0,
        failed: 0,
      });
    };
    reportProgress(options, {
      phase: "discovering",
      label: "Reading calendar events",
      completed: 0,
      succeeded: 0,
      failed: 0,
    });
    const personal = this.clients.personal.listEvents(
      this.config.accounts.personal.calendarId,
      window,
      (progress) => {
        update("personal", progress.fetched);
      },
    );
    const work = this.clients.work.listEvents(
      this.config.accounts.work.calendarId,
      window,
      (progress) => {
        update("work", progress.fetched);
      },
    );
    await Promise.all([personal, work]);
    const events = { personal: await personal, work: await work };
    const total = events.personal.length + events.work.length;
    reportProgress(options, {
      phase: "discovering",
      label: "Reading calendar events",
      completed: total,
      total,
      succeeded: 0,
      failed: 0,
    });
    return events;
  }

  private async reconcileDirection(
    sourceRole: AccountRole,
    destinationEvents: readonly GoogleCalendarEvent[],
    sourceEvents: readonly NormalizedSourceEvent[],
    duplicateKeys: ReadonlySet<string>,
    result: SyncReconcileResult,
    options: ReconcileOptions,
    now: Date,
    failures: unknown[],
  ): Promise<MirrorDirectionSummary> {
    const destinationRole = opposite(sourceRole);
    const destinationCalendarId = this.config.accounts[destinationRole].calendarId;
    const { evaluatedSources, desired } = this.evaluateDirection(
      sourceRole,
      sourceEvents,
      duplicateKeys,
    );
    for (const { source, exclusionReason } of evaluatedSources) {
      options.onSourceEvent?.({
        sourceRole,
        destinationRole,
        ...(source.sourceTitle === undefined ? {} : { sourceTitle: source.sourceTitle }),
        timeRange: normalizedTimeRange(source),
        exclusionKeys: sourceExclusionKeys(sourceRole, source),
        ...(exclusionReason === undefined ? {} : { exclusionReason }),
        isRecurring: source.isRecurring,
      });
    }
    const summary: MirrorDirectionSummary = {
      active: options.dryRun === true ? desired.size : 0,
      excluded: evaluatedSources.filter(({ exclusionReason }) => exclusionReason !== undefined)
        .length,
      duplicateSuppressed: evaluatedSources.filter(
        ({ source, exclusionReason }) =>
          exclusionReason === undefined &&
          source.duplicateMatchKey !== undefined &&
          duplicateKeys.has(source.duplicateMatchKey),
      ).length,
    };
    const managedByKey = indexManagedEvents(destinationEvents);
    const mappings = new Map(
      this.mappings
        .listMappings(sourceRole, this.config.tenantId)
        .map((mapping) => [mapping.mappingKey, mapping]),
    );
    const total = desired.size + [...mappings.keys()].filter((key) => !desired.has(key)).length;
    let completed = 0;
    let succeeded = 0;
    let failed = 0;
    const progress = (): void => {
      reportProgress(options, {
        phase: "applying",
        label: `Applying ${sourceRole} → ${destinationRole}`,
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
      if (desired.has(mapping.mappingKey)) {
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
          () =>
            this.clients[destinationRole].deleteEvent(
              destinationCalendarId,
              mapping.destinationEventId,
            ),
          result,
          failures,
        ))
      ) {
        finishItem(failuresBefore, operationsBefore);
        continue;
      }
      record(
        result,
        "delete",
        sourceRole,
        "source-no-longer-desired",
        options,
        destination === undefined ? undefined : eventTimeRange(destination),
      );
      if (options.dryRun !== true) {
        this.mappings.deleteMapping(mapping.mappingKey, this.config.tenantId);
      }
      finishItem(failuresBefore, operationsBefore);
    }

    for (const [key, source] of desired) {
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
            () => this.clients[destinationRole].deleteEvent(destinationCalendarId, extraId),
            result,
            failures,
          ))
        ) {
          finishItem(failuresBefore, operationsBefore);
          continue;
        }
        record(
          result,
          "delete",
          sourceRole,
          "duplicate-destination",
          options,
          eventTimeRange(extra),
          source.sourceTitle,
        );
      }

      if (
        destination === undefined ||
        destination.status === "cancelled" ||
        destination.id == null
      ) {
        const reason =
          destination?.status === "cancelled" ? "destination-cancelled" : "destination-missing";
        const insert = projectBusyEventInsert(source, key);
        if (knownMapping !== undefined || destination?.status === "cancelled") {
          const tombstone = destination?.id ?? knownMapping?.destinationEventId ?? insert.id;
          insert.id = managedGoogleEventId(`${key}:replacement:${tombstone}`);
        }
        let inserted: GoogleCalendarEvent | undefined;
        if (
          options.dryRun !== true &&
          !(await attemptOperation(
            async () => {
              inserted = await this.clients[destinationRole].insertEvent(
                destinationCalendarId,
                insert,
              );
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
        record(
          result,
          "create",
          sourceRole,
          reason,
          options,
          normalizedTimeRange(source),
          source.sourceTitle,
        );
      } else if (!matchesManagedProjection(destination, projectBusyEvent(source, key))) {
        const destinationId = destination.id;
        const destinationEtag = destination.etag;
        let patched: GoogleCalendarEvent | undefined;
        if (
          options.dryRun !== true &&
          !(await attemptOperation(
            async () => {
              patched = await this.clients[destinationRole].patchEvent(
                destinationCalendarId,
                destinationId,
                projectBusyEvent(source, key),
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
        record(
          result,
          "update",
          sourceRole,
          "destination-drifted",
          options,
          normalizedTimeRange(source),
          source.sourceTitle,
        );
      }

      if (options.dryRun !== true) {
        this.mappings.putMapping(toMapping(key, sourceRole, source, destination, now));
      }
      if (adoptedExisting) {
        record(
          result,
          "repair",
          sourceRole,
          "mapping-missing",
          options,
          normalizedTimeRange(source),
          source.sourceTitle,
        );
      }
      finishItem(failuresBefore, operationsBefore);
    }
    return summary;
  }
}

export function mappingKey(
  role: AccountRole,
  source: NormalizedSourceEvent,
  tenantId?: string,
): string {
  // Keys are embedded in managed Google event ids and extended properties, so
  // the default tenant must keep the pre-tenant format: changing it would
  // orphan every mirrored event on an existing deployment.
  const scope = tenantId === undefined || tenantId === "default" ? "" : `${tenantId}\0`;
  return createHash("sha256").update(`${scope}${role}\0${source.occurrenceKey}`).digest("hex");
}

export function calendarWindow(config: SyncConfig, now: Date): CalendarWindow {
  return {
    timeMin: new Date(now.getTime() - config.window.pastDays * 86_400_000).toISOString(),
    timeMax: new Date(now.getTime() + config.window.futureDays * 86_400_000).toISOString(),
    timeZone: config.timezone,
  };
}

function roles(): readonly AccountRole[] {
  return accountRoles;
}

function opposite(role: AccountRole): AccountRole {
  return role === "personal" ? "work" : "personal";
}

function emptyMirrorSummary(): MirrorDirectionSummary {
  return { active: 0, excluded: 0, duplicateSuppressed: 0 };
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
  desired: ReadonlyMap<string, NormalizedSourceEvent>,
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

function intersectDuplicateKeys(
  personal: readonly NormalizedSourceEvent[],
  work: readonly NormalizedSourceEvent[],
): Set<string> {
  const personalKeys = new Set(personal.flatMap((event) => event.duplicateMatchKey ?? []));
  return new Set(
    work
      .map((event) => event.duplicateMatchKey)
      .filter((key): key is string => key !== undefined && personalKeys.has(key)),
  );
}

function toMapping(
  key: string,
  sourceRole: AccountRole,
  source: NormalizedSourceEvent,
  destination: GoogleCalendarEvent,
  now: Date,
): EventMapping {
  return {
    mappingKey: key,
    sourceRole,
    sourceEventId: source.id,
    destinationEventId: destination.id ?? managedGoogleEventId(key),
    sourceEtag: source.etag ?? null,
    destinationEtag: destination.etag ?? null,
    updatedAt: now.toISOString(),
  };
}

function record(
  result: ReconcileResult,
  operation: ReconcileOperation,
  sourceRole: AccountRole,
  reason: ReconcileReason,
  options: ReconcileOptions,
  timeRange?: ReconcileTimeRange,
  sourceTitle?: string,
): void {
  const field = `${operation}${operation === "repair" ? "ed" : "d"}` as
    "created" | "updated" | "deleted" | "repaired";
  result[field] += 1;
  options.log?.({
    operation,
    sourceRole,
    destinationRole: opposite(sourceRole),
    reason,
    ...(timeRange === undefined ? {} : { timeRange }),
    ...(sourceTitle === undefined ? {} : { sourceTitle }),
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
