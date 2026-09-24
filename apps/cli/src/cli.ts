#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  readSyncSummary,
  type DedupeResult,
  type ReconcileLog,
  type ReconcileProgress,
  type ReconcileResult,
  type ReconcileSourceDetail,
  type SyncReconcileResult,
} from "@calsync/engine";
import { Command, Option } from "commander";

import {
  accountRoles,
  type AccountRole,
  type AppConfig,
  ConfigError,
  defaultTenantId,
  parseTenantId,
  loadConfig,
  loadScanGateLimits,
  loadWebConfig,
  stateDatabasePath,
} from "./config.js";
import {
  changeExclusions,
  snapshotExclusions,
  type ExclusionChangeResult,
  type ExclusionItem,
} from "./exclusions.js";
import type { GoogleAuthService } from "./google/auth.js";
import { LaunchdServiceManager, type LaunchdService } from "./launchd/service.js";
import { RotatingFileLogger, serviceLogPath } from "./logging.js";
import { runLiveMcpStdioServer } from "./mcp/server.js";
import { TerminalProgress } from "./progress.js";
import { ScanGate } from "./scanlimit.js";
import { CALSYNC_VERSION, createAuthRuntime } from "./runtime.js";
import { StateDatabase, type ExclusionDirection } from "./storage/index.js";
import {
  daemonIsRunning,
  daemonLockPathFor,
  syncLockPathFor,
  syncResultFromError,
  type SyncService,
  type SyncStatus,
} from "./sync/service.js";
import { WebServer, tenantForIdentity, webLink } from "./web/server.js";

export interface AppRuntime {
  auth: Pick<GoogleAuthService, "authorize" | "getStatus" | "logout">;
  state: Pick<StateDatabase, "close">;
  sync?: SyncService;
}

export function createProgram(
  runtimeFactory: (tenantId?: string) => AppRuntime = createAuthRuntime,
  serviceFactory: () => LaunchdService = () => new LaunchdServiceManager(),
): Command {
  const program = new Command()
    .name("calsync")
    .description("Mirror private busy blocks between two Google calendars")
    .version(CALSYNC_VERSION)
    .showHelpAfterError();

  program
    .command("config")
    .description("Validate local configuration")
    .command("check")
    .description("Check environment variables without displaying calendar IDs")
    .action(() => {
      const config = loadConfig();
      process.stdout.write(
        `Configuration is valid (${config.timezone}, poll every ${String(config.pollIntervalMs / 1_000)}s, full sync every ${String((config.fullSyncIntervalMs ?? 86_400_000) / 3_600_000)}h).\n`,
      );
    });

  addAuthCommands(program, runtimeFactory);
  addSyncCommands(program, runtimeFactory);
  addExcludeCommands(program);
  addServiceCommands(program, serviceFactory);
  addWebCommands(program);
  addMcpCommand(program);
  return program;
}

function addAuthCommands(
  program: Command,
  runtimeFactory: (tenantId?: string) => AppRuntime,
): void {
  program
    .command("auth")
    .description("Authorize one Google account")
    .argument("<role>", `account role: ${accountRoles.join(" or ")}, optionally as <tenant>/<role>`)
    .option("--tenant <id>", "tenant identifier (defaults to CALSYNC_TENANT_ID)")
    .option("--no-open", "do not open a browser; print the authorization URL for copy/paste")
    .action(async (value: string, options: { open: boolean; tenant?: string }) => {
      const { role, tenantId } = parseTenantRole(value, options.tenant);
      const config = loadConfig();
      await withRuntime(runtimeFactory, tenantId, async ({ auth }) => {
        await auth.authorize(role, config.accounts[role].calendarId, {
          openBrowser: options.open,
          onAuthorizationUrl: (url) => {
            const instruction = options.open
              ? "Use this URL if you need a different browser or profile:"
              : "Open this authorization URL in the browser and profile you want to authorize:";
            process.stdout.write(`${instruction}\n${url}\n`);
          },
          onBrowserOpenFailure: (url, error) => {
            const detail = error instanceof Error ? `: ${error.message}` : "";
            process.stderr.write(
              `Could not open the system browser${detail}\nOpen this authorization URL manually:\n${url}\n`,
            );
          },
        });
        process.stdout.write(`${role}: authorized and calendar is writable\n`);
      });
    });

  program
    .command("status")
    .description("Validate both stored account credentials and calendar access")
    .option("--tenant <id>", "tenant identifier (defaults to CALSYNC_TENANT_ID)")
    .action(async (options: { tenant?: string }) => {
      const config = loadConfig();
      await withRuntime(runtimeFactory, optionalTenant(options.tenant), async ({ auth }) => {
        const statuses = await Promise.all(
          accountRoles.map((role) => auth.getStatus(role, config.accounts[role].calendarId)),
        );
        for (const status of statuses) {
          process.stdout.write(`${status.role}: ${status.message}\n`);
        }
        // Operator-facing: name the other tenant, which the dashboard never does.
        const rival = statuses.find((status) => status.conflictsWith !== undefined)?.conflictsWith;
        if (rival !== undefined) {
          process.stdout.write(
            `warning: tenant ${rival} syncs the same two calendars on this host; ` +
              "two tenants on one pair mirror every event twice. Remove one of them.\n",
          );
        }
        if (statuses.some((status) => !status.valid)) {
          process.exitCode = 1;
        }
      });
    });

  program
    .command("logout")
    .description("Revoke and remove stored authorization")
    .argument(
      "[role]",
      `optional account role: ${accountRoles.join(" or ")}, optionally as <tenant>/<role>`,
    )
    .option("--tenant <id>", "tenant identifier (defaults to CALSYNC_TENANT_ID)")
    .action(async (value: string | undefined, options: { tenant?: string }) => {
      const parsed = value === undefined ? undefined : parseTenantRole(value, options.tenant);
      const tenantId = parsed?.tenantId ?? optionalTenant(options.tenant);
      const roles = parsed === undefined ? accountRoles : [parsed.role];
      await withRuntime(runtimeFactory, tenantId, async ({ auth }) => {
        for (const role of roles) {
          const removed = await auth.logout(role);
          process.stdout.write(
            `${role}: ${removed ? "authorization removed" : "not authorized"}\n`,
          );
        }
      });
    });
}

function addSyncCommands(program: Command, runtimeFactory: () => AppRuntime): void {
  program
    .command("sync")
    .description("Run one reconciliation pass")
    .option("--once", "run one reconciliation pass")
    .option("--dry-run", "preview operations without writing")
    .option("--no-progress", "disable interactive progress output")
    .option(
      "--details",
      "show private source details and opaque exclusion keys in dry-run output (sensitive terminal data)",
    )
    .option("--verbose", "alias for --details; shows private details and exclusion keys")
    .addHelpText(
      "after",
      `
Exclusions:
  Prefer \`calsync exclude add\` after a detailed dry run, or
  \`calsync exclude add --from personal --keyword dentist,therapy,school pickup\`.
  Environment variables remain supported for the same keys and keywords.

Totals:
  Active mirror totals are the complete post-run desired set, not just events
  created by that pass. Dry runs project these totals. Excluded and
  cross-account duplicate-suppressed sources are reported but not included.
`,
    )
    .action(
      async (options: {
        once?: boolean;
        dryRun?: boolean;
        details?: boolean;
        verbose?: boolean;
        progress?: boolean;
      }) => {
        if (options.once !== true) {
          throw new Error("Use calsync sync --once (or calsync start for polling)");
        }
        const showDetails = options.details === true || options.verbose === true;
        if (showDetails && options.dryRun !== true) {
          throw new Error("--details and --verbose require --dry-run");
        }
        await withRuntime(runtimeFactory, undefined, async (runtime) => {
          if (options.dryRun === true) {
            const operations: ReconcileLog[] = [];
            const sources: ReconcileSourceDetail[] = [];
            const result = await requireSync(runtime).once({
              dryRun: true,
              onOperation: (entry) => operations.push(entry),
              onStatus: printSyncStatus,
              ...(showDetails ? { onSourceEvent: (entry) => sources.push(entry) } : {}),
            });
            process.stdout.write(formatDryRunReport(operations, result, showDetails, sources));
          } else {
            try {
              const result = await withTerminalProgress(
                options.progress !== false,
                async (onProgress) =>
                  requireSync(runtime).once({
                    dryRun: false,
                    onStatus: printSyncStatus,
                    ...(onProgress === undefined ? {} : { onProgress }),
                  }),
              );
              printSyncResult(result);
            } catch (error) {
              const result = syncResultFromError(error);
              if (result !== undefined) {
                printSyncResult(result);
              }
              throw error;
            }
          }
        });
      },
    );

  program
    .command("start")
    .description("Start the polling daemon")
    .option("--dry-run", "poll and preview operations without writing")
    .addOption(new Option("--service-mode").hideHelp())
    .action(async (options: { dryRun?: boolean; serviceMode?: boolean }) => {
      await withRuntime(runtimeFactory, undefined, async (runtime) => {
        await requireSync(runtime).start({ dryRun: options.dryRun ?? false });
      });
    });

  program
    .command("rebuild")
    .description("Rebuild local mappings from managed event metadata")
    .option("--dry-run", "preview mapping repairs without writing")
    .action(async (options: { dryRun?: boolean }) => {
      await withRuntime(runtimeFactory, undefined, async (runtime) => {
        printResult(await requireSync(runtime).rebuild({ dryRun: options.dryRun ?? false }));
      });
    });

  program
    .command("cleanup")
    .description("Remove every managed mirror event")
    .option("--dry-run", "preview removals without writing")
    .option("--no-progress", "disable interactive progress output")
    .action(async (options: { dryRun?: boolean; progress?: boolean }) => {
      await withRuntime(runtimeFactory, undefined, async (runtime) => {
        if (options.dryRun === true) {
          printResult(await requireSync(runtime).cleanup({ dryRun: true }));
          return;
        }
        const result = await withTerminalProgress(options.progress !== false, async (onProgress) =>
          requireSync(runtime).cleanup({
            dryRun: false,
            ...(onProgress === undefined ? {} : { onProgress }),
          }),
        );
        printResult(result);
      });
    });

  program
    .command("dedupe")
    .description(
      "Remove stray busy blocks: duplicates of another block and phantoms with no event behind them",
    )
    .option("--dry-run", "list what would be removed without writing")
    .option("--no-progress", "disable interactive progress output")
    .action(async (options: { dryRun?: boolean; progress?: boolean }) => {
      await withRuntime(runtimeFactory, undefined, async (runtime) => {
        const dryRun = options.dryRun === true;
        const result = await withTerminalProgress(
          !dryRun && options.progress !== false,
          async (onProgress) =>
            requireSync(runtime).dedupe({
              dryRun,
              ...(onProgress === undefined ? {} : { onProgress }),
            }),
        );
        printDedupeResult(result, dryRun);
      });
    });
}

function addExcludeCommands(program: Command): void {
  const exclude = program
    .command("exclude")
    .description("Manage source events that should not be mirrored");

  exclude
    .command("list")
    .description("Show CLI-managed and .env exclusions without event titles")
    .option("--tenant <id>", "tenant identifier (defaults to CALSYNC_TENANT_ID)")
    .action((options: { tenant?: string }) => {
      const config = loadConfig();
      withState(optionalTenant(options.tenant) ?? config.tenantId, (state) => {
        process.stdout.write(formatExclusionList(config, state));
      });
    });

  exclude
    .command("add")
    .description("Exclude source event keys or title keywords")
    .argument("[keys...]", "opaque occurrence or series keys from a detailed dry run")
    .option(
      "--from <role>",
      "source calendar for --keyword: personal or work; once per command",
      collectOption,
      [],
    )
    .option("--keyword <list...>", "comma-separated case-insensitive title substrings")
    .option("--tenant <id>", "tenant identifier (defaults to CALSYNC_TENANT_ID)")
    .addHelpText(
      "after",
      `
Examples:
  calsync exclude add calsync-exclude:v1:p2w:occ:...
  calsync exclude add KEY1 KEY2 KEY3
  calsync exclude add --from personal --keyword dentist,therapy,school pickup
  calsync exclude add --from work --keyword confidential,internal
`,
    )
    .action((keys: string[], options: ExclusionCliOptions & { tenant?: string }) => {
      withState(optionalTenant(options.tenant) ?? defaultTenantId(), (state) => {
        process.stdout.write(`${applyExclusionChange("add", state, keys, options)}\n`);
      });
    });

  exclude
    .command("remove")
    .description("Stop excluding source event keys or title keywords")
    .argument("[keys...]", "opaque occurrence or series keys previously added")
    .option(
      "--from <role>",
      "source calendar for --keyword: personal or work; once per command",
      collectOption,
      [],
    )
    .option("--keyword <list...>", "comma-separated case-insensitive title substrings")
    .option("--tenant <id>", "tenant identifier (defaults to CALSYNC_TENANT_ID)")
    .addHelpText(
      "after",
      `
Examples:
  calsync exclude remove KEY1 KEY2
  calsync exclude remove --from work --keyword confidential,internal
`,
    )
    .action((keys: string[], options: ExclusionCliOptions & { tenant?: string }) => {
      withState(optionalTenant(options.tenant) ?? defaultTenantId(), (state) => {
        process.stdout.write(`${applyExclusionChange("remove", state, keys, options)}\n`);
      });
    });
}

function addServiceCommands(program: Command, serviceFactory: () => LaunchdService): void {
  const service = program
    .command("service")
    .description("Manage the macOS launchd background service");

  service
    .command("install")
    .description("Build, install, and load the calsync LaunchAgent")
    .action(async () => {
      printServiceMessage(await serviceFactory().install());
    });

  service
    .command("start")
    .description("Load the installed calsync LaunchAgent")
    .action(async () => {
      printServiceMessage(await serviceFactory().start());
    });

  service
    .command("stop")
    .description("Unload the calsync LaunchAgent without removing it")
    .action(async () => {
      printServiceMessage(await serviceFactory().stop());
    });

  service
    .command("restart")
    .description("Restart the loaded service, or load it if stopped")
    .action(async () => {
      printServiceMessage(await serviceFactory().restart());
    });

  service
    .command("status")
    .description("Show whether the calsync LaunchAgent is installed and running")
    .action(async () => {
      printServiceMessage(await serviceFactory().status());
    });

  service
    .command("logs")
    .description("Show privacy-safe daemon stdout and stderr logs")
    .option("-f, --follow", "follow appended log output; press Ctrl-C to stop")
    .option("-n, --lines <count>", "number of recent lines to show", parseLogLines, 100)
    .addHelpText(
      "after",
      `
By default, shows the last 100 lines from the current structured service log.
With --follow, filename following continues across rotation; press Ctrl-C to stop.
`,
    )
    .action(async (options: { follow?: boolean; lines: number }) => {
      if (options.follow === true) {
        process.stderr.write("Following calsync service logs. Press Ctrl-C to stop.\n");
      }
      printServiceMessage(
        await serviceFactory().logs({
          follow: options.follow === true,
          lines: options.lines,
        }),
      );
    });

  service
    .command("uninstall")
    .description("Unload the service and remove only its LaunchAgent plist")
    .action(async () => {
      printServiceMessage(await serviceFactory().uninstall());
    });
}

function addMcpCommand(program: Command): void {
  program
    .command("mcp")
    .description("Start a local stdio MCP server for Cursor and Claude Desktop")
    .action(async () => {
      await runLiveMcpStdioServer();
    });
}

function addWebCommands(program: Command): void {
  const web = program
    .command("web")
    .description("Onboarding dashboard: connected calendars, sync status, connect links");

  web
    .command("serve", { isDefault: true })
    .description("Serve the onboarding dashboard")
    .option("--host <host>", "interface to bind (defaults to CALSYNC_WEB_HOST)")
    .option("--port <port>", "port to bind (defaults to CALSYNC_WEB_PORT)")
    .action(async (options: { host?: string; port?: string }) => {
      const config = loadConfig();
      const webConfig = loadWebConfig();
      const databasePath = stateDatabasePath();
      const server = new WebServer({
        host: options.host ?? webConfig.host,
        port: options.port === undefined ? webConfig.port : Number(options.port),
        defaultTenantId: config.tenantId,
        ...(webConfig.secret === undefined ? {} : { secret: webConfig.secret }),
        ...(webConfig.connectUrl === undefined ? {} : { connectUrl: webConfig.connectUrl }),
        // Hosted dashboards advertise an https base; that is the signal the
        // session cookie may be marked Secure.
        secureCookies: webConfig.baseUrl?.startsWith("https://") ?? false,
        ...(webConfig.identityHeader === undefined
          ? {}
          : { identityHeader: webConfig.identityHeader }),
        ...(webConfig.identityTenants === undefined
          ? {}
          : { identityTenants: webConfig.identityTenants }),
        defaultCalendarIds: {
          personal: config.accounts.personal.calendarId,
          work: config.accounts.work.calendarId,
        },
        daemonLockPath: daemonLockPathFor(syncLockPathFor(databasePath)),
        daemonIsRunning,
        // Shares `sync_state` with `calsync mcp`, so a person clicking and an
        // assistant calling draw on one allowance rather than two.
        scanGate: new ScanGate(new StateDatabase(databasePath), loadScanGateLimits()),
        runtimeFor: (tenantId) => {
          const runtime = createAuthRuntime(tenantId);
          return {
            getStatus: (role, calendarId) => runtime.auth.getStatus(role, calendarId),
            startConnect: (role, calendarId) =>
              runtime.auth.startConnect(role, calendarId, { openBrowser: false }),
            listAccounts: () => runtime.state.listAccounts(),
            syncSummary: () => readSyncSummary(runtime.state, tenantId),
            // Config is re-read per call so .env exclusions show current, as
            // the MCP tools do.
            listExclusions: () => snapshotExclusions(loadConfig(), runtime.state),
            changeExclusions: (action, input) =>
              changeExclusions(action, runtime.state, input, { allowMix: true }),
            previewSync: async ({ lockTimeoutMs }) => {
              const sources: ReconcileSourceDetail[] = [];
              const result = await runtime.sync.once({
                dryRun: true,
                lockTimeoutMs,
                onSourceEvent: (entry) => sources.push(entry),
              });
              return { result, sources };
            },
            dedupe: async ({ dryRun, lockTimeoutMs }) => {
              const operations: ReconcileLog[] = [];
              const result = await runtime.sync.dedupe({
                dryRun,
                lockTimeoutMs,
                onOperation: (entry) => operations.push(entry),
              });
              return { result, operations };
            },
            close: () => {
              runtime.auth.cancelPendingConnects();
              runtime.state.close();
            },
          };
        },
        onLog: (line) => process.stdout.write(`${line}\n`),
      });
      const port = await server.listen();
      process.stdout.write(
        `calsync web: listening on http://${options.host ?? webConfig.host}:${String(port)}/ (${
          webConfig.secret === undefined
            ? "single-tenant; no CALSYNC_WEB_SECRET"
            : webConfig.identityHeader === undefined
              ? "signed tenant links required"
              : `signed tenant links, or ${webConfig.identityHeader} from the proxy`
        })\n`,
      );
      await new Promise<void>((resolve) => {
        const stop = (): void => {
          resolve();
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      await server.close();
    });

  web
    .command("link")
    .description(
      "Mint a signed onboarding link for one tenant (expires; the dashboard keeps its own session)",
    )
    .argument("<tenant>", "tenant identifier")
    .option("--base <url>", "dashboard base URL (defaults to CALSYNC_WEB_BASE_URL)")
    .option("--ttl <days>", "how long the link stays valid", "7")
    .action((tenant: string, options: { base?: string; ttl: string }) => {
      const webConfig = loadWebConfig();
      if (webConfig.secret === undefined) {
        throw new Error("CALSYNC_WEB_SECRET is required to mint onboarding links");
      }
      const base = options.base ?? webConfig.baseUrl;
      if (base === undefined) {
        throw new Error("Pass --base or set CALSYNC_WEB_BASE_URL");
      }
      const days = Number(options.ttl);
      if (!Number.isFinite(days) || days <= 0 || days > 90) {
        throw new Error("--ttl must be a number of days between 0 and 90");
      }
      process.stdout.write(
        `${webLink(base, tenant, webConfig.secret, Math.round(days * 24 * 60 * 60))}\n`,
      );
    });

  web
    .command("identity")
    .description("Print the hash tenant id a signed-in email lands on")
    .argument("<email>", "signed-in email from the identity header")
    .action((email: string) => {
      const tenant = tenantForIdentity(email);
      if (tenant === null) {
        throw new Error("email does not produce a tenant id");
      }
      process.stdout.write(`tenant=${tenant}\n`);
    });
}

function withState(tenantId: string, action: (state: StateDatabase) => void): void {
  const state = new StateDatabase(stateDatabasePath(), tenantId);
  try {
    action(state);
  } finally {
    state.close();
  }
}

interface ExclusionCliOptions {
  from: string[];
  keyword: string[];
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function applyExclusionChange(
  action: "add" | "remove",
  state: StateDatabase,
  keys: string[] | string | undefined,
  options: { from?: string[] | string; keyword?: string[] | string },
): string {
  return formatExclusionChangeReport(
    action,
    changeExclusions(action, state, {
      ...(keys === undefined ? {} : { keys: typeof keys === "string" ? [keys] : keys }),
      ...(options.keyword === undefined
        ? {}
        : {
            keywords:
              typeof options.keyword === "string" ? [options.keyword] : [options.keyword.join(" ")],
          }),
      ...(options.from === undefined ? {} : { from: options.from }),
    }),
  );
}

function formatExclusionChangeReport(
  action: "add" | "remove",
  result: ExclusionChangeResult,
): string {
  const lines: string[] = [];
  const formatItem = (item: ExclusionItem): string =>
    item.kind === "keyword"
      ? `  keyword "${item.value}" (${formatDirection(item.direction)})`
      : `  ${formatKeyScope(item.value)} (${formatDirection(item.direction)}): ${item.value}`;
  const pushSection = (title: string, items: ExclusionItem[]) => {
    if (items.length === 0) {
      return;
    }
    lines.push(`${title}:`);
    lines.push(...items.map(formatItem));
  };

  if (action === "add") {
    pushSection("Added", result.added);
    pushSection("Already present", result.alreadyPresent);
  } else {
    pushSection("Removed", result.removed);
    pushSection("Missing", result.missing);
  }
  if (
    (action === "add" && result.added.length > 0) ||
    (action === "remove" && result.removed.length > 0)
  ) {
    lines.push(EXCLUSION_APPLY_HINT);
  }
  if (action === "remove" && result.missing.length > 0) {
    lines.push("CLI exclusions only; edit .env to change environment-based exclusions.");
  }
  return lines.join("\n");
}

const EXCLUSION_APPLY_HINT =
  "The next sync pass applies this. Preview with `calsync sync --once --dry-run`, or wait for the background service.";

export function formatExclusionList(config: AppConfig, state: StateDatabase): string {
  const storedKeys = new Map(
    state.listExclusionKeys().map((row) => [`${row.direction}\0${row.value}`, row] as const),
  );
  const storedKeywords = new Map(
    state.listExclusionKeywords().map((row) => [`${row.direction}\0${row.keyword}`, row] as const),
  );
  const lines: string[] = [];
  for (const direction of ["personalToWork", "workToPersonal"] as const) {
    lines.push(`${formatDirection(direction)}:`);
    const envKeywords =
      direction === "personalToWork"
        ? config.exclusions.personalToWorkKeywords
        : config.exclusions.workToPersonalKeywords;
    const envKeys =
      direction === "personalToWork"
        ? config.exclusions.personalToWork
        : config.exclusions.workToPersonal;
    const keywordLines = [
      ...[...storedKeywords.values()]
        .filter((row) => row.direction === direction)
        .map((row) => `    ${row.keyword}  (cli)`),
      ...envKeywords
        .filter((keyword) => !storedKeywords.has(`${direction}\0${keyword}`))
        .map((keyword) => `    ${keyword}  (.env)`),
    ];
    const keyLines = [
      ...[...storedKeys.values()]
        .filter((row) => row.direction === direction)
        .map((row) => `    ${row.value}  (cli)`),
      ...envKeys
        .filter((value) => !storedKeys.has(`${direction}\0${value}`))
        .map((value) => `    ${value}  (.env)`),
    ];
    lines.push("  keywords:");
    lines.push(...(keywordLines.length === 0 ? ["    (none)"] : keywordLines));
    lines.push("  keys:");
    lines.push(...(keyLines.length === 0 ? ["    (none)"] : keyLines));
  }
  lines.push(
    "",
    "Add title keywords with `calsync exclude add --from personal --keyword dentist,therapy,school pickup`.",
    "Add specific events after `calsync sync --once --dry-run --verbose`.",
  );
  return `${lines.join("\n")}\n`;
}

function formatDirection(direction: ExclusionDirection): string {
  return direction === "personalToWork" ? "personal → work" : "work → personal";
}

function formatKeyScope(value: string): string {
  return value.includes(":series:") ? "the whole series" : "this occurrence";
}

async function withRuntime(
  factory: (tenantId?: string) => AppRuntime,
  tenantId: string | undefined,
  action: (runtime: AppRuntime) => Promise<void>,
): Promise<void> {
  const runtime = factory(tenantId);
  try {
    await action(runtime);
  } finally {
    runtime.state.close();
  }
}

function parseRole(value: string): AccountRole {
  if (value === "personal" || value === "work") {
    return value;
  }
  throw new Error(`Invalid account role "${value}"; expected personal or work`);
}

/**
 * Parses a role argument that may carry a tenant prefix ("acme/work").
 * A bare tenantId of undefined defers to CALSYNC_TENANT_ID at runtime.
 */
function parseTenantRole(
  value: string,
  tenantOption?: string,
): { role: AccountRole; tenantId: string | undefined } {
  const separator = value.indexOf("/");
  if (separator === -1) {
    return { role: parseRole(value), tenantId: optionalTenant(tenantOption) };
  }
  const prefix = value.slice(0, separator);
  if (prefix.length === 0) {
    throw new Error(`Invalid tenant/role "${value}"; expected <tenant>/<role>`);
  }
  const tenantId = parseTenantId(prefix);
  if (tenantOption !== undefined && tenantOption !== tenantId) {
    throw new Error(`--tenant ${tenantOption} conflicts with tenant in "${value}"`);
  }
  return { role: parseRole(value.slice(separator + 1)), tenantId };
}

/** Validates an optional --tenant flag value; undefined defers to the env default. */
function optionalTenant(value?: string): string | undefined {
  return value === undefined ? undefined : parseTenantId(value);
}

function requireSync(runtime: AppRuntime): SyncService {
  if (runtime.sync === undefined) {
    throw new Error("Sync runtime is unavailable");
  }
  return runtime.sync;
}

async function withTerminalProgress<T>(
  enabled: boolean,
  action: (onProgress: ((progress: ReconcileProgress) => void) | undefined) => Promise<T>,
): Promise<T> {
  const progress = new TerminalProgress(process.stderr, enabled);
  const disposeSignals = progress.bindSignalCleanup();
  try {
    return await action(
      progress.enabled
        ? (entry) => {
            progress.update(entry);
          }
        : undefined,
    );
  } finally {
    disposeSignals();
    progress.finish();
  }
}

function printResult(result: ReconcileResult): void {
  process.stdout.write(
    `Reconciliation complete: ${String(result.created)} created, ${String(result.updated)} updated, ${String(result.deleted)} deleted, ${String(result.repaired)} repaired\n`,
  );
}

function printDedupeResult(result: DedupeResult, dryRun: boolean): void {
  const count = (n: number, word: string): string => `${String(n)} ${n === 1 ? word : `${word}s`}`;
  const checked = result.inspected.personal + result.inspected.work;
  const duplicates = result.duplicates.personal + result.duplicates.work;
  const phantoms = result.phantoms.personal + result.phantoms.work;
  const onCalendars =
    `${String(result.duplicates.personal + result.phantoms.personal)} on personal, ` +
    `${String(result.duplicates.work + result.phantoms.work)} on work`;
  process.stdout.write(
    `Stray-block cleanup ${dryRun ? "preview" : "complete"}: ${dryRun ? "would remove" : "removed"} ` +
      `${count(result.deleted, "busy block")} ` +
      `(${count(duplicates, "duplicate")}, ${count(phantoms, "phantom")}; ${onCalendars}) ` +
      `out of ${count(checked, "busy block")} checked\n`,
  );
}

function printSyncResult(result: SyncReconcileResult): void {
  const status = result.converged ? "complete" : "incomplete";
  process.stdout.write(
    `Reconciliation ${status}: ${String(result.created)} created, ${String(result.updated)} updated, ${String(result.deleted)} deleted, ${String(result.repaired)} repaired${result.failed === 0 ? "" : `, ${String(result.failed)} failed`}\n`,
  );
  process.stdout.write(
    `${formatMirrorTotals(result, result.converged ? "Active mirrors" : "Active mirrors after partial run")}\n`,
  );
  if (!result.converged) {
    process.stdout.write(
      "Desired state did not fully converge; totals include only desired mirrors active after successful operations.\n",
    );
  }
  process.stdout.write(
    "Excluded and duplicate-suppressed source events are not included in active totals.\n",
  );
}

export function formatDryRunReport(
  operations: readonly ReconcileLog[],
  result: SyncReconcileResult,
  showDetails = false,
  sources: readonly ReconcileSourceDetail[] = [],
): string {
  const total = result.created + result.updated + result.deleted + result.repaired;
  const lines =
    total === 0
      ? ["Dry run: no changes planned."]
      : [`Dry run: ${String(total)} ${total === 1 ? "operation" : "operations"} planned.`];
  const directions = [
    ["personal", "work"],
    ["work", "personal"],
  ] as const;
  for (const [sourceRole, destinationRole] of directions) {
    const directional = operations.filter(
      (entry) => entry.sourceRole === sourceRole && entry.destinationRole === destinationRole,
    );
    if (directional.length === 0) {
      continue;
    }
    lines.push(`${sourceRole} → ${destinationRole}:`);
    const counts = new Map<string, number>();
    for (const entry of directional) {
      const key = `${entry.operation}\0${entry.reason}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of [...counts].sort(([left], [right]) => left.localeCompare(right))) {
      const [operation, reason] = key.split("\0");
      lines.push(
        `  ${operation ?? "unknown"} — ${formatReason(reason ?? "unknown")}: ${String(count)}`,
      );
    }
  }

  if (total > 0 && operations.length !== total) {
    lines.push(`Unclassified operations: ${String(total - operations.length)}`);
  }

  if (showDetails && operations.length > 0) {
    lines.push("", "Details (private source titles and timestamps; terminal output is sensitive):");
    for (const entry of operations) {
      const title =
        entry.sourceTitle === undefined
          ? "(source title unavailable)"
          : JSON.stringify(entry.sourceTitle);
      const range =
        entry.timeRange === undefined
          ? "(time range unavailable)"
          : entry.timeRange.kind === "all-day"
            ? `${entry.timeRange.start} → ${entry.timeRange.end} (all-day; end exclusive)`
            : `${entry.timeRange.start} → ${entry.timeRange.end}`;
      lines.push(
        `  ${entry.sourceRole} → ${entry.destinationRole} | ${entry.operation} | ${range} | ${formatReason(entry.reason)} | ${title}`,
      );
    }
  }
  if (showDetails && sources.length > 0) {
    lines.push("", "Source exclusion keys (opaque; copy into `calsync exclude add`):");
    for (const source of sources) {
      const title =
        source.sourceTitle === undefined
          ? "(source title unavailable)"
          : JSON.stringify(source.sourceTitle);
      const recurrence = source.isRecurring ? "recurring occurrence" : "one-time event";
      const exclusion =
        source.exclusionReason === undefined
          ? "not excluded"
          : source.exclusionReason === "keyword"
            ? "excluded_by_keyword"
            : source.exclusionReason === "legacy"
              ? "excluded_by_legacy_raw_key"
              : `excluded_by_${source.exclusionReason}_key`;
      lines.push(
        `  ${source.sourceRole} → ${source.destinationRole} | ${recurrence} | ${formatTimeRange(source.timeRange)} | ${title} | ${exclusion}`,
        `    occurrence only: ${source.exclusionKeys.occurrence}`,
        `    whole series:    ${source.exclusionKeys.series}`,
      );
    }
  }
  lines.push(
    ...(showDetails && (operations.length > 0 || sources.length > 0) ? [""] : []),
    formatMirrorTotals(result, "Projected active mirrors"),
    "Excluded and duplicate-suppressed source events are not included in active totals.",
  );
  return `${lines.join("\n")}\n`;
}

function formatMirrorTotals(result: SyncReconcileResult, label: string): string {
  const personal = result.mirrors.personalToWork;
  const work = result.mirrors.workToPersonal;
  return `${label}: personal → work ${String(personal.active)} (${String(personal.excluded)} excluded, ${String(personal.duplicateSuppressed)} duplicate-suppressed); work → personal ${String(work.active)} (${String(work.excluded)} excluded, ${String(work.duplicateSuppressed)} duplicate-suppressed)`;
}

function formatTimeRange(range: ReconcileSourceDetail["timeRange"]): string {
  return range.kind === "all-day"
    ? `${range.start} → ${range.end} (all-day; end exclusive)`
    : `${range.start} → ${range.end}`;
}

function formatReason(reason: string): string {
  return reason.replaceAll("-", " ");
}

function parseLogLines(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(`Invalid log line count "${value}"; expected a positive integer`);
  }
  const lines = Number(value);
  if (!Number.isSafeInteger(lines)) {
    throw new Error(`Invalid log line count "${value}"; value is too large`);
  }
  return lines;
}

function printServiceMessage(message: string): void {
  if (message !== "") {
    process.stdout.write(`${message}\n`);
  }
}

function printSyncStatus(status: SyncStatus): void {
  if (status.event === "incremental_noop") {
    process.stdout.write(
      `Incremental sync: no relevant changes; next full sync ${status.nextFullAt}.\n`,
    );
    return;
  }
  if (status.event === "invalid_sync_token") {
    process.stdout.write(`${status.role}: invalid sync token; rebuilding incremental state.\n`);
    return;
  }
  process.stdout.write(
    `Full sync: ${status.reason.replaceAll("-", " ")}; next scheduled full sync ${status.nextFullAt}.\n`,
  );
}

async function main(): Promise<void> {
  try {
    await createProgram().parseAsync(process.argv);
  } catch (error) {
    const message =
      error instanceof ConfigError || error instanceof Error ? error.message : "Unknown error";
    if (process.argv.includes("--service-mode")) {
      const logger = new RotatingFileLogger(serviceLogPath(), {
        maxBytes: 5 * 1024 * 1024,
        backups: 5,
      });
      logger.write(
        JSON.stringify({
          event: "service_fatal",
          error: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    }
    process.stderr.write(`calsync: ${message}\n`);
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined) {
  let resolvedEntrypoint = entrypoint;
  try {
    resolvedEntrypoint = realpathSync(entrypoint);
  } catch {
    // Keep the unresolved path when the binary has not been written yet.
  }
  if (import.meta.url === pathToFileURL(resolvedEntrypoint).href) {
    await main();
  }
}
