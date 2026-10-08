import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type {
  CalendarKey,
  EventMapping,
  ExclusionSource,
  MappingStore,
  StoredExclusionKey,
  StoredExclusionKeyword,
  SyncStateStore,
} from "@calsync/engine";

import { MAX_CALENDARS, type AccountRole } from "../config.js";

export type { EventMapping, StoredExclusionKey, StoredExclusionKeyword } from "@calsync/engine";

/** A two-calendar-era account: the role's sign-in and its one calendar. */
export interface AccountRecord {
  tenantId: string;
  role: AccountRole;
  calendarId: string;
  authorizedAt: string;
  verifiedAt: string | null;
}

/** One Google sign-in. Its refresh token lives in the vault under `slot`. */
export interface GoogleAccountRecord {
  tenantId: string;
  /** Token slot: "personal" or "work" for the original two, else account1..account6. */
  slot: string;
  /** The account's address, known once a check has read its primary calendar. */
  email: string | null;
  authorizedAt: string;
  verifiedAt: string | null;
}

/** One connected Google calendar and what it does in the sync. */
export interface CalendarRecord {
  tenantId: string;
  key: CalendarKey;
  /** Slot of the sign-in that reads and writes it. */
  account: string;
  calendarId: string;
  /** Google's name for it, for display. */
  name: string | null;
  accessRole: string | null;
  source: boolean;
  destination: boolean;
  addedAt: string;
  verifiedAt: string | null;
}

export interface CalendarInput {
  key: CalendarKey;
  account: string;
  calendarId: string;
  name?: string | null;
  accessRole?: string | null;
  source?: boolean;
  destination?: boolean;
  /** Identifies the calendar across accounts and tenants; see calendarFingerprint. */
  fingerprint?: string | undefined;
}

export type CalendarAddResult = { added: true } | CalendarRefusal;

export type CalendarRefusal =
  /** This tenant already syncs the calendar, under `key`. */
  | { added: false; reason: "duplicate"; key: CalendarKey }
  /** The tenant already has MAX_CALENDARS calendars. */
  | { added: false; reason: "limit" }
  /** Another tenant on this host already syncs it alongside one of this tenant's calendars. */
  | { added: false; reason: "conflict"; tenant: string };

interface CalendarRow {
  tenant_id: string;
  calendar_key: string;
  account_slot: string;
  calendar_id: string;
  name: string | null;
  access_role: string | null;
  source: number;
  destination: number;
  added_at: string;
  verified_at: string | null;
}

interface GoogleAccountRow {
  tenant_id: string;
  slot: string;
  email: string | null;
  authorized_at: string;
  verified_at: string | null;
}

interface AccountRow {
  tenant_id: string;
  role: AccountRole;
  calendar_id: string;
  authorized_at: string;
  verified_at: string | null;
}

interface MappingRow {
  mapping_key: string;
  destination_key: CalendarKey;
  destination_event_id: string;
  destination_etag: string | null;
  updated_at: string;
}

interface ExclusionKeyRow {
  source_key: CalendarKey;
  value: string;
  created_at: string;
}

interface ExclusionKeywordRow {
  source_key: CalendarKey;
  keyword: string;
  created_at: string;
}

export interface WatchChannelRecord {
  tenantId: string;
  calendarKey: CalendarKey;
  calendarId: string;
  channelId: string;
  resourceId: string;
  tokenHash: string;
  address: string;
  expiresAt: string;
  createdAt: string;
}

interface WatchChannelRow {
  tenant_id: string;
  calendar_key: CalendarKey;
  calendar_id: string;
  channel_id: string;
  resource_id: string;
  token_hash: string;
  address: string;
  expires_at: string;
  created_at: string;
}

export class StateDatabase implements MappingStore, SyncStateStore, ExclusionSource {
  private readonly db: Database.Database;
  readonly tenantId: string;

  constructor(path: string, tenantId = "default") {
    this.tenantId = tenantId;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  /**
   * Records a sign-in. A slot signed in again keeps its row and calendars;
   * the email, once known, is never cleared by a later check that lacks it.
   */
  upsertGoogleAccount(
    slot: string,
    email: string | null,
    now = new Date(),
    tenantId?: string,
  ): void {
    const tid = tenantId ?? this.tenantId;
    this.db
      .prepare(
        `INSERT INTO google_accounts (tenant_id, slot, email, authorized_at, verified_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, slot) DO UPDATE SET
           email = COALESCE(excluded.email, google_accounts.email),
           authorized_at = excluded.authorized_at,
           verified_at = excluded.verified_at`,
      )
      .run(tid, slot, normalizeEmail(email), now.toISOString(), now.toISOString());
    this.db
      .prepare("INSERT OR IGNORE INTO signed_in_tenants (tenant_id, first_at) VALUES (?, ?)")
      .run(tid, now.toISOString());
  }

  /**
   * Whether this tenant ever had a sign-in. A tenant that removed all of its
   * own is not new: nothing may sign it back in on its behalf.
   */
  hasSignedIn(tenantId?: string): boolean {
    const tid = tenantId ?? this.tenantId;
    return (
      this.db.prepare("SELECT 1 FROM signed_in_tenants WHERE tenant_id = ?").get(tid) !== undefined
    );
  }

  /**
   * Hands every calendar of one sign-in to another and forgets the first:
   * the same Google account signed in again under a new slot.
   */
  moveGoogleAccount(from: string, to: string, tenantId?: string): void {
    const tid = tenantId ?? this.tenantId;
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE calendars SET account_slot = ? WHERE tenant_id = ? AND account_slot = ?")
        .run(to, tid, from);
      this.deleteGoogleAccount(from, tid);
    })();
  }

  /** Marks a sign-in verified, learning its email when the check found it. */
  verifyGoogleAccount(
    slot: string,
    email: string | null,
    now = new Date(),
    tenantId?: string,
  ): void {
    const tid = tenantId ?? this.tenantId;
    this.db
      .prepare(
        `UPDATE google_accounts SET verified_at = ?, email = COALESCE(?, email)
         WHERE tenant_id = ? AND slot = ?`,
      )
      .run(now.toISOString(), normalizeEmail(email), tid, slot);
  }

  getGoogleAccount(slot: string, tenantId?: string): GoogleAccountRecord | null {
    const tid = tenantId ?? this.tenantId;
    const row = this.db
      .prepare(`${GOOGLE_ACCOUNT_COLUMNS} WHERE tenant_id = ? AND slot = ?`)
      .get(tid, slot) as GoogleAccountRow | undefined;
    return row === undefined ? null : googleAccountFromRow(row);
  }

  findGoogleAccountByEmail(email: string, tenantId?: string): GoogleAccountRecord | null {
    const tid = tenantId ?? this.tenantId;
    const row = this.db
      .prepare(`${GOOGLE_ACCOUNT_COLUMNS} WHERE tenant_id = ? AND email = ?`)
      .get(tid, normalizeEmail(email)) as GoogleAccountRow | undefined;
    return row === undefined ? null : googleAccountFromRow(row);
  }

  /** Every sign-in on this host, in any tenant, that is this Google account. */
  signInsWithEmail(email: string): { tenantId: string; slot: string }[] {
    const rows = this.db
      .prepare(
        "SELECT tenant_id, slot FROM google_accounts WHERE email = ? ORDER BY tenant_id, slot",
      )
      .all(normalizeEmail(email)) as { tenant_id: string; slot: string }[];
    return rows.map((row) => ({ tenantId: row.tenant_id, slot: row.slot }));
  }

  listGoogleAccounts(tenantId?: string): GoogleAccountRecord[] {
    const tid = tenantId ?? this.tenantId;
    const rows = this.db
      .prepare(`${GOOGLE_ACCOUNT_COLUMNS} WHERE tenant_id = ? ORDER BY ${SLOT_ORDER}`)
      .all(tid) as GoogleAccountRow[];
    return rows.map(googleAccountFromRow);
  }

  /**
   * Holds the first of `slots` that no sign-in has and none is waiting on,
   * until `until`. One immediate transaction, so two processes reserving at
   * once get different slots. Undefined when every slot is taken.
   */
  reserveSignInSlot(
    slots: readonly string[],
    until: Date,
    now = new Date(),
    tenantId?: string,
  ): string | undefined {
    const tid = tenantId ?? this.tenantId;
    return this.db
      .transaction((): string | undefined => {
        const taken = new Set([
          ...this.listGoogleAccounts(tid).map((account) => account.slot),
          ...this.listSignInReservations(now, tid),
        ]);
        const slot = slots.find((candidate) => !taken.has(candidate));
        if (slot !== undefined) {
          this.db
            .prepare(
              `INSERT INTO sign_in_reservations (tenant_id, slot, reserved_until) VALUES (?, ?, ?)
               ON CONFLICT(tenant_id, slot) DO UPDATE SET reserved_until = excluded.reserved_until`,
            )
            .run(tid, slot, until.toISOString());
        }
        return slot;
      })
      .immediate();
  }

  /** Slots held for sign-ins still in progress, forgetting the expired ones. */
  listSignInReservations(now = new Date(), tenantId?: string): string[] {
    const tid = tenantId ?? this.tenantId;
    this.db
      .prepare("DELETE FROM sign_in_reservations WHERE tenant_id = ? AND reserved_until <= ?")
      .run(tid, now.toISOString());
    const rows = this.db
      .prepare("SELECT slot FROM sign_in_reservations WHERE tenant_id = ? ORDER BY slot")
      .all(tid) as { slot: string }[];
    return rows.map((row) => row.slot);
  }

  releaseSignInSlot(slot: string, tenantId?: string): void {
    const tid = tenantId ?? this.tenantId;
    this.db
      .prepare("DELETE FROM sign_in_reservations WHERE tenant_id = ? AND slot = ?")
      .run(tid, slot);
  }

  deleteGoogleAccount(slot: string, tenantId?: string): void {
    const tid = tenantId ?? this.tenantId;
    this.db.prepare("DELETE FROM google_accounts WHERE tenant_id = ? AND slot = ?").run(tid, slot);
  }

  /**
   * Adds or replaces one calendar, refusing what would sync a calendar twice:
   * the same calendar already in this tenant (under another key), more than
   * MAX_CALENDARS, or a calendar another tenant already syncs together with
   * one of this tenant's (both tenants would mirror the same events into each
   * other's blocks). Replacing a key in place is not a new calendar, so the
   * cap does not apply to it. One immediate transaction, so two adds at once
   * still see each other's rows.
   */
  addCalendar(input: CalendarInput, now = new Date(), tenantId?: string): CalendarAddResult {
    const tid = tenantId ?? this.tenantId;
    return this.db
      .transaction((): CalendarAddResult => {
        const fingerprint = input.fingerprint;
        const refusal = this.calendarRefusal(input.key, fingerprint, tid);
        if (refusal !== undefined) {
          return refusal;
        }
        this.db
          .prepare(
            `INSERT INTO calendars (
               tenant_id, calendar_key, account_slot, calendar_id, name, access_role,
               source, destination, calendar_fingerprint, added_at, verified_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(tenant_id, calendar_key) DO UPDATE SET
               account_slot = excluded.account_slot,
               calendar_id = excluded.calendar_id,
               name = COALESCE(excluded.name, calendars.name),
               access_role = COALESCE(excluded.access_role, calendars.access_role),
               source = excluded.source,
               destination = excluded.destination,
               calendar_fingerprint = COALESCE(excluded.calendar_fingerprint,
                                               calendars.calendar_fingerprint),
               verified_at = excluded.verified_at`,
          )
          .run(
            tid,
            input.key,
            input.account,
            input.calendarId,
            input.name ?? null,
            input.accessRole ?? null,
            input.source === false ? 0 : 1,
            input.destination === false ? 0 : 1,
            fingerprint ?? null,
            now.toISOString(),
            now.toISOString(),
          );
        return { added: true };
      })
      .immediate();
  }

  /**
   * Why addCalendar would refuse this calendar, without adding it: for a
   * caller that must decide before it touches anything else (a token).
   */
  calendarRefusal(
    key: CalendarKey,
    fingerprint: string | undefined,
    tenantId?: string,
  ): CalendarRefusal | undefined {
    const tid = tenantId ?? this.tenantId;
    if (fingerprint !== undefined) {
      const duplicate = this.db
        .prepare(
          `SELECT calendar_key FROM calendars
           WHERE tenant_id = ? AND calendar_fingerprint = ? AND calendar_key != ?`,
        )
        .get(tid, fingerprint, key) as { calendar_key: string } | undefined;
      if (duplicate !== undefined) {
        return { added: false, reason: "duplicate", key: duplicate.calendar_key };
      }
      const tenant = this.calendarConflict(fingerprint, key, tid);
      if (tenant !== undefined) {
        return { added: false, reason: "conflict", tenant };
      }
    }
    const existing = this.db
      .prepare("SELECT 1 FROM calendars WHERE tenant_id = ? AND calendar_key = ?")
      .get(tid, key);
    const count = (
      this.db.prepare("SELECT COUNT(*) AS n FROM calendars WHERE tenant_id = ?").get(tid) as {
        n: number;
      }
    ).n;
    return existing === undefined && count >= MAX_CALENDARS
      ? { added: false, reason: "limit" }
      : undefined;
  }

  /**
   * The other tenant, if any, that already syncs the calendar `fingerprint`
   * names together with another of this tenant's calendars (other than
   * `replacing`, the key being re-added). One shared calendar alone is not a
   * conflict (two people can mirror different work calendars into a family
   * one); two shared calendars are, since both tenants would mirror the same
   * events between them.
   */
  calendarConflict(
    fingerprint: string,
    replacing: CalendarKey,
    tenantId?: string,
  ): string | undefined {
    const tid = tenantId ?? this.tenantId;
    const row = this.db
      .prepare(
        `SELECT theirs.tenant_id FROM calendars theirs
         WHERE theirs.calendar_fingerprint = ? AND theirs.tenant_id != ?
           AND EXISTS (
             SELECT 1 FROM calendars mine
             JOIN calendars shared
               ON shared.calendar_fingerprint = mine.calendar_fingerprint
              AND shared.tenant_id = theirs.tenant_id
             WHERE mine.tenant_id = ? AND mine.calendar_key != ?
               AND mine.calendar_fingerprint IS NOT NULL
               AND mine.calendar_fingerprint != ?
           )
         ORDER BY theirs.tenant_id LIMIT 1`,
      )
      .get(fingerprint, tid, tid, replacing, fingerprint) as { tenant_id: string } | undefined;
    return row?.tenant_id;
  }

  /** Marks a calendar verified and fills in what the check learned about it. */
  /**
   * Records a passing check. `resolvedId` replaces the "primary" alias a role
   * calendar was stored under with the id Google resolves it to, so the
   * calendar compares equal to itself however it is reached.
   */
  verifyCalendar(
    key: CalendarKey,
    details: {
      fingerprint?: string | undefined;
      name?: string | null;
      accessRole?: string | null;
      resolvedId?: string | undefined;
    },
    now = new Date(),
    tenantId?: string,
  ): void {
    const tid = tenantId ?? this.tenantId;
    this.db
      .prepare(
        // A fingerprint another of this tenant's calendars already has is not
        // taken: that is a duplicate the status surfaces report, not a crash.
        `UPDATE calendars SET verified_at = ?,
           calendar_fingerprint = CASE
             WHEN EXISTS (
               SELECT 1 FROM calendars other
               WHERE other.tenant_id = calendars.tenant_id
                 AND other.calendar_key != calendars.calendar_key
                 AND other.calendar_fingerprint = ?
             ) THEN calendar_fingerprint
             ELSE COALESCE(?, calendar_fingerprint)
           END,
           name = COALESCE(?, name),
           access_role = COALESCE(?, access_role),
           calendar_id = CASE
             WHEN calendar_id = 'primary' AND ? IS NOT NULL THEN ?
             ELSE calendar_id
           END
         WHERE tenant_id = ? AND calendar_key = ?`,
      )
      .run(
        now.toISOString(),
        details.fingerprint ?? null,
        details.fingerprint ?? null,
        details.name ?? null,
        details.accessRole ?? null,
        details.resolvedId ?? null,
        details.resolvedId ?? null,
        tid,
        key,
      );
  }

  getCalendar(key: CalendarKey, tenantId?: string): CalendarRecord | null {
    const tid = tenantId ?? this.tenantId;
    const row = this.db
      .prepare(`${CALENDAR_COLUMNS} WHERE tenant_id = ? AND calendar_key = ?`)
      .get(tid, key) as CalendarRow | undefined;
    return row === undefined ? null : calendarFromRow(row);
  }

  listCalendars(tenantId?: string): CalendarRecord[] {
    const tid = tenantId ?? this.tenantId;
    const rows = this.db
      .prepare(`${CALENDAR_COLUMNS} WHERE tenant_id = ? ORDER BY ${CALENDAR_ORDER}`)
      .all(tid) as CalendarRow[];
    return rows.map(calendarFromRow);
  }

  /**
   * Calendars a check has not resolved yet: a role calendar still under the
   * "primary" alias, or one written before calsync kept fingerprints. Until
   * it is, a second copy of it would get past the duplicate check.
   */
  listUnresolvedCalendars(tenantId?: string): CalendarRecord[] {
    const tid = tenantId ?? this.tenantId;
    const rows = this.db
      .prepare(
        `${CALENDAR_COLUMNS} WHERE tenant_id = ?
           AND (calendar_id = 'primary' OR calendar_fingerprint IS NULL)
         ORDER BY ${CALENDAR_ORDER}`,
      )
      .all(tid) as CalendarRow[];
    return rows.map(calendarFromRow);
  }

  setCalendarRoles(
    key: CalendarKey,
    roles: { source: boolean; destination: boolean },
    tenantId?: string,
  ): void {
    const tid = tenantId ?? this.tenantId;
    this.db
      .prepare(
        "UPDATE calendars SET source = ?, destination = ? WHERE tenant_id = ? AND calendar_key = ?",
      )
      .run(roles.source ? 1 : 0, roles.destination ? 1 : 0, tid, key);
  }

  /**
   * Forgets a calendar and everything calsync kept for it: its block
   * mappings, the exclusions that held its events back, its watch channel
   * row and its incremental sync state. The caller removes its busy blocks
   * from Google first; `stateKeys` are its sync_state keys, which the engine
   * names.
   */
  removeCalendar(key: CalendarKey, stateKeys: readonly string[], tenantId?: string): void {
    const tid = tenantId ?? this.tenantId;
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM event_mappings WHERE tenant_id = ? AND destination_key = ?")
        .run(tid, key);
      for (const table of ["exclusion_keys", "exclusion_keywords"]) {
        this.db
          .prepare(`DELETE FROM ${table} WHERE tenant_id = ? AND source_key = ?`)
          .run(tid, key);
      }
      this.db
        .prepare("DELETE FROM watch_channels WHERE tenant_id = ? AND calendar_key = ?")
        .run(tid, key);
      for (const stateKey of stateKeys) {
        this.db.prepare("DELETE FROM sync_state WHERE key = ?").run(stateKey);
      }
      this.db
        .prepare("DELETE FROM calendars WHERE tenant_id = ? AND calendar_key = ?")
        .run(tid, key);
    })();
  }

  // ---- The two-calendar API: a role names both its sign-in slot and its
  // calendar key. Kept so role-based surfaces work unchanged.

  upsertAccount(role: AccountRole, calendarId: string, now = new Date(), tenantId?: string): void {
    const tid = tenantId ?? this.tenantId;
    this.db.transaction(() => {
      this.upsertGoogleAccount(role, null, now, tid);
      this.db
        .prepare(
          `INSERT INTO calendars (
             tenant_id, calendar_key, account_slot, calendar_id, source, destination,
             added_at, verified_at
           ) VALUES (?, ?, ?, ?, 1, 1, ?, ?)
           ON CONFLICT(tenant_id, calendar_key) DO UPDATE SET
             account_slot = excluded.account_slot,
             calendar_id = excluded.calendar_id,
             verified_at = excluded.verified_at`,
        )
        .run(tid, role, role, calendarId, now.toISOString(), now.toISOString());
    })();
  }

  /**
   * Records a validated role account and its calendar, unless that would
   * sync a calendar twice (see addCalendar). The first passing check is what
   * makes the daemon adopt a tenant, so refusing here keeps it out.
   */
  adoptAccount(
    role: AccountRole,
    calendarId: string,
    fingerprint: string | undefined,
    now = new Date(),
    tenantId?: string,
  ): { adopted: true } | { adopted: false; refusal: CalendarRefusal } {
    const tid = tenantId ?? this.tenantId;
    return this.db
      .transaction((): { adopted: true } | { adopted: false; refusal: CalendarRefusal } => {
        const result = this.addCalendar(
          { key: role, account: role, calendarId, fingerprint },
          now,
          tid,
        );
        if (!result.added) {
          return { adopted: false, refusal: result };
        }
        this.upsertGoogleAccount(role, null, now, tid);
        return { adopted: true };
      })
      .immediate();
  }

  /** The other tenant already syncing this role's calendar alongside one of ours. */
  pairConflict(role: AccountRole, fingerprint: string, tenantId?: string): string | undefined {
    return this.calendarConflict(fingerprint, role, tenantId);
  }

  /**
   * Marks an established role account verified and fills in its fingerprint,
   * which rows written before the guard lack. Returns another tenant already
   * syncing the same calendars, for a warning: an established tenant is never
   * refused.
   */
  verifyAccount(
    role: AccountRole,
    fingerprint: string | undefined,
    now = new Date(),
    tenantId?: string,
    resolvedId?: string,
  ): string | undefined {
    const tid = tenantId ?? this.tenantId;
    return this.db
      .transaction((): string | undefined => {
        this.verifyGoogleAccount(role, null, now, tid);
        this.verifyCalendar(role, { fingerprint, resolvedId }, now, tid);
        return fingerprint === undefined
          ? undefined
          : this.calendarConflict(fingerprint, role, tid);
      })
      .immediate();
  }

  markAccountVerified(role: AccountRole, now = new Date(), tenantId?: string): void {
    const tid = tenantId ?? this.tenantId;
    this.verifyGoogleAccount(role, null, now, tid);
    this.verifyCalendar(role, {}, now, tid);
  }

  getAccount(role: AccountRole, tenantId?: string): AccountRecord | null {
    const tid = tenantId ?? this.tenantId;
    const row = this.db.prepare(`${ROLE_ACCOUNT_COLUMNS} AND c.calendar_key = ?`).get(tid, role) as
      AccountRow | undefined;
    return row === undefined ? null : accountFromRow(row);
  }

  listAccounts(tenantId?: string): AccountRecord[] {
    const tid = tenantId ?? this.tenantId;
    const rows = this.db
      .prepare(
        `${ROLE_ACCOUNT_COLUMNS} AND c.calendar_key IN ('personal', 'work')
         ORDER BY CASE c.calendar_key WHEN 'personal' THEN 0 ELSE 1 END`,
      )
      .all(tid) as AccountRow[];
    return rows.map(accountFromRow);
  }

  deleteAccount(role: AccountRole, tenantId?: string): void {
    const tid = tenantId ?? this.tenantId;
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM calendars WHERE tenant_id = ? AND calendar_key = ?")
        .run(tid, role);
      const used = this.db
        .prepare("SELECT 1 FROM calendars WHERE tenant_id = ? AND account_slot = ?")
        .get(tid, role);
      if (used === undefined) {
        this.deleteGoogleAccount(role, tid);
      }
    })();
  }

  /** Tenants with at least two calendars — the set one daemon serves. */
  listReadyTenants(): string[] {
    const rows = this.db
      .prepare(
        `SELECT tenant_id FROM calendars
         GROUP BY tenant_id HAVING COUNT(*) >= 2
         ORDER BY tenant_id`,
      )
      .all() as { tenant_id: string }[];
    return rows.map((row) => row.tenant_id);
  }

  putMapping(mapping: EventMapping, tenantId?: string): void {
    const tid = tenantId ?? this.tenantId;
    this.db
      .prepare(
        `INSERT INTO event_mappings (
           mapping_key, tenant_id, destination_key, destination_event_id, destination_etag,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(mapping_key) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           destination_key = excluded.destination_key,
           destination_event_id = excluded.destination_event_id,
           destination_etag = excluded.destination_etag,
           updated_at = excluded.updated_at`,
      )
      .run(
        mapping.mappingKey,
        tid,
        mapping.destinationKey,
        mapping.destinationEventId,
        mapping.destinationEtag,
        mapping.updatedAt,
      );
  }

  getMapping(mappingKey: string, tenantId?: string): EventMapping | null {
    const tid = tenantId ?? this.tenantId;
    const row = this.db
      .prepare(`${MAPPING_COLUMNS} WHERE mapping_key = ? AND tenant_id = ?`)
      .get(mappingKey, tid) as MappingRow | undefined;
    return row === undefined ? null : mappingFromRow(row);
  }

  listMappings(destinationKey?: CalendarKey, tenantId?: string): EventMapping[] {
    const tid = tenantId ?? this.tenantId;
    const rows =
      destinationKey === undefined
        ? (this.db
            .prepare(`${MAPPING_COLUMNS} WHERE tenant_id = ? ORDER BY mapping_key`)
            .all(tid) as MappingRow[])
        : (this.db
            .prepare(
              `${MAPPING_COLUMNS} WHERE tenant_id = ? AND destination_key = ? ORDER BY mapping_key`,
            )
            .all(tid, destinationKey) as MappingRow[]);
    return rows.map(mappingFromRow);
  }

  deleteMapping(mappingKey: string, tenantId?: string): void {
    const tid = tenantId ?? this.tenantId;
    this.db
      .prepare("DELETE FROM event_mappings WHERE tenant_id = ? AND mapping_key = ?")
      .run(tid, mappingKey);
  }

  setState(key: string, value: string, now = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now.toISOString());
  }

  setStates(values: Readonly<Record<string, string>>, now = new Date()): void {
    const entries = Object.entries(values);
    const update = this.db.transaction(() => {
      for (const [key, value] of entries) {
        this.setState(key, value, now);
      }
    });
    update();
  }

  getState(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM sync_state WHERE key = ?").get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  deleteState(key: string): void {
    this.db.prepare("DELETE FROM sync_state WHERE key = ?").run(key);
  }

  listExclusionKeys(tenantId?: string): StoredExclusionKey[] {
    const tid = tenantId ?? this.tenantId;
    const rows = this.db
      .prepare(
        `SELECT tenant_id, source_key, value, created_at
         FROM exclusion_keys
         WHERE tenant_id = ?
         ORDER BY source_key, value`,
      )
      .all(tid) as ExclusionKeyRow[];
    return rows.map((row) => ({
      sourceKey: row.source_key,
      value: row.value,
      createdAt: row.created_at,
    }));
  }

  addExclusionKey(sourceKey: CalendarKey, value: string, tenantId?: string): boolean {
    const tid = tenantId ?? this.tenantId;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO exclusion_keys (tenant_id, value, source_key, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(tid, value, sourceKey, new Date().toISOString());
    return result.changes > 0;
  }

  removeExclusionKey(value: string, tenantId?: string): boolean {
    const tid = tenantId ?? this.tenantId;
    const result = this.db
      .prepare("DELETE FROM exclusion_keys WHERE tenant_id = ? AND value = ?")
      .run(tid, value);
    return result.changes > 0;
  }

  listExclusionKeywords(tenantId?: string): StoredExclusionKeyword[] {
    const tid = tenantId ?? this.tenantId;
    const rows = this.db
      .prepare(
        `SELECT tenant_id, source_key, keyword, created_at
         FROM exclusion_keywords
         WHERE tenant_id = ?
         ORDER BY source_key, keyword`,
      )
      .all(tid) as ExclusionKeywordRow[];
    return rows.map((row) => ({
      sourceKey: row.source_key,
      keyword: row.keyword,
      createdAt: row.created_at,
    }));
  }

  addExclusionKeyword(sourceKey: CalendarKey, keyword: string, tenantId?: string): boolean {
    const tid = tenantId ?? this.tenantId;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO exclusion_keywords (tenant_id, source_key, keyword, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(tid, sourceKey, keyword, new Date().toISOString());
    return result.changes > 0;
  }

  removeExclusionKeyword(sourceKey: CalendarKey, keyword: string, tenantId?: string): boolean {
    const tid = tenantId ?? this.tenantId;
    const result = this.db
      .prepare(
        "DELETE FROM exclusion_keywords WHERE tenant_id = ? AND source_key = ? AND keyword = ?",
      )
      .run(tid, sourceKey, keyword);
    return result.changes > 0;
  }

  upsertWatchChannel(channel: WatchChannelRecord, tenantId?: string): void {
    const tid = tenantId ?? this.tenantId;
    this.db
      .prepare(
        `INSERT INTO watch_channels
           (tenant_id, calendar_key, calendar_id, channel_id, resource_id, token_hash, address,
            expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, calendar_key) DO UPDATE SET
           calendar_id = excluded.calendar_id,
           channel_id = excluded.channel_id,
           resource_id = excluded.resource_id,
           token_hash = excluded.token_hash,
           address = excluded.address,
           expires_at = excluded.expires_at,
           created_at = excluded.created_at`,
      )
      .run(
        tid,
        channel.calendarKey,
        channel.calendarId,
        channel.channelId,
        channel.resourceId,
        channel.tokenHash,
        channel.address,
        channel.expiresAt,
        channel.createdAt,
      );
  }

  getWatchChannel(calendarKey: CalendarKey, tenantId?: string): WatchChannelRecord | null {
    const tid = tenantId ?? this.tenantId;
    const row = this.db
      .prepare(`${WATCH_CHANNEL_COLUMNS} WHERE tenant_id = ? AND calendar_key = ?`)
      .get(tid, calendarKey) as WatchChannelRow | undefined;
    return row === undefined ? null : watchChannelFromRow(row);
  }

  getWatchChannelByChannelId(channelId: string): WatchChannelRecord | null {
    // channel_id is globally unique and the record names its tenant, so the
    // shared webhook receiver can dispatch notifications for every tenant.
    const row = this.db.prepare(`${WATCH_CHANNEL_COLUMNS} WHERE channel_id = ?`).get(channelId) as
      WatchChannelRow | undefined;
    return row === undefined ? null : watchChannelFromRow(row);
  }

  listWatchChannels(tenantId?: string): WatchChannelRecord[] {
    const tid = tenantId ?? this.tenantId;
    const rows = this.db
      .prepare(`${WATCH_CHANNEL_COLUMNS} WHERE tenant_id = ? ORDER BY calendar_key`)
      .all(tid) as WatchChannelRow[];
    return rows.map(watchChannelFromRow);
  }

  deleteWatchChannel(calendarKey: CalendarKey, tenantId?: string): void {
    const tid = tenantId ?? this.tenantId;
    this.db
      .prepare("DELETE FROM watch_channels WHERE tenant_id = ? AND calendar_key = ?")
      .run(tid, calendarKey);
  }

  private migrate(): void {
    const preTenant = Object.keys(LEGACY_COPIES).filter((table) => this.isPreTenantTable(table));
    const preKeyed = Object.keys(ROLE_KEYED_COLUMNS).filter(
      (table) => !preTenant.includes(table) && this.hasColumn(table, ROLE_KEYED_COLUMNS[table]),
    );
    this.db.transaction(() => {
      // Tables whose primary keys or columns changed are rebuilt: renamed
      // aside, recreated, and their rows copied over. Pre-tenant rows land
      // under 'default'; role-keyed rows get the calendar key they meant.
      for (const table of preTenant) {
        this.db.exec(`ALTER TABLE ${table} RENAME TO ${table}_pre_tenant`);
      }
      for (const table of preKeyed) {
        this.db.exec(`ALTER TABLE ${table} RENAME TO ${table}_pre_keys`);
      }
      this.createTables();
      for (const table of preTenant) {
        this.copyLegacyRows(table, `${table}_pre_tenant`, "'default'");
      }
      for (const table of preKeyed) {
        this.copyLegacyRows(table, `${table}_pre_keys`, "tenant_id");
      }
      this.db.exec(`INSERT OR IGNORE INTO signed_in_tenants (tenant_id, first_at)
        SELECT tenant_id, MIN(authorized_at) FROM google_accounts GROUP BY tenant_id`);
    })();
  }

  private copyLegacyRows(table: string, from: string, tenant: string): void {
    const copy = LEGACY_COPIES[table];
    if (copy === undefined) {
      throw new Error(`No migration for table ${table}`);
    }
    const columns = new Set(
      (this.db.pragma(`table_info(${from})`) as { name: string }[]).map((column) => column.name),
    );
    this.db.exec(`${copy(from, tenant, columns)}; DROP TABLE ${from};`);
  }

  private hasColumn(table: string, column: string | undefined): boolean {
    const columns = this.db.pragma(`table_info(${table})`) as { name: string }[];
    return columns.some((existing) => existing.name === column);
  }

  private isPreTenantTable(table: string): boolean {
    const exists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (exists === undefined) {
      return false;
    }
    const columns = this.db.pragma(`table_info(${table})`) as { name: string }[];
    return !columns.some((column) => column.name === "tenant_id");
  }

  private createTables(): void {
    this.db.exec(`
      -- One Google sign-in; its refresh token lives in the vault under slot.
      CREATE TABLE IF NOT EXISTS google_accounts (
        tenant_id TEXT NOT NULL,
        slot TEXT NOT NULL,
        email TEXT,
        authorized_at TEXT NOT NULL,
        verified_at TEXT,
        PRIMARY KEY (tenant_id, slot)
      );

      -- A slot handed to a sign-in still at Google, so no other sign-in takes
      -- it: the dashboard, the MCP server and the CLI are separate processes.
      CREATE TABLE IF NOT EXISTS sign_in_reservations (
        tenant_id TEXT NOT NULL,
        slot TEXT NOT NULL,
        reserved_until TEXT NOT NULL,
        PRIMARY KEY (tenant_id, slot)
      );

      -- Tenants that ever signed in, which a fresh tenant has not.
      CREATE TABLE IF NOT EXISTS signed_in_tenants (
        tenant_id TEXT PRIMARY KEY,
        first_at TEXT NOT NULL
      );

      -- One connected calendar, read and written through account_slot's sign-in.
      CREATE TABLE IF NOT EXISTS calendars (
        tenant_id TEXT NOT NULL,
        calendar_key TEXT NOT NULL,
        account_slot TEXT NOT NULL,
        calendar_id TEXT NOT NULL,
        name TEXT,
        access_role TEXT,
        source INTEGER NOT NULL DEFAULT 1,
        destination INTEGER NOT NULL DEFAULT 1,
        -- SHA-256 of the calendar's resolved id; equality only.
        calendar_fingerprint TEXT,
        added_at TEXT NOT NULL,
        verified_at TEXT,
        PRIMARY KEY (tenant_id, calendar_key)
      );

      -- A tenant syncs any one calendar once.
      CREATE UNIQUE INDEX IF NOT EXISTS calendars_fingerprint
        ON calendars (tenant_id, calendar_fingerprint)
        WHERE calendar_fingerprint IS NOT NULL;

      -- One busy block calsync wrote, by the calendar holding it. No source
      -- event identifiers: a block merges any number of sources.
      CREATE TABLE IF NOT EXISTS event_mappings (
        mapping_key TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        destination_key TEXT NOT NULL,
        destination_event_id TEXT NOT NULL,
        destination_etag TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS event_mappings_destination
        ON event_mappings (tenant_id, destination_key);

      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Exclusions belong to the source calendar whose events they hold back.
      CREATE TABLE IF NOT EXISTS exclusion_keys (
        tenant_id TEXT NOT NULL,
        value TEXT NOT NULL,
        source_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, value)
      );

      CREATE TABLE IF NOT EXISTS exclusion_keywords (
        tenant_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        keyword TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, source_key, keyword)
      );

      CREATE TABLE IF NOT EXISTS watch_channels (
        tenant_id TEXT NOT NULL,
        calendar_key TEXT NOT NULL,
        calendar_id TEXT NOT NULL,
        channel_id TEXT NOT NULL UNIQUE,
        resource_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        address TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, calendar_key)
      );
    `);
  }
}

/**
 * The role-era column that marks a table as needing its rows re-keyed by
 * calendar. Each direction had one source and one destination, so the
 * conversion is exact.
 */
const ROLE_KEYED_COLUMNS: Record<string, string> = {
  accounts: "role",
  watch_channels: "role",
  event_mappings: "source_role",
  exclusion_keys: "direction",
  exclusion_keywords: "direction",
};

/** A mapping sourced from one role's calendar sits on the other's. */
const DESTINATION_OF_SOURCE_ROLE =
  "CASE source_role WHEN 'personal' THEN 'work' ELSE 'personal' END";
/** "personalToWork" held back personal events: the personal source's exclusion. */
const SOURCE_OF_DIRECTION = "CASE direction WHEN 'personalToWork' THEN 'personal' ELSE 'work' END";

/**
 * Copies one legacy table's rows into its current shape. `tenant` is the SQL
 * for each row's tenant: a literal for pre-tenant tables, the column otherwise.
 */
const LEGACY_COPIES: Record<
  string,
  (from: string, tenant: string, columns: ReadonlySet<string>) => string
> = {
  // A role was one sign-in with one calendar: its slot and its calendar key.
  // Both roles could point at the same calendar before calendars were
  // unique per tenant; the later role keeps its row without a fingerprint.
  accounts: (from, tenant, columns) =>
    `INSERT OR IGNORE INTO google_accounts (tenant_id, slot, email, authorized_at, verified_at)
     SELECT ${tenant}, role, NULL, authorized_at, verified_at FROM ${from};
     INSERT OR IGNORE INTO calendars (
       tenant_id, calendar_key, account_slot, calendar_id, source, destination,
       calendar_fingerprint, added_at, verified_at
     )
     SELECT ${tenant}, role, role, calendar_id, 1, 1,
            ${
              columns.has("calendar_fingerprint") && columns.has("tenant_id")
                ? `CASE WHEN EXISTS (
                     SELECT 1 FROM ${from} earlier
                     WHERE earlier.tenant_id = legacy.tenant_id
                       AND earlier.calendar_fingerprint = legacy.calendar_fingerprint
                       AND earlier.role < legacy.role
                   ) THEN NULL ELSE legacy.calendar_fingerprint END`
                : "NULL"
            },
            authorized_at, verified_at
     FROM ${from} legacy`,
  event_mappings: (from, tenant) =>
    `INSERT OR IGNORE INTO event_mappings (
       mapping_key, tenant_id, destination_key, destination_event_id, destination_etag, updated_at
     )
     SELECT mapping_key, ${tenant}, ${DESTINATION_OF_SOURCE_ROLE}, destination_event_id,
            destination_etag, updated_at
     FROM ${from}`,
  exclusion_keys: (from, tenant) =>
    `INSERT OR IGNORE INTO exclusion_keys (tenant_id, value, source_key, created_at)
     SELECT ${tenant}, value, ${SOURCE_OF_DIRECTION}, created_at FROM ${from}`,
  exclusion_keywords: (from, tenant) =>
    `INSERT OR IGNORE INTO exclusion_keywords (tenant_id, source_key, keyword, created_at)
     SELECT ${tenant}, ${SOURCE_OF_DIRECTION}, keyword, created_at FROM ${from}`,
  watch_channels: (from, tenant) =>
    `INSERT OR IGNORE INTO watch_channels (
       tenant_id, calendar_key, calendar_id, channel_id, resource_id, token_hash, address,
       expires_at, created_at
     )
     SELECT ${tenant}, role, calendar_id, channel_id, resource_id, token_hash, address,
            expires_at, created_at
     FROM ${from}`,
};

const MAPPING_COLUMNS = `SELECT mapping_key, tenant_id, destination_key, destination_event_id,
        destination_etag, updated_at
 FROM event_mappings`;

const GOOGLE_ACCOUNT_COLUMNS = `SELECT tenant_id, slot, email, authorized_at, verified_at
 FROM google_accounts`;

const CALENDAR_COLUMNS = `SELECT tenant_id, calendar_key, account_slot, calendar_id, name,
        access_role, source, destination, added_at, verified_at
 FROM calendars`;

/** The two original calendars first, in their old order, then the rest as added. */
const CALENDAR_ORDER = `CASE calendar_key WHEN 'personal' THEN 0 WHEN 'work' THEN 1 ELSE 2 END,
  added_at, calendar_key`;
const SLOT_ORDER = `CASE slot WHEN 'personal' THEN 0 WHEN 'work' THEN 1 ELSE 2 END, slot`;

/** A role's account as one row: the calendar keyed by the role and its sign-in. */
const ROLE_ACCOUNT_COLUMNS = `SELECT c.tenant_id, c.calendar_key AS role, c.calendar_id,
        a.authorized_at, c.verified_at
 FROM calendars c
 JOIN google_accounts a ON a.tenant_id = c.tenant_id AND a.slot = c.account_slot
 WHERE c.tenant_id = ?`;

const WATCH_CHANNEL_COLUMNS = `SELECT tenant_id, calendar_key, calendar_id, channel_id, resource_id,
        token_hash, address, expires_at, created_at
 FROM watch_channels`;

function watchChannelFromRow(row: WatchChannelRow): WatchChannelRecord {
  return {
    tenantId: row.tenant_id,
    calendarKey: row.calendar_key,
    calendarId: row.calendar_id,
    channelId: row.channel_id,
    resourceId: row.resource_id,
    tokenHash: row.token_hash,
    address: row.address,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function googleAccountFromRow(row: GoogleAccountRow): GoogleAccountRecord {
  return {
    tenantId: row.tenant_id,
    slot: row.slot,
    email: row.email,
    authorizedAt: row.authorized_at,
    verifiedAt: row.verified_at,
  };
}

function calendarFromRow(row: CalendarRow): CalendarRecord {
  return {
    tenantId: row.tenant_id,
    key: row.calendar_key,
    account: row.account_slot,
    calendarId: row.calendar_id,
    name: row.name,
    accessRole: row.access_role,
    source: row.source !== 0,
    destination: row.destination !== 0,
    addedAt: row.added_at,
    verifiedAt: row.verified_at,
  };
}

function normalizeEmail(email: string | null): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
}

function accountFromRow(row: AccountRow): AccountRecord {
  return {
    tenantId: row.tenant_id,
    role: row.role,
    calendarId: row.calendar_id,
    authorizedAt: row.authorized_at,
    verifiedAt: row.verified_at,
  };
}

function mappingFromRow(row: MappingRow): EventMapping {
  return {
    mappingKey: row.mapping_key,
    destinationKey: row.destination_key,
    destinationEventId: row.destination_event_id,
    destinationEtag: row.destination_etag,
    updatedAt: row.updated_at,
  };
}
