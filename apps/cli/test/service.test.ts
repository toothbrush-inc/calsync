import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CleanupPassError,
  IncrementalMemoryCalendar,
  MemoryCalendar,
  type CalendarAPI,
} from "@calsync/engine";

import type { AppConfig } from "../src/config.js";
import { StateDatabase } from "../src/storage/index.js";
import {
  acquireLock,
  acquireLockWaiting,
  daemonIsRunning,
  daemonLockPathFor,
  syncLockPathFor,
  SyncDaemon,
  classifyReconciliationError,
  DefaultSyncService,
  ReconciliationError,
} from "../src/sync/service.js";

describe("Google error classification", () => {
  it("classifies quota-related 403 responses as rate limits with safe details", () => {
    const classified = classifyReconciliationError({
      response: {
        status: 403,
        headers: { "retry-after": "3" },
        data: {
          error: {
            message: "Calendar usage limits exceeded.",
            errors: [{ reason: "calendarUsageLimitsExceeded" }],
          },
        },
      },
    });

    expect(classified).toBeInstanceOf(ReconciliationError);
    expect(classified).toMatchObject({ category: "rate-limit" });
    expect((classified as Error).message).toContain("reason calendarUsageLimitsExceeded");
    expect((classified as Error).message).toContain("Calendar usage limits exceeded.");
    expect((classified as Error).message).toContain("Retry-After 3s");
    expect((classified as Error).message).not.toContain("permissions are insufficient");
  });

  it("reserves permissions classification for permission reasons", () => {
    const classified = classifyReconciliationError({
      response: {
        status: 403,
        data: {
          error: {
            message: "Request had insufficient authentication scopes.",
            errors: [{ reason: "insufficientPermissions" }],
          },
        },
      },
    });

    expect(classified).toMatchObject({ category: "permissions" });
    expect((classified as Error).message).toContain("reason insufficientPermissions");
  });

  it("does not guess that an unknown 403 is a permission error", () => {
    const classified = classifyReconciliationError({
      response: {
        status: 403,
        data: {
          error: {
            message: "calendar id private-calendar@example.test was rejected",
            errors: [{ reason: "unexpectedPolicy" }],
          },
        },
      },
    });

    expect(classified).toMatchObject({ category: "google-api" });
    expect((classified as Error).message).not.toContain("private-calendar@example.test");
    expect((classified as Error).message).not.toContain("message ");
    expect((classified as Error).message).toContain("reason unexpectedPolicy");
  });

  it("keeps cleanup partial counts when classifying the Google cause", () => {
    const classified = classifyReconciliationError(
      new CleanupPassError({ created: 0, updated: 0, deleted: 2, repaired: 0 }, 1, {
        response: {
          status: 403,
          data: {
            error: {
              message: "Calendar usage limits exceeded.",
              errors: [{ reason: "calendarUsageLimitsExceeded" }],
            },
          },
        },
      }),
    );

    expect(classified).toMatchObject({ category: "rate-limit" });
    expect((classified as Error).message).toContain("Cleanup incomplete: 2 deleted, 1 failed");
  });
});

describe("sync process lock", () => {
  it("rejects a concurrent process and can be reacquired after release", () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-lock-"));
    const path = join(directory, "sync.lock");
    const first = acquireLock(path);

    expect(() => acquireLock(path)).toThrow("Another calsync process is already running");
    first.release();
    const next = acquireLock(path);
    next.release();
    rmSync(directory, { recursive: true });
  });

  it("treats a leftover PID 1 lock as stale (container restart)", () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-lock-pid1-"));
    const path = join(directory, "sync.lock");
    writeFileSync(path, "1");
    const lock = acquireLock(path);
    lock.release();
    rmSync(directory, { recursive: true });
  });

  it("treats a lock whose starttime does not match the live pid as stale", () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-lock-starttime-"));
    const path = join(directory, "sync.lock");
    writeFileSync(path, `${String(process.pid)} 0`);
    const lock = acquireLock(path);
    lock.release();
    rmSync(directory, { recursive: true });
  });

  it("reports daemon liveness from the daemon lock", () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-daemon-alive-"));
    const path = join(directory, "state.sqlite3.daemon.lock");

    expect(daemonIsRunning(path)).toBe(false);
    const lock = acquireLock(path, { kind: "daemon" });
    expect(daemonIsRunning(path)).toBe(true);
    lock.release();
    expect(daemonIsRunning(path)).toBe(false);

    writeFileSync(path, "not-a-pid");
    expect(daemonIsRunning(path)).toBe(false);
    rmSync(directory, { recursive: true, force: true });
  });

  it("maps the reconcile lock path to a sibling daemon lock", () => {
    expect(daemonLockPathFor("/tmp/state.sqlite3.lock")).toBe("/tmp/state.sqlite3.daemon.lock");
    expect(daemonLockPathFor("/tmp/sync.lock")).toBe("/tmp/sync.daemon.lock");
    expect(syncLockPathFor("/tmp/state.sqlite3")).toBe("/tmp/state.sqlite3.lock");
    expect(syncLockPathFor("/tmp/state.sqlite3", "acme")).toBe("/tmp/state.sqlite3.acme.lock");
    expect(daemonLockPathFor(syncLockPathFor("/tmp/state.sqlite3", "acme"))).toBe(
      "/tmp/state.sqlite3.acme.daemon.lock",
    );
  });

  it("times out waiting for a busy reconcile lock", async () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-lock-timeout-"));
    const path = join(directory, "sync.lock");
    const held = acquireLock(path);
    const waits: number[] = [];
    try {
      await expect(
        acquireLockWaiting(path, {
          intervalMs: 10,
          timeoutMs: 40,
          notifyIntervalMs: 0,
          onWait: (waitedMs) => {
            waits.push(waitedMs);
          },
        }),
      ).rejects.toMatchObject({ name: "LockTimeoutError" });
      expect(waits.length).toBeGreaterThan(0);
    } finally {
      held.release();
      rmSync(directory, { recursive: true });
    }
  });

  it("once() fails fast when the reconcile lock stays busy past lockTimeoutMs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-once-lock-timeout-"));
    const lockPath = join(directory, "sync.lock");
    const state = new StateDatabase(":memory:");
    const held = acquireLock(lockPath);
    const service = new DefaultSyncService(
      testConfig(),
      { createCalendarClient: () => Promise.resolve(idleCalendar()) },
      state,
      lockPath,
    );
    try {
      await expect(service.once({ dryRun: true, lockTimeoutMs: 40 })).rejects.toMatchObject({
        name: "LockTimeoutError",
      });
    } finally {
      held.release();
      state.close();
      rmSync(directory, { recursive: true });
    }
  });

  it("waits for a released reconcile lock instead of failing immediately", async () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-lock-wait-"));
    const path = join(directory, "sync.lock");
    const held = acquireLock(path);
    let acquired = false;
    const waiting = acquireLockWaiting(path, { intervalMs: 10 }).then((lock) => {
      acquired = true;
      return lock;
    });

    await delay(40);
    expect(acquired).toBe(false);
    held.release();
    const next = await waiting;
    expect(acquired).toBe(true);
    next.release();
    rmSync(directory, { recursive: true });
  });

  it("serializes two overlapping once() passes on the reconcile lock", async () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-once-serialize-"));
    const lockPath = join(directory, "sync.lock");
    const state = new StateDatabase(":memory:");
    let listInFlight = 0;
    let maxListInFlight = 0;
    let listCalls = 0;
    let firstListed!: () => void;
    const listed = new Promise<void>((resolve) => {
      firstListed = resolve;
    });
    let releaseLists!: () => void;
    const listsReady = new Promise<void>((resolve) => {
      releaseLists = resolve;
    });
    const client: CalendarAPI = {
      ...idleCalendar(),
      listEvents: async () => {
        listCalls += 1;
        listInFlight += 1;
        maxListInFlight = Math.max(maxListInFlight, listInFlight);
        firstListed();
        try {
          await listsReady;
          return [];
        } finally {
          listInFlight -= 1;
        }
      },
    };
    const service = new DefaultSyncService(
      testConfig(),
      { createCalendarClient: () => Promise.resolve(client) },
      state,
      lockPath,
    );

    const first = service.once();
    await listed;
    const second = service.once();
    await delay(80);
    expect(maxListInFlight).toBe(2);
    expect(listCalls).toBe(2);
    releaseLists();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(maxListInFlight).toBe(2);
    expect(listCalls).toBe(4);

    state.close();
    rmSync(directory, { recursive: true });
  });

  it("lets once() take the reconcile lock while start() is between polls", async () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-daemon-sleep-"));
    const lockPath = join(directory, "sync.lock");
    const daemonLockPath = daemonLockPathFor(lockPath);
    const state = new StateDatabase(":memory:");
    const auth = {
      createCalendarClient: () => Promise.resolve(idleCalendar()),
    };
    let completed!: () => void;
    const firstPass = new Promise<void>((resolve) => {
      completed = resolve;
    });
    const daemon = new DefaultSyncService(testConfig(), auth, state, lockPath, (line) => {
      if (line.includes('"reconcile_complete"')) {
        completed();
      }
    });
    const other = new DefaultSyncService(testConfig(), auth, state, lockPath);
    const stop = new AbortController();

    const running = daemon.start({ signal: stop.signal });
    try {
      await firstPass;
      expect(() => {
        acquireLock(lockPath).release();
      }).not.toThrow();
      expect(() => acquireLock(daemonLockPath, { kind: "daemon" })).toThrow(
        "Another calsync daemon is already running",
      );

      await expect(other.once({ dryRun: true, lockTimeoutMs: 250 })).resolves.toMatchObject({
        converged: true,
      });
      expect(() => acquireLock(daemonLockPath, { kind: "daemon" })).toThrow(
        "Another calsync daemon is already running",
      );
    } finally {
      stop.abort();
      await running;
      acquireLock(lockPath).release();
      acquireLock(daemonLockPath, { kind: "daemon" }).release();
      state.close();
      rmSync(directory, { recursive: true });
    }
  });

  it("rejects a second start() on the daemon instance lock", async () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-daemon-conflict-"));
    const lockPath = join(directory, "sync.lock");
    const state = new StateDatabase(":memory:");
    const auth = {
      createCalendarClient: () => Promise.resolve(idleCalendar()),
    };
    let completed!: () => void;
    const firstPass = new Promise<void>((resolve) => {
      completed = resolve;
    });
    const first = new DefaultSyncService(testConfig(), auth, state, lockPath, (line) => {
      if (line.includes('"reconcile_complete"')) {
        completed();
      }
    });
    const second = new DefaultSyncService(testConfig(), auth, state, lockPath);
    const stop = new AbortController();

    const running = first.start({ signal: stop.signal });
    try {
      await firstPass;
      await expect(second.start()).rejects.toThrow("Another calsync daemon is already running");
    } finally {
      stop.abort();
      await running;
      state.close();
      rmSync(directory, { recursive: true });
    }
  });

  it("stops the daemon gracefully and releases its lock on SIGTERM", async () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-daemon-"));
    const lockPath = join(directory, "sync.lock");
    const state = new StateDatabase(":memory:");
    const config: AppConfig = {
      tenantId: "default",
      accounts: {
        personal: { tenantId: "default", role: "personal", calendarId: "personal-calendar" },
        work: { tenantId: "default", role: "work", calendarId: "work-calendar" },
      },
      pollIntervalMs: 60_000,
      window: { pastDays: 30, futureDays: 365 },
      timezone: "UTC",
      exclusions: {
        personalToWork: [],
        workToPersonal: [],
        personalToWorkKeywords: [],
        workToPersonalKeywords: [],
      },
    };
    const client: CalendarAPI = {
      listEvents: () => Promise.resolve([]),
      listManagedEvents: () => Promise.resolve([]),
      insertEvent: () => Promise.resolve(undefined),
      patchEvent: () => Promise.resolve({}),
      deleteEvent: () => Promise.resolve(),
    };
    const auth = {
      createCalendarClient: () => Promise.resolve(client),
    };
    let completed!: () => void;
    const firstPass = new Promise<void>((resolve) => {
      completed = resolve;
    });
    const service = new DefaultSyncService(config, auth, state, lockPath, (line) => {
      if (line.includes('"reconcile_complete"')) {
        completed();
      }
    });
    const priorListeners = process.listeners("SIGTERM");
    const running = service.start();
    let stopDaemon: NodeJS.SignalsListener | undefined;
    try {
      await firstPass;
      const added = process
        .listeners("SIGTERM")
        .filter((listener) => !priorListeners.includes(listener));
      expect(added).toHaveLength(1);
      stopDaemon = added[0];
      stopDaemon?.("SIGTERM");
      await running;
      expect(process.listeners("SIGTERM")).toEqual(priorListeners);
      acquireLock(lockPath).release();
    } finally {
      stopDaemon?.("SIGTERM");
      await running;
      state.close();
      rmSync(directory, { recursive: true });
    }
  });

  it("emits one privacy-safe summary per daemon pass", async () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-private-logs-"));
    const state = new StateDatabase(":memory:");
    const lines: string[] = [];
    const privateTitle = "Private medical appointment";
    const personal = new MemoryCalendar([
      {
        id: "private-source-id",
        summary: privateTitle,
        start: { dateTime: "2026-08-10T10:00:00Z" },
        end: { dateTime: "2026-08-10T11:00:00Z" },
      },
    ]);
    const work = new MemoryCalendar();
    const auth = {
      createCalendarClient: (role: "personal" | "work") =>
        Promise.resolve(role === "personal" ? personal : work),
    };
    let completed!: () => void;
    const firstPass = new Promise<void>((resolve) => {
      completed = resolve;
    });
    const service = new DefaultSyncService(
      testConfig(),
      auth,
      state,
      join(directory, "sync.lock"),
      (line) => {
        lines.push(line);
        if (line.includes('"reconcile_complete"')) {
          completed();
        }
      },
    );

    await service.once({ dryRun: true });
    expect(lines).toEqual([]);

    const stop = new AbortController();
    const running = service.start({ signal: stop.signal });
    try {
      await firstPass;
    } finally {
      stop.abort();
      await running;
    }
    const output = lines.join("\n");
    expect(lines).toHaveLength(2);
    expect(output).toContain('"event":"full_sync"');
    expect(output).toContain('"reason":"incremental-unavailable"');
    expect(output).toContain('"event":"reconcile_complete"');
    expect(output).toContain('"dryRun":false');
    expect(output).toContain('"active":1');
    expect(output).toContain('"converged":true');
    expect(output).not.toContain(privateTitle);
    expect(output).not.toContain("2026-08-10");
    expect(output).not.toContain("private-source-id");
    expect(output).not.toContain("personal-calendar");
    expect(JSON.stringify(state.listMappings())).not.toContain(privateTitle);

    state.close();
    rmSync(directory, { recursive: true });
  });

  it("applies CLI-stored title keywords on the next sync pass", async () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-stored-exclude-"));
    const state = new StateDatabase(":memory:");
    state.addExclusionKeyword("personalToWork", "medical");
    const personal = new MemoryCalendar([
      {
        id: "private-source-id",
        summary: "Private medical appointment",
        start: { dateTime: "2026-08-10T10:00:00Z" },
        end: { dateTime: "2026-08-10T11:00:00Z" },
      },
    ]);
    const work = new MemoryCalendar();
    const auth = {
      createCalendarClient: (role: "personal" | "work") =>
        Promise.resolve(role === "personal" ? personal : work),
    };
    const service = new DefaultSyncService(testConfig(), auth, state, join(directory, "sync.lock"));

    const result = await service.once({ dryRun: true });
    expect(result.created).toBe(0);
    expect(result.mirrors.personalToWork).toMatchObject({ active: 0, excluded: 1 });
    expect(work.insertedIds).toEqual([]);
    state.close();
    rmSync(directory, { recursive: true });
  });
});

describe("incremental sync orchestration", () => {
  it("persists fully paged tokens and skips full window scans for a no-op poll", async () => {
    const runtime = incrementalRuntime();
    await runtime.service.once();
    const fullReads = runtime.personal.fullReads + runtime.work.fullReads;

    const statuses: string[] = [];
    await expect(
      runtime.service.once({ onStatus: (status) => statuses.push(status.event) }),
    ).resolves.toMatchObject({ created: 0, converged: true });

    expect(runtime.personal.fullReads + runtime.work.fullReads).toBe(fullReads);
    expect(runtime.state.getState("incremental:sync-token:personal")).toBe("personal-token-2");
    expect(runtime.state.getState("incremental:sync-token:work")).toBe("work-token-2");
    expect(statuses).toEqual(["incremental_noop"]);
    runtime.close();
  });

  it("runs a full reconciliation for native changes and managed deletion tombstones", async () => {
    const runtime = incrementalRuntime();
    await runtime.service.once();
    const before = runtime.personal.fullReads + runtime.work.fullReads;
    runtime.personal.changeQueue.push({
      events: [{ id: "native-change", start: { dateTime: "2026-08-10T10:00:00Z" } }],
      nextSyncToken: "personal-native",
    });
    await runtime.service.once();
    expect(runtime.personal.fullReads + runtime.work.fullReads).toBe(before + 2);

    runtime.state.putMapping({
      mappingKey: "mapping",
      sourceRole: "work",
      sourceEventId: "source",
      destinationEventId: "managed-destination",
      sourceEtag: null,
      destinationEtag: '"managed-v1"',
      updatedAt: new Date().toISOString(),
    });
    runtime.personal.changeQueue.push({
      events: [{ id: "managed-destination", status: "cancelled" }],
      nextSyncToken: "personal-deleted",
    });
    await runtime.service.once();
    expect(runtime.personal.fullReads + runtime.work.fullReads).toBe(before + 4);
    runtime.close();
  });

  it("consumes unchanged self-generated managed deltas without another full scan", async () => {
    const runtime = incrementalRuntime();
    await runtime.service.once();
    runtime.state.putMapping({
      mappingKey: "mapping",
      sourceRole: "work",
      sourceEventId: "source",
      destinationEventId: "managed-destination",
      sourceEtag: null,
      destinationEtag: '"managed-v1"',
      updatedAt: new Date().toISOString(),
    });
    runtime.personal.changeQueue.push({
      events: [
        {
          id: "managed-destination",
          etag: '"managed-v1"',
          extendedProperties: {
            private: { calsyncManaged: "true", calsyncMapping: "mapping" },
          },
        },
      ],
      nextSyncToken: "personal-self-write",
    });
    const before = runtime.personal.fullReads + runtime.work.fullReads;

    await runtime.service.once();

    expect(runtime.personal.fullReads + runtime.work.fullReads).toBe(before);
    runtime.personal.changeQueue.push({
      events: [
        {
          id: "managed-destination",
          etag: '"managed-v2"',
          extendedProperties: {
            private: { calsyncManaged: "true", calsyncMapping: "mapping" },
          },
        },
      ],
      nextSyncToken: "personal-managed-edit",
    });
    await runtime.service.once();
    expect(runtime.personal.fullReads + runtime.work.fullReads).toBe(before + 2);
    runtime.close();
  });

  it("clears a 410 token, establishes a fresh baseline, and performs recovery full sync", async () => {
    const runtime = incrementalRuntime();
    await runtime.service.once();
    runtime.personal.changeQueue.push(
      Object.assign(new Error("expired"), { response: { status: 410 } }),
      { events: [], nextSyncToken: "personal-recovered" },
    );
    const statuses: string[] = [];

    await runtime.service.once({
      onStatus: (status) =>
        statuses.push(
          status.event === "full_sync" ? `${status.event}:${status.reason}` : status.event,
        ),
    });

    expect(runtime.state.getState("incremental:sync-token:personal")).toBe("personal-recovered");
    expect(statuses).toEqual(["invalid_sync_token", "full_sync:invalid-token"]);
    runtime.close();
  });

  it("leaves all prior tokens unchanged when one incremental calendar read fails", async () => {
    const runtime = incrementalRuntime();
    await runtime.service.once();
    runtime.work.changeQueue.push(new Error("second calendar failed"));

    await expect(runtime.service.once()).rejects.toThrow("second calendar failed");

    expect(runtime.state.getState("incremental:sync-token:personal")).toBe("personal-token-1");
    expect(runtime.state.getState("incremental:sync-token:work")).toBe("work-token-1");
    runtime.close();
  });

  it("keeps dry runs state-immutable and forces scheduled and configuration rollover scans", async () => {
    const runtime = incrementalRuntime();
    await runtime.service.once();
    const tokenBefore = runtime.state.getState("incremental:sync-token:personal");
    const fullBefore = runtime.state.getState("incremental:last-full-sync");
    const readsBeforeDryRun = runtime.personal.fullReads + runtime.work.fullReads;

    await runtime.service.once({ dryRun: true });
    expect(runtime.personal.fullReads + runtime.work.fullReads).toBe(readsBeforeDryRun + 2);
    expect(runtime.state.getState("incremental:sync-token:personal")).toBe(tokenBefore);
    expect(runtime.state.getState("incremental:last-full-sync")).toBe(fullBefore);

    runtime.state.setState("incremental:last-full-sync", "2000-01-01T00:00:00.000Z");
    const scheduled: string[] = [];
    await runtime.service.once({
      onStatus: (status) => {
        if (status.event === "full_sync") scheduled.push(status.reason);
      },
    });
    expect(scheduled).toEqual(["scheduled"]);

    runtime.config.timezone = "America/New_York";
    const changed: string[] = [];
    await runtime.service.once({
      onStatus: (status) => {
        if (status.event === "full_sync") changed.push(status.reason);
      },
    });
    expect(changed).toEqual(["configuration-changed"]);
    runtime.close();
  });
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

describe("daemon push notifications", () => {
  it("reconciles when Google posts a notification instead of waiting for the backstop", async () => {
    const harness = pushHarness();
    const stop = new AbortController();

    const running = harness.daemon.start({ signal: stop.signal });
    try {
      const port = await harness.listeningPort;
      await harness.channelsArmed;
      const armed = harness.watched[0];
      expect(armed).toBeDefined();
      expect(harness.state.getWatchChannel("personal")?.resourceId).toBe("resource-personal");

      const response = await fetch(`http://127.0.0.1:${String(port)}/gcal/webhook`, {
        method: "POST",
        headers: {
          "x-goog-channel-id": armed?.channelId ?? "",
          "x-goog-channel-token": armed?.token ?? "",
          "x-goog-resource-id": "resource-personal",
          "x-goog-resource-state": "exists",
        },
      });
      expect(response.status).toBe(200);

      await harness.secondPass;
      expect(harness.lines.some((line) => line.includes('"trigger":"webhook"'))).toBe(true);
    } finally {
      stop.abort();
      await running;
      harness.dispose();
    }
  });

  it("recovers push when the receiver port frees up, without repeating the failure log", async () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-webhook-retry-"));
    const state = new StateDatabase(":memory:");
    const blocker = createServer();
    const blockedPort = await listenOn(blocker);
    const lines: string[] = [];
    let resolveFirst!: () => void;
    const firstPass = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let resolveListening!: () => void;
    const listening = new Promise<void>((resolve) => {
      resolveListening = resolve;
    });
    let armed = 0;
    let resolveArmed!: () => void;
    const channelsArmed = new Promise<void>((resolve) => {
      resolveArmed = resolve;
    });
    const writeLog = (line: string): void => {
      lines.push(line);
      if (line.includes('"reconcile_complete"')) {
        resolveFirst();
      }
      if (line.includes('"webhook_listening"')) {
        resolveListening();
      }
      if (line.includes('"webhook_channel_armed"')) {
        armed += 1;
        if (armed === 2) {
          resolveArmed();
        }
      }
    };
    const channelApi = {
      watchEvents: (request: {
        calendarId: string;
        channelId: string;
      }): Promise<{ channelId: string; resourceId: string; expiresAt: string }> =>
        Promise.resolve({
          channelId: request.channelId,
          resourceId: `resource-${request.calendarId}`,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
        }),
      stopChannel: (): Promise<void> => Promise.resolve(),
    };
    const auth = {
      createCalendarClient: () => Promise.resolve(idleCalendar()),
      createChannelClient: () => Promise.resolve(channelApi),
    };
    const config: AppConfig = {
      ...testConfig(),
      // A short poll keeps retry rounds ticking while the port is blocked.
      pollIntervalMs: 25,
      webhook: {
        address: "https://calsync.example.test/gcal/webhook",
        host: "127.0.0.1",
        port: blockedPort,
        path: "/gcal/webhook",
        debounceMs: 0,
        channelTtlSeconds: 604_800,
        renewBeforeMs: 60 * 60 * 1_000,
        pollIntervalMs: 10 * 60 * 1_000,
      },
    };
    const service = new DefaultSyncService(
      config,
      auth,
      state,
      join(directory, "sync.lock"),
      writeLog,
    );

    const stop = new AbortController();
    const running = service.start({ signal: stop.signal });
    try {
      await firstPass;
      expect(lines.some((line) => line.includes('"webhook_listen_failed"'))).toBe(true);
      // Free the port; a later round retries the receiver and arms channels.
      await new Promise<void>((resolve) => {
        blocker.close(() => {
          resolve();
        });
      });
      await listening;
      await channelsArmed;
    } finally {
      stop.abort();
      await running;
    }
    // Every blocked round retried, but the identical failure logged only once.
    expect(lines.filter((line) => line.includes('"webhook_listen_failed"'))).toHaveLength(1);
    expect(state.listWatchChannels()).toHaveLength(2);
    state.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps polling when Google refuses to arm a channel", async () => {
    const harness = pushHarness({ watchError: new Error("watch rejected") });
    const stop = new AbortController();

    const running = harness.daemon.start({ signal: stop.signal });
    try {
      await harness.firstPass;
      expect(harness.lines.some((line) => line.includes("webhook_arm_failed"))).toBe(true);
      expect(harness.state.listWatchChannels()).toEqual([]);
    } finally {
      stop.abort();
      await running;
      harness.dispose();
    }
  });
});

describe("multi-tenant daemon", () => {
  it("syncs every tenant per pass and labels the extra tenants' log lines", async () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-mt-daemon-"));
    const path = join(directory, "state.sqlite3");
    const defaultState = new StateDatabase(path);
    const acmeState = new StateDatabase(path, "acme");
    const lines: string[] = [];
    let resolveBoth!: () => void;
    const bothPassed = new Promise<void>((resolve) => {
      resolveBoth = resolve;
    });
    let passes = 0;
    const writeLog = (line: string): void => {
      lines.push(line);
      if (line.includes('"reconcile_complete"')) {
        passes += 1;
        if (passes === 2) {
          resolveBoth();
        }
      }
    };
    const auth = { createCalendarClient: () => Promise.resolve(idleCalendar()) };
    const tenants = [
      new DefaultSyncService(
        testConfig(),
        auth,
        defaultState,
        join(directory, "default.lock"),
        writeLog,
      ).daemonTenant(),
      new DefaultSyncService(
        tenantConfig("acme"),
        auth,
        acmeState,
        join(directory, "acme.lock"),
        writeLog,
      ).daemonTenant(),
    ];
    const daemon = new SyncDaemon(
      testConfig(),
      () => tenants,
      (channelId) => defaultState.getWatchChannelByChannelId(channelId),
      join(directory, "daemon.lock"),
      writeLog,
    );

    const stop = new AbortController();
    const running = daemon.start({ signal: stop.signal });
    try {
      await bothPassed;
    } finally {
      stop.abort();
      await running;
    }
    const completes = lines.filter((line) => line.includes('"reconcile_complete"'));
    expect(completes).toHaveLength(2);
    expect(completes.some((line) => line.includes('"tenant":"acme"'))).toBe(true);
    expect(completes.some((line) => !line.includes('"tenant"'))).toBe(true);
    defaultState.close();
    acmeState.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("picks up a tenant authorized while the daemon is running", async () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-mt-dynamic-"));
    const path = join(directory, "state.sqlite3");
    const defaultState = new StateDatabase(path);
    const acmeState = new StateDatabase(path, "acme");
    const lines: string[] = [];
    let resolveFirst!: () => void;
    const firstPass = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let resolveAcme!: (line: string) => void;
    const acmePass = new Promise<string>((resolve) => {
      resolveAcme = resolve;
    });
    const writeLog = (line: string): void => {
      lines.push(line);
      if (line.includes('"reconcile_complete"')) {
        if (line.includes('"tenant":"acme"')) {
          resolveAcme(line);
        } else {
          resolveFirst();
        }
      }
    };
    const auth = { createCalendarClient: () => Promise.resolve(idleCalendar()) };
    const tenants = [
      new DefaultSyncService(
        testConfig(),
        auth,
        defaultState,
        join(directory, "default.lock"),
        writeLog,
      ).daemonTenant(),
    ];
    const daemon = new SyncDaemon(
      // A short poll keeps rounds ticking so discovery happens quickly.
      { ...testConfig(), pollIntervalMs: 25 },
      () => [...tenants],
      (channelId) => defaultState.getWatchChannelByChannelId(channelId),
      join(directory, "daemon.lock"),
      writeLog,
    );

    const stop = new AbortController();
    const running = daemon.start({ signal: stop.signal });
    try {
      await firstPass;
      // The tenant signs up after the daemon is already running.
      tenants.push(
        new DefaultSyncService(
          tenantConfig("acme"),
          auth,
          acmeState,
          join(directory, "acme.lock"),
          writeLog,
        ).daemonTenant(),
      );
      const line = await acmePass;
      expect(line).toContain('"tenant":"acme"');
    } finally {
      stop.abort();
      await running;
    }
    defaultState.close();
    acmeState.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("routes a notification to the tenant whose calendar changed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-mt-webhook-"));
    const path = join(directory, "state.sqlite3");
    const defaultState = new StateDatabase(path);
    const acmeState = new StateDatabase(path, "acme");
    const lines: string[] = [];
    const watched: { channelId: string; token: string; calendarId: string }[] = [];
    const channelApi = {
      watchEvents: (request: {
        calendarId: string;
        channelId: string;
        token: string;
      }): Promise<{ channelId: string; resourceId: string; expiresAt: string }> => {
        watched.push(request);
        return Promise.resolve({
          channelId: request.channelId,
          resourceId: `resource-${request.calendarId}`,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
        });
      },
      stopChannel: (): Promise<void> => Promise.resolve(),
    };
    const auth = {
      createCalendarClient: () => Promise.resolve(idleCalendar()),
      createChannelClient: () => Promise.resolve(channelApi),
    };
    let resolvePort!: (port: number) => void;
    const listeningPort = new Promise<number>((resolve) => {
      resolvePort = resolve;
    });
    let resolveStartup!: () => void;
    const startupPasses = new Promise<void>((resolve) => {
      resolveStartup = resolve;
    });
    let resolveWebhookPass!: (line: string) => void;
    const webhookPass = new Promise<string>((resolve) => {
      resolveWebhookPass = resolve;
    });
    let passes = 0;
    const writeLog = (line: string): void => {
      lines.push(line);
      const parsed = JSON.parse(line) as { event?: string; port?: number };
      if (parsed.event === "webhook_listening" && parsed.port !== undefined) {
        resolvePort(parsed.port);
      }
      if (parsed.event === "reconcile_complete") {
        passes += 1;
        if (passes === 2) {
          resolveStartup();
        }
        if (passes === 3) {
          resolveWebhookPass(line);
        }
      }
    };
    const webhook = {
      address: "https://calsync.example.test/gcal/webhook",
      host: "127.0.0.1",
      port: 0,
      path: "/gcal/webhook",
      debounceMs: 0,
      channelTtlSeconds: 604_800,
      renewBeforeMs: 60 * 60 * 1_000,
      // Long enough that a third pass can only come from a notification.
      pollIntervalMs: 10 * 60 * 1_000,
    };
    const sharedConfig: AppConfig = { ...testConfig(), webhook };
    const daemon = new SyncDaemon(
      sharedConfig,
      () => [
        new DefaultSyncService(
          sharedConfig,
          auth,
          defaultState,
          join(directory, "default.lock"),
          writeLog,
        ).daemonTenant(),
        new DefaultSyncService(
          { ...tenantConfig("acme"), webhook },
          auth,
          acmeState,
          join(directory, "acme.lock"),
          writeLog,
        ).daemonTenant(),
      ],
      (channelId) => defaultState.getWatchChannelByChannelId(channelId),
      join(directory, "daemon.lock"),
      writeLog,
    );

    const stop = new AbortController();
    const running = daemon.start({ signal: stop.signal });
    try {
      const port = await listeningPort;
      await startupPasses;
      expect(watched).toHaveLength(4);
      const acmeChannel = watched.find((entry) => entry.calendarId === "acme-personal-calendar");
      expect(acmeChannel).toBeDefined();

      const response = await fetch(`http://127.0.0.1:${String(port)}/gcal/webhook`, {
        method: "POST",
        headers: {
          "x-goog-channel-id": acmeChannel?.channelId ?? "",
          "x-goog-channel-token": acmeChannel?.token ?? "",
          "x-goog-resource-id": "resource-acme-personal-calendar",
          "x-goog-resource-state": "exists",
        },
      });
      expect(response.status).toBe(200);

      const line = await webhookPass;
      expect(line).toContain('"trigger":"webhook"');
      expect(line).toContain('"tenant":"acme"');
    } finally {
      stop.abort();
      await running;
    }
    // Only the notified tenant ran a webhook pass.
    expect(
      lines.filter(
        (line) => line.includes('"reconcile_complete"') && line.includes('"trigger":"webhook"'),
      ),
    ).toHaveLength(1);
    defaultState.close();
    acmeState.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps healthy tenants on the slow backstop when one tenant's channels fail to arm", async () => {
    const harness = cadenceHarness({ acmeChannelClient: "broken" });
    const stop = new AbortController();
    const running = harness.daemon.start({ signal: stop.signal });
    try {
      await harness.acmePolled;
    } finally {
      stop.abort();
      await running;
    }
    // The broken tenant fell back to fast polling…
    expect(harness.scheduled().acme).toBeGreaterThanOrEqual(3);
    expect(
      harness.lines.some(
        (line) => line.includes('"webhook_arm_failed"') && line.includes('"tenant":"acme"'),
      ),
    ).toBe(true);
    // …while the armed tenant stayed on the backstop and never re-polled.
    expect(harness.scheduled().default).toBe(0);
    expect(harness.watched).toHaveLength(2);
    harness.dispose();
  });

  it("polls a tenant that cannot arm push channels while armed tenants ride the backstop", async () => {
    const harness = cadenceHarness({ acmeChannelClient: "absent" });
    const stop = new AbortController();
    const running = harness.daemon.start({ signal: stop.signal });
    try {
      await harness.acmePolled;
    } finally {
      stop.abort();
      await running;
    }
    expect(harness.scheduled().acme).toBeGreaterThanOrEqual(3);
    expect(harness.scheduled().default).toBe(0);
    harness.dispose();
  });
});

interface CadenceHarness {
  daemon: SyncDaemon;
  lines: string[];
  watched: { calendarId: string }[];
  /** Resolves once the acme tenant has run three scheduled (timer) passes. */
  acmePolled: Promise<void>;
  scheduled: () => { default: number; acme: number };
  dispose: () => void;
}

/**
 * Two-tenant daemon where default's push channels arm and acme's cannot —
 * either Google refuses the watch ("broken") or the tenant has no channel
 * client at all ("absent"). The fast poll interval belongs to acme alone.
 */
function cadenceHarness(options: { acmeChannelClient: "broken" | "absent" }): CadenceHarness {
  const directory = mkdtempSync(join(tmpdir(), "calsync-mt-cadence-"));
  const path = join(directory, "state.sqlite3");
  const defaultState = new StateDatabase(path);
  const acmeState = new StateDatabase(path, "acme");
  const lines: string[] = [];
  const watched: { calendarId: string }[] = [];
  const scheduled = { default: 0, acme: 0 };
  let resolveAcmePolled!: () => void;
  const acmePolled = new Promise<void>((resolve) => {
    resolveAcmePolled = resolve;
  });
  const writeLog = (line: string): void => {
    lines.push(line);
    if (!line.includes('"reconcile_complete"') || !line.includes('"trigger":"scheduled"')) {
      return;
    }
    if (line.includes('"tenant":"acme"')) {
      scheduled.acme += 1;
      if (scheduled.acme === 3) {
        resolveAcmePolled();
      }
    } else {
      scheduled.default += 1;
    }
  };
  const channelApi = {
    watchEvents: (request: {
      calendarId: string;
      channelId: string;
    }): Promise<{ channelId: string; resourceId: string; expiresAt: string }> => {
      if (request.calendarId.startsWith("acme-")) {
        return Promise.reject(new Error("watch rejected"));
      }
      watched.push({ calendarId: request.calendarId });
      return Promise.resolve({
        channelId: request.channelId,
        resourceId: `resource-${request.calendarId}`,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
      });
    },
    stopChannel: (): Promise<void> => Promise.resolve(),
  };
  const defaultAuth = {
    createCalendarClient: () => Promise.resolve(idleCalendar()),
    createChannelClient: () => Promise.resolve(channelApi),
  };
  const acmeAuth =
    options.acmeChannelClient === "broken"
      ? defaultAuth
      : { createCalendarClient: () => Promise.resolve(idleCalendar()) };
  const webhook = {
    address: "https://calsync.example.test/gcal/webhook",
    host: "127.0.0.1",
    port: 0,
    path: "/gcal/webhook",
    debounceMs: 0,
    channelTtlSeconds: 604_800,
    renewBeforeMs: 60 * 60 * 1_000,
    // Long enough that an armed tenant never re-polls within the test.
    pollIntervalMs: 10 * 60 * 1_000,
  };
  // The fast fallback poll: only unarmed tenants should feel it.
  const sharedConfig: AppConfig = { ...testConfig(), pollIntervalMs: 25, webhook };
  const daemon = new SyncDaemon(
    sharedConfig,
    () => [
      new DefaultSyncService(
        sharedConfig,
        defaultAuth,
        defaultState,
        join(directory, "default.lock"),
        writeLog,
      ).daemonTenant(),
      new DefaultSyncService(
        { ...tenantConfig("acme"), pollIntervalMs: 25, webhook },
        acmeAuth,
        acmeState,
        join(directory, "acme.lock"),
        writeLog,
      ).daemonTenant(),
    ],
    (channelId) => defaultState.getWatchChannelByChannelId(channelId),
    join(directory, "daemon.lock"),
    writeLog,
  );
  return {
    daemon,
    lines,
    watched,
    acmePolled,
    scheduled: () => ({ ...scheduled }),
    dispose: () => {
      defaultState.close();
      acmeState.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function tenantConfig(tenantId: string): AppConfig {
  return {
    ...testConfig(),
    tenantId,
    accounts: {
      personal: { tenantId, role: "personal", calendarId: `${tenantId}-personal-calendar` },
      work: { tenantId, role: "work", calendarId: `${tenantId}-work-calendar` },
    },
  };
}

interface PushHarness {
  daemon: DefaultSyncService;
  state: StateDatabase;
  lines: string[];
  watched: { channelId: string; token: string }[];
  listeningPort: Promise<number>;
  channelsArmed: Promise<void>;
  firstPass: Promise<void>;
  secondPass: Promise<void>;
  dispose: () => void;
}

function pushHarness(options: { watchError?: Error } = {}): PushHarness {
  const directory = mkdtempSync(join(tmpdir(), "calsync-webhook-"));
  const state = new StateDatabase(":memory:");
  const watched: { channelId: string; token: string; calendarId: string }[] = [];
  const channelApi = {
    watchEvents: (request: {
      calendarId: string;
      channelId: string;
      token: string;
    }): Promise<{ channelId: string; resourceId: string; expiresAt: string }> => {
      if (options.watchError !== undefined) {
        return Promise.reject(options.watchError);
      }
      watched.push(request);
      const role = request.calendarId === "personal-calendar" ? "personal" : "work";
      return Promise.resolve({
        channelId: request.channelId,
        resourceId: `resource-${role}`,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
      });
    },
    stopChannel: (): Promise<void> => Promise.resolve(),
  };
  const auth = {
    createCalendarClient: () => Promise.resolve(idleCalendar()),
    createChannelClient: () => Promise.resolve(channelApi),
  };

  const lines: string[] = [];
  let resolvePort!: (port: number) => void;
  const listeningPort = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });
  let resolveArmed!: () => void;
  const channelsArmed = new Promise<void>((resolve) => {
    resolveArmed = resolve;
  });
  let armedCount = 0;
  let resolveFirst!: () => void;
  const firstPass = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  let resolveSecond!: () => void;
  const secondPass = new Promise<void>((resolve) => {
    resolveSecond = resolve;
  });
  let passes = 0;

  const config: AppConfig = {
    ...testConfig(),
    webhook: {
      address: "https://calsync.example.test/gcal/webhook",
      host: "127.0.0.1",
      port: 0,
      path: "/gcal/webhook",
      debounceMs: 0,
      channelTtlSeconds: 604_800,
      renewBeforeMs: 60 * 60 * 1_000,
      // Long enough that a second pass can only come from a notification.
      pollIntervalMs: 10 * 60 * 1_000,
    },
  };
  const daemon = new DefaultSyncService(
    config,
    auth,
    state,
    join(directory, "sync.lock"),
    (line) => {
      lines.push(line);
      const parsed = JSON.parse(line) as { event?: string; port?: number };
      if (parsed.event === "webhook_listening" && parsed.port !== undefined) {
        resolvePort(parsed.port);
      }
      if (parsed.event === "webhook_channel_armed") {
        armedCount += 1;
        if (armedCount === 2) {
          resolveArmed();
        }
      }
      if (parsed.event === "reconcile_complete") {
        passes += 1;
        if (passes === 1) {
          resolveFirst();
        }
        if (passes === 2) {
          resolveSecond();
        }
      }
    },
  );

  return {
    daemon,
    state,
    lines,
    watched,
    listeningPort,
    channelsArmed,
    firstPass,
    secondPass,
    dispose: () => {
      state.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function listenOn(server: Server): Promise<number> {
  return new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function idleCalendar(): CalendarAPI {
  return {
    listEvents: () => Promise.resolve([]),
    listManagedEvents: () => Promise.resolve([]),
    insertEvent: () => Promise.resolve(undefined),
    patchEvent: () => Promise.resolve({}),
    deleteEvent: () => Promise.resolve(),
  };
}

function testConfig(): AppConfig {
  return {
    tenantId: "default",
    accounts: {
      personal: { tenantId: "default", role: "personal", calendarId: "personal-calendar" },
      work: { tenantId: "default", role: "work", calendarId: "work-calendar" },
    },
    pollIntervalMs: 60_000,
    window: { pastDays: 30, futureDays: 365 },
    timezone: "UTC",
    exclusions: {
      personalToWork: [],
      workToPersonal: [],
      personalToWorkKeywords: [],
      workToPersonalKeywords: [],
    },
  };
}

function incrementalRuntime(): {
  service: DefaultSyncService;
  state: StateDatabase;
  config: AppConfig;
  personal: IncrementalMemoryCalendar;
  work: IncrementalMemoryCalendar;
  close: () => void;
} {
  const directory = mkdtempSync(join(tmpdir(), "calsync-incremental-"));
  const state = new StateDatabase(":memory:");
  const config = testConfig();
  const personal = new IncrementalMemoryCalendar("personal");
  const work = new IncrementalMemoryCalendar("work");
  const auth = {
    createCalendarClient: (role: "personal" | "work") =>
      Promise.resolve(role === "personal" ? personal : work),
  };
  return {
    service: new DefaultSyncService(config, auth, state, join(directory, "sync.lock")),
    state,
    config,
    personal,
    work,
    close: () => {
      state.close();
      rmSync(directory, { recursive: true });
    },
  };
}
