import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ReconcilePassError,
  type DedupeResult,
  type ReconcileLog,
  type SyncReconcileResult,
} from "@calsync/engine";

import {
  type AppRuntime,
  createProgram,
  formatDryRunReport,
  formatExclusionList,
} from "../src/cli.js";
import type { AccountRole, AppConfig } from "../src/config.js";
import type { AuthorizationOptions } from "../src/google/auth.js";
import type { LaunchdService } from "../src/launchd/service.js";
import { StateDatabase } from "../src/storage/index.js";
import type { SyncService } from "../src/sync/service.js";

describe("CLI scaffold", () => {
  it("exposes the planned command surface", () => {
    const commandNames = createProgram().commands.map((command) => command.name());

    expect(commandNames).toEqual([
      "config",
      "auth",
      "status",
      "logout",
      "sync",
      "start",
      "rebuild",
      "cleanup",
      "dedupe",
      "exclude",
      "service",
      "web",
      "mcp",
    ]);
  });

  it("provides useful top-level help", () => {
    const help = createProgram().helpInformation();

    expect(help).toContain("Usage: calsync");
    expect(help).toContain("Mirror private busy blocks");
  });

  it("wires the complete launchd service command surface and log options", async () => {
    const logs = vi.fn(() => Promise.resolve(""));
    const service: LaunchdService = {
      install: vi.fn(() => Promise.resolve("installed")),
      start: vi.fn(() => Promise.resolve("started")),
      stop: vi.fn(() => Promise.resolve("stopped")),
      restart: vi.fn(() => Promise.resolve("restarted")),
      status: vi.fn(() => Promise.resolve("running")),
      logs,
      uninstall: vi.fn(() => Promise.resolve("uninstalled")),
    };
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errorOutput = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const program = createProgram(undefined, () => service);
    const serviceCommand = program.commands.find((command) => command.name() === "service");

    expect(serviceCommand?.commands.map((command) => command.name())).toEqual([
      "install",
      "start",
      "stop",
      "restart",
      "status",
      "logs",
      "uninstall",
    ]);
    expect(
      serviceCommand?.commands.find((command) => command.name() === "logs")?.helpInformation(),
    ).toContain("Ctrl-C");

    await program.parseAsync(["node", "calsync", "service", "logs", "--follow", "--lines", "25"]);

    expect(logs).toHaveBeenCalledWith({ follow: true, lines: 25 });
    output.mockRestore();
    errorOutput.mockRestore();
  });

  it("documents and passes through manual browser selection for auth", async () => {
    vi.stubEnv("CALSYNC_PERSONAL_CALENDAR_ID", "personal@example.com");
    vi.stubEnv("CALSYNC_WORK_CALENDAR_ID", "work@example.com");
    const authorize = vi.fn(
      (_role: AccountRole, _calendarId: string, options?: AuthorizationOptions) => {
        options?.onAuthorizationUrl?.("https://accounts.google.com/o/oauth2/v2/auth?state=state");
        return Promise.resolve();
      },
    );
    const close = vi.fn();
    const runtime = (): AppRuntime => ({
      auth: {
        authorize,
        getStatus: vi.fn(),
        logout: vi.fn(),
      },
      state: { close },
    });
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const authCommand = createProgram(runtime).commands.find(
      (command) => command.name() === "auth",
    );
    expect(authCommand?.helpInformation()).toContain("--no-open");

    await createProgram(runtime).parseAsync(["node", "calsync", "auth", "personal", "--no-open"]);

    expect(authorize).toHaveBeenCalledWith(
      "personal",
      "personal@example.com",
      expect.objectContaining({ openBrowser: false }),
    );
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining("https://accounts.google.com/o/oauth2/v2/auth?state=state"),
    );
    expect(close).toHaveBeenCalledOnce();

    output.mockRestore();
    vi.unstubAllEnvs();
  });

  it("routes the tenant/role auth form into the runtime factory", async () => {
    vi.stubEnv("CALSYNC_PERSONAL_CALENDAR_ID", "personal@example.com");
    vi.stubEnv("CALSYNC_WORK_CALENDAR_ID", "work@example.com");
    const tenants: (string | undefined)[] = [];
    const runtime = (tenantId?: string): AppRuntime => {
      tenants.push(tenantId);
      return {
        auth: {
          authorize: vi.fn(() => Promise.resolve()),
          getStatus: vi.fn(),
          logout: vi.fn(),
        },
        state: { close: vi.fn() },
      };
    };
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram(runtime).parseAsync([
      "node",
      "calsync",
      "auth",
      "acme/personal",
      "--no-open",
    ]);
    expect(tenants).toEqual(["acme"]);

    await expect(
      createProgram(runtime).parseAsync([
        "node",
        "calsync",
        "auth",
        "acme/personal",
        "--tenant",
        "other",
        "--no-open",
      ]),
    ).rejects.toThrow("conflicts");

    output.mockRestore();
    vi.unstubAllEnvs();
  });

  it("wires once, dry-run, rebuild, and cleanup to the sync service", async () => {
    const result = syncResult({ created: 1, personalActive: 1 });
    let onceOptions: Parameters<SyncService["once"]>[0];
    const once = vi.fn((options?: Parameters<SyncService["once"]>[0]) => {
      onceOptions = options;
      return Promise.resolve(result);
    });
    const rebuild = vi.fn(() => Promise.resolve(result));
    const cleanup = vi.fn(() => Promise.resolve(result));
    const dedupe = vi.fn(() => Promise.resolve(dedupeResult));
    const sync: SyncService = {
      once,
      start: vi.fn(() => Promise.resolve()),
      rebuild,
      cleanup,
      dedupe,
    };
    const close = vi.fn();
    const runtime = (): AppRuntime => ({
      auth: {
        authorize: vi.fn(() => Promise.resolve()),
        getStatus: vi.fn((role: AccountRole) =>
          Promise.resolve({
            role,
            configured: true,
            valid: true,
            calendarId: "calendar",
            message: "ok",
          }),
        ),
        logout: vi.fn(() => Promise.resolve(true)),
      },
      state: { close },
      sync,
    });
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram(runtime).parseAsync(["node", "calsync", "sync", "--once", "--dry-run"]);
    await createProgram(runtime).parseAsync(["node", "calsync", "rebuild", "--dry-run"]);
    await createProgram(runtime).parseAsync(["node", "calsync", "cleanup"]);
    await createProgram(runtime).parseAsync(["node", "calsync", "dedupe", "--dry-run"]);
    await createProgram(runtime).parseAsync(["node", "calsync", "dedupe", "--no-progress"]);

    expect(onceOptions?.dryRun).toBe(true);
    expect(onceOptions?.onOperation).toBeTypeOf("function");
    expect(onceOptions?.onProgress).toBeUndefined();
    expect(rebuild).toHaveBeenCalledWith({ dryRun: true });
    expect(cleanup).toHaveBeenCalledWith({ dryRun: false });
    expect(dedupe).toHaveBeenNthCalledWith(1, { dryRun: true });
    expect(dedupe).toHaveBeenNthCalledWith(2, { dryRun: false });
    const printed = output.mock.calls.map(([value]) => String(value)).join("");
    expect(printed).toContain(
      "Stray-block cleanup preview: would remove 3 busy blocks (2 duplicates, 1 phantom; 1 on personal, 2 on work) out of 7 busy blocks checked",
    );
    expect(printed).toContain("Stray-block cleanup complete: removed 3 busy blocks");
    expect(close).toHaveBeenCalledTimes(5);
    output.mockRestore();
  });

  it("summarizes dry-run operations by direction, operation, and reason", () => {
    const operations: ReconcileLog[] = [
      operation("personal", "work", "create", "destination-missing"),
      operation("personal", "work", "create", "destination-missing"),
      operation("work", "personal", "update", "destination-drifted"),
    ];

    const report = formatDryRunReport(
      operations,
      syncResult({ created: 2, updated: 1, personalActive: 2, workActive: 1 }),
      false,
    );

    expect(report).toContain("Dry run: 3 operations planned.");
    expect(report).toContain("personal → work:");
    expect(report).toContain("create — destination missing: 2");
    expect(report).toContain("work → personal:");
    expect(report).toContain("update — destination drifted: 1");
    expect(report).toContain(
      "Projected active mirrors: personal → work 2 (0 excluded, 0 duplicate-suppressed); work → personal 1",
    );
    expect(report).not.toContain("Private planning");
    expect(report).not.toContain("2026-08-10");
  });

  it("ends default, detailed, and verbose dry runs with projected directional totals", async () => {
    const receivedOptions: NonNullable<Parameters<SyncService["once"]>[0]>[] = [];
    const once = vi.fn((options?: Parameters<SyncService["once"]>[0]) => {
      if (options !== undefined) {
        receivedOptions.push(options);
      }
      options?.onOperation?.(
        operation("personal", "work", "create", "destination-missing", "Private planning"),
      );
      options?.onSourceEvent?.({
        sourceRole: "personal",
        destinationRole: "work",
        sourceTitle: "Private planning",
        timeRange: {
          kind: "timed",
          start: "2026-08-10T10:00:00Z",
          end: "2026-08-10T11:00:00Z",
        },
        exclusionKeys: {
          occurrence: `calsync-exclude:v1:p2w:occ:${"a".repeat(43)}`,
          series: `calsync-exclude:v1:p2w:series:${"b".repeat(43)}`,
        },
        isRecurring: false,
      });
      return Promise.resolve(
        syncResult({
          created: 1,
          personalActive: 2,
          workActive: 3,
          personalExcluded: 1,
          workDuplicates: 2,
        }),
      );
    });
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const expectedEnding = [
      "Projected active mirrors: personal → work 2 (1 excluded, 0 duplicate-suppressed); work → personal 3 (0 excluded, 2 duplicate-suppressed)",
      "Excluded and duplicate-suppressed source events are not included in active totals.",
      "",
    ].join("\n");
    const modes = [[], ["--details"], ["--verbose"]] as const;

    for (const mode of modes) {
      output.mockClear();
      await createProgram(runtimeWithSync(syncWithOnce(once))).parseAsync([
        "node",
        "calsync",
        "sync",
        "--once",
        "--dry-run",
        ...mode,
      ]);
      const report = output.mock.calls.map(([value]) => String(value)).join("");
      expect(report).toContain("Dry run: 1 operation planned.");
      expect(report.endsWith(expectedEnding)).toBe(true);
    }

    expect(receivedOptions).toHaveLength(3);
    expect(receivedOptions.every((options) => options.dryRun === true)).toBe(true);
    expect(receivedOptions[0]?.onSourceEvent).toBeUndefined();
    expect(receivedOptions[1]?.onSourceEvent).toBeTypeOf("function");
    expect(receivedOptions[2]?.onSourceEvent).toBeTypeOf("function");
    output.mockRestore();
  });

  it("reveals titles and timestamps only in explicitly requested dry-run details", async () => {
    const sensitiveTitle = "Private planning\nwith Alice";
    const planned = {
      ...operation("personal", "work", "create", "destination-missing", sensitiveTitle),
      calendarId: "personal-calendar",
      sourceEventId: "source-event-id",
      oauthData: "oauth-secret",
      description: "private description",
      attendees: ["alice@example.test"],
    };
    const once = vi.fn((options?: Parameters<SyncService["once"]>[0]) => {
      options?.onOperation?.(planned);
      options?.onSourceEvent?.({
        sourceRole: "personal",
        destinationRole: "work",
        sourceTitle: sensitiveTitle,
        timeRange: {
          kind: "timed",
          start: "2026-08-10T10:00:00Z",
          end: "2026-08-10T11:00:00Z",
        },
        exclusionKeys: {
          occurrence: `calsync-exclude:v1:p2w:occ:${"a".repeat(43)}`,
          series: `calsync-exclude:v1:p2w:series:${"b".repeat(43)}`,
        },
        exclusionReason: "keyword",
        isRecurring: true,
      });
      return Promise.resolve(syncResult({ created: 1, personalActive: 1, personalExcluded: 1 }));
    });
    const runtime = runtimeWithSync({
      once,
      start: vi.fn(() => Promise.resolve()),
      rebuild: vi.fn(() => Promise.resolve({ created: 0, updated: 0, deleted: 0, repaired: 0 })),
      cleanup: vi.fn(() => Promise.resolve({ created: 0, updated: 0, deleted: 0, repaired: 0 })),
      dedupe: vi.fn(() => Promise.resolve(dedupeResult)),
    });
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram(runtime).parseAsync(["node", "calsync", "sync", "--once", "--dry-run"]);
    const defaultOutput = output.mock.calls.map(([value]) => String(value)).join("");
    expect(defaultOutput).not.toContain(sensitiveTitle);
    expect(defaultOutput).not.toContain("Private planning");
    expect(defaultOutput).not.toContain("2026-08-10");

    output.mockClear();
    await createProgram(runtime).parseAsync([
      "node",
      "calsync",
      "sync",
      "--once",
      "--dry-run",
      "--details",
    ]);
    const detailedOutput = output.mock.calls.map(([value]) => String(value)).join("");
    expect(detailedOutput).toContain('"Private planning\\nwith Alice"');
    expect(detailedOutput).toContain("2026-08-10T10:00:00Z → 2026-08-10T11:00:00Z");
    expect(detailedOutput).toContain(
      `occurrence only: calsync-exclude:v1:p2w:occ:${"a".repeat(43)}`,
    );
    expect(detailedOutput).toContain(
      `whole series:    calsync-exclude:v1:p2w:series:${"b".repeat(43)}`,
    );
    expect(detailedOutput).toContain("excluded_by_keyword");
    expect(detailedOutput).not.toContain("personal-calendar");
    expect(detailedOutput).not.toContain("source-event-id");
    expect(detailedOutput).not.toContain("oauth-secret");
    expect(detailedOutput).not.toContain("private description");
    expect(detailedOutput).toContain("copy into `calsync exclude add`");
    expect(detailedOutput).not.toContain("alice@example.test");
    output.mockClear();
    const syncCommand = createProgram(runtime).commands.find(
      (command) => command.name() === "sync",
    );
    syncCommand?.outputHelp();
    const syncHelp = output.mock.calls.map(([value]) => String(value)).join("");
    expect(syncHelp).toContain("opaque exclusion keys");
    expect(syncHelp).toContain("calsync exclude add");
    expect(syncHelp).toContain("--from personal --keyword dentist,therapy,school pickup");
    expect(syncHelp).toContain("--no-progress");
    output.mockRestore();
  });

  it("reports a zero-change dry run without detail noise", () => {
    expect(formatDryRunReport([], syncResult(), true)).toBe(
      [
        "Dry run: no changes planned.",
        "Projected active mirrors: personal → work 0 (0 excluded, 0 duplicate-suppressed); work → personal 0 (0 excluded, 0 duplicate-suppressed)",
        "Excluded and duplicate-suppressed source events are not included in active totals.",
        "",
      ].join("\n"),
    );
  });

  it("labels all-day detail ranges and their exclusive end date", () => {
    const allDay: ReconcileLog = {
      ...operation("work", "personal", "create", "destination-missing", "Private holiday"),
      timeRange: { kind: "all-day", start: "2026-08-10", end: "2026-08-12" },
    };

    expect(formatDryRunReport([allDay], syncResult({ created: 1, workActive: 1 }), true)).toContain(
      "2026-08-10 → 2026-08-12 (all-day; end exclusive)",
    );
  });

  it("prints successful totals without exposing event data", async () => {
    const once = vi.fn(() =>
      Promise.resolve(
        syncResult({
          created: 2,
          personalActive: 3,
          workActive: 4,
          personalExcluded: 1,
          workDuplicates: 2,
        }),
      ),
    );
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram(runtimeWithSync(syncWithOnce(once))).parseAsync([
      "node",
      "calsync",
      "sync",
      "--once",
    ]);

    const report = output.mock.calls.map(([value]) => String(value)).join("");
    expect(report).toContain("Reconciliation complete: 2 created");
    expect(report).toContain(
      "Active mirrors: personal → work 3 (1 excluded, 0 duplicate-suppressed); work → personal 4 (0 excluded, 2 duplicate-suppressed)",
    );
    expect(report).toContain("not included in active totals");
    output.mockRestore();
  });

  it("prints honest post-operation totals before surfacing a partial failure", async () => {
    const partial = syncResult({
      created: 1,
      failed: 1,
      converged: false,
      personalActive: 1,
      workActive: 0,
    });
    const once = vi.fn(() => Promise.reject(new ReconcilePassError(partial, new Error("API"))));
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(
      createProgram(runtimeWithSync(syncWithOnce(once))).parseAsync([
        "node",
        "calsync",
        "sync",
        "--once",
      ]),
    ).rejects.toThrow("1 reconciliation operation failed");

    const report = output.mock.calls.map(([value]) => String(value)).join("");
    expect(report).toContain("Reconciliation incomplete: 1 created");
    expect(report).toContain("1 failed");
    expect(report).toContain("Active mirrors after partial run: personal → work 1");
    expect(report).toContain("did not fully converge");
    output.mockRestore();
  });
});

describe("exclude commands", () => {
  const personalOccurrence = `calsync-exclude:v1:p2w:occ:${"a".repeat(43)}`;
  const personalSeries = `calsync-exclude:v1:p2w:series:${"b".repeat(43)}`;
  const workSeries = `calsync-exclude:v1:w2p:series:${"c".repeat(43)}`;

  describe("CLI add/remove", () => {
    let directory: string;

    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), "calsync-exclude-"));
      vi.stubEnv("CALSYNC_DATABASE_PATH", join(directory, "state.sqlite3"));
      vi.stubEnv("CALSYNC_PERSONAL_CALENDAR_ID", "primary");
      vi.stubEnv("CALSYNC_WORK_CALENDAR_ID", "primary");
      vi.stubEnv("CALSYNC_TIMEZONE", "UTC");
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    });

    it("adds, lists, and removes CLI keywords and opaque keys", async () => {
      await parseExclude(["add", "--from", "personal", "--keyword", "Dentist,therapy"]);
      await parseExclude(["add", personalOccurrence, workSeries]);
      const listed = await parseExclude(["list"]);

      expect(listed).toContain("dentist  (cli)");
      expect(listed).toContain("therapy  (cli)");
      expect(listed).toContain(`${personalOccurrence}  (cli)`);
      expect(listed).toContain(`${workSeries}  (cli)`);
      expect(listed).toContain("personal → work");
      expect(listed).toContain("work → personal");
      expect(listed).not.toContain("Private medical");

      await parseExclude(["remove", "--from", "personal", "--keyword", "dentist,therapy"]);
      await parseExclude(["remove", personalOccurrence, workSeries]);
      const afterRemove = await parseExclude(["list"]);
      expect(afterRemove).not.toContain("dentist  (cli)");
      expect(afterRemove).not.toContain(`${personalOccurrence}  (cli)`);
    });

    it("adds multiple keywords with --from once and reports already-present items", async () => {
      const added = await parseExclude([
        "add",
        "--from",
        "personal",
        "--keyword",
        "Dentist, therapy, school pickup",
      ]);
      expect(added).toContain("Added:");
      expect(added).toContain('keyword "dentist" (personal → work)');
      expect(added).toContain('keyword "therapy" (personal → work)');
      expect(added).toContain('keyword "school pickup" (personal → work)');
      expect(added).toContain("The next sync pass applies this.");

      const again = await parseExclude([
        "add",
        "--from",
        "personal",
        "--keyword",
        "dentist,,focus time",
      ]);
      expect(again).toContain("Added:");
      expect(again).toContain('keyword "focus time" (personal → work)');
      expect(again).toContain("Already present:");
      expect(again).toContain('keyword "dentist" (personal → work)');
    });

    it("treats unquoted spaces after a comma as part of the last keyword", async () => {
      const added = await parseExclude([
        "add",
        "--from",
        "personal",
        "--keyword",
        "dentist,therapy,school",
        "pickup",
      ]);
      expect(added).toContain('keyword "dentist" (personal → work)');
      expect(added).toContain('keyword "therapy" (personal → work)');
      expect(added).toContain('keyword "school pickup" (personal → work)');
    });

    it("adds multiple opaque keys and infers direction from each key", async () => {
      const added = await parseExclude(["add", personalOccurrence, personalSeries, workSeries]);
      expect(added).toContain("this occurrence (personal → work):");
      expect(added).toContain(personalOccurrence);
      expect(added).toContain("the whole series (personal → work):");
      expect(added).toContain(personalSeries);
      expect(added).toContain("the whole series (work → personal):");
      expect(added).toContain(workSeries);

      const again = await parseExclude(["add", personalOccurrence, workSeries]);
      expect(again).toContain("Already present:");
      expect(again).toContain(personalOccurrence);
      expect(again).not.toContain("Added:");
    });

    it("removes batches idempotently and reports missing CLI entries", async () => {
      await parseExclude(["add", "--from", "work", "--keyword", "confidential,internal"]);
      await parseExclude(["add", personalOccurrence, workSeries]);

      const removedKeywords = await parseExclude([
        "remove",
        "--from",
        "work",
        "--keyword",
        "confidential,missing-phrase",
      ]);
      expect(removedKeywords).toContain("Removed:");
      expect(removedKeywords).toContain('keyword "confidential" (work → personal)');
      expect(removedKeywords).toContain("Missing:");
      expect(removedKeywords).toContain('keyword "missing-phrase" (work → personal)');
      expect(removedKeywords).toContain("edit .env");

      const removedKeys = await parseExclude(["remove", personalOccurrence, personalSeries]);
      expect(removedKeys).toContain("Removed:");
      expect(removedKeys).toContain(personalOccurrence);
      expect(removedKeys).toContain("Missing:");
      expect(removedKeys).toContain(personalSeries);

      const missingOnly = await parseExclude(["remove", personalOccurrence]);
      expect(missingOnly).toContain("Missing:");
      expect(missingOnly).toContain(personalOccurrence);
      expect(missingOnly).not.toContain("Removed:");
      expect(missingOnly).not.toContain("The next sync pass applies this.");
    });

    it("rejects mixing keys with keywords, missing --from, and conflicting --from", async () => {
      await expect(
        parseExcludeRejected(["add", personalOccurrence, "--keyword", "dentist"]),
      ).rejects.toThrow(/not both/);
      await expect(parseExcludeRejected(["add", "--keyword", "dentist"])).rejects.toThrow(/--from/);
      await expect(
        parseExcludeRejected(["add", personalOccurrence, "--from", "personal"]),
      ).rejects.toThrow(/only used with --keyword/);
      await expect(
        parseExcludeRejected([
          "add",
          "--from",
          "personal",
          "--from",
          "work",
          "--keyword",
          "dentist,internal",
        ]),
      ).rejects.toThrow(/Use --from once/);
      await expect(
        parseExcludeRejected(["add", "--from", "personal", "--keyword", " , , "]),
      ).rejects.toThrow(/blank/);
      await expect(parseExcludeRejected(["add"])).rejects.toThrow(
        /opaque exclusion keys or --keyword/,
      );
    });
  });

  it("lists env exclusions separately from CLI exclusions", () => {
    const state = new StateDatabase(":memory:");
    state.addExclusionKeyword("personalToWork", "dentist");
    const config: AppConfig = {
      tenantId: "default",
      accounts: {
        personal: { tenantId: "default", role: "personal", calendarId: "personal" },
        work: { tenantId: "default", role: "work", calendarId: "work" },
      },
      pollIntervalMs: 60_000,
      window: { pastDays: 30, futureDays: 365 },
      timezone: "UTC",
      exclusions: {
        personalToWork: [],
        workToPersonal: [],
        personalToWorkKeywords: ["focus time"],
        workToPersonalKeywords: [],
      },
    };

    const listed = formatExclusionList(config, state);
    expect(listed).toContain("dentist  (cli)");
    expect(listed).toContain("focus time  (.env)");
    expect(listed).toContain("--keyword dentist,therapy,school pickup");
    expect(listed).toContain("--verbose");
    state.close();
  });

  it("documents batch add and remove examples", () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exclude = createProgram().commands.find((command) => command.name() === "exclude");
    exclude?.commands.find((command) => command.name() === "add")?.outputHelp();
    const addHelp = output.mock.calls.map(([value]) => String(value)).join("");
    output.mockClear();
    exclude?.commands.find((command) => command.name() === "remove")?.outputHelp();
    const removeHelp = output.mock.calls.map(([value]) => String(value)).join("");
    output.mockRestore();

    expect(addHelp).toContain("[keys...]");
    expect(addHelp).toContain("KEY1 KEY2 KEY3");
    expect(addHelp).toContain("comma-separated case-insensitive title substrings");
    expect(addHelp).toContain("--keyword dentist,therapy,school pickup");
    expect(removeHelp).toContain("KEY1 KEY2");
    expect(removeHelp).toContain("--keyword confidential,internal");
  });
});

async function parseExclude(args: string[]): Promise<string> {
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await createProgram().parseAsync(["node", "calsync", "exclude", ...args]);
    return output.mock.calls.map(([value]) => String(value)).join("");
  } finally {
    output.mockRestore();
  }
}

async function parseExcludeRejected(args: string[]): Promise<never> {
  const program = createProgram();
  program.exitOverride();
  const exclude = program.commands.find((command) => command.name() === "exclude");
  exclude?.exitOverride();
  for (const command of exclude?.commands ?? []) {
    command.exitOverride();
  }
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const errorOutput = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await program.parseAsync(["node", "calsync", "exclude", ...args]);
    throw new Error("expected exclude command to reject");
  } finally {
    output.mockRestore();
    errorOutput.mockRestore();
  }
}

function operation(
  sourceRole: AccountRole,
  destinationRole: AccountRole,
  operationName: ReconcileLog["operation"],
  reason: ReconcileLog["reason"],
  sourceTitle = "Private planning",
): ReconcileLog {
  return {
    operation: operationName,
    sourceRole,
    destinationRole,
    reason,
    sourceTitle,
    timeRange: {
      kind: "timed",
      start: "2026-08-10T10:00:00Z",
      end: "2026-08-10T11:00:00Z",
    },
    dryRun: true,
  };
}

function runtimeWithSync(sync: SyncService): () => AppRuntime {
  return () => ({
    auth: {
      authorize: vi.fn(() => Promise.resolve()),
      getStatus: vi.fn(),
      logout: vi.fn(() => Promise.resolve(true)),
    },
    state: { close: vi.fn() },
    sync,
  });
}

const dedupeResult: DedupeResult = {
  created: 0,
  updated: 0,
  deleted: 3,
  repaired: 0,
  failed: 0,
  inspected: { personal: 3, work: 4 },
  duplicates: { personal: 0, work: 2 },
  phantoms: { personal: 1, work: 0 },
};

function syncWithOnce(once: SyncService["once"]): SyncService {
  return {
    once,
    start: vi.fn(() => Promise.resolve()),
    rebuild: vi.fn(() => Promise.resolve({ created: 0, updated: 0, deleted: 0, repaired: 0 })),
    cleanup: vi.fn(() => Promise.resolve({ created: 0, updated: 0, deleted: 0, repaired: 0 })),
    dedupe: vi.fn(() => Promise.resolve(dedupeResult)),
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
    personalExcluded?: number;
    workExcluded?: number;
    personalDuplicates?: number;
    workDuplicates?: number;
  } = {},
): SyncReconcileResult {
  return {
    created: values.created ?? 0,
    updated: values.updated ?? 0,
    deleted: values.deleted ?? 0,
    repaired: values.repaired ?? 0,
    failed: values.failed ?? 0,
    converged: values.converged ?? true,
    mirrors: {
      personalToWork: {
        active: values.personalActive ?? 0,
        excluded: values.personalExcluded ?? 0,
        duplicateSuppressed: values.personalDuplicates ?? 0,
      },
      workToPersonal: {
        active: values.workActive ?? 0,
        excluded: values.workExcluded ?? 0,
        duplicateSuppressed: values.workDuplicates ?? 0,
      },
    },
  };
}
