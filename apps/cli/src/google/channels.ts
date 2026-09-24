import type { calendar_v3 } from "googleapis";

import { DEFAULT_RETRY_POLICY, isStatus, withRetries, type RetryPolicy } from "./calendar.js";

/**
 * Google Calendar push notifications. A channel tells Google to POST to a
 * public HTTPS address whenever the watched calendar changes. Notifications
 * carry no event data, so the daemon still reads changes through the ordinary
 * incremental sync-token feed; the channel only replaces the poll timer.
 */

export interface WatchRequest {
  calendarId: string;
  channelId: string;
  address: string;
  token: string;
  ttlSeconds?: number;
}

export interface WatchResult {
  channelId: string;
  resourceId: string;
  /** ISO timestamp. Google decides the real expiry; a requested TTL is only a hint. */
  expiresAt: string;
}

export interface ChannelAPI {
  watchEvents(request: WatchRequest): Promise<WatchResult>;
  stopChannel(channelId: string, resourceId: string): Promise<void>;
}

interface WatchRequestBody {
  id: string;
  type: "web_hook";
  address: string;
  token: string;
  params?: { ttl: string };
}

export interface GoogleChannelApi {
  events: {
    watch(parameters: {
      calendarId: string;
      requestBody: WatchRequestBody;
    }): Promise<{ data: { resourceId?: string | null; expiration?: string | null } }>;
  };
  channels: {
    stop(parameters: { requestBody: { id: string; resourceId: string } }): Promise<unknown>;
  };
}

export interface ChannelClientOptions {
  retryPolicy?: Partial<RetryPolicy>;
  now?: () => number;
}

export class ChannelClient implements ChannelAPI {
  readonly #api: GoogleChannelApi;
  readonly #retryPolicy: RetryPolicy;
  readonly #now: () => number;

  constructor(api: GoogleChannelApi, options: ChannelClientOptions = {}) {
    this.#api = api;
    this.#retryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retryPolicy };
    this.#now = options.now ?? Date.now;
  }

  async watchEvents(request: WatchRequest): Promise<WatchResult> {
    const requestBody: WatchRequestBody = {
      id: request.channelId,
      type: "web_hook",
      address: request.address,
      token: request.token,
    };
    if (request.ttlSeconds !== undefined) {
      requestBody.params = { ttl: String(request.ttlSeconds) };
    }
    const response = await withRetries(
      async () => this.#api.events.watch({ calendarId: request.calendarId, requestBody }),
      this.#retryPolicy,
    );
    const resourceId = response.data.resourceId ?? undefined;
    if (resourceId === undefined) {
      throw new Error("Google Calendar returned a watch channel without a resource id");
    }
    return {
      channelId: request.channelId,
      resourceId,
      expiresAt: this.#expiryFromResponse(
        response.data.expiration ?? undefined,
        request.ttlSeconds,
      ),
    };
  }

  /**
   * Google reports `expiration` as Unix milliseconds and caps it at its own
   * internal limit regardless of the requested TTL, so the response is the only
   * trustworthy expiry. The requested TTL is a fallback for the rare response
   * that omits it.
   */
  #expiryFromResponse(expiration: string | undefined, ttlSeconds: number | undefined): string {
    const parsed = expiration === undefined ? Number.NaN : Number(expiration);
    if (Number.isFinite(parsed) && parsed > 0) {
      return new Date(parsed).toISOString();
    }
    return new Date(this.#now() + (ttlSeconds ?? 3_600) * 1_000).toISOString();
  }

  async stopChannel(channelId: string, resourceId: string): Promise<void> {
    try {
      await withRetries(
        async () => this.#api.channels.stop({ requestBody: { id: channelId, resourceId } }),
        this.#retryPolicy,
      );
    } catch (error: unknown) {
      // Desired state is already achieved if Google no longer knows the channel.
      if (!isStatus(error, 404) && !isStatus(error, 410)) {
        throw error;
      }
    }
  }
}

export function createGoogleChannelClient(
  api: calendar_v3.Calendar,
  options: ChannelClientOptions = {},
): ChannelClient {
  return new ChannelClient(api, options);
}
