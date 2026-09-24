import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type {
  AccountRole,
  EventMapping,
  ExclusionDirection,
  ExclusionSource,
  MappingStore,
  StoredExclusionKey,
  StoredExclusionKeyword,
  SyncStateStore,
} from "@calsync/engine";

export type {
  EventMapping,
  ExclusionDirection,
  StoredExclusionKey,
  StoredExclusionKeyword,
} from "@calsync/engine";

export interface AccountRecord {
  tenantId: string;
  role: AccountRole;
  calendarId: string;
  authorizedAt: string;
  verifiedAt: string | null;
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
  source_role: AccountRole;
  source_event_id: string;
  destination_event_id: string;
  source_etag: string | null;
  destination_etag: string | null;
  updated_at: string;
}

interface ExclusionKeyRow {
  direction: ExclusionDirection;
  value: string;
  created_at: string;
}

interface ExclusionKeywordRow {
  direction: ExclusionDirection;
  keyword: string;
  created_at: string;
}

export interface WatchChannelRecord {
  tenantId: string;
  role: AccountRole;
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
  role: AccountRole;
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
  private readonly tenantId: string;

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

  upsertAccount(role: AccountRole, calendarId: string, now = new Date(), tenantId?: string): void {
    const tid = tenantId ?? this.tenantId;
    this.db
      .prepare(
        `INSERT INTO accounts (tenant_id, role, calendar_id, authorized_at, verified_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, role) DO UPDATE SET
           calendar_id = excluded.calendar_id,
           authorized_at = excluded.authorized_at,
           verified_at = excluded.verified_at`,
      )
      .run(tid, role, calendarId, now.toISOString(), now.toISOString());
  }

  /**
   * Records a validated account together with the fingerprint of the calendar
   * it resolved to, unless that would complete a calendar pair another tenant
   * on this host already syncs. Two tenants on one pair mirror every event
   * twice and see each other's busy blocks as strays, so the second one is
   * refused here, where it would otherwise become ready and be adopted by the
   * daemon. Runs as one immediate transaction: two roles validated in
   * parallel, or two processes at once, still see each other's rows.
   */
  adoptAccount(
    role: AccountRole,
    calendarId: string,
    fingerprint: string | undefined,
    now = new Date(),
    tenantId?: string,
  ): { adopted: true } | { adopted: false; conflictsWith: string } {
    const tid = tenantId ?? this.tenantId;
    return this.db
      .transaction((): { adopted: true } | { adopted: false; conflictsWith: string } => {
        const conflictsWith =
          fingerprint === undefined ? undefined : this.pairConflict(role, fingerprint, tid);
        if (conflictsWith !== undefined) {
          return { adopted: false, conflictsWith };
        }
        this.db
          .prepare(
            `INSERT INTO accounts (
               tenant_id, role, calendar_id, authorized_at, verified_at, calendar_fingerprint
             ) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(tenant_id, role) DO UPDATE SET
               calendar_id = excluded.calendar_id,
               authorized_at = excluded.authorized_at,
               verified_at = excluded.verified_at,
               calendar_fingerprint = excluded.calendar_fingerprint`,
          )
          .run(tid, role, calendarId, now.toISOString(), now.toISOString(), fingerprint ?? null);
        return { adopted: true };
      })
      .immediate();
  }

  /**
   * The other tenant, if any, whose two calendars are the pair this tenant
   * would have with `fingerprint` in `role`, in either orientation. Undefined
   * while this tenant's other role is unknown: one shared calendar is not a
   * conflict (two people can mirror different work calendars into a family
   * one), only the same pair is.
   */
  pairConflict(role: AccountRole, fingerprint: string, tenantId?: string): string | undefined {
    const tid = tenantId ?? this.tenantId;
    const other = this.db
      .prepare(
        "SELECT calendar_fingerprint FROM accounts WHERE tenant_id = ? AND role = ? AND calendar_fingerprint IS NOT NULL",
      )
      .get(tid, role === "personal" ? "work" : "personal") as
      { calendar_fingerprint: string } | undefined;
    if (other === undefined) {
      return undefined;
    }
    const row = this.db
      .prepare(
        `SELECT p.tenant_id FROM accounts p
         JOIN accounts w ON w.tenant_id = p.tenant_id AND w.role = 'work'
         WHERE p.role = 'personal' AND p.tenant_id != ?
           AND ((p.calendar_fingerprint = ? AND w.calendar_fingerprint = ?)
             OR (p.calendar_fingerprint = ? AND w.calendar_fingerprint = ?))
         ORDER BY p.tenant_id LIMIT 1`,
      )
      .get(
        tid,
        fingerprint,
        other.calendar_fingerprint,
        other.calendar_fingerprint,
        fingerprint,
      ) as { tenant_id: string } | undefined;
    return row?.tenant_id;
  }

  /**
   * Marks an established account verified and fills in its fingerprint, which
   * rows written before the pair guard lack. Returns another tenant already
   * on the same pair, for a warning: an established tenant is never refused.
   */
  verifyAccount(
    role: AccountRole,
    fingerprint: string | undefined,
    now = new Date(),
    tenantId?: string,
  ): string | undefined {
    const tid = tenantId ?? this.tenantId;
    return this.db
      .transaction((): string | undefined => {
        this.db
          .prepare(
            `UPDATE accounts SET verified_at = ?,
               calendar_fingerprint = COALESCE(?, calendar_fingerprint)
             WHERE tenant_id = ? AND role = ?`,
          )
          .run(now.toISOString(), fingerprint ?? null, tid, role);
        return fingerprint === undefined ? undefined : this.pairConflict(role, fingerprint, tid);
      })
      .immediate();
  }

  markAccountVerified(role: AccountRole, now = new Date(), tenantId?: string): void {
    const tid = tenantId ?? this.tenantId;
    this.db
      .prepare("UPDATE accounts SET verified_at = ? WHERE tenant_id = ? AND role = ?")
      .run(now.toISOString(), tid, role);
  }

  getAccount(role: AccountRole, tenantId?: string): AccountRecord | null {
    const tid = tenantId ?? this.tenantId;
    const row = this.db
      .prepare(
        "SELECT tenant_id, role, calendar_id, authorized_at, verified_at FROM accounts WHERE tenant_id = ? AND role = ?",
      )
      .get(tid, role) as AccountRow | undefined;
    return row === undefined ? null : accountFromRow(row);
  }

  listAccounts(tenantId?: string): AccountRecord[] {
    const tid = tenantId ?? this.tenantId;
    const rows = this.db
      .prepare(
        `SELECT tenant_id, role, calendar_id, authorized_at, verified_at
         FROM accounts
         WHERE tenant_id = ?
         ORDER BY CASE role WHEN 'personal' THEN 0 ELSE 1 END`,
      )
      .all(tid) as AccountRow[];
    return rows.map(accountFromRow);
  }

  deleteAccount(role: AccountRole, tenantId?: string): void {
    const tid = tenantId ?? this.tenantId;
    this.db.prepare("DELETE FROM accounts WHERE tenant_id = ? AND role = ?").run(tid, role);
  }

  /** Tenants with both accounts authorized — the set one daemon serves. */
  listReadyTenants(): string[] {
    const rows = this.db
      .prepare(
        `SELECT tenant_id FROM accounts
         GROUP BY tenant_id HAVING COUNT(DISTINCT role) = 2
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
           mapping_key, tenant_id, source_role, source_event_id, destination_event_id,
           source_etag, destination_etag, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(mapping_key) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           source_role = excluded.source_role,
           source_event_id = excluded.source_event_id,
           destination_event_id = excluded.destination_event_id,
           source_etag = excluded.source_etag,
           destination_etag = excluded.destination_etag,
           updated_at = excluded.updated_at`,
      )
      .run(
        mapping.mappingKey,
        tid,
        mapping.sourceRole,
        mapping.sourceEventId,
        mapping.destinationEventId,
        mapping.sourceEtag,
        mapping.destinationEtag,
        mapping.updatedAt,
      );
  }

  getMapping(mappingKey: string, tenantId?: string): EventMapping | null {
    const tid = tenantId ?? this.tenantId;
    const row = this.db
      .prepare(
        `SELECT mapping_key, tenant_id, source_role, source_event_id, destination_event_id,
                source_etag, destination_etag, updated_at
         FROM event_mappings WHERE mapping_key = ? AND tenant_id = ?`,
      )
      .get(mappingKey, tid) as MappingRow | undefined;
    return row === undefined ? null : mappingFromRow(row);
  }

  listMappings(sourceRole?: AccountRole, tenantId?: string): EventMapping[] {
    const tid = tenantId ?? this.tenantId;
    const rows =
      sourceRole === undefined
        ? (this.db
            .prepare(
              `SELECT mapping_key, tenant_id, source_role, source_event_id, destination_event_id,
                      source_etag, destination_etag, updated_at
               FROM event_mappings WHERE tenant_id = ? ORDER BY mapping_key`,
            )
            .all(tid) as MappingRow[])
        : (this.db
            .prepare(
              `SELECT mapping_key, tenant_id, source_role, source_event_id, destination_event_id,
                      source_etag, destination_etag, updated_at
               FROM event_mappings WHERE tenant_id = ? AND source_role = ? ORDER BY mapping_key`,
            )
            .all(tid, sourceRole) as MappingRow[]);
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
        `SELECT tenant_id, direction, value, created_at
         FROM exclusion_keys
         WHERE tenant_id = ?
         ORDER BY direction, value`,
      )
      .all(tid) as ExclusionKeyRow[];
    return rows.map((row) => ({
      direction: row.direction,
      value: row.value,
      createdAt: row.created_at,
    }));
  }

  addExclusionKey(direction: ExclusionDirection, value: string, tenantId?: string): boolean {
    const tid = tenantId ?? this.tenantId;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO exclusion_keys (tenant_id, value, direction, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(tid, value, direction, new Date().toISOString());
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
        `SELECT tenant_id, direction, keyword, created_at
         FROM exclusion_keywords
         WHERE tenant_id = ?
         ORDER BY direction, keyword`,
      )
      .all(tid) as ExclusionKeywordRow[];
    return rows.map((row) => ({
      direction: row.direction,
      keyword: row.keyword,
      createdAt: row.created_at,
    }));
  }

  addExclusionKeyword(direction: ExclusionDirection, keyword: string, tenantId?: string): boolean {
    const tid = tenantId ?? this.tenantId;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO exclusion_keywords (tenant_id, direction, keyword, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(tid, direction, keyword, new Date().toISOString());
    return result.changes > 0;
  }

  removeExclusionKeyword(
    direction: ExclusionDirection,
    keyword: string,
    tenantId?: string,
  ): boolean {
    const tid = tenantId ?? this.tenantId;
    const result = this.db
      .prepare(
        "DELETE FROM exclusion_keywords WHERE tenant_id = ? AND direction = ? AND keyword = ?",
      )
      .run(tid, direction, keyword);
    return result.changes > 0;
  }

  upsertWatchChannel(channel: WatchChannelRecord, tenantId?: string): void {
    const tid = tenantId ?? this.tenantId;
    this.db
      .prepare(
        `INSERT INTO watch_channels
           (tenant_id, role, calendar_id, channel_id, resource_id, token_hash, address, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, role) DO UPDATE SET
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
        channel.role,
        channel.calendarId,
        channel.channelId,
        channel.resourceId,
        channel.tokenHash,
        channel.address,
        channel.expiresAt,
        channel.createdAt,
      );
  }

  getWatchChannel(role: AccountRole, tenantId?: string): WatchChannelRecord | null {
    const tid = tenantId ?? this.tenantId;
    const row = this.db
      .prepare(`${WATCH_CHANNEL_COLUMNS} WHERE tenant_id = ? AND role = ?`)
      .get(tid, role) as WatchChannelRow | undefined;
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
      .prepare(`${WATCH_CHANNEL_COLUMNS} WHERE tenant_id = ? ORDER BY role`)
      .all(tid) as WatchChannelRow[];
    return rows.map(watchChannelFromRow);
  }

  deleteWatchChannel(role: AccountRole, tenantId?: string): void {
    const tid = tenantId ?? this.tenantId;
    this.db.prepare("DELETE FROM watch_channels WHERE tenant_id = ? AND role = ?").run(tid, role);
  }

  private migrate(): void {
    const legacyTables = Object.entries(PRE_TENANT_COLUMNS).filter(([table]) =>
      this.isPreTenantTable(table),
    );
    this.db.transaction(() => {
      // Pre-tenant tables changed primary keys, so they are rebuilt: renamed
      // aside, recreated with tenant_id, and their rows copied under 'default'.
      for (const [table] of legacyTables) {
        this.db.exec(`ALTER TABLE ${table} RENAME TO ${table}_pre_tenant`);
      }
      this.createTables();
      this.addColumnIfMissing("accounts", "calendar_fingerprint", "TEXT");
      for (const [table, columns] of legacyTables) {
        this.db.exec(
          `INSERT INTO ${table} (tenant_id, ${columns})
           SELECT 'default', ${columns} FROM ${table}_pre_tenant;
           DROP TABLE ${table}_pre_tenant;`,
        );
      }
    })();
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    const columns = this.db.pragma(`table_info(${table})`) as { name: string }[];
    if (!columns.some((existing) => existing.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
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
      CREATE TABLE IF NOT EXISTS accounts (
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('personal', 'work')),
        calendar_id TEXT NOT NULL,
        authorized_at TEXT NOT NULL,
        verified_at TEXT,
        -- SHA-256 of the calendar the account resolved to; equality only.
        calendar_fingerprint TEXT,
        PRIMARY KEY (tenant_id, role)
      );

      CREATE TABLE IF NOT EXISTS event_mappings (
        mapping_key TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        source_role TEXT NOT NULL CHECK (source_role IN ('personal', 'work')),
        source_event_id TEXT NOT NULL,
        destination_event_id TEXT NOT NULL,
        source_etag TEXT,
        destination_etag TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, source_role, source_event_id)
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS exclusion_keys (
        tenant_id TEXT NOT NULL,
        value TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('personalToWork', 'workToPersonal')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, value)
      );

      CREATE TABLE IF NOT EXISTS exclusion_keywords (
        tenant_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('personalToWork', 'workToPersonal')),
        keyword TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, direction, keyword)
      );

      CREATE TABLE IF NOT EXISTS watch_channels (
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('personal', 'work')),
        calendar_id TEXT NOT NULL,
        channel_id TEXT NOT NULL UNIQUE,
        resource_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        address TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, role)
      );
    `);
  }
}

/** Column lists (minus tenant_id) used to copy rows out of pre-tenant tables. */
const PRE_TENANT_COLUMNS: Record<string, string> = {
  accounts: "role, calendar_id, authorized_at, verified_at",
  event_mappings:
    "mapping_key, source_role, source_event_id, destination_event_id, source_etag, destination_etag, updated_at",
  exclusion_keys: "value, direction, created_at",
  exclusion_keywords: "direction, keyword, created_at",
  watch_channels:
    "role, calendar_id, channel_id, resource_id, token_hash, address, expires_at, created_at",
};

const WATCH_CHANNEL_COLUMNS = `SELECT tenant_id, role, calendar_id, channel_id, resource_id,
        token_hash, address, expires_at, created_at
 FROM watch_channels`;

function watchChannelFromRow(row: WatchChannelRow): WatchChannelRecord {
  return {
    tenantId: row.tenant_id,
    role: row.role,
    calendarId: row.calendar_id,
    channelId: row.channel_id,
    resourceId: row.resource_id,
    tokenHash: row.token_hash,
    address: row.address,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
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
    sourceRole: row.source_role,
    sourceEventId: row.source_event_id,
    destinationEventId: row.destination_event_id,
    sourceEtag: row.source_etag,
    destinationEtag: row.destination_etag,
    updatedAt: row.updated_at,
  };
}
