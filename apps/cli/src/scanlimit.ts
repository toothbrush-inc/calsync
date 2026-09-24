import { stateKey } from "@calsync/engine";

/**
 * Keeps the expensive passes from running more often than they are worth.
 *
 * A dry-run check or preview reads the whole window on both calendars and
 * holds the tenant's reconcile lock for as long as it takes, so a run of
 * back-to-back scans keeps that tenant's real sync waiting behind them. The
 * dashboard re-enables its button the moment a scan returns, and under the
 * gateway an assistant can call `preview_sync` in a loop with nobody watching.
 *
 * Two parts, cheapest first. A short result cache answers the repeat click
 * from the last run — inside that window the answer has almost certainly not
 * changed, so it is the right answer rather than a degraded one. Past the
 * cache, a fresh pass has to wait out a minimum gap since the last one.
 *
 * The gap is persisted, not held in memory, because `calsync web`,
 * `calsync mcp` and `calsync start` are three separate processes over one
 * SQLite file: an in-memory gate would hand the dashboard and an assistant an
 * independent allowance each. The cache stays in memory — losing it costs one
 * extra pass, never correctness.
 *
 * The daemon's own scheduled passes never come through here. They call
 * `SyncService.once` directly, and keeping this gate in the adapters is what
 * makes throttling the daemon impossible rather than merely unintended.
 */

/** Read-only passes share one gap; passes that write share a longer one. */
export type ScanOperation = "scan" | "write";

/** The slice of `StateDatabase` a gate needs. */
export interface ScanGateStore {
  getState(key: string): string | null;
  setState(key: string, value: string, now?: Date): void;
}

export interface ScanGateLimits {
  /** Serve a completed dry-run result again for this long. 0 disables. */
  cacheMs: number;
  /** Minimum gap between fresh read-only passes. 0 disables. */
  scanIntervalMs: number;
  /** Minimum gap between passes that write. 0 disables. */
  writeIntervalMs: number;
}

export type ScanDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export const DEFAULT_SCAN_GATE_LIMITS: ScanGateLimits = {
  cacheMs: 30_000,
  scanIntervalMs: 60_000,
  writeIntervalMs: 300_000,
};

/** `scanlimit:<op>`, tenant-namespaced. `sync_state` is one flat table, so a
 * key that skips `stateKey` is the default tenant's row for every tenant. */
function gateKey(operation: ScanOperation, tenantId: string): string {
  return stateKey(`scanlimit:${operation}`, tenantId);
}

export class ScanGate {
  readonly #cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    private readonly store: ScanGateStore,
    private readonly limits: ScanGateLimits = DEFAULT_SCAN_GATE_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Whether a fresh pass may start. Denials carry the whole-seconds wait, so
   * the dashboard can count down and an assistant can back off by a stated
   * amount rather than retrying blindly.
   */
  check(tenantId: string, operation: ScanOperation): ScanDecision {
    const interval =
      operation === "write" ? this.limits.writeIntervalMs : this.limits.scanIntervalMs;
    if (interval <= 0) {
      return { allowed: true };
    }
    const last = this.#lastRunAt(tenantId, operation);
    if (last === undefined) {
      return { allowed: true };
    }
    const waited = this.now() - last;
    // A clock that jumped backwards would otherwise lock the tenant out until
    // it caught up; treat anything in the future as "long enough ago".
    if (waited < 0 || waited >= interval) {
      return { allowed: true };
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((interval - waited) / 1000)),
    };
  }

  /**
   * Starts the clock on the next gap. Called once a pass has actually done
   * its work, so a request that never reached Google — one that gave up
   * waiting for the reconcile lock — does not spend the tenant's allowance.
   */
  record(tenantId: string, operation: ScanOperation): void {
    this.store.setState(gateKey(operation, tenantId), new Date(this.now()).toISOString());
  }

  /**
   * The last result for this tenant and key, while it is still fresh.
   *
   * `unknown` rather than a type parameter: the cache holds whatever each
   * caller put in it, and only that caller knows the shape. Narrowing here
   * would be an unchecked cast wearing a generic.
   */
  cached(tenantId: string, key: string): unknown {
    if (this.limits.cacheMs <= 0) {
      return undefined;
    }
    const entry = this.#cache.get(`${tenantId}:${key}`);
    if (entry === undefined || this.now() - entry.at >= this.limits.cacheMs) {
      return undefined;
    }
    return entry.value;
  }

  remember(tenantId: string, key: string, value: unknown): void {
    if (this.limits.cacheMs > 0) {
      this.#cache.set(`${tenantId}:${key}`, { at: this.now(), value });
    }
  }

  /** Drops a tenant's cached answer — the state behind it just changed. */
  invalidate(tenantId: string, key: string): void {
    this.#cache.delete(`${tenantId}:${key}`);
  }

  #lastRunAt(tenantId: string, operation: ScanOperation): number | undefined {
    const stored = this.store.getState(gateKey(operation, tenantId));
    if (stored === null) {
      return undefined;
    }
    const parsed = Date.parse(stored);
    // A corrupt row reads as "never ran"; the next pass rewrites it.
    return Number.isNaN(parsed) ? undefined : parsed;
  }
}
