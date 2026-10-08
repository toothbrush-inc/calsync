import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { StateDatabase } from "../src/storage/database.js";

describe("StateDatabase", () => {
  it("stores non-secret account metadata and updates verification", () => {
    const database = new StateDatabase(":memory:");
    const authorizedAt = new Date("2026-08-10T20:00:00.000Z");

    database.upsertAccount("personal", "primary", authorizedAt);
    database.markAccountVerified("personal", new Date("2026-08-10T20:05:00.000Z"));

    expect(database.getAccount("personal")).toEqual({
      tenantId: "default",
      role: "personal",
      calendarId: "primary",
      authorizedAt: authorizedAt.toISOString(),
      verifiedAt: "2026-08-10T20:05:00.000Z",
    });
    database.close();
  });

  it("scopes rows by tenant so tenants never see each other's state", () => {
    const database = new StateDatabase(":memory:", "acme");
    database.upsertAccount("personal", "acme-calendar");
    database.putMapping({
      mappingKey: "acme-mapping-key",
      destinationKey: "work",
      destinationEventId: "destination-id",
      destinationEtag: null,
      updatedAt: "2026-08-10T20:00:00.000Z",
    });

    expect(database.getAccount("personal", "default")).toBeNull();
    expect(database.getAccount("personal")?.tenantId).toBe("acme");
    expect(database.getMapping("acme-mapping-key", "default")).toBeNull();
    expect(database.listMappings(undefined, "acme")).toHaveLength(1);
    expect(database.listMappings(undefined, "default")).toHaveLength(0);
    expect(database.listMappings("work")).toHaveLength(1);
    expect(database.listMappings("personal")).toHaveLength(0);
    database.close();
  });

  it("discovers ready tenants and finds watch channels across tenants", () => {
    const database = new StateDatabase(":memory:");
    database.upsertAccount("personal", "half-authorized");
    database.upsertAccount("personal", "acme-personal", new Date(), "acme");
    database.upsertAccount("work", "acme-work", new Date(), "acme");

    expect(database.listReadyTenants()).toEqual(["acme"]);

    database.upsertWatchChannel(
      {
        tenantId: "acme",
        calendarKey: "personal",
        calendarId: "acme-personal",
        channelId: "channel-acme",
        resourceId: "resource-acme",
        tokenHash: "ab",
        address: "https://calsync.example.test/gcal/webhook",
        expiresAt: "2026-09-01T00:00:00.000Z",
        createdAt: "2026-08-28T00:00:00.000Z",
      },
      "acme",
    );
    // The lookup is cross-tenant: this instance is scoped to "default".
    expect(database.getWatchChannelByChannelId("channel-acme")?.tenantId).toBe("acme");
    database.close();
  });

  it("migrates a pre-tenant database under the default tenant", () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-migrate-"));
    const path = join(directory, "state.sqlite");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE accounts (
        role TEXT PRIMARY KEY CHECK (role IN ('personal', 'work')),
        calendar_id TEXT NOT NULL,
        authorized_at TEXT NOT NULL,
        verified_at TEXT
      );
      CREATE TABLE event_mappings (
        mapping_key TEXT PRIMARY KEY,
        source_role TEXT NOT NULL CHECK (source_role IN ('personal', 'work')),
        source_event_id TEXT NOT NULL,
        destination_event_id TEXT NOT NULL,
        source_etag TEXT,
        destination_etag TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (source_role, source_event_id)
      );
      INSERT INTO accounts VALUES ('personal', 'primary', '2026-08-10T20:00:00.000Z', NULL);
      INSERT INTO event_mappings VALUES
        ('legacy-key', 'work', 'source-id', 'destination-id', NULL, NULL, '2026-08-10T20:00:00.000Z');
    `);
    legacy.close();

    const database = new StateDatabase(path);
    try {
      expect(database.getAccount("personal")).toMatchObject({
        tenantId: "default",
        calendarId: "primary",
      });
      // Sourced from work, so the block sits on personal.
      expect(database.getMapping("legacy-key")).toMatchObject({
        destinationKey: "personal",
        destinationEventId: "destination-id",
      });
      // Re-opening must not attempt the rebuild again.
      const reopened = new StateDatabase(path);
      expect(reopened.listMappings()).toHaveLength(1);
      reopened.close();
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("re-keys role-era mappings and exclusions by calendar, keeping their meaning", () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-role-keyed-"));
    const path = join(directory, "state.sqlite");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE event_mappings (
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
      CREATE TABLE exclusion_keys (
        tenant_id TEXT NOT NULL,
        value TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('personalToWork', 'workToPersonal')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, value)
      );
      CREATE TABLE exclusion_keywords (
        tenant_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('personalToWork', 'workToPersonal')),
        keyword TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, direction, keyword)
      );
      INSERT INTO event_mappings VALUES
        ('block-on-work', 'acme', 'personal', 'k1', 'dest-1', NULL, '"e1"', '2026-08-10T20:00:00.000Z'),
        ('block-on-personal', 'acme', 'work', 'k2', 'dest-2', NULL, NULL, '2026-08-10T20:00:00.000Z');
      INSERT INTO exclusion_keys VALUES
        ('acme', 'calsync-exclude:v1:p2w:occ:x', 'personalToWork', '2026-08-10T20:00:00.000Z');
      INSERT INTO exclusion_keywords VALUES
        ('acme', 'workToPersonal', 'confidential', '2026-08-10T20:00:00.000Z');
    `);
    legacy.close();

    const database = new StateDatabase(path, "acme");
    try {
      expect(database.listMappings("work")).toEqual([
        expect.objectContaining({
          mappingKey: "block-on-work",
          destinationEventId: "dest-1",
          destinationEtag: '"e1"',
        }),
      ]);
      expect(database.listMappings("personal").map((mapping) => mapping.mappingKey)).toEqual([
        "block-on-personal",
      ]);
      expect(database.listExclusionKeys()).toEqual([
        expect.objectContaining({ sourceKey: "personal", value: "calsync-exclude:v1:p2w:occ:x" }),
      ]);
      expect(database.listExclusionKeywords()).toEqual([
        expect.objectContaining({ sourceKey: "work", keyword: "confidential" }),
      ]);
      // A third calendar's keys fit the new columns.
      expect(database.addExclusionKeyword("calendar-family", "soccer")).toBe(true);
      const reopened = new StateDatabase(path, "acme");
      expect(reopened.listMappings()).toHaveLength(2);
      reopened.close();
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("upserts mappings and sync state for reconciliation consumers", () => {
    const database = new StateDatabase(":memory:");

    database.putMapping({
      mappingKey: "opaque-mapping-key",
      destinationKey: "work",
      destinationEventId: "destination-id",
      destinationEtag: null,
      updatedAt: "2026-08-10T20:00:00.000Z",
    });
    database.setState("work:page-token", "token-value");
    database.setStates({
      "incremental:sync-token:personal": "personal-token",
      "incremental:sync-token:work": "work-token",
    });

    expect(database.getMapping("opaque-mapping-key")).toMatchObject({
      destinationKey: "work",
      destinationEventId: "destination-id",
    });
    expect(database.listMappings("work")).toHaveLength(1);
    expect(database.getState("work:page-token")).toBe("token-value");
    expect(database.getState("incremental:sync-token:personal")).toBe("personal-token");
    database.deleteState("incremental:sync-token:personal");
    expect(database.getState("incremental:sync-token:personal")).toBeNull();
    database.close();
  });

  it("stores CLI exclusion keys and keywords without event details", () => {
    const database = new StateDatabase(":memory:");
    const key = `calsync-exclude:v1:w2p:series:${"c".repeat(43)}`;

    expect(database.addExclusionKeyword("personal", "dentist")).toBe(true);
    expect(database.addExclusionKeyword("personal", "dentist")).toBe(false);
    expect(database.addExclusionKey("work", key)).toBe(true);
    expect(database.listExclusionKeywords()).toEqual([
      expect.objectContaining({ sourceKey: "personal", keyword: "dentist" }),
    ]);
    expect(database.listExclusionKeys()).toEqual([
      expect.objectContaining({ sourceKey: "work", value: key }),
    ]);
    expect(database.removeExclusionKeyword("personal", "dentist")).toBe(true);
    expect(database.removeExclusionKey(key)).toBe(true);
    expect(database.listExclusionKeywords()).toEqual([]);
    expect(database.listExclusionKeys()).toEqual([]);
    database.close();
  });

  it("refuses the account that would complete a calendar pair another tenant already syncs", () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-pair-"));
    const path = join(directory, "state.sqlite3");
    const first = new StateDatabase(path, "first");
    const second = new StateDatabase(path, "second");
    try {
      expect(first.adoptAccount("personal", "primary", "fp-home")).toEqual({ adopted: true });
      expect(first.adoptAccount("work", "primary", "fp-office")).toEqual({ adopted: true });

      // One shared calendar is fine: only the same pair is a conflict.
      expect(second.adoptAccount("personal", "primary", "fp-home")).toEqual({ adopted: true });
      expect(second.adoptAccount("work", "primary", "fp-office")).toEqual({
        adopted: false,
        refusal: { added: false, reason: "conflict", tenant: "first" },
      });
      expect(second.getAccount("work")).toBeNull();
      expect(second.listReadyTenants()).toEqual(["first"]);

      // A different second calendar completes a different pair.
      expect(second.adoptAccount("work", "primary", "fp-other-office")).toEqual({ adopted: true });
      expect(second.listReadyTenants()).toEqual(["first", "second"]);

      // Roles swapped is still the same two calendars.
      const third = new StateDatabase(path, "third");
      expect(third.adoptAccount("work", "primary", "fp-home")).toEqual({ adopted: true });
      expect(third.adoptAccount("personal", "primary", "fp-office")).toEqual({
        adopted: false,
        refusal: { added: false, reason: "conflict", tenant: "first" },
      });
      // An unidentifiable calendar cannot be compared, so it is let through.
      expect(third.adoptAccount("personal", "primary", undefined)).toEqual({ adopted: true });
      third.close();

      // Once the first tenant is gone, the pair is free again.
      first.deleteAccount("personal");
      first.deleteAccount("work");
      expect(second.adoptAccount("work", "primary", "fp-office")).toEqual({ adopted: true });
    } finally {
      first.close();
      second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("backfills fingerprints on rows that predate the guard and reports an established clash", () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-backfill-"));
    const path = join(directory, "state.sqlite3");
    // A database written before the fingerprint column existed.
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE accounts (
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('personal', 'work')),
        calendar_id TEXT NOT NULL,
        authorized_at TEXT NOT NULL,
        verified_at TEXT,
        PRIMARY KEY (tenant_id, role)
      );
      INSERT INTO accounts VALUES
        ('default', 'personal', 'primary', '2026-08-21T00:00:00.000Z', NULL),
        ('default', 'work', 'primary', '2026-08-21T00:00:00.000Z', NULL),
        ('second', 'personal', 'primary', '2026-09-16T00:00:00.000Z', NULL),
        ('second', 'work', 'primary', '2026-09-16T00:00:00.000Z', NULL);
    `);
    legacy.close();

    const first = new StateDatabase(path);
    const second = new StateDatabase(path, "second");
    try {
      const verifiedAt = new Date("2026-09-18T12:00:00.000Z");
      expect(first.verifyAccount("personal", "fp-home", verifiedAt)).toBeUndefined();
      expect(first.verifyAccount("work", "fp-office", verifiedAt)).toBeUndefined();
      expect(first.getAccount("work")?.verifiedAt).toBe(verifiedAt.toISOString());

      // Established tenants are warned about, never refused or unseated.
      expect(second.verifyAccount("personal", "fp-home")).toBeUndefined();
      expect(second.verifyAccount("work", "fp-office")).toBe("default");
      expect(first.verifyAccount("work", "fp-office")).toBe("second");
      expect(second.listReadyTenants()).toEqual(["default", "second"]);
      // A check that could not identify the calendar keeps the stored fingerprint.
      expect(first.verifyAccount("work", undefined)).toBeUndefined();
      expect(second.verifyAccount("work", "fp-office")).toBe("default");
    } finally {
      first.close();
      second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes account metadata without affecting the other role", () => {
    const database = new StateDatabase(":memory:");
    database.upsertAccount("personal", "primary");
    database.upsertAccount("work", "primary");

    database.deleteAccount("personal");

    expect(database.getAccount("personal")).toBeNull();
    expect(database.getAccount("work")).not.toBeNull();
    database.close();
  });

  it("lets a second connection read while WAL is enabled", () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-wal-"));
    const path = join(directory, "state.sqlite");
    const writer = new StateDatabase(path);
    writer.setState("incremental:last-full-sync", "2026-08-14T12:00:00.000Z");
    const reader = new StateDatabase(path);
    try {
      expect(reader.getState("incremental:last-full-sync")).toBe("2026-08-14T12:00:00.000Z");
    } finally {
      reader.close();
      writer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
