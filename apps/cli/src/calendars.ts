import { createHash } from "node:crypto";

import type { CalendarKey } from "@calsync/engine";

import type { AppCalendar, AppConfig } from "./config.js";
import type { CalendarRecord, GoogleAccountRecord } from "./storage/database.js";

/**
 * The key a newly connected calendar gets, from its resolved Google id.
 * Stable, so removing a calendar and adding it back finds the busy blocks,
 * sync state and exclusion keys it had; opaque, so the id never shows up in
 * block keys or logs. The two original calendars keep "personal" and "work".
 */
export function calendarKeyFor(resolvedCalendarId: string): CalendarKey {
  const digest = createHash("sha256")
    .update(`calsync-calendar-key\0${resolvedCalendarId.trim().toLowerCase()}`)
    .digest("hex");
  return `cal-${digest.slice(0, 12)}`;
}

/**
 * How a person sees a calendar: its Google account and its name. A primary
 * calendar is named after the account, so the account alone says it.
 */
export function calendarLabel(
  calendar: Pick<CalendarRecord, "key" | "account" | "calendarId" | "name">,
  accounts: readonly Pick<GoogleAccountRecord, "slot" | "email">[],
): string {
  const email = accounts.find((account) => account.slot === calendar.account)?.email ?? null;
  const name = calendar.name ?? (calendar.calendarId === "primary" ? null : calendar.calendarId);
  if (email === null) {
    // Signed in before calsync kept emails, and not checked since.
    return name === null || name === "primary" ? calendar.key : `${calendar.key} (${name})`;
  }
  if (name === null || name.toLowerCase() === email || calendar.calendarId === email) {
    return email;
  }
  return `${email} / ${name}`;
}

/** Labels for every calendar, by key, for output that names calendars. */
export function calendarLabels(
  calendars: readonly CalendarRecord[],
  accounts: readonly GoogleAccountRecord[],
): Map<CalendarKey, string> {
  return new Map(calendars.map((calendar) => [calendar.key, calendarLabel(calendar, accounts)]));
}

export class CalendarRefError extends Error {
  override readonly name = "CalendarRefError";
}

/**
 * The connected calendar a person means. Accepts its key, its Google id, its
 * label, `<email>` for that account's primary calendar, or `<email>/<name>`
 * (names compare case-insensitively; spaces around the slash are fine).
 */
export function resolveCalendarRef(
  ref: string,
  calendars: readonly CalendarRecord[],
  accounts: readonly GoogleAccountRecord[],
): CalendarRecord {
  const wanted = ref.trim().toLowerCase();
  const matches = calendars.filter((calendar) => {
    const label = calendarLabel(calendar, accounts).toLowerCase();
    if (
      calendar.key === wanted ||
      calendar.calendarId.toLowerCase() === wanted ||
      label.replaceAll(/\s*\/\s*/gu, "/") === wanted.replaceAll(/\s*\/\s*/gu, "/")
    ) {
      return true;
    }
    const email = accounts.find((account) => account.slot === calendar.account)?.email;
    if (email === null || email === undefined) {
      return false;
    }
    const slash = wanted.indexOf("/");
    if (slash < 0) {
      return wanted === email && calendar.calendarId.toLowerCase() === email;
    }
    const name = wanted.slice(slash + 1).trim();
    return (
      wanted.slice(0, slash).trim() === email &&
      (calendar.name?.toLowerCase() === name || calendar.calendarId.toLowerCase() === name)
    );
  });
  const [only, ...others] = matches;
  if (only === undefined) {
    const known = calendars.map((calendar) => calendarLabel(calendar, accounts));
    throw new CalendarRefError(
      known.length === 0
        ? `No calendar matches "${ref}"; none are connected yet`
        : `No calendar matches "${ref}"; connected: ${known.join(", ")}`,
    );
  }
  if (others.length > 0) {
    throw new CalendarRefError(`"${ref}" matches more than one calendar; use its key instead`);
  }
  return only;
}

/** The signed-in account a person means: its email or its slot. */
export function resolveAccountRef(
  ref: string,
  accounts: readonly GoogleAccountRecord[],
): GoogleAccountRecord {
  const wanted = ref.trim().toLowerCase();
  const account = accounts.find(
    (candidate) => candidate.email === wanted || candidate.slot === wanted,
  );
  if (account === undefined) {
    const known = accounts.map((candidate) => candidate.email ?? candidate.slot);
    throw new CalendarRefError(
      known.length === 0
        ? `No Google account matches "${ref}"; none are signed in yet`
        : `No Google account matches "${ref}"; signed in: ${known.join(", ")}`,
    );
  }
  return account;
}

/**
 * A tenant's synced calendars: the ones it has connected. Only a tenant that
 * has never signed in falls back to the two environment calendars, which
 * `calsync auth personal|work` connects — one that removed its calendars
 * stays without them.
 */
export function withStoredCalendars(
  config: AppConfig,
  calendars: readonly CalendarRecord[],
  accounts: readonly GoogleAccountRecord[],
): AppConfig {
  if (calendars.length === 0 && accounts.length === 0) {
    return config;
  }
  return { ...config, calendars: calendars.map(appCalendar) };
}

function appCalendar(calendar: CalendarRecord): AppCalendar {
  return {
    key: calendar.key,
    account: calendar.account,
    calendarId: calendar.calendarId,
    source: calendar.source,
    destination: calendar.destination,
  };
}

/** Whether two calendar lists sync the same calendars the same way, in any order. */
export function sameCalendarSet(
  left: readonly AppCalendar[],
  right: readonly AppCalendar[],
): boolean {
  const shape = (calendars: readonly AppCalendar[]) =>
    JSON.stringify(
      [...calendars]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map(({ key, account, calendarId, source, destination }) => [
          key,
          account,
          calendarId,
          source,
          destination,
        ]),
    );
  return shape(left) === shape(right);
}
