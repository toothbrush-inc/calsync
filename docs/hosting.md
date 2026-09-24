# Hosting calsync for more than one person

One daemon can serve many people on one host, each fully isolated, with a
signed-link onboarding dashboard for connecting calendars and confirming that
sync is live. Everything here is optional: a single-user laptop install needs
none of it.

## Multiple tenants

`CALSYNC_TENANT_ID` names the tenant a process works for (lowercase letters,
digits, and hyphens, starting with a letter). It defaults to `default`, which
keeps all state exactly where a single-user install already has it, so
upgrading changes nothing.

Tenants share the state database but are fully isolated inside it: accounts,
event mappings, sync tokens, exclusions, watch channels, lock files, and OAuth
refresh tokens are all scoped per tenant. Auth-related commands accept
`--tenant <id>` (or the `<tenant>/<role>` argument form):

```sh
calsync auth acme/personal
calsync status --tenant acme
calsync exclude add --tenant acme --from work --keyword confidential
```

`calsync start` discovers every tenant with both accounts authorized and syncs
them all from one process — one webhook receiver, one poll timer, one launchd
service. Discovery re-runs before every pass, so a tenant who signs up while
the daemon is running is picked up on the next pass. A push notification wakes
only the tenant whose calendar changed; the backstop timer covers everyone.
Window, timezone, and cadence come from the shared environment, while each
tenant's calendar IDs are the ones recorded when its accounts were authorized.
`CALSYNC_TENANT_ID` names the tenant that one-shot commands (`sync --once`,
`rebuild`, `cleanup`) and unprefixed auth commands act on; the daemon serves
every tenant regardless of it.

Tenants in different timezones are fine: mirrored blocks copy each source
event's own start, end, and timezone, event identity is canonicalized to UTC
instants, and the rolling window is bounded by absolute instants. The shared
`CALSYNC_TIMEZONE` only shapes how Google formats API responses.

### One calendar pair, one tenant

Two tenants on the same pair would mirror every event twice and see each
other's busy blocks as strays, so the connection that would complete an
already-synced pair is refused: the account is not recorded, the tenant never
becomes ready, and the daemon never adopts it. This is the usual result of one
person signing in under a second email; they should open the first tenant's
dashboard instead, or map both emails to it with
`CALSYNC_WEB_IDENTITY_TENANTS`.

The comparison uses a SHA-256 fingerprint of each validated calendar, stored
with the account row, so sharing one calendar between tenants (a family
calendar mirrored against two different work calendars) stays allowed. Two
tenants that already share a pair from before this check are left running and
reported instead: `calsync status` names the other tenant, and the dashboard
shows a warning without naming it.

## Onboarding dashboard

`calsync web` serves a small dashboard where a person sees their connected
calendars (with links into Google Calendar), connects a missing one, checks
that syncing is actively running, and manages exclusions. It shows
privacy-safe data — counts, timestamps, the keywords they chose, and opaque
keys — and event titles only in a dry-run preview they ask for. Its status
check doubles as brokered onboarding: a passing validation records the
tenant's accounts, which is what makes the daemon adopt them.

Everything below the two calendars and the sync status lives under a collapsed
"Advanced" block.

- **Exclusions** mirror `calsync exclude` and the MCP exclusion tools. Each
  direction lists its keywords and excluded events with its own keyword box;
  `.env` entries are read-only, CLI-managed ones have a remove button, and a
  paste box takes opaque keys. `GET /api/exclusions` returns the
  `exclude list` snapshot; `POST /api/exclusions` takes
  `{ action: "add" | "remove", keys?, keywords?, from? }`.
- **Preview a sync** is `sync --once --dry-run --verbose`: `POST /api/preview`
  runs one dry run and lists every source event in the window with its title,
  time, whether it repeats, and whether it would be mirrored or is already
  excluded, with Exclude / Exclude series / Include again buttons. This is the
  one place the dashboard shows titles: only in answer to that deliberate
  same-origin request, never cached, logged, or included in `/api/status`.
- **Prune duplicates** is `calsync dedupe`: `POST /api/dedupe` with `{}` lists,
  per calendar and by time only, every managed Busy block no live source event
  stands behind, marked duplicate or phantom; `{ apply: true }` deletes them.
  Only calsync's own blocks are considered and every mirror of a live event is
  kept.

Both writes sit behind the same same-origin JSON lock as connect, and answer
409 while a live pass holds the sync lock.

### Access modes

- **Without `CALSYNC_WEB_SECRET`** the server is single-tenant (the env
  tenant) and binds loopback — the local setup companion. There is no cookie
  in this mode, so every request must also carry a loopback `Host`
  (`localhost`, `127.0.0.1`, `[::1]`, or the bound address); anything else is
  answered 421. That is what stops a DNS-rebound page, which looks
  same-origin to the browser, from reading the preview or changing exclusions.
- **With `CALSYNC_WEB_SECRET`**, a person needs a signed tenant link:
  `calsync web link <tenant> [--ttl <days>]` mints
  `https://<base>/?t=link.<tenant>.<expires>.<hmac>` (7 days by default).
  Opening it sets a six-month session cookie and drops the token from the URL.
  Front the server with a reverse proxy for TLS.
- **Behind a proxy that signs people in itself**, set
  `CALSYNC_WEB_IDENTITY_HEADER` to the header it fills with the verified email
  (`x-forwarded-user` under the gateway's `forward_auth`) and no link is
  needed: the email names the tenant, via `CALSYNC_WEB_IDENTITY_TENANTS`
  (`you@example.com=default`) or a stable hash of the address (`i` + the first
  32 hex characters of SHA-256 of the lowercased email).
  `calsync web identity <email>` prints that hash. **The proxy must strip any
  client-supplied copy of that header**; never set this on a server that is
  reachable directly.

Connect buttons run calsync's own OAuth flow locally, or, when
`CALSYNC_WEB_CONNECT_URL` is set, send the user to that URL with `{slot}`,
`{tenant}`, and `{role}` substituted. "Actively syncing" means both calendars
validate and a daemon currently holds the daemon lock on this host.

## How often the expensive passes may run

"Preview a sync" and "Check for stray blocks" — and the MCP `preview_sync` and
`sync_now` behind them — each read both calendars end to end and hold the
tenant's reconcile lock while they do. Nothing about that is cheap to repeat,
and on a hosted host a person clicking, or an assistant looping, would keep
that tenant's real sync waiting behind them.

Three settings bound it, cheapest first:

| Setting                              | Default | What it does                                                                                                     |
| ------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `CALSYNC_SCAN_CACHE_SECONDS`         | `30`    | Serve the last dry-run result again, at no cost. Inside this window the answer has almost certainly not changed. |
| `CALSYNC_SCAN_MIN_INTERVAL_SECONDS`  | `60`    | Minimum gap between fresh read-only passes.                                                                      |
| `CALSYNC_WRITE_MIN_INTERVAL_SECONDS` | `300`   | Minimum gap between passes that write — a prune, or `sync_now`.                                                  |

A refused request is a `429` carrying `Retry-After` and a `retryAfter` field,
and the dashboard counts the button down rather than showing a failure. Over
MCP the same refusal is `scan_rate_limited` with the seconds in the message, so
an assistant can back off by a stated amount. Each `0` turns that layer off.

The gaps are stored per tenant in the state database, so `calsync web` and
`calsync mcp` — separate processes — share one allowance instead of getting one
each. Applying a prune clears that tenant's cached check, since the blocks it
listed are gone.

**The daemon is never gated.** Its scheduled passes do not go through this, so
throttling the dashboard never slows real syncing. A scan that collides with a
daemon pass waits up to five seconds for the lock and then answers `409`, which
the page offers to retry.

## Push notifications

Set `CALSYNC_WEBHOOK_URL` and the daemon stops waiting on a one-minute timer:
it registers a Google Calendar watch channel per calendar, and Google POSTs to
that address whenever either calendar changes. Typical propagation drops from
up to a minute to a few seconds.

This needs a publicly reachable HTTPS endpoint with a CA-signed certificate
whose subject matches the hostname — a bare IP or self-signed certificate will
not work, so a laptop behind NAT stays on polling. The receiver binds loopback
and expects a reverse proxy in front of it; see
[`deploy/webhook/`](../deploy/webhook/README.md) for Caddy and nginx snippets.

- Notifications carry **no event data** — only which channel changed. Changes
  still arrive through the ordinary incremental sync-token feed, so nothing
  new is persisted beyond channel IDs, a hashed channel token, and an expiry.
- Bursts are debounced (`CALSYNC_WEBHOOK_DEBOUNCE_SECONDS`). Each mirror write
  produces a notification of its own, so the pass after a write is normally a
  cheap no-op.
- Google states notifications are not 100% reliable, so polling never goes
  away: a slower backstop pass (`CALSYNC_WEBHOOK_POLL_INTERVAL_SECONDS`,
  default 15 minutes) and the daily full pass still run.
- Channels expire on Google's schedule and Google never renews them. The
  daemon re-arms between passes, creating the replacement before stopping the
  old one.
- If arming fails, the daemon logs `webhook_arm_failed` and falls back to
  `CALSYNC_POLL_INTERVAL_SECONDS` until the next attempt succeeds. The same
  holds for the receiver: if its port can't be bound at startup, the daemon
  polls and retries each round, logging each distinct failure once.
- `calsync cleanup` stops every armed channel, so leaving calsync does not
  leave Google posting to a dead endpoint.

`get_status` reports `push.configured` and each channel's expiry. Daemon logs
carry `webhook_listening`, `webhook_channel_armed`, `webhook_notification`,
and a `trigger` field (`startup`, `webhook`, `scheduled`) on every
`reconcile_complete`. The channel token is never logged or persisted in the
clear.

## The OAuth callback listener

Normally calsync opens an ephemeral loopback port on 127.0.0.1 for the
duration of one consent, which is what a Desktop OAuth client expects. Set
`CALSYNC_CONNECT_BASE_URL` only where consent has to return through a public
address; calsync then holds a fixed per-role port
(`CALSYNC_CONNECT_PORT_PERSONAL`, `CALSYNC_CONNECT_PORT_WORK`, default 8801 and 8802) and advertises `<base>/oauth2callback/<role>`, which must be a
registered redirect URI on the OAuth client.

That mode binds `0.0.0.0` by default, so the raw port answers on every
interface. Put the reverse proxy on the same host and pin the listener to
loopback with `CALSYNC_CONNECT_BIND_HOST=127.0.0.1`.

## Capability grants and the gateway

calsync is a capability on the shared local vault. Its manifest
([`apps/cli/capability.json`](../apps/cli/capability.json)) declares the two
Google connections it may use. `calsync auth personal|work` stores the refresh
token in the vault and registers a grant (`calsync:google:personal|work`);
`calsync logout` removes both. Token reads go through
`getSecretFor("calsync", ...)`. The default `VAULT_GRANT_MODE=auto` never
blocks on a laptop; `VAULT_GRANT_MODE=explicit` enforces the grant rows and is
useful for hosted-like testing — a missing grant then surfaces as "connected
but not granted to calsync; run calsync auth <role> to re-grant". The full
contract is in the vault repo's
[CAPABILITY.md](https://github.com/toothbrush-inc/toy-box-vault/blob/main/CAPABILITY.md).

Under the [capability gateway](https://github.com/toothbrush-inc/toy-box-gateway),
calsync also uses the broker's **OAuth token exchange**: when the gateway
hands the process an egress endpoint (`VAULT_EGRESS_URL`/`TOKEN`), Google API
clients mint short-lived access tokens from the broker (`POST /token`) and
this process never reads the refresh token — so calsync can run with the
gateway's `secretsAccess: "broker"` mode. The gateway needs
`oauth.google.envFile` pointing at this repo's `.env`. Standalone runs are
unchanged. The `auth`/connect flow always runs in-process (it writes the
refresh token into the vault); Google-side revocation during `logout` is
skipped when the token is unreadable in broker mode — revoke from your Google
account settings if needed.

Mount calsync with one entry in the gateway's `gateway.config.json`; point
`cwd` at this checkout so `.env` loads, and build first:

```json
{
  "id": "calsync",
  "command": "node",
  "args": ["apps/cli/dist/cli.js", "mcp"],
  "cwd": "/path/to/calsync",
  "manifestPath": "/path/to/calsync/apps/cli/capability.json",
  "secretsAccess": "broker",
  "denyTools": ["sync_now"]
}
```

Multi-tenancy works under the broker too: each tenant's short-lived access
tokens are minted from tenant-scoped broker slots (`<tenant>_<role>`; the
default tenant keeps the bare `personal`/`work` slots). The gateway must store
each tenant's Google grants under those same slots. In brokered mode a
`calsync status --tenant <id>` validates both connections and records the
tenant's accounts, after which the daemon picks the tenant up on its next pass.

[`apps/cli/capability.json`](../apps/cli/capability.json) also carries a
`store` block — name, tagline, description, highlights, accent colour, and
repository link — used by the store page and the gateway's status. It has no
`web` path: calsync appears there as an agent-only capability. The gateway's
config can override any field for one deployment without touching this repo.
