import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReconcileLog, SyncReconcileResult } from "@calsync/engine";

import { createProgram } from "../src/cli.js";
import type { AppConfig } from "../src/config.js";
import { createCalsyncMcpServer, runMcpStdioServer } from "../src/mcp/server.js";
import { previewProgressFromLockWait } from "../src/mcp/progress.js";
import {
  handleAddCalendar,
  handleAddExclusion,
  handleConnectAccount,
  handleListCalendars,
  handleRemoveCalendar,
  handleConnectProvider,
  handleGetStatus,
  handleListExclusions,
  handlePreviewSync,
  handleRemoveExclusion,
  handleSyncNow,
  toJsonPayload,
  type McpRuntime,
} from "../src/mcp/tools.js";
import { StateDatabase } from "../src/storage/index.js";
import { acquireLock, LockTimeoutError, type SyncService } from "../src/sync/service.js";
import { ScanGate, type ScanGateStore } from "../src/scanlimit.js";

const PERSONAL_KEY = `calsync-exclude:v1:p2w:occ:${"a".repeat(43)}`;
const WORK_KEY = `calsync-exclude:v1:w2p:series:${"b".repeat(43)}`;
const databases: StateDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

/** The gate persists to `sync_state`; these tests only need it to remember. */
function memoryScanStore(): ScanGateStore {
  const rows = new Map<string, string>();
  return {
    getState: (key) => rows.get(key) ?? null,
    setState: (key, value) => {
      rows.set(key, value);
    },
  };
}

describe("MCP tool handlers", () => {
  it("returns auth writability and last sync aggregates without calendar IDs or tokens", async () => {
    const runtime = mockRuntime();
    runtime.state.setState(
      "incremental:last-result",
      JSON.stringify({
        created: 2,
        updated: 0,
        deleted: 1,
        repaired: 0,
        failed: 0,
        converged: true,
        destinations: {
          work: { active: 4, duplicateSuppressed: 0 },
          personal: { active: 3, duplicateSuppressed: 2 },
        },
        sources: {
          personal: { excluded: 1 },
          work: { excluded: 0 },
        },
        access_token: "ya29.secret-token",
        sourceTitle: "Dentist",
      }),
    );
    runtime.state.setState("incremental:last-full-sync", "2026-08-14T12:00:00.000Z");

    const result = await handleGetStatus(runtime);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const json = JSON.stringify(toJsonPayload(result.data));
    // Without account management, the two roles' checks stand in for sign-ins.
    expect(result.data.signIns).toEqual([
      { account: "personal", valid: true, message: "authorized and writable", calendars: 0 },
      { account: "work", valid: true, message: "authorized and writable", calendars: 0 },
    ]);
    expect(result.data.calendars).toEqual([]);
    expect(result.data.lastSync).toMatchObject({
      created: 2,
      deleted: 1,
      lastFullSyncAt: "2026-08-14T12:00:00.000Z",
      destinations: {
        work: { active: 4, duplicateSuppressed: 0 },
        personal: { active: 3, duplicateSuppressed: 2 },
      },
      sources: {
        personal: { excluded: 1 },
        work: { excluded: 0 },
      },
    });
    expect(json).not.toContain("ya29");
    expect(json).not.toContain("secret-token");
    expect(json).not.toContain("Dentist");
    expect(json).not.toContain("personal@example.com");
    expect(json).not.toContain("calendarId");
    expect(json).not.toContain("access_token");
  });

  it("reports the asking tenant's last sync, never the default tenant's", async () => {
    // sync_state is one flat table; the default tenant owns the unprefixed
    // keys, so a non-default tenant that reads them sees someone else's
    // counts and timestamps.
    const runtime = mockRuntime({ config: configFixture("acme") });
    runtime.state.setState("incremental:last-result", JSON.stringify(storedAggregates(111)));
    runtime.state.setState("incremental:last-full-sync", "2026-01-01T00:00:00.000Z");
    runtime.state.setState(
      "tenant:acme:incremental:last-result",
      JSON.stringify(storedAggregates(7)),
    );
    runtime.state.setState("tenant:acme:incremental:last-full-sync", "2026-09-22T00:00:00.000Z");

    const result = await handleGetStatus(runtime);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.lastSync?.created).toBe(7);
    expect(result.data.lastSync?.destinations["work"]?.active).toBe(7);
    expect(result.data.lastSync?.lastFullSyncAt).toBe("2026-09-22T00:00:00.000Z");
  });

  it("holds off a second preview inside the gap, and says how long", async () => {
    // An assistant can call this in a loop; a full-window dry run is the most
    // expensive thing it can ask for.
    const time = { at: 1_000_000 };
    const gate = new ScanGate(
      memoryScanStore(),
      { cacheMs: 0, scanIntervalMs: 60_000, writeIntervalMs: 300_000 },
      () => time.at,
    );
    const once = vi.fn(() => Promise.resolve(syncResult()));
    const runtime = { ...mockRuntime({ once }), scanGate: gate };

    expect((await handlePreviewSync(runtime)).ok).toBe(true);
    expect(once).toHaveBeenCalledTimes(1);

    time.at += 20_000;
    const denied = await handlePreviewSync(runtime);
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "scan_rate_limited", message: expect.stringContaining("40s") as string },
    });
    expect(once).toHaveBeenCalledTimes(1);

    time.at += 40_000;
    expect((await handlePreviewSync(runtime)).ok).toBe(true);
    expect(once).toHaveBeenCalledTimes(2);
  });

  it("gives sync_now its own, longer gap and does not spend it on a preview", async () => {
    const time = { at: 1_000_000 };
    const gate = new ScanGate(
      memoryScanStore(),
      { cacheMs: 0, scanIntervalMs: 60_000, writeIntervalMs: 300_000 },
      () => time.at,
    );
    const runtime = { ...mockRuntime(), scanGate: gate };

    expect((await handleSyncNow(runtime)).ok).toBe(true);
    expect(await handleSyncNow(runtime)).toMatchObject({
      ok: false,
      error: { code: "scan_rate_limited", message: expect.stringContaining("300s") as string },
    });
    // A write does not close the door on a read-only preview.
    expect((await handlePreviewSync(runtime)).ok).toBe(true);
  });

  it("keeps a tenant's allowance when a preview never got the lock", async () => {
    const gate = new ScanGate(memoryScanStore(), {
      cacheMs: 0,
      scanIntervalMs: 60_000,
      writeIntervalMs: 300_000,
    });
    const once = vi.fn(() => Promise.reject(new LockTimeoutError()));
    const runtime = { ...mockRuntime({ once }), scanGate: gate };

    expect(await handlePreviewSync(runtime)).toMatchObject({
      ok: false,
      error: { code: "preview_lock_busy" },
    });
    // Nothing reached Google, so the next attempt is not made to wait.
    const second = await handlePreviewSync(runtime);
    expect((second as { error?: { code: string } }).error?.code).not.toBe("scan_rate_limited");
  });

  it("starts Google connect without accepting a secret and returns only a URL", async () => {
    const startConnect = vi.fn(() =>
      Promise.resolve({
        provider: "google" as const,
        slot: "personal" as const,
        url: "https://accounts.google.com/o/oauth2/v2/auth?state=csrf",
        expiresAt: "2026-08-17T22:05:00.000Z",
      }),
    );
    const runtime = mockRuntime({ startConnect });
    const result = await handleConnectProvider(runtime, { provider: "google", slot: "personal" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(startConnect).toHaveBeenCalledWith(
      "personal",
      "personal@example.com",
      expect.objectContaining({ openBrowser: true }),
    );
    expect(result.data).toEqual({
      provider: "google",
      slot: "personal",
      url: "https://accounts.google.com/o/oauth2/v2/auth?state=csrf",
      expires_at: "2026-08-17T22:05:00.000Z",
    });
    const json = JSON.stringify(toJsonPayload(result.data));
    expect(json).toContain("accounts.google.com");
    expect(json).not.toContain("api_key");
    expect(json).not.toContain("refresh");
    expect(json).not.toContain("ya29");
  });

  it("fails connect_provider when the runtime cannot start a connection", async () => {
    const result = await handleConnectProvider(mockRuntime(), {
      provider: "google",
      slot: "work",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("connect_unavailable");
  });

  it("previews sync as per-calendar counts and omits titles unless the dangerous flag is on", async () => {
    const once = vi.fn((options?: Parameters<SyncService["once"]>[0]) => {
      options?.onOperation?.(
        operation("personal", "work", "create", "destination-missing", "Private planning"),
      );
      options?.onOperation?.(
        operation("personal", "work", "create", "destination-missing", "Therapy"),
      );
      options?.onOperation?.(
        operation("work", "personal", "update", "destination-drifted", "Confidential staffing"),
      );
      return Promise.resolve(
        syncResult({ created: 2, updated: 1, personalActive: 2, workActive: 1 }),
      );
    });
    const runtime = mockRuntime({ once });

    const preview = await handlePreviewSync(runtime);
    expect(preview.ok).toBe(true);
    if (!preview.ok) {
      return;
    }
    expect(once).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(once.mock.calls[0]?.[0]).not.toHaveProperty("lockTimeoutMs");
    expect(preview.data.operations).toEqual([
      {
        destination: "personal",
        operation: "update",
        reason: "destination-drifted",
        count: 1,
      },
      {
        destination: "work",
        operation: "create",
        reason: "destination-missing",
        count: 2,
      },
    ]);
    const defaultJson = JSON.stringify(toJsonPayload(preview.data));
    expect(defaultJson).not.toContain("Private planning");
    expect(defaultJson).not.toContain("Therapy");
    expect(defaultJson).not.toContain("Confidential staffing");
    expect(preview.data.sourceTitles).toBeUndefined();

    const detailed = await handlePreviewSync(runtime, { include_source_titles: true });
    expect(detailed.ok).toBe(true);
    if (!detailed.ok) {
      return;
    }
    expect(detailed.data.sourceTitles).toEqual([
      "Private planning",
      "Therapy",
      "Confidential staffing",
    ]);
    const detailedJson = JSON.stringify(toJsonPayload(detailed.data, true));
    expect(detailedJson).toContain("Private planning");
    expect(detailedJson).not.toContain("ya29");
  });

  it("reports preview progress for lock wait, listing, and reconciling", async () => {
    const reports: string[] = [];
    const once = vi.fn(async (options?: Parameters<SyncService["once"]>[0]) => {
      expect(options?.lockTimeoutMs).toBeUndefined();
      await options?.onLockWait?.(0);
      options?.onStatus?.({
        event: "full_sync",
        reason: "dry-run",
        nextFullAt: "2026-08-15T00:00:00.000Z",
      });
      options?.onProgress?.({
        phase: "discovering",
        label: "Reading calendar events",
        completed: 12,
        succeeded: 0,
        failed: 0,
      });
      options?.onProgress?.({
        phase: "planning",
        label: "Planning reconciliation",
        completed: 12,
        total: 12,
        succeeded: 0,
        failed: 0,
      });
      return syncResult({ created: 1, personalActive: 1 });
    });

    const preview = await handlePreviewSync(
      mockRuntime({ once }),
      {},
      {
        onProgress: (report) => {
          reports.push(`${report.phase}:${report.message}`);
        },
      },
    );
    expect(preview.ok).toBe(true);
    expect(reports).toEqual([
      "waiting_for_lock:Waiting for reconcile lock",
      "listing_calendars:Listing calendars",
      "listing_calendars:Listing calendars (12 events)",
      "reconciling:Planning reconciliation",
    ]);
    if (!preview.ok) {
      return;
    }
    expect(preview.data.sourceTitles).toBeUndefined();
    expect(JSON.stringify(toJsonPayload(preview.data))).not.toContain("title");
  });

  it("hints at a launchd reinstall when the reconcile lock wait stretches", () => {
    expect(previewProgressFromLockWait(0).message).toBe("Waiting for reconcile lock");
    expect(previewProgressFromLockWait(2_000).message).toBe("Waiting for reconcile lock (2s)");
    expect(previewProgressFromLockWait(8_000).message).toContain("calsync service install");
  });

  it("returns preview_lock_busy when the reconcile lock stays held", async () => {
    const once = vi.fn(() => Promise.reject(new LockTimeoutError()));
    const preview = await handlePreviewSync(mockRuntime({ once }));
    expect(once).toHaveBeenCalled();
    expect(preview.ok).toBe(false);
    if (preview.ok) {
      return;
    }
    expect(preview.error.code).toBe("preview_lock_busy");
    expect(preview.error.message).toContain("service install");
  });

  it("adds and lists exclusions via the same storage as the CLI", () => {
    const runtime = mockRuntime();
    const added = handleAddExclusion(runtime, {
      keywords: ["dentist", "therapy"],
      from: "personal",
      keys: [PERSONAL_KEY, WORK_KEY],
    });
    expect(added.ok).toBe(true);
    if (!added.ok) {
      return;
    }
    expect(added.data.added).toHaveLength(4);
    expect(JSON.stringify(toJsonPayload(added.data))).not.toContain("Dentist");

    const listed = handleListExclusions(runtime);
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      return;
    }
    expect(listed.data.keywords).toEqual(
      expect.arrayContaining([
        { value: "dentist", source: "personal", origin: "cli" },
        { value: "focus time", source: "personal", origin: "env" },
      ]),
    );
    expect(listed.data.keys.map((entry) => entry.value)).toEqual(
      expect.arrayContaining([PERSONAL_KEY, WORK_KEY]),
    );

    const removed = handleRemoveExclusion(runtime, { keys: [PERSONAL_KEY] });
    expect(removed.ok).toBe(true);
    if (!removed.ok) {
      return;
    }
    expect(removed.data.removed).toEqual([
      { kind: "key", value: PERSONAL_KEY, source: "personal" },
    ]);
  });

  it("runs a live once pass without echoing titles or tokens", async () => {
    const once = vi.fn((options?: Parameters<SyncService["once"]>[0]) => {
      expect(options?.dryRun).toBe(false);
      return Promise.resolve(syncResult({ created: 1, personalActive: 1, converged: true }));
    });
    const result = await handleSyncNow(mockRuntime({ once }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data).toMatchObject({
      dryRun: false,
      created: 1,
      destinations: { work: { active: 1 } },
    });
    expect(JSON.stringify(toJsonPayload(result.data))).not.toContain("title");
  });

  it("returns JSON errors without Google token material", async () => {
    const runtime = mockRuntime({
      once: () =>
        Promise.reject(
          Object.assign(new Error("Google rejected the credentials; run calsync auth again"), {
            response: { data: { access_token: "ya29.should-not-leak" } },
          }),
        ),
    });
    const result = await handleSyncNow(runtime);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const json = JSON.stringify(toJsonPayload(result));
    expect(result.error.message).toContain("run calsync auth again");
    expect(json).not.toContain("ya29");
    expect(json).not.toContain("should-not-leak");
  });

  it("reads status without taking the sync process lock", async () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-mcp-status-"));
    const dbPath = join(directory, "state.sqlite");
    const state = new StateDatabase(dbPath);
    state.setState("incremental:last-full-sync", "2026-08-14T12:00:00.000Z");
    const lock = acquireLock(`${dbPath}.lock`);
    try {
      const once = vi.fn(() => Promise.reject(new Error("sync must not run")));
      const result = await handleGetStatus(mockRuntime({ once, state }));
      expect(once).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.data.lastSync?.lastFullSyncAt).toBe("2026-08-14T12:00:00.000Z");
    } finally {
      lock.release();
      state.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("MCP stdio server", () => {
  it("exposes the mcp CLI command without starting stdio", () => {
    const mcp = createProgram().commands.find((command) => command.name() === "mcp");
    expect(mcp?.description()).toContain("stdio MCP");
  });

  it("registers typed tools over the official SDK in-memory transport", async () => {
    const runtime = mockRuntime();
    const server = createCalsyncMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "calsync-test", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "get_status",
        "connect_provider",
        "connect_account",
        "list_calendars",
        "add_calendar",
        "remove_calendar",
        "preview_sync",
        "add_exclusion",
        "sync_now",
        "list_exclusions",
        "remove_exclusion",
      ]);
      const connect = listed.tools.find((tool) => tool.name === "connect_provider");
      expect(JSON.stringify(connect?.inputSchema)).not.toContain("api_key");
      expect(JSON.stringify(connect?.inputSchema)).not.toContain("token");
      const status = await client.callTool({ name: "get_status", arguments: {} });
      expect("isError" in status && status.isError === true).toBe(false);
      const encoded = JSON.stringify(status);
      expect(encoded).toContain('"valid":true');
      expect(encoded).not.toContain("ya29");
      expect(encoded).not.toContain("personal@example.com");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns a Google connect URL over MCP without tokens", async () => {
    const runtime = mockRuntime({
      startConnect: () =>
        Promise.resolve({
          provider: "google",
          slot: "work",
          url: "https://accounts.google.com/o/oauth2/v2/auth?state=work",
          expiresAt: "2026-08-17T22:10:00.000Z",
        }),
    });
    const server = createCalsyncMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "calsync-test", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const connected = await client.callTool({
        name: "connect_provider",
        arguments: { provider: "google", slot: "work" },
      });
      expect("isError" in connected && connected.isError === true).toBe(false);
      const encoded = JSON.stringify(connected);
      expect(encoded).toContain("accounts.google.com");
      expect(encoded).toContain("2026-08-17T22:10:00.000Z");
      expect(encoded).not.toContain("api_key");
      expect(encoded).not.toContain("ya29");
      expect(encoded).not.toContain("refresh_token");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("sends preview_sync progress notifications when the client supplies a progressToken", async () => {
    const once = vi.fn(async (options?: Parameters<SyncService["once"]>[0]) => {
      await options?.onLockWait?.(0);
      options?.onStatus?.({
        event: "full_sync",
        reason: "dry-run",
        nextFullAt: "2026-08-15T00:00:00.000Z",
      });
      options?.onProgress?.({
        phase: "discovering",
        label: "Reading calendar events",
        completed: 4,
        succeeded: 0,
        failed: 0,
      });
      options?.onProgress?.({
        phase: "planning",
        label: "Planning reconciliation",
        completed: 4,
        total: 4,
        succeeded: 0,
        failed: 0,
      });
      return Promise.resolve(syncResult());
    });
    const runtime = mockRuntime({ once });
    const server = createCalsyncMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "calsync-test", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const progress: string[] = [];
    try {
      const result = await client.callTool({ name: "preview_sync", arguments: {} }, undefined, {
        onprogress: (entry) => {
          progress.push(entry.message ?? "");
        },
      });
      expect("isError" in result && result.isError === true).toBe(false);
      expect(progress).toContain("Waiting for reconcile lock");
      expect(progress).toContain("Listing calendars");
      expect(progress.some((message) => message.startsWith("Listing calendars ("))).toBe(true);
      expect(progress).toContain("Planning reconciliation");
      expect(JSON.stringify(result)).not.toContain("Private planning");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("serves get_status after a previous tool call without closing SQLite", async () => {
    const runtime = mockRuntime();
    const server = createCalsyncMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "calsync-test", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const listed = await client.callTool({ name: "list_exclusions", arguments: {} });
      expect("isError" in listed && listed.isError === true).toBe(false);
      const status = await client.callTool({ name: "get_status", arguments: {} });
      expect("isError" in status && status.isError === true).toBe(false);
      expect(JSON.stringify(status)).toContain('"valid":true');
      expect(JSON.stringify(status)).not.toContain("The database connection is not open");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps SQLite open after connect until the stdio server shuts down", async () => {
    const runtime = mockRuntime();
    let connected!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      connected = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const running = runMcpStdioServer(runtime, {
      transport: {
        start: () => {
          connected();
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
        send: () => Promise.resolve(),
      },
      closed,
    });
    try {
      await started;
      const listed = handleListExclusions(runtime);
      expect(listed.ok).toBe(true);
      const status = await handleGetStatus(runtime);
      expect(status.ok).toBe(true);
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      finish();
      await running;
      stdout.mockRestore();
      stderr.mockRestore();
    }
    const afterShutdown = await handleGetStatus(runtime);
    expect(afterShutdown.ok).toBe(true);
  });
});

function mockRuntime(
  overrides: {
    once?: SyncService["once"];
    state?: StateDatabase;
    startConnect?: McpRuntime["auth"]["startConnect"];
    config?: AppConfig;
  } = {},
): McpRuntime & {
  state: StateDatabase;
} {
  const state = overrides.state ?? new StateDatabase(":memory:");
  if (overrides.state === undefined) {
    databases.push(state);
  }
  const once =
    overrides.once ??
    ((options?: Parameters<SyncService["once"]>[0]) => {
      options?.onOperation?.(
        operation("personal", "work", "create", "destination-missing", "Private planning"),
      );
      return Promise.resolve(syncResult());
    });
  return {
    auth: {
      getStatus: (role) =>
        Promise.resolve({
          role,
          configured: true,
          valid: true,
          calendarId: "personal@example.com",
          message: "authorized and writable",
        }),
      ...(overrides.startConnect === undefined ? {} : { startConnect: overrides.startConnect }),
    },
    state,
    sync: { once },
    loadConfig: () => overrides.config ?? configFixture(),
  };
}

/** One stored summary, distinguishable by the number of mirrors it reports. */
function storedAggregates(created: number): Record<string, unknown> {
  return {
    created,
    updated: 0,
    deleted: 0,
    repaired: 0,
    failed: 0,
    converged: true,
    destinations: {
      work: { active: created, duplicateSuppressed: 0 },
      personal: { active: 0, duplicateSuppressed: 0 },
    },
    sources: {
      personal: { excluded: 0 },
      work: { excluded: 0 },
    },
  };
}

function configFixture(tenantId = "default"): AppConfig {
  return {
    tenantId,
    calendars: [
      {
        key: "personal",
        account: "personal",
        calendarId: "personal@example.com",
        source: true,
        destination: true,
      },
      {
        key: "work",
        account: "work",
        calendarId: "work@example.com",
        source: true,
        destination: true,
      },
    ],
    accounts: {
      personal: { tenantId, role: "personal", calendarId: "personal@example.com" },
      work: { tenantId, role: "work", calendarId: "work@example.com" },
    },
    pollIntervalMs: 60_000,
    window: { pastDays: 30, futureDays: 365 },
    timezone: "UTC",
    exclusions: {
      keys: { personal: [], work: [] },
      keywords: { personal: ["focus time"], work: [] },
    },
  };
}

function operation(
  sourceRole: "personal" | "work",
  destinationRole: "personal" | "work",
  operationName: ReconcileLog["operation"],
  reason: ReconcileLog["reason"],
  sourceTitle: string,
): ReconcileLog {
  return {
    operation: operationName,
    destinationKey: destinationRole,
    sourceKeys: [sourceRole],
    reason,
    sourceTitles: [sourceTitle],
    timeRange: {
      kind: "timed",
      start: "2026-08-10T10:00:00Z",
      end: "2026-08-10T11:00:00Z",
    },
    dryRun: true,
  };
}

function syncResult(
  values: Partial<
    Pick<
      SyncReconcileResult,
      "created" | "updated" | "deleted" | "repaired" | "failed" | "converged"
    >
  > & {
    personalActive?: number;
    workActive?: number;
  } = {},
): SyncReconcileResult {
  return {
    created: values.created ?? 0,
    updated: values.updated ?? 0,
    deleted: values.deleted ?? 0,
    repaired: values.repaired ?? 0,
    failed: values.failed ?? 0,
    converged: values.converged ?? true,
    destinations: {
      work: { active: values.personalActive ?? 0, duplicateSuppressed: 0 },
      personal: { active: values.workActive ?? 0, duplicateSuppressed: 0 },
    },
    sources: {
      personal: { excluded: 0 },
      work: { excluded: 0 },
    },
  };
}

describe("MCP calendar tools", () => {
  function accountsRuntime(connectUrl?: string) {
    const state = new StateDatabase(":memory:");
    databases.push(state);
    state.upsertGoogleAccount("account1", "me@work.test");
    state.addCalendar({
      key: "cal-mine",
      account: "account1",
      calendarId: "me@work.test",
      name: "me@work.test",
      fingerprint: "fp-mine",
    });
    const removed: string[] = [];
    const accounts: NonNullable<McpRuntime["accounts"]> = {
      auth: {
        connectAccount: vi.fn(),
        startAccountConnect: () =>
          Promise.resolve({ slot: "account2", url: "https://consent", expiresAt: "later" }),
        freeAccountSlot: vi.fn(),
        reserveAccountSlot: () =>
          state.reserveSignInSlot(
            ["account1", "account2", "account3"],
            new Date(Date.now() + 60_000),
          ),
        adoptReservedSignIns: async () => {
          const adopted = [];
          for (const slot of state.listSignInReservations()) {
            adopted.push(await accounts.auth.adoptSignIn(slot));
          }
          return adopted;
        },
        adoptSignIn: (slot: string) => {
          state.releaseSignInSlot(slot);
          state.upsertGoogleAccount(slot, "colleague@work.test");
          const account = state.getGoogleAccount(slot);
          return account === null
            ? Promise.resolve({ status: "missing" as const, message: "no token" })
            : Promise.resolve({ status: "adopted" as const, account });
        },
        availableCalendars: () =>
          Promise.resolve([
            {
              calendarId: "me@work.test",
              name: "me@work.test",
              accessRole: "owner",
              primary: true,
              writable: true,
              readable: true,
            },
            {
              calendarId: "team@group.test",
              name: "Team",
              accessRole: "writer",
              primary: false,
              writable: true,
              readable: true,
            },
          ]),
        connectCalendar: (slot: string, calendarId: string, roles) => {
          state.addCalendar({
            key: "cal-team",
            account: slot,
            calendarId,
            name: "Team",
            source: roles?.source ?? true,
            destination: roles?.destination ?? true,
          });
          const added = state.getCalendar("cal-team");
          return added === null ? Promise.reject(new Error("not added")) : Promise.resolve(added);
        },
        checkAccount: (slot: string) =>
          Promise.resolve({
            slot,
            email: state.getGoogleAccount(slot)?.email ?? null,
            valid: true,
            message: "signed in",
          }),
        checkCalendar: (calendar) =>
          Promise.resolve({ calendar, valid: true, message: "readable and writable" }),
        disconnectAccount: vi.fn(),
      },
      state,
      removeCalendar: (key: string) => {
        removed.push(key);
        state.removeCalendar(key, []);
        return Promise.resolve({ created: 0, updated: 0, deleted: 2, repaired: 0 });
      },
    };
    const runtime: McpRuntime = {
      ...mockRuntime({ state }),
      accounts,
      ...(connectUrl === undefined ? {} : { connectUrl }),
    };
    return { runtime, state, removed };
  }

  it("names sign-ins and calendars by account in get_status", async () => {
    const { runtime } = accountsRuntime();
    const result = await handleGetStatus(runtime);
    expect(result.ok && result.data.signIns).toEqual([
      { account: "me@work.test", valid: true, message: "signed in", calendars: 1 },
    ]);
    expect(result.ok && result.data.calendars).toEqual([
      {
        calendar: "me@work.test",
        shares: true,
        receives: true,
        valid: true,
        message: "readable and writable",
      },
    ]);
  });

  it("links to the gateway for a new sign-in and adopts it on the next status", async () => {
    const { runtime, state } = accountsRuntime(
      "https://gw.example.test/auth/google/connect?slot={slot}",
    );
    const started = await handleConnectAccount(runtime);
    expect(started.ok && started.data.url).toBe(
      "https://gw.example.test/auth/google/connect?slot=account2",
    );
    expect(state.getGoogleAccount("account2")).toBeNull();
    await handleGetStatus(runtime);
    expect(state.getGoogleAccount("account2")?.email).toBe("colleague@work.test");
  });

  it("lists what could be added, adds by name, and removes by name", async () => {
    const { runtime, removed } = accountsRuntime();
    const listed = await handleListCalendars(runtime, { available: true });
    expect(listed.ok && listed.data.available).toEqual([
      { calendar: "me@work.test", synced: true, can_receive: true, can_share: true },
      { calendar: "me@work.test/Team", synced: false, can_receive: true, can_share: true },
    ]);
    const added = await handleAddCalendar(runtime, {
      calendar: "me@work.test/team",
      share_only: true,
    });
    expect(added.ok && added.data).toEqual({
      calendar: "me@work.test / Team",
      shares: true,
      receives: false,
    });
    expect((await handleAddCalendar(runtime, { calendar: "nobody@x.test" })).ok).toBe(false);

    const keyword = handleAddExclusion(runtime, {
      keywords: ["standup"],
      from: "me@work.test / Team",
    });
    expect(keyword.ok && keyword.data.added).toEqual([
      { kind: "keyword", value: "standup", source: "cal-team" },
    ]);

    const result = await handleRemoveCalendar(runtime, { calendar: "me@work.test / Team" });
    expect(result.ok && result.data).toEqual({ calendar: "me@work.test / Team", deleted: 2 });
    expect(removed).toEqual(["cal-team"]);
  });
});
