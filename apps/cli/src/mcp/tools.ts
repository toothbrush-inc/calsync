import {
  LAST_FULL_SYNC_KEY,
  LAST_RESULT_KEY,
  stateKey,
  type AccountRole,
  type ReconcileLog,
  type ReconcileProgress,
  type SyncReconcileResult,
} from "@calsync/engine";

import { accountRoles, loadConfig, type AppConfig } from "../config.js";
import {
  changeExclusions,
  snapshotExclusions,
  type ExclusionChangeResult,
  type ExclusionSnapshot,
  type ExclusionStore,
} from "../exclusions.js";
import type { AccountStatus, AuthorizationOptions, ConnectStartResult } from "../google/auth.js";
import type { WatchChannelRecord } from "../storage/index.js";
import { LockTimeoutError, type SyncService } from "../sync/service.js";
import type { ScanGate } from "../scanlimit.js";
import { sanitizeToolPayload } from "./privacy.js";
import {
  previewProgressFromLockWait,
  previewProgressFromReconcile,
  type PreviewProgressReport,
} from "./progress.js";

export interface McpRuntime {
  auth: {
    getStatus(role: AccountRole, calendarId: string): Promise<AccountStatus>;
    startConnect?(
      role: AccountRole,
      calendarId: string,
      options?: AuthorizationOptions,
    ): Promise<ConnectStartResult>;
    cancelPendingConnects?(): void;
  };
  state: ExclusionStore & {
    getState(key: string): string | null;
    listWatchChannels?(): WatchChannelRecord[];
  };
  sync: Pick<SyncService, "once">;
  /** Bounds how often the full-window passes may run. Absent → unbounded.
   * An assistant can call these in a loop, so the gate matters more here
   * than it does behind a button. */
  scanGate?: ScanGate;
  loadConfig?: () => AppConfig;
}

export interface AccountStatusResult {
  role: AccountRole;
  configured: boolean;
  valid: boolean;
  writable: boolean;
  message: string;
}

export interface MirrorTotals {
  active: number;
  excluded: number;
  duplicateSuppressed: number;
}

export interface SyncAggregates {
  created: number;
  updated: number;
  deleted: number;
  repaired: number;
  failed: number;
  converged: boolean;
  mirrors: {
    personalToWork: MirrorTotals;
    workToPersonal: MirrorTotals;
  };
}

/** Push-notification health: whether channels are configured and when they expire. */
export interface PushStatusResult {
  configured: boolean;
  channels: { role: AccountRole; expiresAt: string }[];
}

export interface StatusResult {
  accounts: AccountStatusResult[];
  lastSync: (SyncAggregates & { lastFullSyncAt: string | null }) | null;
  push: PushStatusResult;
}

export interface OperationCount {
  direction: "personalToWork" | "workToPersonal";
  operation: ReconcileLog["operation"];
  reason: ReconcileLog["reason"];
  count: number;
}

export interface PreviewSyncResult extends SyncAggregates {
  dryRun: true;
  operations: OperationCount[];
  sourceTitles?: string[];
}

export interface SyncNowResult extends SyncAggregates {
  dryRun: false;
}

export interface ToolSuccess<T> {
  ok: true;
  data: T;
}
export interface ToolFailure {
  ok: false;
  error: { code: string; message: string };
}
export type ToolResult<T> = ToolSuccess<T> | ToolFailure;

export async function handleGetStatus(runtime: McpRuntime): Promise<ToolResult<StatusResult>> {
  // Lock-free: launchd may hold the daemon instance lock; WAL allows concurrent readers.
  try {
    const config = resolveConfig(runtime);
    const accounts = await Promise.all(
      accountRoles.map(async (role) => {
        const status = await runtime.auth.getStatus(role, config.accounts[role].calendarId);
        return {
          role: status.role,
          configured: status.configured,
          valid: status.valid,
          writable: status.valid,
          message: status.message,
        };
      }),
    );
    return {
      ok: true,
      data: {
        accounts,
        // sync_state is one flat table across tenants; unscoped keys belong
        // to the default tenant, so every read names this tenant's.
        lastSync: readLastSync(
          runtime.state.getState(stateKey(LAST_RESULT_KEY, config.tenantId)),
          runtime.state.getState(stateKey(LAST_FULL_SYNC_KEY, config.tenantId)),
        ),
        push: {
          configured: config.webhook !== undefined,
          channels: (runtime.state.listWatchChannels?.() ?? []).map((channel) => ({
            role: channel.role,
            expiresAt: channel.expiresAt,
          })),
        },
      },
    };
  } catch (error) {
    return toolFailure(error, "status_failed");
  }
}

export interface ConnectProviderInput {
  provider: "google";
  slot: AccountRole;
}

export interface ConnectProviderResult {
  provider: "google";
  slot: AccountRole;
  url: string;
  expires_at: string;
}

export async function handleConnectProvider(
  runtime: McpRuntime,
  input: ConnectProviderInput,
): Promise<ToolResult<ConnectProviderResult>> {
  if (runtime.auth.startConnect === undefined) {
    return {
      ok: false,
      error: {
        code: "connect_unavailable",
        message: "This server cannot start a provider connection",
      },
    };
  }
  try {
    const config = resolveConfig(runtime);
    const started = await runtime.auth.startConnect(
      input.slot,
      config.accounts[input.slot].calendarId,
      {
        openBrowser: true,
        onBrowserOpenFailure: (url, error) => {
          const detail = error instanceof Error ? `: ${error.message}` : "";
          process.stderr.write(
            `calsync mcp: could not open the system browser${detail}\nOpen this authorization URL manually:\n${url}\n`,
          );
        },
      },
    );
    return {
      ok: true,
      data: {
        provider: started.provider,
        slot: started.slot,
        url: started.url,
        expires_at: started.expiresAt,
      },
    };
  } catch (error) {
    return toolFailure(error, "connect_provider_failed");
  }
}

export interface PreviewSyncHooks {
  onProgress?: (report: PreviewProgressReport) => void | Promise<void>;
  signal?: AbortSignal;
}

export async function handlePreviewSync(
  runtime: McpRuntime,
  input: { include_source_titles?: boolean } = {},
  hooks: PreviewSyncHooks = {},
): Promise<ToolResult<PreviewSyncResult>> {
  const includeTitles = input.include_source_titles === true;
  const tenantId = resolveConfig(runtime).tenantId;
  const gate = runtime.scanGate?.check(tenantId, "scan");
  if (gate !== undefined && !gate.allowed) {
    return scanRateLimited(gate.retryAfterSeconds, "previewing a sync");
  }
  let lastProgress = Promise.resolve();
  const report = (entry: PreviewProgressReport): Promise<void> => {
    lastProgress = lastProgress.then(() => Promise.resolve(hooks.onProgress?.(entry)));
    return lastProgress;
  };
  try {
    const operations: ReconcileLog[] = [];
    const result = await runtime.sync.once({
      dryRun: true,
      ...(hooks.signal === undefined ? {} : { signal: hooks.signal }),
      onLockWait: (waitedMs) => report(previewProgressFromLockWait(waitedMs)),
      onStatus: (status) => {
        if (status.event === "full_sync") {
          void report({ phase: "listing_calendars", message: "Listing calendars" });
        }
      },
      onProgress: (progress: ReconcileProgress) => {
        void report(previewProgressFromReconcile(progress));
      },
      onOperation: (entry) => operations.push(entry),
    });
    await lastProgress;
    runtime.scanGate?.record(tenantId, "scan");
    const payload: PreviewSyncResult = {
      dryRun: true,
      ...syncAggregates(result),
      operations: countOperations(operations),
      ...(includeTitles ? { sourceTitles: titledSources(operations) } : {}),
    };
    return { ok: true, data: payload };
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      return {
        ok: false,
        error: { code: "preview_lock_busy", message: error.message },
      };
    }
    return toolFailure(error, "preview_failed");
  }
}

export async function handleSyncNow(runtime: McpRuntime): Promise<ToolResult<SyncNowResult>> {
  try {
    const tenantId = resolveConfig(runtime).tenantId;
    const gate = runtime.scanGate?.check(tenantId, "write");
    if (gate !== undefined && !gate.allowed) {
      return scanRateLimited(gate.retryAfterSeconds, "running a sync");
    }
    const result = await runtime.sync.once({ dryRun: false });
    runtime.scanGate?.record(tenantId, "write");
    return {
      ok: true,
      data: {
        dryRun: false,
        ...syncAggregates(result),
      },
    };
  } catch (error) {
    return toolFailure(error, "sync_failed");
  }
}

export interface ExclusionToolInput {
  keys?: string[] | undefined;
  keywords?: string[] | undefined;
  from?: "personal" | "work" | undefined;
}

export function handleAddExclusion(
  runtime: McpRuntime,
  input: ExclusionToolInput,
): ToolResult<ExclusionChangeResult & { action: "add" }> {
  return handleExclusionChange(runtime, "add", input);
}

export function handleRemoveExclusion(
  runtime: McpRuntime,
  input: ExclusionToolInput,
): ToolResult<ExclusionChangeResult & { action: "remove" }> {
  return handleExclusionChange(runtime, "remove", input);
}

export function handleListExclusions(runtime: McpRuntime): ToolResult<ExclusionSnapshot> {
  try {
    return { ok: true, data: snapshotExclusions(resolveConfig(runtime), runtime.state) };
  } catch (error) {
    return toolFailure(error, "list_exclusions_failed");
  }
}

function handleExclusionChange<T extends "add" | "remove">(
  runtime: McpRuntime,
  action: T,
  input: ExclusionToolInput,
): ToolResult<ExclusionChangeResult & { action: T }> {
  try {
    const result = changeExclusions(
      action,
      runtime.state,
      {
        ...(input.keys === undefined ? {} : { keys: input.keys }),
        ...(input.keywords === undefined ? {} : { keywords: input.keywords }),
        ...(input.from === undefined ? {} : { from: input.from }),
      },
      { allowMix: true },
    );
    return { ok: true, data: { action, ...result } };
  } catch (error) {
    return toolFailure(error, `${action}_exclusion_failed`);
  }
}

export function toJsonPayload(value: unknown, allowTitles = false): Record<string, unknown> {
  const sanitized = sanitizeToolPayload(value, { allowTitles });
  if (typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)) {
    return sanitized as Record<string, unknown>;
  }
  return { value: sanitized };
}

/**
 * A wait, not a failure. The seconds go in the message because that is all an
 * assistant reads — given a number it can say "in a minute" and mean it,
 * rather than retrying straight into the same answer.
 */
function scanRateLimited(retryAfterSeconds: number, what: string): ToolFailure {
  return {
    ok: false,
    error: {
      code: "scan_rate_limited",
      message: `${what} reads both calendars in full, so it runs at most once in a while; try again in ${String(retryAfterSeconds)}s`,
    },
  };
}

function resolveConfig(runtime: McpRuntime): AppConfig {
  return (runtime.loadConfig ?? loadConfig)();
}

function readLastSync(
  rawResult: string | null,
  lastFullSyncAt: string | null,
): (SyncAggregates & { lastFullSyncAt: string | null }) | null {
  if (rawResult === null && lastFullSyncAt === null) {
    return null;
  }
  const aggregates = rawResult === null ? null : parseStoredAggregates(rawResult);
  if (aggregates === null && lastFullSyncAt === null) {
    return null;
  }
  return {
    ...(aggregates ?? emptyAggregates()),
    lastFullSyncAt,
  };
}

function parseStoredAggregates(raw: string): SyncAggregates | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record["created"] !== "number" ||
      typeof record["updated"] !== "number" ||
      typeof record["deleted"] !== "number" ||
      typeof record["repaired"] !== "number" ||
      typeof record["failed"] !== "number" ||
      typeof record["converged"] !== "boolean"
    ) {
      return null;
    }
    return {
      created: record["created"],
      updated: record["updated"],
      deleted: record["deleted"],
      repaired: record["repaired"],
      failed: record["failed"],
      converged: record["converged"],
      mirrors: parseMirrors(record["mirrors"]),
    };
  } catch {
    return null;
  }
}

function parseMirrors(value: unknown): SyncAggregates["mirrors"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return emptyAggregates().mirrors;
  }
  const record = value as Record<string, unknown>;
  return {
    personalToWork: parseMirrorTotals(record["personalToWork"]),
    workToPersonal: parseMirrorTotals(record["workToPersonal"]),
  };
}

function parseMirrorTotals(value: unknown): MirrorTotals {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { active: 0, excluded: 0, duplicateSuppressed: 0 };
  }
  const record = value as Record<string, unknown>;
  return {
    active: numberOrZero(record["active"]),
    excluded: numberOrZero(record["excluded"]),
    duplicateSuppressed: numberOrZero(record["duplicateSuppressed"]),
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function emptyAggregates(): SyncAggregates {
  return {
    created: 0,
    updated: 0,
    deleted: 0,
    repaired: 0,
    failed: 0,
    converged: true,
    mirrors: {
      personalToWork: { active: 0, excluded: 0, duplicateSuppressed: 0 },
      workToPersonal: { active: 0, excluded: 0, duplicateSuppressed: 0 },
    },
  };
}

function syncAggregates(result: SyncReconcileResult): SyncAggregates {
  return {
    created: result.created,
    updated: result.updated,
    deleted: result.deleted,
    repaired: result.repaired,
    failed: result.failed,
    converged: result.converged,
    mirrors: {
      personalToWork: { ...result.mirrors.personalToWork },
      workToPersonal: { ...result.mirrors.workToPersonal },
    },
  };
}

function countOperations(operations: readonly ReconcileLog[]): OperationCount[] {
  const counts = new Map<string, OperationCount>();
  for (const entry of operations) {
    const direction =
      entry.sourceRole === "personal" && entry.destinationRole === "work"
        ? "personalToWork"
        : "workToPersonal";
    const key = `${direction}\0${entry.operation}\0${entry.reason}`;
    const existing = counts.get(key);
    if (existing === undefined) {
      counts.set(key, {
        direction,
        operation: entry.operation,
        reason: entry.reason,
        count: 1,
      });
    } else {
      existing.count += 1;
    }
  }
  return [...counts.values()].sort((left, right) => {
    const direction = left.direction.localeCompare(right.direction);
    if (direction !== 0) {
      return direction;
    }
    const operation = left.operation.localeCompare(right.operation);
    return operation === 0 ? left.reason.localeCompare(right.reason) : operation;
  });
}

function titledSources(operations: readonly ReconcileLog[]): string[] {
  return operations.flatMap((entry) =>
    entry.sourceTitle === undefined ? [] : [entry.sourceTitle],
  );
}

function toolFailure(error: unknown, code: string): ToolFailure {
  const message =
    error instanceof Error && error.message.trim() !== "" ? error.message : "Unknown error";
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}
