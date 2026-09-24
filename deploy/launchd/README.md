# macOS launchd service

The LaunchAgent runs `calsync start` after login and keeps the polling process
alive. **Do not install it until the README's test-calendar dry run and manual
acceptance checks pass.** It runs only while the user is logged in, and sync
pauses while the Mac sleeps.

## Recommended setup

From the source checkout:

```sh
nvm use
npm ci
npm run build
chmod 600 .env
node apps/cli/dist/cli.js service install
node apps/cli/dist/cli.js service status
```

The installer:

- requires macOS, the current absolute Node.js 24 executable, a stable project
  root, and an existing `.env`;
- rebuilds a source checkout and verifies `apps/cli/dist/cli.js`;
- creates `~/Library/Logs/calsync` with private permissions;
- generates an XML-escaped
  `~/Library/LaunchAgents/com.local.calsync.plist` and validates it with
  `plutil`;
- safely unloads an existing copy before replacing and bootstrapping it in the
  current user's `gui/<uid>` launchd domain.

The plist contains no `.env` values. It runs the exact Node executable with
`apps/cli/dist/cli.js start`, sets the checkout as its working directory so `dotenv`
loads the untracked `.env`, enables `RunAtLoad` and `KeepAlive`, and directs
launchd stdout/stderr to `/dev/null`. The app writes privacy-safe structured
records to the private log directory with bounded rotation.

## Daily operations

```sh
node apps/cli/dist/cli.js service start
node apps/cli/dist/cli.js service stop
node apps/cli/dist/cli.js service restart
node apps/cli/dist/cli.js service status
node apps/cli/dist/cli.js service logs
node apps/cli/dist/cli.js service logs --lines 200
node apps/cli/dist/cli.js service logs --follow
```

Lifecycle commands clearly handle already-running, already-stopped, and
not-installed states. `logs` tails the last 100 lines from the current
`calsync.log` by default. `--follow` uses filename following across app-managed
rotation; press Ctrl-C to stop viewing logs without stopping the service.
Rotation defaults to 5 MiB with five backups and is configured with
`CALSYNC_LOG_MAX_BYTES` and `CALSYNC_LOG_BACKUPS`.

After pulling an update:

```sh
git pull
nvm use
npm ci
npm run build
node apps/cli/dist/cli.js service install
```

Reinstalling is idempotent: it validates the replacement before unloading the
current definition, then bootstraps the updated service.

## Uninstall and data cleanup

```sh
node apps/cli/dist/cli.js service uninstall
```

Uninstall stops the service and removes only its LaunchAgent plist. It does
not remove `.env`, Keychain OAuth tokens, SQLite state, logs, or managed
calendar events. If desired, remove managed mirror events first with
`calsync cleanup --dry-run` followed by `calsync cleanup`, and remove OAuth
tokens separately with `calsync logout`.

## Troubleshooting

- A missing `.env` or `apps/cli/dist/cli.js` message includes the command needed to
  prepare it. The installer never prints `.env` contents.
- A Node mismatch means the active runtime is not Node.js 24 or the selected
  executable reports a different version. Run `nvm use`, rebuild, and retry.
- A plist validation failure leaves the existing plist untouched. Correct the
  reported path/build issue before retrying.
- A `launchctl` failure includes the failing operation's diagnostic. Check
  that this is an interactive macOS login session and inspect
  `service status` and `service logs`.
- If the checkout or Node installation moves, run `service install` again so
  all absolute paths are regenerated.

The adjacent `com.local.calsync.plist` remains a manual reference template.
For low-level diagnosis, the generated file can be checked with:

```sh
plutil -lint "$HOME/Library/LaunchAgents/com.local.calsync.plist"
launchctl print "gui/$(id -u)/com.local.calsync"
```
