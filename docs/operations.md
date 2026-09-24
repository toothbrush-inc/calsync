# Running calsync day to day

## The background service

```sh
npm run build
node apps/cli/dist/cli.js service install
node apps/cli/dist/cli.js service status
```

The service polls about once a minute, starts at login, and pauses while the
Mac sleeps. Logs are written to `~/Library/Logs/calsync/calsync.log` with
rotation; manual launchd details are in [`deploy/launchd/`](../deploy/launchd/README.md).

```sh
calsync service start | stop | restart | status | uninstall
calsync service logs --lines 200
calsync service logs --follow
```

Linux runs the CLI and daemon with the local vault, but launchd and the
Keychain fallback are macOS-only: supervise `calsync start` yourself.

## Ongoing checks

Once the service is installed, keep using Google Calendar as usual. New busy
events, moves, and deletions are mirrored automatically. Recurring events are
expanded inside the rolling window, and mirrors that age out of it are
removed.

```sh
calsync status
calsync sync --once --dry-run
calsync service logs --lines 50
```

## After pulling code updates

```sh
git pull && nvm use && npm ci && npm run build
node apps/cli/dist/cli.js service install
```

## Repairs

Reauthorize one role after a revoked or expired token — no stop needed:

```sh
calsync status
calsync auth personal --no-open   # or auth work
```

Rebuild mappings from managed-event metadata if they look wrong. Do not
delete the database first:

```sh
calsync rebuild --dry-run
calsync rebuild
```

Remove stray Busy blocks — an old mirror left by a reinstall, a calendar
switch, or an event Google re-created under a new identity, sitting either
beside its replacement or alone after its event moved or went away. Every
mirror of a live source event is kept, and nothing but calsync's own blocks is
touched:

```sh
calsync dedupe --dry-run
calsync dedupe
```

A prune paces its deletes to stay under Google's limits, starting slower when
there are more than a hundred blocks to remove. If Google still throttles it,
every worker pauses, the pause and the spacing double for next time, and the
block is retried rather than failed. A run that reports failures is safe to
repeat: it only removes what is still there.

## Leaving

```sh
calsync service stop
calsync cleanup --dry-run
calsync cleanup
calsync logout
calsync service uninstall
```

Uninstall removes only the LaunchAgent. Cleanup removes managed Busy mirrors
and stops every armed push channel. Logout removes the stored tokens. Never
bulk-delete destination events based only on the title `Busy`.

## Manual acceptance with test calendars

Before enabling writes on primary calendars, use disposable ones:

1. Create one test calendar in each account, set their IDs in `.env`,
   authorize both roles, and run `calsync status`.
2. Add timed, all-day, recurring, transparent, and declined events. Include
   one invitation visible on both accounts.
3. Run `calsync sync --once --dry-run`, then `--verbose` if you need titles.
4. Run `calsync sync --once`. Confirm mirrors are private `Busy` events with
   no guests or reminders. A second dry run should plan no changes.
5. Move and delete sources, and edit or delete mirrors; sync should repair
   from source truth.
6. Exclude one keyword and one opaque key from the verbose dry run; confirm
   those mirrors are removed and not recreated.
7. Preview `calsync cleanup --dry-run`, then run cleanup.
