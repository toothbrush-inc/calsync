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
  handleAddExclusion,
  handleConnectProvider,
  handleGetStatus,
  handleListExclusions,
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
  from: z.enum(["personal", "work"]).optional().describe("Source calendar for keywords"),
});

export function createCalsyncMcpServer(runtime: McpRuntime): McpServer {
  const server = new McpServer(
    { name: "calsync", version: CALSYNC_VERSION },
    {
      instructions:
        `${CALSYNC_STORE.name}: ${CALSYNC_STORE.tagline ?? "calendar sync tools"} ` +
        "Results are JSON counts and opaque keys only. Never expect titles, attendees, or Google tokens unless include_source_titles is explicitly true. Use connect_provider to authorize Google (returns a URL; never pass tokens or API keys).",
    },
  );

  server.registerTool(
    "get_status",
    {
      description:
        "Return auth/calendar writability and last sync aggregates. JSON only; no tokens or titles.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => jsonResult(await handleGetStatus(runtime)),
  );

  server.registerTool(
    "connect_provider",
    {
      description:
        "Start connecting a Google account. Returns { url, expires_at } for the browser consent page. Never pass API keys, tokens, or client secrets. After the user finishes in the browser, call get_status.",
      inputSchema: z.object({
        provider: z.literal("google").describe("Only google is supported on this server"),
        slot: z.enum(["personal", "work"]).describe("Which Google account to connect"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input) => jsonResult(await handleConnectProvider(runtime, input)),
  );

  server.registerTool(
    "preview_sync",
    {
      description:
        "Dry-run one reconciliation. Returns counts by direction/operation. Source titles are omitted unless include_source_titles is true. Reports progress while waiting for the reconcile lock, listing calendars, and reconciling.",
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
        "Exclude keywords and/or opaque keys from mirroring. Keywords require from=personal|work.",
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
        "Stop excluding keywords and/or opaque keys. Keywords require from=personal|work.",
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
    await runMcpStdioServer({
      ...runtime,
      scanGate: new ScanGate(runtime.state, loadScanGateLimits()),
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
