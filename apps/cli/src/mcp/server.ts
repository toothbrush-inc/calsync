import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { CALSYNC_STORE } from "../capability.js";
import { loadScanGateLimits } from "../config.js";
import { ScanGate } from "../scanlimit.js";
import { CALSYNC_VERSION, createAuthRuntime } from "../runtime.js";
import { createMcpProgressSink } from "./progress.js";
import {
  handleAddCalendar,
  handleAddExclusion,
  handleConnectAccount,
  handleConnectProvider,
  handleGetStatus,
  handleListCalendars,
  handleListExclusions,
  handleRemoveCalendar,
  handlePreviewSync,
  handleRemoveExclusion,
  handleSyncNow,
  toJsonPayload,
  type McpRuntime,
  type ToolResult,
} from "./tools.js";

const exclusionInputSchema = z.object({
  keys: z.array(z.string()).optional().describe("Opaque occurrence or series keys"),
  keywords: z
    .array(z.string())
    .optional()
    .describe("Case-insensitive title substrings; requires from"),
  from: z
    .string()
    .optional()
    .describe("Calendar whose events the keywords hold back, as get_status names it"),
});

export function createCalsyncMcpServer(runtime: McpRuntime): McpServer {
  const server = new McpServer(
    { name: "calsync", version: CALSYNC_VERSION },
    {
      instructions:
        `${CALSYNC_STORE.name}: ${CALSYNC_STORE.tagline ?? "calendar sync tools"} ` +
        "Results are JSON counts, calendar names and opaque keys only. Never expect event titles, attendees, or Google tokens unless include_source_titles is explicitly true. Calendars are named '<google account email>' (that account's own calendar) or '<email>/<calendar name>'. To add one: connect_account (returns a URL for the person; never pass tokens or API keys), then list_calendars with available=true, then add_calendar. Up to six calendars sync; each shares its busy time with the others, receives theirs as private Busy blocks, or both.",
    },
  );

  server.registerTool(
    "get_status",
    {
      description:
        "Check every Google sign-in and synced calendar, and return last sync aggregates. JSON only; no tokens or titles.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => jsonResult(await handleGetStatus(runtime)),
  );

  server.registerTool(
    "connect_provider",
    {
      description:
        "Re-authorize one of the two original sign-ins (personal or work). To add another Google account use connect_account. Returns { url, expires_at } for the browser consent page. Never pass API keys, tokens, or client secrets. After the user finishes in the browser, call get_status.",
      inputSchema: z.object({
        provider: z.literal("google").describe("Only google is supported on this server"),
        slot: z.enum(["personal", "work"]).describe("Which Google account to connect"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input) => jsonResult(await handleConnectProvider(runtime, input)),
  );

  server.registerTool(
    "connect_account",
    {
      description:
        "Start signing in another Google account. Returns { url } for the person to open; they pick the account at Google. Never pass API keys, tokens, or client secrets. Afterwards call get_status, then list_calendars with available=true and add_calendar.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => jsonResult(await handleConnectAccount(runtime)),
  );

  server.registerTool(
    "list_calendars",
    {
      description:
        "List synced calendars and what each does. With available=true, also every calendar the signed-in accounts can see, named the way add_calendar takes it, and whether it can receive busy blocks.",
      inputSchema: z.object({
        available: z.boolean().optional().describe("Also list calendars that could be added"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ available }) =>
      jsonResult(await handleListCalendars(runtime, available === undefined ? {} : { available })),
  );

  server.registerTool(
    "add_calendar",
    {
      description:
        "Sync one more calendar (up to six). calendar is '<email>' for that account's own calendar or '<email>/<calendar name>'. By default it shares its busy time and receives the others'; share_only for a calendar that can't be written, receive_only to keep its own events private.",
      inputSchema: z.object({
        calendar: z.string().describe("'<email>' or '<email>/<calendar name>'"),
        share_only: z.boolean().optional().describe("Share its busy time; write no blocks to it"),
        receive_only: z
          .boolean()
          .optional()
          .describe("Receive busy blocks; share none of its own busy time"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => jsonResult(await handleAddCalendar(runtime, input)),
  );

  server.registerTool(
    "remove_calendar",
    {
      description:
        "Stop syncing a calendar. Runs one pass that deletes the busy blocks calsync wrote to it and the blocks its events put on the others. keep_blocks, for a calendar calsync can no longer reach, leaves the blocks on it and cleans up only the others.",
      inputSchema: z.object({
        calendar: z.string().describe("The calendar as get_status names it"),
        keep_blocks: z.boolean().optional().describe("Leave the busy blocks on it in place"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input) => jsonResult(await handleRemoveCalendar(runtime, input)),
  );

  server.registerTool(
    "preview_sync",
    {
      description:
        "Dry-run one reconciliation. Returns counts by destination calendar and operation. Source titles are omitted unless include_source_titles is true. Reports progress while waiting for the reconcile lock, listing calendars, and reconciling.",
      inputSchema: z.object({
        include_source_titles: z
          .boolean()
          .optional()
          .describe("DANGEROUS. Include private source titles. Default false."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ include_source_titles }, extra) =>
      jsonResult(
        await handlePreviewSync(
          runtime,
          include_source_titles === undefined ? {} : { include_source_titles },
          { onProgress: createMcpProgressSink(extra), signal: extra.signal },
        ),
        include_source_titles === true,
      ),
  );

  server.registerTool(
    "add_exclusion",
    {
      description:
        "Exclude keywords and/or opaque keys from mirroring. Keywords require from: the calendar whose events they hold back.",
      inputSchema: exclusionInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (input) => jsonResult(handleAddExclusion(runtime, input)),
  );

  server.registerTool(
    "sync_now",
    {
      description: "Run one live reconciliation pass and return JSON counts. No titles or tokens.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async () => jsonResult(await handleSyncNow(runtime)),
  );

  server.registerTool(
    "list_exclusions",
    {
      description:
        "List CLI and .env exclusions as JSON. Keywords and opaque keys only; no titles.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    () => jsonResult(handleListExclusions(runtime)),
  );

  server.registerTool(
    "remove_exclusion",
    {
      description:
        "Stop excluding keywords and/or opaque keys. Keywords require from: the calendar they were added for.",
      inputSchema: exclusionInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (input) => jsonResult(handleRemoveExclusion(runtime, input)),
  );

  return server;
}

export interface RunMcpStdioServerOptions {
  transport?: Transport;
  closed?: Promise<void>;
}

export async function runLiveMcpStdioServer(): Promise<void> {
  const runtime = createAuthRuntime();
  try {
    // An assistant can call the full-window passes in a loop, so the gate
    // that bounds them matters more here than behind a dashboard button.
    // It shares `sync_state` with `calsync web`, so one allowance covers both.
    const connectUrl = process.env["CALSYNC_WEB_CONNECT_URL"]?.trim();
    await runMcpStdioServer({
      ...runtime,
      scanGate: new ScanGate(runtime.state, loadScanGateLimits()),
      ...(connectUrl === undefined || connectUrl === "" ? {} : { connectUrl }),
    });
  } finally {
    runtime.auth.cancelPendingConnects();
    runtime.state.close();
  }
}

export async function runMcpStdioServer(
  runtime: McpRuntime,
  options: RunMcpStdioServerOptions = {},
): Promise<void> {
  const server = createCalsyncMcpServer(runtime);
  const transport = options.transport ?? new StdioServerTransport();
  process.stderr.write("calsync mcp: listening on stdio\n");
  await server.connect(transport);
  try {
    await (options.closed ?? waitForStdioShutdown());
  } finally {
    await server.close();
  }
}

function waitForStdioShutdown(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      process.stdin.off("end", done);
      process.stdin.off("close", done);
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.stdin.once("end", done);
    process.stdin.once("close", done);
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

function jsonResult<T>(result: ToolResult<T>, allowTitles = false): CallToolResult {
  logToolOutcome(result);
  if (!result.ok) {
    const payload = toJsonPayload({ error: result.error });
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  }
  const payload = toJsonPayload(result.data, allowTitles);
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function logToolOutcome<T>(result: ToolResult<T>): void {
  if (result.ok) {
    return;
  }
  process.stderr.write(`calsync mcp: ${result.error.code}\n`);
}
