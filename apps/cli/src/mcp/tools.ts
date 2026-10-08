import {
  LAST_FULL_SYNC_KEY,
  LAST_RESULT_KEY,
  parseStoredResult,
  stateKey,
  type CalendarKey,
  type ReconcileLog,
  type ReconcileProgress,
  type SyncReconcileResult,
} from "@calsync/engine";

import {
  accountRoles,
  accountSlots,
  loadConfig,
  type AccountRole,
  type AppConfig,
} from "../config.js";
import {
  changeExclusions,
  exclusionSources,
  snapshotExclusions,
  type ExclusionChangeResult,
  type ExclusionSnapshot,
  type ExclusionStore,
} from "../exclusions.js";
import {
  calendarLabel,
  resolveAvailableRef,
  resolveCalendarRef,
  withStoredCalendars,
} from "../calendars.js";
import type { AccountStatus, AuthorizationOptions, ConnectStartResult } from "../google/auth.js";
import type { AccountRuntime } from "../runtime.js";
import { tokenSlot, type WatchChannelRecord } from "../storage/index.js";
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
  /** Sign-ins and calendars. Absent → only the two roles' statuses are reported. */
  accounts?: AccountRuntime;
  /**
   * The gateway's connect URL template ({slot}, {tenant}, {role}), as the
   * dashboard's CALSYNC_WEB_CONNECT_URL. Set under the gateway, where sign-ins
   * are collected there; absent → calsync's own consent flow.
   */
  connectUrl?: string;
  /** Bounds how often the full-window passes may run. Absent → unbounded.
   * An assistant can call these in a loop, so the gate matters more here
   * than it does behind a button. */
  scanGate?: ScanGate;
  loadConfig?: () => AppConfig;
}

export interface SyncAggregates {
  created: number;
  updated: number;
  deleted: number;
  repaired: number;
  failed: number;
  converged: boolean;
  /** Busy blocks each calendar holds, by calendar key. */
  destinations: SyncReconcileResult["destinations"];
  /** Events each source calendar's exclusions hold back, by calendar key. */
  sources: SyncReconcileResult["sources"];
}

/** Push-notification health: whether channels are configured and when they expire. */
export interface PushStatusResult {
  configured: boolean;
  /** One per calendar, by calendar key. */
  channels: { calendar: string; expiresAt: string }[];
}

/** One Google sign-in. `account` is its address, once known. */
export interface SignInStatusResult {
  account: string;
  valid: boolean;
  message: string;
  calendars: number;
}

/** One synced calendar, named the way the other tools take it. */
export interface CalendarStatusResult {
  calendar: string;
  shares: boolean;
  receives: boolean;
  valid: boolean;
  message: string;
}

export interface StatusResult {
  signIns: SignInStatusResult[];
  calendars: CalendarStatusResult[];
  lastSync: (SyncAggregates & { lastFullSyncAt: string | null }) | null;
  push: PushStatusResult;
}

export interface OperationCount {
  /** Calendar the busy blocks are written to. */
  destination: CalendarKey;
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
    const accounts = runtime.accounts;
    let signIns: SignInStatusResult[] = [];
    let calendars: CalendarStatusResult[] = [];
    if (accounts === undefined) {
      signIns = await Promise.all(
        accountRoles.map(async (role) => {
          const status = await runtime.auth.getStatus(role, config.accounts[role].calendarId);
          return { account: role, valid: status.valid, message: status.message, calendars: 0 };
        }),
      );
    } else {
      // Gateway sign-ins handed out here or by the dashboard; one failing never fails the status.
      await accounts.auth.adoptReservedSignIns().catch(() => []);
      // A tenant that never signed in may have finished a role connect at the
      // gateway: a passing check is what records it.
      if (!accounts.state.hasSignedIn()) {
        await Promise.all(
          accountRoles.map((role) =>
            runtime.auth.getStatus(role, config.accounts[role].calendarId).catch(() => undefined),
          ),
        );
      }
      const stored = accounts.state.listCalendars();
      const signedIn = accounts.state.listGoogleAccounts();
      signIns = await Promise.all(
        signedIn.map(async (entry) => {
          const check = await accounts.auth.checkAccount(entry.slot);
          return {
            account: check.email ?? entry.slot,
            valid: check.valid,
            message: check.message,
            calendars: stored.filter((calendar) => calendar.account === entry.slot).length,
          };
        }),
      );
      const refreshed = accounts.state.listGoogleAccounts();
      calendars = await Promise.all(
        stored.map(async (calendar) => {
          const check = await accounts.auth.checkCalendar(calendar);
          return {
            calendar: calendarLabel(check.calendar, refreshed),
            shares: calendar.source,
            receives: calendar.destination,
            valid: check.valid,
            message: check.message,
          };
        }),
      );
    }
    return {
      ok: true,
      data: {
        signIns,
        calendars,
        // sync_state is one flat table across tenants; unscoped keys belong
        // to the default tenant, so every read names this tenant's.
        lastSync: readLastSync(
          runtime.state.getState(stateKey(LAST_RESULT_KEY, config.tenantId)),
          runtime.state.getState(stateKey(LAST_FULL_SYNC_KEY, config.tenantId)),
        ),
        push: {
          configured: config.webhook !== undefined,
          channels: (runtime.state.listWatchChannels?.() ?? []).map((channel) => ({
            calendar: channel.calendarKey,
            expiresAt: channel.expiresAt,
          })),
        },
      },
    };
  } catch (error) {
    return toolFailure(error, "status_failed");
  }
}

export interface ConnectAccountResult {
  url: string;
  expires_at?: string;
  next: string;
}

/**
 * Starts signing in another Google account. Under the gateway, a link to its
 * consent flow for the next free slot, adopted on the next get_status; else
 * calsync's own consent, recorded when the person finishes.
 */
export async function handleConnectAccount(
  runtime: McpRuntime,
): Promise<ToolResult<ConnectAccountResult>> {
  const accounts = runtime.accounts;
  if (accounts === undefined) {
    return unavailable("connect_unavailable", "This server cannot sign in accounts");
  }
  try {
    const next =
      "After the person finishes in the browser, call get_status, then list_calendars with available=true and add_calendar.";
    if (runtime.connectUrl !== undefined) {
      // A fresh slot every time, never an existing account's: the gateway
      // stores the token before anyone knows whose it is.
      const slot = accounts.auth.reserveAccountSlot();
      if (slot === undefined) {
        return unavailable(
          "account_limit",
          `calsync holds at most ${String(accountSlots.length)} added Google accounts; remove one first`,
        );
      }
      const tenant = resolveConfig(runtime).tenantId;
      return {
        ok: true,
        data: {
          url: runtime.connectUrl
            .replaceAll("{slot}", tokenSlot(slot, tenant))
            .replaceAll("{tenant}", tenant)
            .replaceAll("{role}", slot),
          next,
        },
      };
    }
    const started = await accounts.auth.startAccountConnect();
    return { ok: true, data: { url: started.url, expires_at: started.expiresAt, next } };
  } catch (error) {
    return toolFailure(error, "connect_account_failed");
  }
}

export interface CalendarListResult {
  /** What each synced calendar does; get_status checks them. */
  calendars: { calendar: string; shares: boolean; receives: boolean }[];
  /** With available=true: every calendar each signed-in account can see. */
  available?: {
    calendar: string;
    synced: boolean;
    can_receive: boolean;
    can_share: boolean;
  }[];
}

export async function handleListCalendars(
  runtime: McpRuntime,
  input: { available?: boolean | undefined } = {},
): Promise<ToolResult<CalendarListResult>> {
  const accounts = runtime.accounts;
  if (accounts === undefined) {
    return unavailable("calendars_unavailable", "This server cannot list calendars");
  }
  try {
    const signedIn = accounts.state.listGoogleAccounts();
    const stored = accounts.state.listCalendars();
    const calendars = stored.map((calendar) => ({
      calendar: calendarLabel(calendar, signedIn),
      shares: calendar.source,
      receives: calendar.destination,
    }));
    if (input.available !== true) {
      return { ok: true, data: { calendars } };
    }
    const available: NonNullable<CalendarListResult["available"]> = [];
    for (const entry of signedIn) {
      const email = entry.email ?? entry.slot;
      // One account that cannot list (signed out, say) leaves the others' lists.
      const options = await accounts.auth.availableCalendars(entry.slot).catch(() => []);
      for (const option of options) {
        available.push({
          calendar: option.primary ? email : `${email}/${option.name}`,
          synced: stored.some(
            (calendar) =>
              calendar.calendarId.toLowerCase() === option.calendarId.toLowerCase() ||
              (option.primary &&
                calendar.account === entry.slot &&
                calendar.calendarId === "primary"),
          ),
          can_receive: option.writable,
          can_share: option.readable,
        });
      }
    }
    return { ok: true, data: { calendars, available } };
  } catch (error) {
    return toolFailure(error, "list_calendars_failed");
  }
}

export interface AddCalendarInput {
  calendar: string;
  share_only?: boolean | undefined;
  receive_only?: boolean | undefined;
}

export async function handleAddCalendar(
  runtime: McpRuntime,
  input: AddCalendarInput,
): Promise<ToolResult<{ calendar: string; shares: boolean; receives: boolean }>> {
  const accounts = runtime.accounts;
  if (accounts === undefined) {
    return unavailable("calendars_unavailable", "This server cannot add calendars");
  }
  if (input.share_only === true && input.receive_only === true) {
    return unavailable("invalid_roles", "Use share_only or receive_only, not both");
  }
  try {
    const { account, calendar } = await resolveAvailableRef(
      input.calendar,
      accounts.state.listGoogleAccounts(),
      (slot) => accounts.auth.availableCalendars(slot),
    );
    const added = await accounts.auth.connectCalendar(account.slot, calendar.calendarId, {
      source: input.receive_only !== true,
      destination: input.share_only !== true,
    });
    return {
      ok: true,
      data: {
        calendar: calendarLabel(added, accounts.state.listGoogleAccounts()),
        shares: added.source,
        receives: added.destination,
      },
    };
  } catch (error) {
    return toolFailure(error, "add_calendar_failed");
  }
}

export async function handleRemoveCalendar(
  runtime: McpRuntime,
  input: { calendar: string; keep_blocks?: boolean | undefined },
): Promise<ToolResult<{ calendar: string; deleted: number | null }>> {
  const accounts = runtime.accounts;
  if (accounts === undefined) {
    return unavailable("calendars_unavailable", "This server cannot remove calendars");
  }
  // A removal runs a full pass and writes; an assistant can call it in a loop.
  const gate = runtime.scanGate?.check(resolveConfig(runtime).tenantId, "write");
  if (gate !== undefined && !gate.allowed) {
    return scanRateLimited(gate.retryAfterSeconds, "removing a calendar");
  }
  try {
    const signedIn = accounts.state.listGoogleAccounts();
    const target = resolveCalendarRef(input.calendar, accounts.state.listCalendars(), signedIn);
    const result = await accounts.removeCalendar(target.key, {
      ...(input.keep_blocks === true ? { keepBlocks: true } : {}),
    });
    runtime.scanGate?.record(resolveConfig(runtime).tenantId, "write");
    return {
      ok: true,
      data: { calendar: calendarLabel(target, signedIn), deleted: result?.deleted ?? null },
    };
  } catch (error) {
    return toolFailure(error, "remove_calendar_failed");
  }
}

function unavailable(code: string, message: string): ToolFailure {
  return { ok: false, error: { code, message } };
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
  /** The calendar whose events keywords hold back, as get_status names it. */
  from?: string | undefined;
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
    return { ok: true, data: snapshotExclusions(storedConfig(runtime), runtime.state) };
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
    const config = storedConfig(runtime);
    const sources = exclusionSources(config);
    const accounts = runtime.accounts;
    // `from` names a calendar the way get_status does; a key passes through.
    const from =
      input.from === undefined || sources.includes(input.from) || accounts === undefined
        ? input.from
        : resolveCalendarRef(
            input.from,
            accounts.state.listCalendars(),
            accounts.state.listGoogleAccounts(),
          ).key;
    const result = changeExclusions(
      action,
      runtime.state,
      {
        ...(input.keys === undefined ? {} : { keys: input.keys }),
        ...(input.keywords === undefined ? {} : { keywords: input.keywords }),
        ...(from === undefined ? {} : { from }),
      },
      sources,
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

/** The config with the tenant's stored calendars: what exclusions apply to. */
function storedConfig(runtime: McpRuntime): AppConfig {
  const config = resolveConfig(runtime);
  const accounts = runtime.accounts;
  return accounts === undefined
    ? config
    : withStoredCalendars(config, accounts.state.listCalendars(), accounts.state.hasSignedIn());
}

function readLastSync(
  rawResult: string | null,
  lastFullSyncAt: string | null,
): (SyncAggregates & { lastFullSyncAt: string | null }) | null {
  if (rawResult === null && lastFullSyncAt === null) {
    return null;
  }
  const stored = parseStoredResult(rawResult);
  const aggregates = stored === null ? null : syncAggregates(stored);
  if (aggregates === null && lastFullSyncAt === null) {
    return null;
  }
  return {
    ...(aggregates ?? emptyAggregates()),
    lastFullSyncAt,
  };
}

function emptyAggregates(): SyncAggregates {
  return {
    created: 0,
    updated: 0,
    deleted: 0,
    repaired: 0,
    failed: 0,
    converged: true,
    destinations: {},
    sources: {},
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
    destinations: structuredClone(result.destinations),
    sources: structuredClone(result.sources),
  };
}

function countOperations(operations: readonly ReconcileLog[]): OperationCount[] {
  const counts = new Map<string, OperationCount>();
  for (const entry of operations) {
    const destination = entry.destinationKey;
    const key = `${destination}\0${entry.operation}\0${entry.reason}`;
    const existing = counts.get(key);
    if (existing === undefined) {
      counts.set(key, {
        destination,
        operation: entry.operation,
        reason: entry.reason,
        count: 1,
      });
    } else {
      existing.count += 1;
    }
  }
  return [...counts.values()].sort((left, right) => {
    const destination = left.destination.localeCompare(right.destination);
    if (destination !== 0) {
      return destination;
    }
    const operation = left.operation.localeCompare(right.operation);
    return operation === 0 ? left.reason.localeCompare(right.reason) : operation;
  });
}

function titledSources(operations: readonly ReconcileLog[]): string[] {
  return operations.flatMap((entry) => entry.sourceTitles ?? []);
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
