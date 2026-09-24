import { randomBytes, randomUUID } from "node:crypto";

import { accountRoles, systemClock, type AccountRole, type Clock } from "@calsync/engine";

import type { ChannelAPI } from "../google/channels.js";
import type { WatchChannelRecord } from "../storage/index.js";
import { channelTokenHash } from "./webhook.js";

export interface WatchChannelStore {
  getWatchChannel(role: AccountRole, tenantId?: string): WatchChannelRecord | null;
  listWatchChannels(tenantId?: string): WatchChannelRecord[];
  upsertWatchChannel(channel: WatchChannelRecord, tenantId: string): void;
  deleteWatchChannel(role: AccountRole, tenantId?: string): void;
}

export interface ChannelManagerOptions {
  /** Public HTTPS address Google posts notifications to. */
  address: string;
  calendarIds: Record<AccountRole, string>;
  ttlSeconds: number;
  /** Re-arm once a channel is within this long of expiring. */
  renewBeforeMs: number;
  createClient: (role: AccountRole) => Promise<ChannelAPI>;
  store: WatchChannelStore;
  clock?: Clock;
  onLog?: (line: string) => void;
  generateChannelId?: () => string;
  generateToken?: () => string;
  tenantId: string;
}

export interface ChannelFailure {
  role: AccountRole;
  error: unknown;
}

export interface ChannelEnsureResult {
  armed: AccountRole[];
  current: AccountRole[];
  failed: ChannelFailure[];
}

/**
 * Owns the lifecycle of Google Calendar watch channels.
 *
 * Google never renews a channel on its own and caps how long one lives, so the
 * daemon re-arms before expiry: create the replacement, persist it, then stop
 * the old one, leaving no window where nothing is watching.
 */
export class ChannelManager {
  readonly #clock: Clock;
  readonly #newChannelId: () => string;
  readonly #newToken: () => string;

  constructor(private readonly options: ChannelManagerOptions) {
    this.#clock = options.clock ?? systemClock;
    this.#newChannelId = options.generateChannelId ?? randomUUID;
    this.#newToken = options.generateToken ?? (() => randomBytes(32).toString("base64url"));
  }

  async ensure(): Promise<ChannelEnsureResult> {
    const result: ChannelEnsureResult = { armed: [], current: [], failed: [] };
    for (const role of accountRoles) {
      const existing = this.options.store.getWatchChannel(role, this.options.tenantId);
      if (existing !== null && this.#isCurrent(existing)) {
        result.current.push(role);
        continue;
      }
      try {
        await this.#arm(role, existing);
        result.armed.push(role);
      } catch (error: unknown) {
        result.failed.push({ role, error });
      }
    }
    return result;
  }

  #isCurrent(channel: WatchChannelRecord): boolean {
    if (
      channel.address !== this.options.address ||
      channel.calendarId !== this.options.calendarIds[channel.role]
    ) {
      return false;
    }
    const expiresAt = Date.parse(channel.expiresAt);
    if (Number.isNaN(expiresAt)) {
      return false;
    }
    return expiresAt - this.#clock.now().getTime() > this.options.renewBeforeMs;
  }

  async #arm(role: AccountRole, existing: WatchChannelRecord | null): Promise<void> {
    const calendarId = this.options.calendarIds[role];
    const client = await this.options.createClient(role);
    const token = this.#newToken();
    const watch = await client.watchEvents({
      calendarId,
      channelId: this.#newChannelId(),
      address: this.options.address,
      token,
      ttlSeconds: this.options.ttlSeconds,
    });
    this.options.store.upsertWatchChannel(
      {
        tenantId: this.options.tenantId,
        role,
        calendarId,
        channelId: watch.channelId,
        resourceId: watch.resourceId,
        tokenHash: channelTokenHash(token),
        address: this.options.address,
        expiresAt: watch.expiresAt,
        createdAt: this.#clock.now().toISOString(),
      },
      this.options.tenantId,
    );
    this.#log({
      event: existing === null ? "webhook_channel_armed" : "webhook_channel_renewed",
      role,
      expiresAt: watch.expiresAt,
    });
    if (existing !== null) {
      // Best effort: the replacement is already live, so a failure here only
      // leaves a channel at Google that our receiver will answer with 404.
      try {
        await client.stopChannel(existing.channelId, existing.resourceId);
      } catch {
        this.#log({ event: "webhook_channel_stop_failed", role });
      }
    }
  }

  #log(entry: Record<string, unknown>): void {
    // Single-tenant log lines stay byte-identical; only extra tenants label.
    const labeled =
      this.options.tenantId === "default" ? entry : { ...entry, tenant: this.options.tenantId };
    this.options.onLog?.(JSON.stringify(labeled));
  }
}

/**
 * Stops every armed channel at Google and forgets it locally. Used by cleanup,
 * so leaving calsync does not leave Google posting to a dead endpoint.
 */
export async function stopWatchChannels(options: {
  store: WatchChannelStore;
  createClient: (role: AccountRole) => Promise<ChannelAPI>;
  onLog?: (line: string) => void;
  tenantId?: string;
}): Promise<ChannelFailure[]> {
  const failures: ChannelFailure[] = [];
  for (const channel of options.store.listWatchChannels(options.tenantId)) {
    try {
      const client = await options.createClient(channel.role);
      await client.stopChannel(channel.channelId, channel.resourceId);
      options.store.deleteWatchChannel(channel.role, options.tenantId);
      options.onLog?.(JSON.stringify({ event: "webhook_channel_stopped", role: channel.role }));
    } catch (error: unknown) {
      failures.push({ role: channel.role, error });
    }
  }
  return failures;
}
