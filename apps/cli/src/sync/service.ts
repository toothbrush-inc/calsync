import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import {
  CleanupPassError,
  DedupePassError,
  ReconcilePassError,
  SyncEngine,
  googleApiErrorInfo,
  systemClock,
  type AccountRole,
  type CalendarAPI,
  type Clock,
  type DedupeResult,
  type FullSyncReason,
  type GoogleApiErrorInfo,
  type ReconcileResult,
  type SyncReconcileResult,
  type SyncRunOptions,
  type SyncStatus,
} from "@calsync/engine";

import type { AppConfig, WebhookConfig } from "../config.js";
import type { ChannelAPI } from "../google/channels.js";
import type { StateDatabase, WatchChannelRecord } from "../storage/index.js";
import { ChannelManager, stopWatchChannels, type WatchChannelStore } from "./channels.js";
import { SyncTrigger, WebhookReceiver, type SyncTriggerReason } from "./webhook.js";

export type { FullSyncReason, SyncRunOptions, SyncStatus };

export interface CalendarClientFactory {
  createCalendarClient(role: "personal" | "work"): Promise<CalendarAPI>;
  /** Present once the factory can arm Google push channels. */
  createChannelClient?: (role: "personal" | "work") => Promise<ChannelAPI>;
}

export interface SyncLockOptions {
  lockTimeoutMs?: number;
  onLockWait?: (waitedMs: number) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface SyncOnceOptions extends SyncRunOptions, SyncLockOptions {}

export interface SyncStartOptions extends SyncRunOptions {
  signal?: AbortSignal;
}

export interface SyncService {
  once(options?: SyncOnceOptions): Promise<SyncReconcileResult>;
  start(options?: SyncStartOptions): Promise<void>;
  rebuild(options?: SyncOnceOptions): Promise<ReconcileResult>;
  cleanup(options?: SyncOnceOptions): Promise<ReconcileResult>;
  /** Removes managed busy blocks that double up on the same slot; see Reconciler.dedupe. */
  dedupe(options?: SyncOnceOptions): Promise<DedupeResult>;
}

export class ReconciliationError extends Error {
  override readonly name = "ReconciliationError";

  constructor(
    readonly category: "credentials" | "permissions" | "rate-limit" | "conflict" | "google-api",
    message: string,
    options?: ErrorOptions,
    readonly result?: SyncReconcileResult,
  ) {
    super(message, options);
  }
}

export class DefaultSyncService implements SyncService {
  constructor(
    private readonly config: AppConfig,
    private readonly auth: CalendarClientFactory,
    private readonly state: StateDatabase,
    private readonly lockPath: string,
    private readonly writeLog: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
    private readonly clock: Clock = systemClock,
  ) {}

  async once(options: SyncOnceOptions = {}): Promise<SyncReconcileResult> {
    return this.withLock(() => this.runOnce(options), options);
  }

  async rebuild(options: SyncOnceOptions = {}): Promise<ReconcileResult> {
    return this.withLock(() => this.withEngine((engine) => engine.rebuild(options)), options);
  }

  async cleanup(options: SyncOnceOptions = {}): Promise<ReconcileResult> {
    const result = await this.withLock(
      () => this.withEngine((engine) => engine.cleanup(options)),
      options,
    );
    if (options.dryRun !== true) {
      await this.stopPushChannels();
    }
    return result;
  }

  async dedupe(options: SyncOnceOptions = {}): Promise<DedupeResult> {
    return this.withLock(() => this.withEngine((engine) => engine.dedupe(options)), options);
  }

  /** Leaves nothing armed at Google once the mirrors are gone. */
  private async stopPushChannels(): Promise<void> {
    const createClient = this.channelClientFactory();
    if (
      createClient === undefined ||
      this.state.listWatchChannels(this.config.tenantId).length === 0
    ) {
      return;
    }
    const failures = await stopWatchChannels({
      store: this.state,
      createClient,
      onLog: (line) => {
        this.writeLog(line);
      },
      tenantId: this.config.tenantId,
    });
    for (const failure of failures) {
      this.writeLog(
        JSON.stringify({
          event: "webhook_channel_stop_failed",
          role: failure.role,
          error: errorName(failure.error),
        }),
      );
    }
  }

  /** Runs a daemon over this service's tenant alone. */
  async start(options: SyncStartOptions = {}): Promise<void> {
    const tenant = this.daemonTenant();
    await new SyncDaemon(
      this.config,
      () => [tenant],
      (channelId) => this.state.getWatchChannelByChannelId(channelId),
      this.daemonLockPath,
      this.writeLog,
      this.clock,
    ).start(options);
  }

  /** This service as one tenant of a SyncDaemon. */
  daemonTenant(): DaemonTenant {
    const createChannelClient = this.channelClientFactory();
    return {
      tenantId: this.config.tenantId,
      service: this,
      store: this.state,
      calendarIds: {
        personal: this.config.accounts.personal.calendarId,
        work: this.config.accounts.work.calendarId,
      },
      ...(createChannelClient === undefined ? {} : { createChannelClient }),
    };
  }

  private channelClientFactory(): ((role: AccountRole) => Promise<ChannelAPI>) | undefined {
    return this.auth.createChannelClient?.bind(this.auth);
  }

  private get daemonLockPath(): string {
    return daemonLockPathFor(this.lockPath);
  }

  private async runOnce(options: SyncRunOptions): Promise<SyncReconcileResult> {
    return this.withEngine((engine) => engine.once(options));
  }

  private async withEngine<T>(run: (engine: SyncEngine) => Promise<T>): Promise<T> {
    try {
      const [personal, work] = await Promise.all([
        this.auth.createCalendarClient("personal"),
        this.auth.createCalendarClient("work"),
      ]);
      return await run(
        new SyncEngine(
          this.config,
          this.state,
          this.state,
          this.state,
          { personal, work },
          this.clock,
        ),
      );
    } catch (error) {
      throw classifyReconciliationError(error);
    }
  }

  private async withLock<T>(run: () => Promise<T>, options: SyncLockOptions = {}): Promise<T> {
    const lock = await acquireLockWaiting(this.lockPath, {
      ...(options.lockTimeoutMs === undefined ? {} : { timeoutMs: options.lockTimeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onLockWait === undefined ? {} : { onWait: options.onLockWait }),
    });
    try {
      return await run();
    } finally {
      lock.release();
    }
  }
}

/** One tenant a SyncDaemon serves. */
export interface DaemonTenant {
  tenantId: string;
  /** Runs the tenant's passes under its own reconcile lock. */
  service: SyncService;
  /** The tenant's watch-channel rows. */
  store: WatchChannelStore;
  calendarIds: Record<AccountRole, string>;
  /** Absent when this tenant cannot arm Google push channels. */
  createChannelClient?: (role: AccountRole) => Promise<ChannelAPI>;
}

/**
 * The daemon loop: one process, one webhook receiver, every tenant on the
 * host. A notification wakes only the tenant whose calendar changed; the
 * startup pass covers everyone, and the timer wakes each tenant on its own
 * cadence — the slow backstop while its push channels are armed, the poll
 * rate while they are not — so one tenant with broken channels doesn't drag
 * every healthy tenant into fast polling. The tenant provider is consulted
 * before every pass round, so tenants authorized after startup join the loop
 * without a restart.
 */
export class SyncDaemon {
  readonly #dirty = new Set<string>();
  /** When each tenant's last pass round started, keyed by tenant id. */
  readonly #lastPass = new Map<string, number>();
  /** Last startPush failure, so retries don't repeat the same log line. */
  #pushFailure: string | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly tenants: () => readonly DaemonTenant[],
    private readonly lookupChannel: (channelId: string) => WatchChannelRecord | null,
    private readonly daemonLockPath: string,
    private readonly writeLog: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
    private readonly clock: Clock = systemClock,
  ) {}

  async start(options: SyncStartOptions = {}): Promise<void> {
    const daemonLock = acquireLock(this.daemonLockPath, { kind: "daemon" });
    const controller = new AbortController();
    const stop = (): void => {
      controller.abort();
    };
    if (options.signal?.aborted) {
      daemonLock.release();
      return;
    }
    const listenToProcess = options.signal === undefined;
    options.signal?.addEventListener("abort", stop, { once: true });
    if (listenToProcess) {
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }
    let push: PushSession | undefined;
    try {
      push = await this.startPush();
      let reason: SyncTriggerReason = "startup";
      for (;;) {
        const targets = this.passTargets(reason, push);
        this.#dirty.clear();
        // Tenants that pass together stay anchored to the same instant, so
        // they keep waking in one round instead of fragmenting the timer.
        const roundStart = this.clock.now().getTime();
        for (const tenant of this.tenants()) {
          if (targets !== undefined && !targets.has(tenant.tenantId)) {
            continue;
          }
          await this.runLoggedPass(tenant, options, reason);
          this.#lastPass.set(tenant.tenantId, roundStart);
          if (controller.signal.aborted) {
            break;
          }
        }
        if (controller.signal.aborted) {
          break;
        }
        // A failed receiver start (port taken, channels refused) degrades to
        // polling; retry each round so push recovers without a restart.
        push ??= await this.startPush();
        reason = await this.waitForNextPass(push, controller.signal);
        if (reason === "aborted") {
          break;
        }
      }
    } finally {
      await push?.close();
      options.signal?.removeEventListener("abort", stop);
      if (listenToProcess) {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
      daemonLock.release();
    }
  }

  /** Waits for the next reason to reconcile: a notification, the timer, or shutdown. */
  private async waitForNextPass(
    push: PushSession | undefined,
    signal: AbortSignal,
  ): Promise<SyncTriggerReason> {
    if (push === undefined) {
      await abortableDelay(this.config.pollIntervalMs, signal);
      return signal.aborted ? "aborted" : "scheduled";
    }
    // Channels expire on Google's schedule; re-arm between passes.
    await push.ensure();
    return await push.trigger.next(this.nextScheduledWaitMs(push), signal);
  }

  /**
   * The tenants a pass round covers: the notified tenants after a webhook,
   * the tenants whose cadence has elapsed on a timer wake, everyone otherwise
   * (startup, or a poll-only daemon without push).
   */
  private passTargets(
    reason: SyncTriggerReason,
    push: PushSession | undefined,
  ): Set<string> | undefined {
    if (reason === "webhook" && this.#dirty.size > 0) {
      return new Set(this.#dirty);
    }
    if (reason !== "scheduled" || push === undefined) {
      return undefined;
    }
    const now = this.clock.now().getTime();
    const due = new Set<string>();
    for (const tenant of this.tenants()) {
      const last = this.#lastPass.get(tenant.tenantId);
      if (last === undefined || last + push.cadenceMs(tenant.tenantId) <= now) {
        due.add(tenant.tenantId);
      }
    }
    return due;
  }

  /** Milliseconds until the earliest tenant's next pass comes due. */
  private nextScheduledWaitMs(push: PushSession): number {
    const now = this.clock.now().getTime();
    const active = new Set<string>();
    let waitMs = Number.POSITIVE_INFINITY;
    for (const tenant of this.tenants()) {
      active.add(tenant.tenantId);
      const last = this.#lastPass.get(tenant.tenantId);
      // A tenant with no pass yet (discovered between rounds) is due now.
      waitMs = Math.min(
        waitMs,
        last === undefined ? 0 : last + push.cadenceMs(tenant.tenantId) - now,
      );
    }
    for (const tenantId of this.#lastPass.keys()) {
      if (!active.has(tenantId)) {
        this.#lastPass.delete(tenantId);
      }
    }
    return Number.isFinite(waitMs) ? Math.max(0, waitMs) : this.config.pollIntervalMs;
  }

  private async runLoggedPass(
    tenant: DaemonTenant,
    options: SyncStartOptions,
    trigger: SyncTriggerReason,
  ): Promise<void> {
    // Single-tenant log lines stay byte-identical; only extra tenants label.
    const label = tenant.tenantId === "default" ? {} : { tenant: tenant.tenantId };
    try {
      // The daemon's abort signal stays out of the pass: a pass in flight
      // finishes, and only the wait between passes is interruptible.
      const result = await tenant.service.once({
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        ...(options.onOperation === undefined ? {} : { onOperation: options.onOperation }),
        ...(options.onSourceEvent === undefined ? {} : { onSourceEvent: options.onSourceEvent }),
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
        onStatus: (status) => {
          options.onStatus?.(status);
          this.writeLog(JSON.stringify({ ...status, ...label }));
        },
      });
      this.writeLog(
        JSON.stringify({
          event: "reconcile_complete",
          ...label,
          trigger,
          dryRun: options.dryRun ?? false,
          ...result,
        }),
      );
    } catch (error) {
      const result = syncResultFromError(error);
      this.writeLog(
        JSON.stringify({
          event: "reconcile_failed",
          ...label,
          trigger,
          dryRun: options.dryRun ?? false,
          totalsAvailable: result !== undefined,
          ...(result ?? {}),
          error:
            error instanceof ReconciliationError
              ? error.category
              : error instanceof Error
                ? error.name
                : "UnknownError",
        }),
      );
    }
  }

  /**
   * Arms Google push channels and starts the loopback receiver. Any failure
   * here is survivable: the daemon keeps its poll timer instead.
   */
  private async startPush(): Promise<PushSession | undefined> {
    const webhook = this.config.webhook;
    if (webhook === undefined) {
      return undefined;
    }
    // Managers are cached per tenant and rebuilt from the live tenant list on
    // every re-arm check, so a tenant discovered mid-run gets channels too.
    const managerCache = new Map<string, ChannelManager>();
    const managersFor = (): { tenantId: string; manager: ChannelManager }[] => {
      const current = this.tenants();
      const active = new Set(current.map((tenant) => tenant.tenantId));
      for (const tenantId of managerCache.keys()) {
        if (!active.has(tenantId)) {
          managerCache.delete(tenantId);
        }
      }
      return current.flatMap((tenant) => {
        const createClient = tenant.createChannelClient;
        if (createClient === undefined) {
          return [];
        }
        let manager = managerCache.get(tenant.tenantId);
        manager ??= new ChannelManager({
          address: webhook.address,
          calendarIds: tenant.calendarIds,
          ttlSeconds: webhook.channelTtlSeconds,
          renewBeforeMs: webhook.renewBeforeMs,
          createClient,
          store: tenant.store,
          clock: this.clock,
          onLog: (line) => {
            this.writeLog(line);
          },
          tenantId: tenant.tenantId,
        });
        managerCache.set(tenant.tenantId, manager);
        return [{ tenantId: tenant.tenantId, manager }];
      });
    };
    if (managersFor().length === 0) {
      this.#logPushFailure("no-channel-client", {
        event: "webhook_unavailable",
        reason: "no-channel-client",
      });
      return undefined;
    }
    const trigger = new SyncTrigger(webhook.debounceMs);
    const writeLog = (line: string): void => {
      this.writeLog(line);
    };
    const receiver = new WebhookReceiver({
      host: webhook.host,
      port: webhook.port,
      path: webhook.path,
      lookupChannel: this.lookupChannel,
      onNotification: (role, tenantId) => {
        this.#dirty.add(tenantId);
        trigger.notify();
      },
      onLog: writeLog,
    });
    try {
      const port = await receiver.listen();
      this.#pushFailure = undefined;
      writeLog(
        JSON.stringify({
          event: "webhook_listening",
          host: webhook.host,
          port,
          path: webhook.path,
        }),
      );
    } catch (error) {
      this.#logPushFailure(`listen:${errorName(error)}`, {
        event: "webhook_listen_failed",
        error: errorName(error),
      });
      trigger.dispose();
      return undefined;
    }
    const session = new PushSession(
      webhook,
      receiver,
      managersFor,
      trigger,
      writeLog,
      this.config.pollIntervalMs,
    );
    await session.ensure();
    return session;
  }

  /** Logs a startPush failure only when it differs from the previous one. */
  #logPushFailure(key: string, entry: Record<string, unknown>): void {
    if (this.#pushFailure === key) {
      return;
    }
    this.#pushFailure = key;
    this.writeLog(JSON.stringify(entry));
  }
}

/**
 * Live push-notification state for one daemon run: the receiver, the channels
 * it answers for (one manager per tenant), and the debounced trigger that
 * wakes the sync loop.
 */
class PushSession {
  /** Whether each tenant's channels are all armed, keyed by tenant id. */
  readonly #armed = new Map<string, boolean>();

  constructor(
    private readonly webhook: WebhookConfig,
    private readonly receiver: WebhookReceiver,
    private readonly managers: () => readonly { tenantId: string; manager: ChannelManager }[],
    readonly trigger: SyncTrigger,
    private readonly writeLog: (line: string) => void,
    private readonly fallbackPollIntervalMs: number,
  ) {}

  async ensure(): Promise<void> {
    const seen = new Set<string>();
    for (const { tenantId, manager } of this.managers()) {
      seen.add(tenantId);
      const result = await manager.ensure();
      this.#armed.set(
        tenantId,
        result.failed.length === 0 && result.armed.length + result.current.length > 0,
      );
      for (const failure of result.failed) {
        const classified = classifyReconciliationError(failure.error);
        this.writeLog(
          JSON.stringify({
            event: "webhook_arm_failed",
            ...(tenantId === "default" ? {} : { tenant: tenantId }),
            role: failure.role,
            error:
              classified instanceof ReconciliationError
                ? classified.category
                : errorName(failure.error),
            message: classified instanceof ReconciliationError ? classified.message : undefined,
          }),
        );
      }
    }
    for (const tenantId of this.#armed.keys()) {
      if (!seen.has(tenantId)) {
        this.#armed.delete(tenantId);
      }
    }
  }

  /**
   * One tenant's backstop cadence: slow while its channels are armed, the
   * poll rate when not — including a tenant with no channel client, which
   * hears no notifications and must rely on polling.
   */
  cadenceMs(tenantId: string): number {
    return this.#armed.get(tenantId) === true
      ? this.webhook.pollIntervalMs
      : this.fallbackPollIntervalMs;
  }

  async close(): Promise<void> {
    this.trigger.dispose();
    await this.receiver.close();
  }
}

export interface ProcessLock {
  release(): void;
}

export type LockKind = "process" | "daemon";

export class LockTimeoutError extends Error {
  override readonly name = "LockTimeoutError";

  constructor(message = LOCK_TIMEOUT_MESSAGE) {
    super(message);
  }
}

const LOCK_TIMEOUT_MESSAGE =
  "Timed out waiting for the reconcile lock. If this persists after a rebuild, " +
  "run calsync service install so launchd runs apps/cli/dist/cli.js instead of the old dist/cli.js.";

const LOCK_WAIT_INTERVAL_MS = 25;
const LOCK_WAIT_NOTIFY_INTERVAL_MS = 2_000;

/**
 * Sync-pass lock path for one tenant's daemon. The default tenant keeps the
 * legacy name; other tenants get their own lock so per-tenant daemons on one
 * host don't refuse to start over each other.
 */
export function syncLockPathFor(databasePath: string, tenantId = "default"): string {
  return tenantId === "default" ? `${databasePath}.lock` : `${databasePath}.${tenantId}.lock`;
}

export function daemonLockPathFor(lockPath: string): string {
  return lockPath.endsWith(".lock")
    ? `${lockPath.slice(0, -".lock".length)}.daemon.lock`
    : `${lockPath}.daemon.lock`;
}

export function acquireLock(path: string, options: { kind?: LockKind } = {}): ProcessLock {
  const kind = options.kind ?? "process";
  const noun = kind === "daemon" ? "daemon" : "process";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeFileSync(descriptor, lockPayload());
      } catch (error) {
        closeSync(descriptor);
        rmSync(path, { force: true });
        throw error;
      }
      return {
        release(): void {
          closeSync(descriptor);
          rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw new Error(`Unable to acquire the calsync ${noun} lock`, { cause: error });
      }
      if (attempt > 0 || !removeStaleLock(path)) {
        throw new Error(`Another calsync ${noun} is already running`, { cause: error });
      }
    }
  }
  throw new Error(`Unable to acquire calsync ${noun} lock`);
}

export async function acquireLockWaiting(
  path: string,
  options: {
    intervalMs?: number;
    timeoutMs?: number;
    notifyIntervalMs?: number;
    signal?: AbortSignal;
    onWait?: (waitedMs: number) => void | Promise<void>;
  } = {},
): Promise<ProcessLock> {
  const intervalMs = options.intervalMs ?? LOCK_WAIT_INTERVAL_MS;
  const notifyIntervalMs = options.notifyIntervalMs ?? LOCK_WAIT_NOTIFY_INTERVAL_MS;
  const started = Date.now();
  let notifiedAt = Number.NEGATIVE_INFINITY;
  for (;;) {
    if (options.signal?.aborted) {
      throw new Error("Unable to acquire the calsync process lock");
    }
    try {
      return acquireLock(path);
    } catch (error) {
      if (!isBusyLockError(error)) {
        throw error;
      }
      const waitedMs = Date.now() - started;
      if (options.timeoutMs !== undefined && waitedMs >= options.timeoutMs) {
        throw new LockTimeoutError();
      }
      if (options.onWait !== undefined && waitedMs - notifiedAt >= notifyIntervalMs) {
        notifiedAt = waitedMs;
        await options.onWait(waitedMs);
      }
      const remaining =
        options.timeoutMs === undefined
          ? intervalMs
          : Math.max(0, options.timeoutMs - (Date.now() - started));
      if (remaining === 0) {
        throw new LockTimeoutError();
      }
      await abortableDelay(Math.min(intervalMs, remaining), options.signal);
    }
  }
}

/** `pid` plus Linux starttime so a recycled PID (Docker PID 1 after restart) looks stale. */
function lockPayload(): string {
  const starttime = processStarttime(process.pid);
  return starttime === undefined ? String(process.pid) : `${String(process.pid)} ${starttime}`;
}

function parseLock(content: string): { pid: number; starttime: string | undefined } | null {
  const parts = content.trim().split(/\s+/u);
  const pid = Number(parts[0]);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const starttime = parts[1];
  return { pid, starttime: starttime === undefined || starttime === "" ? undefined : starttime };
}

function processStarttime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close === -1) {
      return undefined;
    }
    const starttime = stat.slice(close + 2).split(" ")[19];
    return starttime === undefined || starttime === "" ? undefined : starttime;
  } catch {
    return undefined;
  }
}

function pidIsAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    // EPERM: the pid exists (we just can't signal it). Anything else is unknown.
    return code === "EPERM" ? true : undefined;
  }
}

/**
 * True when a live process holds the given daemon lock — the same liveness
 * rules the stale-lock recovery uses, without touching the file. Status
 * surfaces use this to report whether syncing is actually running.
 */
export function daemonIsRunning(daemonLockPath: string): boolean {
  let parsed: ReturnType<typeof parseLock>;
  try {
    parsed = parseLock(readFileSync(daemonLockPath, "utf8"));
  } catch {
    return false;
  }
  if (parsed === null) {
    return false;
  }
  const alive = pidIsAlive(parsed.pid);
  if (alive === undefined) {
    // Not ours to signal, but the pid exists — treat the lock as held.
    return true;
  }
  if (!alive) {
    return false;
  }
  if (parsed.starttime !== undefined) {
    return parsed.starttime === processStarttime(parsed.pid);
  }
  // Legacy pid-only lock: PID 1 is never a live calsync (see removeStaleLock).
  return parsed.pid !== 1;
}

function removeStaleLock(path: string): boolean {
  try {
    const parsed = parseLock(readFileSync(path, "utf8"));
    if (parsed !== null) {
      const alive = pidIsAlive(parsed.pid);
      if (alive === undefined) {
        return false;
      }
      if (alive) {
        const liveStart = processStarttime(parsed.pid);
        if (parsed.starttime !== undefined) {
          if (parsed.starttime === liveStart) {
            return false;
          }
        } else if (parsed.pid !== 1) {
          // Legacy pid-only lock. PID 1 is never a live calsync on a host
          // (launchd/systemd owns it) and after a container restart it is
          // always alive — the Docker failure mode we hit on the VM.
          return false;
        }
      }
    }
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isBusyLockError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^Another calsync (process|daemon) is already running$/.test(error.message)
  );
}

const RATE_LIMIT_REASONS = new Set([
  "calendarUsageLimitsExceeded",
  "dailyLimitExceeded",
  "quotaExceeded",
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);

const PERMISSION_REASONS = new Set([
  "forbidden",
  "forbiddenForNonOrganizer",
  "insufficientPermissions",
  "requiredAccessLevel",
]);

export function classifyReconciliationError(error: unknown): unknown {
  if (error instanceof ReconciliationError) {
    return error;
  }
  if (error instanceof CleanupPassError || error instanceof DedupePassError) {
    const classifiedCause = classifyReconciliationError(error.cause);
    if (classifiedCause instanceof ReconciliationError) {
      return new ReconciliationError(
        classifiedCause.category,
        `${error.message}. ${classifiedCause.message}`,
        { cause: error },
      );
    }
    return error;
  }
  if (error instanceof ReconcilePassError) {
    const classifiedCause = classifyReconciliationError(error.cause);
    if (classifiedCause instanceof ReconciliationError) {
      return new ReconciliationError(
        classifiedCause.category,
        classifiedCause.message,
        { cause: error },
        error.result,
      );
    }
    return error;
  }
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : undefined;
  const response =
    typeof record?.["response"] === "object" && record["response"] !== null
      ? (record["response"] as Record<string, unknown>)
      : undefined;
  const responseData =
    typeof response?.["data"] === "object" && response["data"] !== null
      ? (response["data"] as Record<string, unknown>)
      : undefined;
  const googleError = googleApiErrorInfo(error);
  const rawStatus = record?.["code"] ?? response?.["status"];
  const parsedStatus = typeof rawStatus === "string" ? Number(rawStatus) : rawStatus;
  const status = typeof parsedStatus === "number" ? parsedStatus : googleError.status;
  const oauthError = responseData?.["error"];
  if (status === 401 || oauthError === "invalid_grant") {
    return new ReconciliationError(
      "credentials",
      "Google credentials were revoked or expired; run calsync auth again",
      { cause: error },
    );
  }
  const detail = formatGoogleErrorDetail(googleError);
  if (
    status === 429 ||
    (status === 403 &&
      googleError.reason !== undefined &&
      RATE_LIMIT_REASONS.has(googleError.reason))
  ) {
    return new ReconciliationError(
      "rate-limit",
      `Google Calendar rate or quota limit persisted after retries; retry later${detail}`,
      { cause: error },
    );
  }
  if (
    status === 403 &&
    googleError.reason !== undefined &&
    PERMISSION_REASONS.has(googleError.reason)
  ) {
    return new ReconciliationError(
      "permissions",
      `Google Calendar permissions are insufficient; verify calendar write access${detail}`,
      { cause: error },
    );
  }
  if (status === 403) {
    return new ReconciliationError(
      "google-api",
      `Google Calendar rejected a request; inspect the Google reason before retrying${detail}`,
      { cause: error },
    );
  }
  if (status === 412) {
    return new ReconciliationError(
      "conflict",
      "A calendar event changed during reconciliation; retry the sync",
      { cause: error },
    );
  }
  return error;
}

function formatGoogleErrorDetail(info: GoogleApiErrorInfo): string {
  const parts: string[] = [];
  if (info.status !== undefined) {
    parts.push(`HTTP ${String(info.status)}`);
  }
  const reason =
    info.reason !== undefined && /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/.test(info.reason)
      ? info.reason
      : undefined;
  if (reason !== undefined) {
    parts.push(`reason ${reason}`);
  }
  const message =
    reason !== undefined && (RATE_LIMIT_REASONS.has(reason) || PERMISSION_REASONS.has(reason))
      ? safeGoogleMessage(info.message)
      : undefined;
  if (message !== undefined) {
    parts.push(`message ${message}`);
  }
  if (info.retryAfterMs !== undefined) {
    parts.push(`Retry-After ${formatRetryAfter(info.retryAfterMs)}`);
  }
  return parts.length === 0 ? "" : ` (${parts.join("; ")})`;
}

function safeGoogleMessage(message: string | undefined): string | undefined {
  if (message === undefined) {
    return undefined;
  }
  const normalized = message.replaceAll(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return undefined;
  }
  return normalized
    .replaceAll(/https?:\/\/\S+/gi, "[redacted URL]")
    .replaceAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted account]")
    .replaceAll(/(["'])[^"']+\1/g, "[redacted value]")
    .replaceAll(/\b(?:calendar|event|resource)\s+id\s*[:=]?\s*\S+/gi, "[redacted resource]")
    .replaceAll(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted identifier]")
    .slice(0, 200);
}

function formatRetryAfter(milliseconds: number): string {
  return `${String(Math.ceil(milliseconds / 1_000))}s`;
}

export function syncResultFromError(error: unknown): SyncReconcileResult | undefined {
  if (error instanceof ReconcilePassError || error instanceof ReconciliationError) {
    return error.result;
  }
  return undefined;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
