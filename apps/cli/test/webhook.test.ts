import { afterEach, describe, expect, it } from "vitest";

import type { AccountRole } from "@calsync/engine";

import type { WatchChannelRecord } from "../src/storage/index.js";
import { channelTokenHash, SyncTrigger, WebhookReceiver } from "../src/sync/webhook.js";

const NOTIFICATION_PATH = "/gcal/webhook";
const TOKEN = "channel-secret";

let open: WebhookReceiver | undefined;

afterEach(async () => {
  await open?.close();
  open = undefined;
});

interface Harness {
  url: string;
  notified: AccountRole[];
  logs: string[];
}

async function startReceiver(channel: WatchChannelRecord | null): Promise<Harness> {
  const notified: AccountRole[] = [];
  const logs: string[] = [];
  const receiver = new WebhookReceiver({
    host: "127.0.0.1",
    port: 0,
    path: NOTIFICATION_PATH,
    lookupChannel: (channelId) =>
      channel !== null && channel.channelId === channelId ? channel : null,
    onNotification: (role) => {
      notified.push(role);
    },
    onLog: (line) => {
      logs.push(line);
    },
  });
  open = receiver;
  const port = await receiver.listen();
  return { url: `http://127.0.0.1:${String(port)}${NOTIFICATION_PATH}`, notified, logs };
}

function testChannel(overrides: Partial<WatchChannelRecord> = {}): WatchChannelRecord {
  return {
    tenantId: "default",
    role: "personal",
    calendarId: "personal-calendar",
    channelId: "channel-1",
    resourceId: "resource-1",
    tokenHash: channelTokenHash(TOKEN),
    address: `https://calsync.example.test${NOTIFICATION_PATH}`,
    expiresAt: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

function notification(headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: {
      "x-goog-channel-id": "channel-1",
      "x-goog-channel-token": TOKEN,
      "x-goog-resource-id": "resource-1",
      "x-goog-resource-state": "exists",
      ...headers,
    },
  };
}

describe("webhook receiver", () => {
  it("triggers a sync for a notification on a known channel", async () => {
    const harness = await startReceiver(testChannel());

    const response = await fetch(harness.url, notification());

    expect(response.status).toBe(200);
    expect(harness.notified).toEqual(["personal"]);
  });

  it("acknowledges the channel handshake without syncing", async () => {
    const harness = await startReceiver(testChannel());

    const response = await fetch(harness.url, notification({ "x-goog-resource-state": "sync" }));

    expect(response.status).toBe(200);
    expect(harness.notified).toEqual([]);
    expect(harness.logs.join("\n")).toContain("webhook_channel_ready");
  });

  it("rejects a wrong channel token", async () => {
    const harness = await startReceiver(testChannel());

    const response = await fetch(harness.url, notification({ "x-goog-channel-token": "guessed" }));

    expect(response.status).toBe(403);
    expect(harness.notified).toEqual([]);
  });

  it("rejects a notification whose resource id does not match the channel", async () => {
    const harness = await startReceiver(testChannel());

    const response = await fetch(harness.url, notification({ "x-goog-resource-id": "other" }));

    expect(response.status).toBe(403);
    expect(harness.notified).toEqual([]);
  });

  it("answers 404 for a channel it no longer tracks, so Google stops sending", async () => {
    const harness = await startReceiver(null);

    const response = await fetch(harness.url, notification());

    expect(response.status).toBe(404);
    expect(harness.notified).toEqual([]);
  });

  it("ignores other paths and methods", async () => {
    const harness = await startReceiver(testChannel());

    const wrongPath = await fetch(harness.url.replace(NOTIFICATION_PATH, "/other"), notification());
    const wrongMethod = await fetch(harness.url, { method: "GET" });

    expect(wrongPath.status).toBe(404);
    expect(wrongMethod.status).toBe(404);
    expect(harness.notified).toEqual([]);
  });

  it("never logs the channel token", async () => {
    const harness = await startReceiver(testChannel());

    await fetch(harness.url, notification());
    await fetch(harness.url, notification({ "x-goog-channel-token": "guessed" }));

    expect(harness.logs.join("\n")).not.toContain(TOKEN);
    expect(harness.logs.join("\n")).not.toContain("guessed");
  });
});

describe("sync trigger", () => {
  it("coalesces a burst of notifications into one wake-up", async () => {
    const trigger = new SyncTrigger(10);
    const controller = new AbortController();

    const waiting = trigger.next(5_000, controller.signal);
    trigger.notify();
    trigger.notify();
    trigger.notify();

    await expect(waiting).resolves.toBe("webhook");
    // The burst is spent: the next wait falls through to the backstop.
    await expect(trigger.next(20, controller.signal)).resolves.toBe("scheduled");
    trigger.dispose();
  });

  it("remembers a notification that lands while a sync is running", async () => {
    const trigger = new SyncTrigger(0);
    const controller = new AbortController();

    trigger.notify();

    await expect(trigger.next(5_000, controller.signal)).resolves.toBe("webhook");
    trigger.dispose();
  });

  it("falls back to the backstop interval when nothing arrives", async () => {
    const trigger = new SyncTrigger(10);
    const controller = new AbortController();

    await expect(trigger.next(20, controller.signal)).resolves.toBe("scheduled");
    trigger.dispose();
  });

  it("resolves as aborted on shutdown", async () => {
    const trigger = new SyncTrigger(10);
    const controller = new AbortController();

    const waiting = trigger.next(5_000, controller.signal);
    controller.abort();

    await expect(waiting).resolves.toBe("aborted");
    trigger.dispose();
  });
});
