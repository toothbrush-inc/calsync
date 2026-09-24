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
  AccountRole,
  CalendarAPI,
  CalendarChangeSet,
  Clock,
  EventMapping,
  ExclusionSource,
  IncrementalCalendarAPI,
  MappingStore,
  SyncConfig,
  SyncStateStore,
} from "./types.js";
import { accountRoles } from "./types.js";

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
      role: AccountRole;
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
    private readonly clients: Record<AccountRole, CalendarAPI>,
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
    if (!supportsIncremental(clients)) {
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
      clearSyncTokens(this.syncState, this.config.tenantId);
    } else if (fullSyncDue(this.syncState, config, now)) {
      reason = "scheduled";
    }

    const pendingTokens: Partial<Record<AccountRole, string>> = {};
    // changesRequireFull matches managed events against mappings sourced from
    // the opposite calendar, so it needs the tenant's full mapping list.
    const tenantMappings = this.mappings.listMappings(undefined, this.config.tenantId);
    let relevantChange = false;
    for (const role of accountRoles) {
      const poll = await this.pollChanges(role, clients[role], options);
      pendingTokens[role] = poll.changes.nextSyncToken;
      if (poll.invalidToken) {
        reason = "invalid-token";
      }
      if (changesRequireFull(role, poll.changes.events, tenantMappings)) {
        relevantChange = true;
      }
    }
    if (reason === undefined && relevantChange) {
      reason = "calendar-change";
    }

    if (reason === undefined) {
      persistIncrementalState(
        this.syncState,
        pendingTokens,
        fingerprint,
        undefined,
        now,
        this.config.tenantId,
      );
      emitStatus(options, {
        event: "incremental_noop",
        nextFullAt: nextFullAt(this.syncState, config, now),
      });
      return storedSyncResult(this.syncState, this.mappings, this.config.tenantId);
    }

    emitStatus(options, {
      event: "full_sync",
      reason,
      nextFullAt: new Date(now.getTime() + fullSyncInterval(config)).toISOString(),
    });
    const result = await reconciler.reconcile({ ...this.reconcileOptions(options), now });
    persistIncrementalState(
      this.syncState,
      pendingTokens,
      fingerprint,
      result,
      now,
      this.config.tenantId,
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
    role: AccountRole,
    client: IncrementalCalendarAPI,
    options: SyncRunOptions,
  ): Promise<{ changes: CalendarChangeSet; invalidToken: boolean }> {
    const calendarId = this.effectiveConfig().accounts[role].calendarId;
    const token = this.syncState.getState(syncTokenKey(role, this.config.tenantId)) ?? undefined;
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
      this.syncState.deleteState(syncTokenKey(role, this.config.tenantId));
      emitStatus(options, { event: "invalid_sync_token", role });
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

function syncTokenKey(role: AccountRole, tenantId: string): string {
  return stateKey(`incremental:sync-token:${role}`, tenantId);
}

function clearSyncTokens(state: SyncStateStore, tenantId: string): void {
  for (const role of accountRoles) {
    state.deleteState(syncTokenKey(role, tenantId));
  }
}

function supportsIncremental(
  clients: Record<AccountRole, CalendarAPI>,
): clients is Record<AccountRole, IncrementalCalendarAPI> {
  return accountRoles.every((role) => typeof clients[role].listChanges === "function");
}

function changesRequireFull(
  calendarRole: AccountRole,
  events: readonly GoogleCalendarEvent[],
  mappings: readonly EventMapping[],
): boolean {
  const destinations = new Map(
    mappings
      .filter((mapping) => mapping.sourceRole !== calendarRole)
      .map((mapping) => [mapping.destinationEventId, mapping]),
  );

  for (const event of events) {
    const id = event.id ?? undefined;
    if (id === undefined) {
      return true;
    }
    const destination = destinations.get(id);
    if (event.status === "cancelled") {
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
  const fingerprintInput = {
    version: 1,
    calendars: {
      personal: config.accounts.personal.calendarId,
      work: config.accounts.work.calendarId,
    },
    window: config.window,
    timezone: config.timezone,
    exclusions: {
      personalToWork: [...config.exclusions.personalToWork].sort(),
      workToPersonal: [...config.exclusions.workToPersonal].sort(),
      personalToWorkKeywords: [...config.exclusions.personalToWorkKeywords].sort(),
      workToPersonalKeywords: [...config.exclusions.workToPersonalKeywords].sort(),
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

function persistIncrementalState(
  state: SyncStateStore,
  tokens: Partial<Record<AccountRole, string>>,
  fingerprint: string,
  result: SyncReconcileResult | undefined,
  now: Date,
  tenantId: string,
): void {
  const personal = tokens.personal;
  const work = tokens.work;
  if (personal === undefined || work === undefined) {
    throw new Error("Both calendar sync tokens are required before advancing incremental state");
  }
  state.setStates(
    {
      [syncTokenKey("personal", tenantId)]: personal,
      [syncTokenKey("work", tenantId)]: work,
      [stateKey(CONFIG_FINGERPRINT_KEY, tenantId)]: fingerprint,
      ...(result === undefined
        ? {}
        : {
            [stateKey(LAST_FULL_SYNC_KEY, tenantId)]: now.toISOString(),
            [stateKey(LAST_RESULT_KEY, tenantId)]: JSON.stringify(result),
          }),
    },
    now,
  );
}

function storedSyncResult(
  state: SyncStateStore,
  mappings: MappingStore,
  tenantId?: string,
): SyncReconcileResult {
  const stored = state.getState(stateKey(LAST_RESULT_KEY, tenantId));
  if (stored !== null) {
    try {
      const parsed = JSON.parse(stored) as SyncReconcileResult;
      if (
        typeof parsed.created === "number" &&
        typeof parsed.updated === "number" &&
        typeof parsed.deleted === "number" &&
        typeof parsed.repaired === "number" &&
        typeof parsed.failed === "number" &&
        typeof parsed.converged === "boolean"
      ) {
        return {
          ...parsed,
          created: 0,
          updated: 0,
          deleted: 0,
          repaired: 0,
          failed: 0,
          converged: true,
        };
      }
    } catch {
      // Fall back to privacy-safe mapping counts for migrated or corrupt state.
    }
  }
  return {
    created: 0,
    updated: 0,
    deleted: 0,
    repaired: 0,
    failed: 0,
    converged: true,
    mirrors: {
      personalToWork: {
        active: mappings.listMappings("personal", tenantId).length,
        excluded: 0,
        duplicateSuppressed: 0,
      },
      workToPersonal: {
        active: mappings.listMappings("work", tenantId).length,
        excluded: 0,
        duplicateSuppressed: 0,
      },
    },
  };
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
 */
export function readSyncSummary(state: SyncStateStore, tenantId?: string): StoredSyncSummary {
  const lastFullSyncAt = state.getState(stateKey(LAST_FULL_SYNC_KEY, tenantId));
  const stored = state.getState(stateKey(LAST_RESULT_KEY, tenantId));
  let lastResult: SyncReconcileResult | null = null;
  if (stored !== null) {
    try {
      const parsed = JSON.parse(stored) as SyncReconcileResult;
      if (
        typeof parsed.created === "number" &&
        typeof parsed.converged === "boolean" &&
        typeof parsed.mirrors === "object" &&
        typeof parsed.mirrors.personalToWork === "object" &&
        typeof parsed.mirrors.workToPersonal === "object"
      ) {
        lastResult = parsed;
      }
    } catch {
      // Corrupt state reads as "no summary yet"; the daemon repairs it on
      // its next full pass.
    }
  }
  return { lastFullSyncAt, lastResult };
}
