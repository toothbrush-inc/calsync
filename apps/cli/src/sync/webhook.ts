import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AccountRole } from "@calsync/engine";

import type { WatchChannelRecord } from "../storage/index.js";

/**
 * Receiver for Google Calendar push notifications.
 *
 * Google requires a public HTTPS address with a CA-signed certificate, so this
 * server binds to loopback and expects a reverse proxy to terminate TLS and
 * forward the notification path. Notifications carry no body — only headers
 * naming the channel that changed — so nothing here touches event data.
 */

export type NotificationOutcome =
  "accepted" | "handshake" | "unknown-channel" | "rejected" | "ignored";

export interface WebhookReceiverOptions {
  host: string;
  port: number;
  path: string;
  lookupChannel: (channelId: string) => WatchChannelRecord | null;
  onNotification: (role: AccountRole, tenantId: string) => void;
  onLog?: (line: string) => void;
}

export class WebhookReceiver {
  #server: Server | undefined;

  constructor(private readonly options: WebhookReceiverOptions) {}

  async listen(): Promise<number> {
    const server = createServer((request, response) => {
      this.#handle(request, response);
    });
    // A hung notification must never keep the daemon from shutting down.
    server.unref();
    this.#server = server;
    return await new Promise<number>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(error);
      };
      server.once("error", onError);
      server.listen(this.options.port, this.options.host, () => {
        server.off("error", onError);
        const address = server.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (server === undefined) {
      return;
    }
    this.#server = undefined;
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  }

  #handle(request: IncomingMessage, response: ServerResponse): void {
    // Notifications have no body; drain anything sent so the socket can close.
    request.resume();
    const outcome = this.#classify(request);
    switch (outcome) {
      case "accepted":
      case "handshake": {
        response.writeHead(200).end();
        break;
      }
      case "unknown-channel": {
        // 404 tells Google to stop sending on a channel we no longer track.
        response.writeHead(404).end();
        break;
      }
      case "rejected": {
        response.writeHead(403).end();
        break;
      }
      case "ignored": {
        response.writeHead(404).end();
        break;
      }
    }
  }

  #classify(request: IncomingMessage): NotificationOutcome {
    if (request.method !== "POST" || pathOf(request.url) !== this.options.path) {
      return "ignored";
    }
    const channelId = headerValue(request, "x-goog-channel-id");
    if (channelId === undefined) {
      return "ignored";
    }
    const channel = this.options.lookupChannel(channelId);
    if (channel === null) {
      this.#log({ event: "webhook_unknown_channel" });
      return "unknown-channel";
    }
    const token = headerValue(request, "x-goog-channel-token");
    const resourceId = headerValue(request, "x-goog-resource-id");
    if (
      token === undefined ||
      !matchesTokenHash(token, channel.tokenHash) ||
      resourceId !== channel.resourceId
    ) {
      this.#log({ event: "webhook_rejected", role: channel.role });
      return "rejected";
    }
    // The first message on a new channel is a handshake, not a change.
    const state = headerValue(request, "x-goog-resource-state");
    if (state === "sync") {
      this.#log({ event: "webhook_channel_ready", role: channel.role });
      return "handshake";
    }
    this.#log({ event: "webhook_notification", role: channel.role, state: state ?? "unknown" });
    this.options.onNotification(channel.role, channel.tenantId);
    return "accepted";
  }

  #log(entry: Record<string, unknown>): void {
    this.options.onLog?.(JSON.stringify(entry));
  }
}

export function channelTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function matchesTokenHash(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(channelTokenHash(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (typeof value === "string") {
    return value;
  }
  return Array.isArray(value) ? value[0] : undefined;
}

function pathOf(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  const separator = url.indexOf("?");
  return separator === -1 ? url : url.slice(0, separator);
}

export type SyncTriggerReason = "startup" | "webhook" | "scheduled" | "aborted";

/**
 * Coalesces a burst of notifications into one sync.
 *
 * Every mirror write we make also produces a notification, so bursts are the
 * normal case. The window opens on the first notification and is not extended
 * by later ones, which bounds how long a real change waits.
 */
export class SyncTrigger {
  #timer: NodeJS.Timeout | undefined;
  #ready = false;
  #wake: (() => void) | undefined;

  constructor(private readonly debounceMs: number) {}

  notify(): void {
    if (this.#ready || this.#timer !== undefined) {
      return;
    }
    if (this.debounceMs <= 0) {
      this.#fire();
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#fire();
    }, this.debounceMs);
    this.#timer.unref();
  }

  /** Resolves when a notification lands, when `timeoutMs` elapses, or on abort. */
  async next(timeoutMs: number, signal: AbortSignal): Promise<SyncTriggerReason> {
    if (signal.aborted) {
      return "aborted";
    }
    if (this.#ready) {
      this.#ready = false;
      return "webhook";
    }
    return await new Promise<SyncTriggerReason>((resolve) => {
      let settled = false;
      const finish = (reason: SyncTriggerReason): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.#wake = undefined;
        resolve(reason);
      };
      const onAbort = (): void => {
        finish("aborted");
      };
      const timer = setTimeout(() => {
        finish("scheduled");
      }, timeoutMs);
      this.#wake = () => {
        this.#ready = false;
        finish("webhook");
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  dispose(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #fire(): void {
    const wake = this.#wake;
    if (wake === undefined) {
      this.#ready = true;
      return;
    }
    wake();
  }
}
