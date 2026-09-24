# Use calsync from an assistant

calsync runs as a **local stdio MCP server**, so Cursor or Claude Desktop can
check status, preview a sync, and manage exclusions from chat. The process
uses the shared local vault ([`@dvd-toy-box/vault`](https://github.com/toothbrush-inc/toy-box-vault),
Keychain on macOS), SQLite, and `@calsync/engine` on this machine. There is no
hosted MCP endpoint.

Tool results are JSON counts and opaque keys. Google tokens, titles,
descriptions, and attendees are never returned unless you explicitly set
`include_source_titles` on `preview_sync` (default off).

## Setup

Build first, then add a server to Cursor's `mcp.json` (project
`.cursor/mcp.json` or `~/.cursor/mcp.json`). Set `cwd` to this repository so
`.env` loads:

```json
{
  "mcpServers": {
    "calsync": {
      "command": "node",
      "args": ["/absolute/path/to/calsync/apps/cli/dist/cli.js", "mcp"],
      "cwd": "/absolute/path/to/calsync"
    }
  }
}
```

After `npm run build` and `npm link` from the repo root, `"command": "calsync"`
with `"args": ["mcp"]` works too. Claude Desktop uses the same
`command` / `args` / `cwd` in
`~/Library/Application Support/Claude/claude_desktop_config.json`. Logs go to
stderr only; do not point stdout at a log file.

Authorize from chat with `connect_provider` (`provider=google`,
`slot=personal|work`). It returns a browser URL — never pass a token or API
key. After consent, `get_status` shows authorized. `calsync auth` is the same
flow from the terminal.

## Tools

| Tool               | What it does                                                              | Reads / writes                            |
| ------------------ | ------------------------------------------------------------------------- | ----------------------------------------- |
| `get_status`       | Auth state, calendar writability, and last-sync aggregates                | Reads                                     |
| `connect_provider` | Starts Google consent for `personal` or `work` and returns a browser URL  | Writes a token to the vault after consent |
| `preview_sync`     | Dry-runs one reconciliation and returns counts by direction and operation | Reads                                     |
| `sync_now`         | Runs one live reconciliation pass and returns counts                      | Writes mirrors                            |
| `list_exclusions`  | Lists keyword and opaque-key exclusions                                   | Reads                                     |
| `add_exclusion`    | Excludes keywords or opaque keys from mirroring                           | Writes exclusions                         |
| `remove_exclusion` | Stops excluding keywords or opaque keys                                   | Writes exclusions                         |

Only `preview_sync` can return titles, and only when `include_source_titles`
is explicitly true. The gateway config in [hosting.md](hosting.md) denies
`sync_now`, so an assistant can preview while the daemon does the writing.

## When `preview_sync` is slow

`preview_sync` is a full-window Google dry run, not an incremental poll. With
many source events it can outlast a typical MCP `tools/call` timeout
(~30–60s). Cursor's `mcp.json` schema has no per-server `timeout` field, so a
longer deadline cannot be set there. The server sends
`notifications/progress` when the client supplies `_meta.progressToken`
(waiting for the reconcile lock, listing calendars, reconciling); clients that
reset their timeout on progress can wait out a large dry run.

`preview_sync` waits on the reconcile lock (`<state db>.lock`), not the daemon
instance lock. `calsync start` holds the daemon lock for the process lifetime
and takes the reconcile lock only for each pass, which an incremental poll
should release in about a second.

If it still times out, launchd may be running a pre-workspace `dist/cli.js`
whose `start()` holds the reconcile lock for the process lifetime. Rebuild and
reinstall, which rewrites the plist to `apps/cli/dist/cli.js`:

```sh
npm run build
node apps/cli/dist/cli.js service install
```

Reloading the MCP server alone is not enough: disable and re-enable
**calsync** under Cursor Settings → MCP, or reload the window, so Cursor
respawns the new binary.
