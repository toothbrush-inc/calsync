import { randomBytes, randomUUID } from "node:crypto";

import { systemClock, type Clock } from "@calsync/engine";

import type { CalendarKey } from "@calsync/engine";

import type { ChannelAPI } from "../google/channels.js";
import type { WatchChannelRecord } from "../storage/index.js";
import { channelTokenHash } from "./webhook.js";

export interface WatchChannelStore {
  getWatchChannel(calendarKey: CalendarKey, tenantId?: string): WatchChannelRecord | null;
  listWatchChannels(tenantId?: string): WatchChannelRecord[];
  upsertWatchChannel(channel: WatchChannelRecord, tenantId: string): void;
  deleteWatchChannel(calendarKey: CalendarKey, tenantId?: string): void;
}

export interface ChannelManagerOptions {
  /** Public HTTPS address Google posts notifications to. */
  address: string;
  /** One channel per calendar. */
  calendars: readonly { key: CalendarKey; calendarId: string }[];
  ttlSeconds: number;
  /** Re-arm once a channel is within this long of expiring. */
  renewBeforeMs: number;
  /** Channel API client for a calendar, by key. */
  createClient: (calendarKey: CalendarKey) => Promise<ChannelAPI>;
  store: WatchChannelStore;
  clock?: Clock;
  onLog?: (line: string) => void;
  generateChannelId?: () => string;
  generateToken?: () => string;
  tenantId: string;
}

export interface ChannelFailure {
  calendarKey: CalendarKey;
  error: unknown;
}

export interface ChannelEnsureResult {
  armed: CalendarKey[];
  current: CalendarKey[];
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
    for (const { key, calendarId } of this.options.calendars) {
      const existing = this.options.store.getWatchChannel(key, this.options.tenantId);
      if (existing !== null && this.#isCurrent(existing, calendarId)) {
        result.current.push(key);
        continue;
      }
      try {
        await this.#arm(key, calendarId, existing);
        result.armed.push(key);
      } catch (error: unknown) {
        result.failed.push({ calendarKey: key, error });
      }
    }
    return result;
  }

  #isCurrent(channel: WatchChannelRecord, calendarId: string): boolean {
    if (channel.address !== this.options.address || channel.calendarId !== calendarId) {
      return false;
    }
    const expiresAt = Date.parse(channel.expiresAt);
    if (Number.isNaN(expiresAt)) {
      return false;
    }
    return expiresAt - this.#clock.now().getTime() > this.options.renewBeforeMs;
  }

  async #arm(
    calendarKey: CalendarKey,
    calendarId: string,
    existing: WatchChannelRecord | null,
  ): Promise<void> {
    const client = await this.options.createClient(calendarKey);
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
        calendarKey,
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
      calendar: calendarKey,
      expiresAt: watch.expiresAt,
    });
    if (existing !== null) {
      // Best effort: the replacement is already live, so a failure here only
      // leaves a channel at Google that our receiver will answer with 404.
      try {
        await client.stopChannel(existing.channelId, existing.resourceId);
      } catch {
        this.#log({ event: "webhook_channel_stop_failed", calendar: calendarKey });
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
  createClient: (calendarKey: CalendarKey) => Promise<ChannelAPI>;
  onLog?: (line: string) => void;
  tenantId?: string;
  /** Only this calendar's channel; every channel when absent. */
  calendarKey?: CalendarKey;
}): Promise<ChannelFailure[]> {
  const failures: ChannelFailure[] = [];
  for (const channel of options.store.listWatchChannels(options.tenantId)) {
    if (options.calendarKey !== undefined && channel.calendarKey !== options.calendarKey) {
      continue;
    }
    try {
      const client = await options.createClient(channel.calendarKey);
      await client.stopChannel(channel.channelId, channel.resourceId);
      options.store.deleteWatchChannel(channel.calendarKey, options.tenantId);
      options.onLog?.(
        JSON.stringify({ event: "webhook_channel_stopped", calendar: channel.calendarKey }),
      );
    } catch (error: unknown) {
      failures.push({ calendarKey: channel.calendarKey, error });
    }
  }
  return failures;
}
