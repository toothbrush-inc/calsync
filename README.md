<h1 align="center">calsync</h1>

<p align="center"><strong>Mirror your busy time between a personal and a work Google calendar — times only, never details.</strong></p>

<p align="center">
<a href="#quick-start">Quick start</a> ·
<a href="#how-it-works">How it works</a> ·
<a href="#privacy">Privacy</a> ·
<a href="#commands">Commands</a> ·
<a href="#documentation">Docs</a>
</p>

---

Work can't see personal. Personal can't see work. The booking dialog in front
of you doesn't care — which is how a dentist appointment and a staff meeting
end up in the same hour.

calsync closes that gap without handing either calendar to the other. Every
busy event on one becomes a private `Busy` block on the other, in both
directions. Scheduling tools see when you're free; nobody sees why.

- **Privacy is the design, not a setting.** Mirrors carry start and end times
  and nothing else. Titles, descriptions, locations, attendees, and conference
  links never cross. No reminders or guest notifications are ever sent.
- **Keep some things out entirely.** Exclude a category by title keyword
  ("therapy", "confidential"), or one event or series by an opaque key.
  Excluded events never get a mirror, and existing ones are removed.
- **Your machine, your keys.** Refresh tokens live in the macOS Keychain or
  your local vault, and Google only ever talks to your own OAuth client.
- **Fast when it can be.** With a public HTTPS endpoint, Google pushes changes
  and mirrors land in seconds; otherwise calsync polls every minute. A daily
  full pass repairs anything that drifted.
- **Talks to your AI tools.** `calsync mcp` lets Cursor or Claude Desktop check
  status, preview a sync, and manage exclusions from chat — counts and opaque
  keys only, never event contents.
- **Safe to leave.** Every write has a dry run. `calsync cleanup` removes only
  the mirrors it created, and your calendars are as you found them.

Sync is polling or push-backed, not a transactional lock across two Google
accounts, so a booking that lands between passes can still collide until the
next update.

## Quick start

You need macOS, Node.js 24, and two Google accounts. Setup takes about fifteen
minutes, most of it in Google Cloud Console.

```sh
git clone https://github.com/toothbrush-inc/calsync.git
cd calsync
nvm use && npm ci && npm run build
cp .env.example .env          # add your Google OAuth client ID and secret

npm run dev -- auth personal   # opens a browser to consent
npm run dev -- auth work
npm run dev -- status

npm run dev -- sync --once --dry-run   # see what would change, no writes
npm run dev -- sync --once             # do it

node apps/cli/dist/cli.js service install   # keep it running at login
```

That's the whole loop. Creating the OAuth client is covered in
[docs/configuration.md](docs/configuration.md); testing on disposable
calendars first is in [docs/operations.md](docs/operations.md).

`npm test` runs right after `npm install`, but `npm run dev` needs
`npm run build` first so `@calsync/engine` has a `dist/`.

Linux runs the CLI and daemon; launchd and the Keychain fallback are
macOS-only, so supervise `calsync start` yourself there.

### Or don't run it yourself

calsync is also offered hosted at `https://toys.thephotobase.com`: sign in
once, connect both Google accounts from the onboarding page, nothing to
install. That deployment's broker holds the refresh tokens and hands calsync
only short-lived access tokens. It is run by one person and may become a paid
service; the code here is free either way, and both run the same calsync.

## How it works

```text
  personal calendar                                  work calendar
  ┌──────────────────────┐                          ┌──────────────────────┐
  │ Dentist  15:00–16:00 │ ──── mirror as ────────▶ │ Busy     15:00–16:00 │
  │ Busy     09:00–09:30 │ ◀─── mirror as ───────── │ Standup  09:00–09:30 │
  └──────────────────────┘                          └──────────────────────┘
                     ▲                                 ▲
                     └───────── calsync daemon ────────┘
                         (your Mac, your OAuth client)
```

1. You authorize two Google accounts, `personal` and `work`, with your own
   OAuth client. Tokens never leave your machine.
2. calsync reads busy events inside a rolling window (30 days back, 365 ahead)
   and writes a private `Busy` block the other way for each one.
3. A background service keeps them in step: push notifications when
   available, polling otherwise, and a full reconciliation every day.
4. Transparent ("available") events, declined invitations, excluded events,
   and invitations already on both calendars are skipped.

## Privacy

Mirrors contain only `Busy`, start/end times, private visibility, and opaque
transparency. Verbose dry-run output — in the terminal or the dashboard's
on-demand preview — is the only place titles are shown, and they are not
stored in SQLite or in daemon logs.

This still discloses that the time is busy:

- Destination owners and Workspace administrators can see private Busy blocks
  and their time ranges.
- Google receives the API traffic.
- Anyone with access to this account on this machine can inspect local
  configuration, logs, and database metadata.
- With push notifications configured, Google also learns your receiver's
  address.

## Commands

```sh
calsync status                        # both accounts and calendar access
calsync sync --once --dry-run         # plan a pass, write nothing
calsync sync --once                   # run one pass
calsync exclude list                  # what never gets mirrored
calsync service logs --follow         # what the daemon is doing
calsync dedupe --dry-run              # find stray Busy blocks
calsync cleanup --dry-run             # preview removing every mirror
```

`--dry-run` requires `--once`. During development, prefix with
`npm run dev --` after a build; afterwards `node apps/cli/dist/cli.js` works
too. Full command reference: `calsync --help`.

## Documentation

- [Configuration](docs/configuration.md) — OAuth setup, every setting,
  exclusions
- [Operations](docs/operations.md) — the background service, repairs,
  uninstalling, acceptance testing
- [Assistants](docs/assistants.md) — `calsync mcp` for Cursor and Claude
  Desktop
- [Hosting](docs/hosting.md) — multiple tenants, the onboarding dashboard,
  push notifications, capability grants

## Development

```sh
npm run typecheck && npm run lint && npm run format:check && npm test
```

The pure sync engine lives in `packages/engine`; Google, storage, CLI, MCP,
and web adapters live in `apps/cli`. See [CONTRIBUTING.md](CONTRIBUTING.md)
and, for vulnerability reports, [SECURITY.md](SECURITY.md).

Each tenant is intentionally limited to one personal and one work calendar.
Multi-calendar sync within a tenant is not implemented.

## License

[MIT](LICENSE).
