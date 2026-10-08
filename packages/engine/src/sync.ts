import { createHash } from "node:crypto";

import { applyStoredExclusions } from "./exclusion.js";
import { isManagedEvent, type GoogleCalendarEvent } from "./normalize.js";
import {
  Reconciler,
  type DedupeResult,
  type ReconcileLog,
  type ReconcileOptions,
  type ReconcileProgress,
  type ReconcileResult,
  type ReconcileSourceDetail,
  type SyncReconcileResult,
} from "./reconcile.js";
import { systemClock } from "./clock.js";
import { isInvalidSyncTokenError } from "./errors.js";
import type {
  CalendarAPI,
  CalendarKey,
  CalendarChangeSet,
  Clock,
  EventMapping,
  ExclusionSource,
  IncrementalCalendarAPI,
  MappingStore,
  SyncConfig,
  SyncStateStore,
} from "./types.js";

export interface SyncRunOptions {
  dryRun?: boolean;
  onOperation?: (entry: ReconcileLog) => void;
  onSourceEvent?: (entry: ReconcileSourceDetail) => void;
  onProgress?: (progress: ReconcileProgress) => void;
  onStatus?: (status: SyncStatus) => void;
}

export type FullSyncReason =
  | "initial"
  | "configuration-changed"
  | "scheduled"
  | "calendar-change"
  | "invalid-token"
  | "dry-run"
  | "incremental-unavailable";

export type SyncStatus =
  | {
      event: "incremental_noop";
      nextFullAt: string;
    }
  | {
      event: "full_sync";
      reason: FullSyncReason;
      nextFullAt: string;
    }
  | {
      event: "invalid_sync_token";
      calendarKey: CalendarKey;
    };

const CONFIG_FINGERPRINT_KEY = "incremental:configuration-fingerprint";
/** The two summary keys status surfaces read; exported so no caller has to
 * restate them (and forget to scope them by tenant). */
export const LAST_FULL_SYNC_KEY = "incremental:last-full-sync";
export const LAST_RESULT_KEY = "incremental:last-result";
const DEFAULT_FULL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export class SyncEngine {
  constructor(
    private readonly config: SyncConfig,
    private readonly mappings: MappingStore,
    private readonly syncState: SyncStateStore,
    private readonly exclusions: ExclusionSource,
    private readonly clients: Readonly<Record<CalendarKey, CalendarAPI>>,
    private readonly clock: Clock = systemClock,
  ) {}

  async once(options: SyncRunOptions = {}): Promise<SyncReconcileResult> {
    const config = this.effectiveConfig();
    const reconciler = this.reconciler(config);
    const now = this.clock.now();
    if (options.dryRun === true) {
      emitStatus(options, {
        event: "full_sync",
        reason: "dry-run",
        nextFullAt: nextFullAt(this.syncState, config, now),
      });
      return await reconciler.reconcile({ ...this.reconcileOptions(options), now });
    }

    const clients = this.clients;
    if (!supportsIncremental(config, clients)) {
      emitStatus(options, {
        event: "full_sync",
        reason: "incremental-unavailable",
        nextFullAt: new Date(now.getTime() + fullSyncInterval(config)).toISOString(),
      });
      return await reconciler.reconcile({ ...this.reconcileOptions(options), now });
    }

    const fingerprint = syncFingerprint(config);
    const previousFingerprint = this.syncState.getState(
      stateKey(CONFIG_FINGERPRINT_KEY, this.config.tenantId),
    );
    let reason: FullSyncReason | undefined;
    if (previousFingerprint === null) {
      reason = "initial";
    } else if (previousFingerprint !== fingerprint) {
      reason = "configuration-changed";
      clearSyncTokens(this.syncState, config, this.config.tenantId);
    } else if (fullSyncDue(this.syncState, config, now)) {
      reason = "scheduled";
    }

    const pendingTokens: Record<CalendarKey, string> = {};
    const ownDeletions = readOwnDeletions(this.syncState, config, this.config.tenantId);
    let relevantChange = false;
    // Independent per calendar, so a wake costs one round-trip, not one per calendar.
    const polls = await Promise.all(
      config.calendars.map(async (calendar) => {
        const client = clients[calendar.key];
        if (client === undefined) {
          throw new Error(`No calendar client for "${calendar.key}"`);
        }
        return {
          calendar,
          poll: await this.pollChanges(calendar.key, calendar.calendarId, client, options),
        };
      }),
    );
    for (const { calendar, poll } of polls) {
      pendingTokens[calendar.key] = poll.changes.nextSyncToken;
      if (poll.invalidToken) {
        reason = "invalid-token";
      }
      const blocks = this.mappings.listMappings(calendar.key, this.config.tenantId);
      if (
        changesRequireFull(poll.changes.events, blocks, ownDeletions.get(calendar.key) ?? new Set())
      ) {
        relevantChange = true;
      }
    }
    if (reason === undefined && relevantChange) {
      reason = "calendar-change";
    }

    if (reason === undefined) {
      // This poll consumed the echoes of the last pass's deletions.
      persistIncrementalState(
        this.syncState,
        config,
        pendingTokens,
        fingerprint,
        undefined,
        now,
        this.config.tenantId,
        {},
      );
      emitStatus(options, {
        event: "incremental_noop",
        nextFullAt: nextFullAt(this.syncState, config, now),
      });
      return storedSyncResult(this.syncState, this.mappings, config);
    }

    emitStatus(options, {
      event: "full_sync",
      reason,
      nextFullAt: new Date(now.getTime() + fullSyncInterval(config)).toISOString(),
    });
    const deleted: Record<CalendarKey, string[]> = {};
    const result = await reconciler.reconcile({
      ...this.reconcileOptions(options),
      now,
      onDestinationDeleted: (calendarKey, eventId) => {
        (deleted[calendarKey] ??= []).push(eventId);
      },
    });
    persistIncrementalState(
      this.syncState,
      config,
      pendingTokens,
      fingerprint,
      result,
      now,
      this.config.tenantId,
      deleted,
    );
    return result;
  }

  async rebuild(options: SyncRunOptions = {}): Promise<ReconcileResult> {
    return this.reconciler(this.effectiveConfig()).rebuild(this.reconcileOptions(options));
  }

  async cleanup(options: SyncRunOptions = {}): Promise<ReconcileResult> {
    return this.reconciler(this.effectiveConfig()).cleanup(this.reconcileOptions(options));
  }

  async dedupe(options: SyncRunOptions = {}): Promise<DedupeResult> {
    return this.reconciler(this.effectiveConfig()).dedupe(this.reconcileOptions(options));
  }

  private reconciler(config: SyncConfig): Reconciler {
    return new Reconciler(config, this.mappings, this.clients, this.clock);
  }

  private async pollChanges(
    calendarKey: CalendarKey,
    calendarId: string,
    client: IncrementalCalendarAPI,
    options: SyncRunOptions,
  ): Promise<{ changes: CalendarChangeSet; invalidToken: boolean }> {
    const tokenKey = syncTokenKey(calendarKey, this.config.tenantId);
    const token = this.syncState.getState(tokenKey) ?? undefined;
    try {
      return {
        changes: await client.listChanges(
          calendarId,
          token === undefined ? {} : { syncToken: token },
        ),
        invalidToken: false,
      };
    } catch (error) {
      if (token === undefined || !isInvalidSyncTokenError(error)) {
        throw error;
      }
      this.syncState.deleteState(tokenKey);
      emitStatus(options, { event: "invalid_sync_token", calendarKey });
      return {
        changes: await client.listChanges(calendarId),
        invalidToken: true,
      };
    }
  }

  private effectiveConfig(): SyncConfig {
    return applyStoredExclusions(this.config, this.exclusions);
  }

  private reconcileOptions(options: SyncRunOptions): ReconcileOptions {
    return {
      dryRun: options.dryRun ?? false,
      ...(options.onSourceEvent === undefined ? {} : { onSourceEvent: options.onSourceEvent }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      log: (entry) => {
        options.onOperation?.(entry);
      },
    };
  }
}

/**
 * Namespaces a sync_state key by tenant. The default tenant keeps the legacy
 * unprefixed keys so existing deployments retain their incremental state.
 * Exported because sync_state is one flat table: a reader that skips this
 * reads the default tenant's row for every tenant.
 */
export function stateKey(key: string, tenantId?: string): string {
  return tenantId === undefined || tenantId === "default" ? key : `tenant:${tenantId}:${key}`;
}

/**
 * Every sync_state key the engine keeps for one calendar, for a caller that
 * forgets the calendar.
 */
export function calendarStateKeys(calendarKey: CalendarKey, tenantId: string): string[] {
  return [syncTokenKey(calendarKey, tenantId), ownDeletionsKey(calendarKey, tenantId)];
}

function syncTokenKey(calendarKey: CalendarKey, tenantId: string): string {
  return stateKey(`incremental:sync-token:${calendarKey}`, tenantId);
}

function ownDeletionsKey(calendarKey: CalendarKey, tenantId: string): string {
  return stateKey(`incremental:own-deletions:${calendarKey}`, tenantId);
}

/**
 * Managed blocks the previous full pass deleted, per calendar. Their
 * cancellations arrive in the very next poll, which consumes them, so the
 * list only ever spans one pass. Unreadable state reads as empty: the worst
 * case is one redundant full pass.
 */
function readOwnDeletions(
  state: SyncStateStore,
  config: SyncConfig,
  tenantId: string,
): Map<CalendarKey, Set<string>> {
  const deletions = new Map<CalendarKey, Set<string>>();
  for (const calendar of config.calendars) {
    const value = state.getState(ownDeletionsKey(calendar.key, tenantId));
    try {
      const parsed: unknown = value === null ? [] : JSON.parse(value);
      deletions.set(
        calendar.key,
        new Set(
          Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [],
        ),
      );
    } catch {
      deletions.set(calendar.key, new Set());
    }
  }
  return deletions;
}

function clearSyncTokens(state: SyncStateStore, config: SyncConfig, tenantId: string): void {
  for (const calendar of config.calendars) {
    state.deleteState(syncTokenKey(calendar.key, tenantId));
  }
}

function supportsIncremental(
  config: SyncConfig,
  clients: Readonly<Record<CalendarKey, CalendarAPI>>,
): clients is Readonly<Record<CalendarKey, IncrementalCalendarAPI>> {
  return config.calendars.every(
    (calendar) => typeof clients[calendar.key]?.listChanges === "function",
  );
}

/**
 * Whether one calendar's changes can alter what calsync wants. `blocks` are
 * the mappings of busy blocks calsync holds on this calendar.
 */
function changesRequireFull(
  events: readonly GoogleCalendarEvent[],
  blocks: readonly EventMapping[],
  ownDeletions: ReadonlySet<string>,
): boolean {
  const destinations = new Map(blocks.map((mapping) => [mapping.destinationEventId, mapping]));

  for (const event of events) {
    const id = event.id ?? undefined;
    if (id === undefined) {
      return true;
    }
    const destination = destinations.get(id);
    if (event.status === "cancelled") {
      // A block calsync itself deleted changes nothing it wants; anything
      // else cancelled (a source, or a block someone else removed) does.
      if (ownDeletions.has(id)) {
        continue;
      }
      return true;
    }
    if (destination !== undefined) {
      if (
        !isManagedEvent(event) ||
        destination.destinationEtag === null ||
        event.etag == null ||
        event.etag !== destination.destinationEtag
      ) {
        return true;
      }
      continue;
    }
    // A native create/update, including an event moved into the rolling window,
    // can alter desired state. Unmapped managed events also require adoption or cleanup.
    return true;
  }
  return false;
}

function syncFingerprint(config: SyncConfig): string {
  const sorted = (values: Readonly<Record<string, readonly string[]>>) =>
    Object.fromEntries(
      Object.entries(values)
        .filter(([, list]) => list.length > 0)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, list]) => [key, [...list].sort()]),
    );
  const fingerprintInput = {
    // 3: calendars became a keyed list, each a source, a destination, or both.
    version: 3,
    calendars: [...config.calendars]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(({ key, calendarId, source, destination }) => ({
        key,
        calendarId,
        source,
        destination,
      })),
    window: config.window,
    timezone: config.timezone,
    exclusions: {
      keys: sorted(config.exclusions.keys),
      keywords: sorted(config.exclusions.keywords),
    },
  };
  return createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex");
}

function fullSyncInterval(config: SyncConfig): number {
  return config.fullSyncIntervalMs ?? DEFAULT_FULL_SYNC_INTERVAL_MS;
}

function fullSyncDue(state: SyncStateStore, config: SyncConfig, now: Date): boolean {
  const value = state.getState(stateKey(LAST_FULL_SYNC_KEY, config.tenantId));
  if (value === null) {
    return true;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) || now.getTime() - timestamp >= fullSyncInterval(config);
}

function nextFullAt(state: SyncStateStore, config: SyncConfig, now: Date): string {
  const lastFull = state.getState(stateKey(LAST_FULL_SYNC_KEY, config.tenantId));
  const timestamp = lastFull === null ? Number.NaN : Date.parse(lastFull);
  return new Date(
    Number.isNaN(timestamp)
      ? now.getTime() + fullSyncInterval(config)
      : timestamp + fullSyncInterval(config),
  ).toISOString();
}

/**
 * Advances every calendar's token together, with the deletions the pass
 * made: a calendar the pass deleted nothing on clears its list, since the
 * poll that just ran consumed any older echoes.
 */
function persistIncrementalState(
  state: SyncStateStore,
  config: SyncConfig,
  tokens: Readonly<Record<CalendarKey, string>>,
  fingerprint: string,
  result: SyncReconcileResult | undefined,
  now: Date,
  tenantId: string,
  ownDeletions: Readonly<Record<CalendarKey, readonly string[]>>,
): void {
  const values: Record<string, string> = {
    [stateKey(CONFIG_FINGERPRINT_KEY, tenantId)]: fingerprint,
  };
  for (const calendar of config.calendars) {
    const token = tokens[calendar.key];
    if (token === undefined) {
      throw new Error("Every calendar's sync token is required before advancing incremental state");
    }
    values[syncTokenKey(calendar.key, tenantId)] = token;
    values[ownDeletionsKey(calendar.key, tenantId)] = JSON.stringify(
      ownDeletions[calendar.key] ?? [],
    );
  }
  if (result !== undefined) {
    values[stateKey(LAST_FULL_SYNC_KEY, tenantId)] = now.toISOString();
    values[stateKey(LAST_RESULT_KEY, tenantId)] = JSON.stringify(result);
  }
  state.setStates(values, now);
}

function storedSyncResult(
  state: SyncStateStore,
  mappings: MappingStore,
  config: SyncConfig,
): SyncReconcileResult {
  const stored = parseStoredResult(state.getState(stateKey(LAST_RESULT_KEY, config.tenantId)));
  if (stored !== null) {
    return {
      ...stored,
      created: 0,
      updated: 0,
      deleted: 0,
      repaired: 0,
      failed: 0,
      converged: true,
    };
  }
  // Fall back to privacy-safe mapping counts for migrated or corrupt state.
  const destinations: SyncReconcileResult["destinations"] = {};
  const sources: SyncReconcileResult["sources"] = {};
  for (const calendar of config.calendars) {
    if (calendar.destination) {
      destinations[calendar.key] = {
        active: mappings.listMappings(calendar.key, config.tenantId).length,
        duplicateSuppressed: 0,
      };
    }
    if (calendar.source) {
      sources[calendar.key] = { excluded: 0 };
    }
  }
  return {
    created: 0,
    updated: 0,
    deleted: 0,
    repaired: 0,
    failed: 0,
    converged: true,
    destinations,
    sources,
  };
}

/**
 * A persisted pass result, or null when missing or unreadable. Results saved
 * before calendars were keyed carry per-direction totals; each direction had
 * one source and one destination, so they convert exactly.
 */
export function parseStoredResult(stored: string | null): SyncReconcileResult | null {
  if (stored === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(stored) as Partial<SyncReconcileResult> & {
      mirrors?: Record<
        string,
        { active?: number; excluded?: number; duplicateSuppressed?: number }
      >;
    };
    if (
      typeof parsed.created !== "number" ||
      typeof parsed.updated !== "number" ||
      typeof parsed.deleted !== "number" ||
      typeof parsed.repaired !== "number" ||
      typeof parsed.failed !== "number" ||
      typeof parsed.converged !== "boolean"
    ) {
      return null;
    }
    const counts = {
      created: parsed.created,
      updated: parsed.updated,
      deleted: parsed.deleted,
      repaired: parsed.repaired,
      failed: parsed.failed,
      converged: parsed.converged,
    };
    if (typeof parsed.destinations === "object" && typeof parsed.sources === "object") {
      return { ...counts, destinations: parsed.destinations, sources: parsed.sources };
    }
    const toWork = parsed.mirrors?.["personalToWork"];
    const toPersonal = parsed.mirrors?.["workToPersonal"];
    if (typeof toWork !== "object" || typeof toPersonal !== "object") {
      return null;
    }
    return {
      ...counts,
      destinations: {
        work: { active: toWork.active ?? 0, duplicateSuppressed: toWork.duplicateSuppressed ?? 0 },
        personal: {
          active: toPersonal.active ?? 0,
          duplicateSuppressed: toPersonal.duplicateSuppressed ?? 0,
        },
      },
      sources: {
        personal: { excluded: toWork.excluded ?? 0 },
        work: { excluded: toPersonal.excluded ?? 0 },
      },
    };
  } catch {
    return null;
  }
}

function emitStatus(options: SyncRunOptions, status: SyncStatus): void {
  options.onStatus?.(status);
}

export interface StoredSyncSummary {
  lastFullSyncAt: string | null;
  lastResult: SyncReconcileResult | null;
}

/**
 * Privacy-safe aggregates the daemon persisted for one tenant, for status
 * surfaces (CLI, MCP, web). Counts and timestamps only — never event data.
 * Corrupt state reads as "no summary yet"; the daemon repairs it on its next
 * full pass.
 */
export function readSyncSummary(state: SyncStateStore, tenantId?: string): StoredSyncSummary {
  return {
    lastFullSyncAt: state.getState(stateKey(LAST_FULL_SYNC_KEY, tenantId)),
    lastResult: parseStoredResult(state.getState(stateKey(LAST_RESULT_KEY, tenantId))),
  };
}
