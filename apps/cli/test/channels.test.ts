import { describe, expect, it } from "vitest";

import { ChannelClient, type GoogleChannelApi } from "../src/google/channels.js";
import { StateDatabase } from "../src/storage/index.js";
import { ChannelManager, stopWatchChannels } from "../src/sync/channels.js";
import { channelTokenHash } from "../src/sync/webhook.js";

const ADDRESS = "https://calsync.example.test/gcal/webhook";

interface WatchCall {
  calendarId: string;
  channelId: string;
  address: string;
  token: string;
  ttlSeconds?: number;
}

class FakeChannelApi {
  readonly watched: WatchCall[] = [];
  readonly stopped: { channelId: string; resourceId: string }[] = [];
  failWatch: Error | undefined;

  constructor(private readonly expiresAt = "2026-09-01T00:00:00.000Z") {}

  watchEvents(request: WatchCall): Promise<{
    channelId: string;
    resourceId: string;
    expiresAt: string;
  }> {
    if (this.failWatch !== undefined) {
      return Promise.reject(this.failWatch);
    }
    this.watched.push(request);
    return Promise.resolve({
      channelId: request.channelId,
      resourceId: `resource-for-${request.channelId}`,
      expiresAt: this.expiresAt,
    });
  }

  stopChannel(channelId: string, resourceId: string): Promise<void> {
    this.stopped.push({ channelId, resourceId });
    return Promise.resolve();
  }
}

function manager(
  state: StateDatabase,
  api: FakeChannelApi,
  options: { now: string; renewBeforeMs?: number; address?: string; prefix?: string } = {
    now: "2026-08-24T00:00:00.000Z",
  },
): ChannelManager {
  const prefix = options.prefix ?? "channel";
  let channels = 0;
  let tokens = 0;
  return new ChannelManager({
    address: options.address ?? ADDRESS,
    calendarIds: { personal: "personal-calendar", work: "work-calendar" },
    ttlSeconds: 604_800,
    renewBeforeMs: options.renewBeforeMs ?? 60 * 60 * 1_000,
    createClient: () => Promise.resolve(api),
    store: state,
    clock: { now: () => new Date(options.now) },
    generateChannelId: () => {
      channels += 1;
      return `${prefix}-${String(channels)}`;
    },
    generateToken: () => {
      tokens += 1;
      return `${prefix}-token-${String(tokens)}`;
    },
    tenantId: "default",
  });
}

describe("channel manager", () => {
  it("arms one channel per calendar and stores only the token hash", async () => {
    const state = new StateDatabase(":memory:");
    const api = new FakeChannelApi();

    const result = await manager(state, api).ensure();

    expect(result.armed).toEqual(["personal", "work"]);
    expect(result.failed).toEqual([]);
    expect(api.watched.map((call) => call.calendarId)).toEqual([
      "personal-calendar",
      "work-calendar",
    ]);
    expect(api.watched[0]?.address).toBe(ADDRESS);
    expect(api.watched[0]?.ttlSeconds).toBe(604_800);

    const sentToken = api.watched[0]?.token ?? "";
    const stored = state.getWatchChannel("personal");
    expect(stored?.channelId).toBe("channel-1");
    expect(stored?.resourceId).toBe("resource-for-channel-1");
    expect(stored?.tokenHash).toBe(channelTokenHash(sentToken));
    expect(JSON.stringify(stored)).not.toContain(sentToken);
    state.close();
  });

  it("reuses a channel that is not near expiry", async () => {
    const state = new StateDatabase(":memory:");
    const api = new FakeChannelApi();
    await manager(state, api).ensure();

    const result = await manager(state, api).ensure();

    expect(result.current).toEqual(["personal", "work"]);
    expect(result.armed).toEqual([]);
    expect(api.watched).toHaveLength(2);
    state.close();
  });

  it("re-arms before expiry and stops the replaced channel", async () => {
    const state = new StateDatabase(":memory:");
    const api = new FakeChannelApi("2026-08-24T00:30:00.000Z");
    await manager(state, api).ensure();

    const result = await manager(state, api, {
      now: "2026-08-24T00:00:00.000Z",
      prefix: "renewed",
    }).ensure();

    expect(result.armed).toEqual(["personal", "work"]);
    expect(api.watched).toHaveLength(4);
    expect(api.stopped.map((call) => call.channelId)).toEqual(["channel-1", "channel-2"]);
    // The replacement is persisted, so the receiver answers for the new channel.
    expect(state.getWatchChannel("personal")?.channelId).toBe("renewed-1");
    state.close();
  });

  it("re-arms when the public address changes", async () => {
    const state = new StateDatabase(":memory:");
    const api = new FakeChannelApi();
    await manager(state, api).ensure();

    const result = await manager(state, api, {
      now: "2026-08-24T00:00:00.000Z",
      address: "https://calsync.example.test/hooks/gcal",
    }).ensure();

    expect(result.armed).toEqual(["personal", "work"]);
    expect(state.getWatchChannel("work")?.address).toBe("https://calsync.example.test/hooks/gcal");
    state.close();
  });

  it("reports a watch failure instead of throwing", async () => {
    const state = new StateDatabase(":memory:");
    const api = new FakeChannelApi();
    api.failWatch = new Error("watch rejected");

    const result = await manager(state, api).ensure();

    expect(result.armed).toEqual([]);
    expect(result.failed.map((failure) => failure.role)).toEqual(["personal", "work"]);
    expect(state.getWatchChannel("personal")).toBeNull();
    state.close();
  });
});

describe("stopWatchChannels", () => {
  it("stops every armed channel and forgets it", async () => {
    const state = new StateDatabase(":memory:");
    const api = new FakeChannelApi();
    await manager(state, api).ensure();

    const failures = await stopWatchChannels({
      store: state,
      createClient: () => Promise.resolve(api),
    });

    expect(failures).toEqual([]);
    expect(api.stopped.map((call) => call.channelId)).toEqual(["channel-1", "channel-2"]);
    expect(state.listWatchChannels()).toEqual([]);
    state.close();
  });
});

describe("channel client", () => {
  function googleApi(
    data: { resourceId?: string | null; expiration?: string | null },
    onStop?: () => Promise<unknown>,
  ): { api: GoogleChannelApi; requests: unknown[] } {
    const requests: unknown[] = [];
    return {
      requests,
      api: {
        events: {
          watch: (parameters) => {
            requests.push(parameters);
            return Promise.resolve({ data });
          },
        },
        channels: {
          stop: (parameters) => {
            requests.push(parameters);
            return onStop === undefined ? Promise.resolve({}) : onStop();
          },
        },
      },
    };
  }

  it("requests a web_hook channel and converts Google's expiration to ISO", async () => {
    const { api, requests } = googleApi({
      resourceId: "resource-1",
      expiration: String(Date.parse("2026-08-31T00:00:00.000Z")),
    });

    const result = await new ChannelClient(api).watchEvents({
      calendarId: "personal-calendar",
      channelId: "channel-1",
      address: ADDRESS,
      token: "secret",
      ttlSeconds: 604_800,
    });

    expect(result).toEqual({
      channelId: "channel-1",
      resourceId: "resource-1",
      expiresAt: "2026-08-31T00:00:00.000Z",
    });
    expect(requests[0]).toMatchObject({
      calendarId: "personal-calendar",
      requestBody: { type: "web_hook", address: ADDRESS, params: { ttl: "604800" } },
    });
  });

  it("falls back to the requested ttl when Google omits an expiration", async () => {
    const { api } = googleApi({ resourceId: "resource-1", expiration: null });

    const result = await new ChannelClient(api, {
      now: () => Date.parse("2026-08-24T00:00:00.000Z"),
    }).watchEvents({
      calendarId: "personal-calendar",
      channelId: "channel-1",
      address: ADDRESS,
      token: "secret",
      ttlSeconds: 3_600,
    });

    expect(result.expiresAt).toBe("2026-08-24T01:00:00.000Z");
  });

  it("rejects a watch response without a resource id", async () => {
    const { api } = googleApi({ expiration: "1" });

    await expect(
      new ChannelClient(api).watchEvents({
        calendarId: "personal-calendar",
        channelId: "channel-1",
        address: ADDRESS,
        token: "secret",
      }),
    ).rejects.toThrow("without a resource id");
  });

  it("treats an already-gone channel as stopped", async () => {
    const { api } = googleApi({ resourceId: "resource-1" }, () =>
      Promise.reject(Object.assign(new Error("not found"), { code: 404 })),
    );

    await expect(
      new ChannelClient(api).stopChannel("channel-1", "resource-1"),
    ).resolves.toBeUndefined();
  });
});
