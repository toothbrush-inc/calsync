# Configuration

Configuration is loaded from the environment and an untracked `.env` file.
[`.env.example`](../.env.example) documents every setting; this table is the
summary.

| Setting                                     | Default          | Purpose                              |
| ------------------------------------------- | ---------------- | ------------------------------------ |
| `GOOGLE_OAUTH_CLIENT_ID`                    | required         | Your Desktop OAuth client            |
| `GOOGLE_OAUTH_CLIENT_SECRET`                | required         | Your Desktop OAuth client            |
| `CALSYNC_PERSONAL_CALENDAR_ID`              | `primary`        | Personal account's calendar ID       |
| `CALSYNC_WORK_CALENDAR_ID`                  | `primary`        | Work account's calendar ID           |
| `CALSYNC_TENANT_ID`                         | `default`        | Tenant this process syncs            |
| `CALSYNC_DATABASE_PATH`                     | app support dir  | State database location              |
| `CALSYNC_LOG_PATH`                          | `~/Library/Logs` | Daemon log location                  |
| `CALSYNC_POLL_INTERVAL_SECONDS`             | `60`             | Delay between passes without push    |
| `CALSYNC_FULL_SYNC_INTERVAL_HOURS`          | `24`             | Maximum time between full syncs      |
| `CALSYNC_WINDOW_PAST_DAYS`                  | `30`             | Past portion of the rolling window   |
| `CALSYNC_WINDOW_FUTURE_DAYS`                | `365`            | Future portion of the rolling window |
| `CALSYNC_TIMEZONE`                          | system timezone  | Fallback IANA timezone               |
| `CALSYNC_LOG_MAX_BYTES`                     | `5242880`        | Current daemon log size limit        |
| `CALSYNC_LOG_BACKUPS`                       | `5`              | Rotated daemon logs retained         |
| `CALSYNC_EXCLUDE_PERSONAL_TO_WORK`          | empty            | Extra personal-source opaque keys    |
| `CALSYNC_EXCLUDE_WORK_TO_PERSONAL`          | empty            | Extra work-source opaque keys        |
| `CALSYNC_EXCLUDE_PERSONAL_TO_WORK_KEYWORDS` | empty            | Extra personal-title substrings      |
| `CALSYNC_EXCLUDE_WORK_TO_PERSONAL_KEYWORDS` | empty            | Extra work-title substrings          |

Push notifications (`CALSYNC_WEBHOOK_*`), the dashboard (`CALSYNC_WEB_*`), and
the OAuth callback listener (`CALSYNC_CONNECT_*`) are covered in
[hosting.md](hosting.md).

Refresh tokens stay in the macOS Keychain or the local vault. SQLite stores
account metadata, opaque mappings, sync tokens, CLI exclusions, and
privacy-safe aggregates — never event contents.

## Google OAuth credentials

1. Create or select a project in
   [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **Google Calendar API** under **APIs & Services → Library**.
3. Configure the OAuth consent screen. Add both account addresses as test
   users while the app is in Testing status.
4. Create an OAuth client under **APIs & Services → Credentials**. Choose
   **Desktop app**, not Web application.
5. Put the client ID and secret in your untracked `.env`. Do not commit the
   downloaded JSON.

Leave the calendar IDs as `primary` unless you are using disposable test
calendars, where you copy **Integrate calendar → Calendar ID** from that
calendar's settings. Validate non-secret configuration with
`calsync config check`.

An external OAuth app left in **Testing** generally receives refresh tokens
that expire after seven days. Reauthorize as needed, or move the consent
screen to Production. Google Workspace administrators can block third-party
apps or Calendar writes; if work-account authorization fails, ask the
administrator to trust the OAuth client.

## Exclusions

Prefer title keywords for a category of events, and opaque keys for one event
or one recurring series. Never copy raw Google event IDs. Inspect first:

```sh
calsync sync --once --dry-run --verbose
```

The detailed report includes lines like:

```text
personal → work | one-time event | 2026-08-12T15:00:00-07:00 → 2026-08-12T16:00:00-07:00 | "Dentist" | not excluded
  occurrence only: calsync-exclude:v1:p2w:occ:AbCdEf...
  whole series:    calsync-exclude:v1:p2w:series:XyZ123...
```

Then add several at once. Direction is inferred from each opaque key; keyword
batches take `--from` once. Do not mix keys and keywords in one command.

```sh
calsync exclude add --from personal --keyword dentist,therapy,school pickup
calsync exclude add --from work --keyword confidential,internal
calsync exclude add calsync-exclude:v1:p2w:occ:AbCdEf... calsync-exclude:v1:w2p:series:...

calsync exclude list
calsync exclude remove KEY1 KEY2
calsync exclude remove --from work --keyword confidential,internal
```

`--from personal` means personal → work; `--from work` means the reverse.
Keywords are case-insensitive literal substrings (`plan` matches `planning`),
comma-separated, trimmed, and blanks are ignored — a comma cannot appear
inside a keyword. Add and remove are idempotent.

`exclude list` marks CLI-managed entries `(cli)` and `.env` entries `(.env)`.
Environment lists merge with CLI-managed entries; edit `.env` to change them.
The next pass applies the change, and existing mirrors for newly excluded
events are deleted.
