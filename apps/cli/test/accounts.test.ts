import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { google, type calendar_v3 } from "googleapis";
import { describe, expect, it, vi } from "vitest";

import {
  calendarKeyFor,
  calendarLabel,
  CalendarRefError,
  resolveAccountRef,
  resolveCalendarRef,
} from "../src/calendars.js";
import { MAX_CALENDARS } from "../src/config.js";
import { AuthenticationError, GoogleAuthService } from "../src/google/auth.js";
import { StateDatabase, type CalendarInput } from "../src/storage/database.js";
import type { TokenStore } from "../src/storage/keychain.js";

const NOW = new Date("2026-10-08T12:00:00.000Z");

function calendar(key: string, fingerprint: string, extra: Partial<CalendarInput> = {}) {
  return { key, account: "account1", calendarId: `${key}@example.test`, fingerprint, ...extra };
}

describe("accounts and calendars storage", () => {
  it("moves role-era accounts and watch channels onto sign-ins and calendars", () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-accounts-"));
    const path = join(directory, "state.sqlite");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE accounts (
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('personal', 'work')),
        calendar_id TEXT NOT NULL,
        authorized_at TEXT NOT NULL,
        verified_at TEXT,
        calendar_fingerprint TEXT,
        PRIMARY KEY (tenant_id, role)
      );
      CREATE TABLE watch_channels (
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
      INSERT INTO accounts VALUES
        ('acme', 'personal', 'primary', '2026-08-01T00:00:00.000Z', NULL, 'fp-home'),
        ('acme', 'work', 'primary', '2026-08-02T00:00:00.000Z', '2026-08-03T00:00:00.000Z', 'fp-office');
      INSERT INTO watch_channels VALUES
        ('acme', 'work', 'primary', 'channel-1', 'resource-1', 'hash', 'https://x', '2026-09-01T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
    `);
    legacy.close();

    const state = new StateDatabase(path, "acme");
    try {
      expect(state.listGoogleAccounts().map((account) => account.slot)).toEqual([
        "personal",
        "work",
      ]);
      expect(state.listCalendars()).toEqual([
        expect.objectContaining({ key: "personal", account: "personal", calendarId: "primary" }),
        expect.objectContaining({ key: "work", account: "work", source: true, destination: true }),
      ]);
      // The role API still reads them, so role-based surfaces keep working.
      expect(state.getAccount("work")).toMatchObject({
        role: "work",
        calendarId: "primary",
        verifiedAt: "2026-08-03T00:00:00.000Z",
      });
      expect(state.getWatchChannel("work")).toMatchObject({
        calendarKey: "work",
        channelId: "channel-1",
      });
      // The fingerprints came along, so the duplicate guard knows these calendars.
      expect(state.addCalendar(calendar("cal-again", "fp-office"))).toEqual({
        added: false,
        reason: "duplicate",
        key: "work",
      });
      expect(state.listReadyTenants()).toEqual(["acme"]);
      const reopened = new StateDatabase(path, "acme");
      expect(reopened.listCalendars()).toHaveLength(2);
      reopened.close();
    } finally {
      state.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("migrates two roles that point at the same calendar, keeping the first fingerprint", () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-same-pair-"));
    const path = join(directory, "state.sqlite");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE accounts (
        tenant_id TEXT NOT NULL, role TEXT NOT NULL, calendar_id TEXT NOT NULL,
        authorized_at TEXT NOT NULL, verified_at TEXT, calendar_fingerprint TEXT,
        PRIMARY KEY (tenant_id, role)
      );
      INSERT INTO accounts VALUES
        ('default', 'personal', 'primary', '2026-08-01T00:00:00.000Z', NULL, 'fp-same'),
        ('default', 'work', 'primary', '2026-08-01T00:00:00.000Z', NULL, 'fp-same'),
        ('other', 'personal', 'primary', '2026-08-01T00:00:00.000Z', NULL, 'fp-same');
    `);
    legacy.close();
    const state = new StateDatabase(path);
    try {
      expect(state.listCalendars().map((entry) => entry.key)).toEqual(["personal", "work"]);
      // Verifying work with the shared fingerprint is reported, not a crash.
      expect(() => {
        state.verifyCalendar("work", { fingerprint: "fp-same" });
      }).not.toThrow();
      expect(state.calendarRefusal("cal-new", "fp-same")).toEqual({
        added: false,
        reason: "duplicate",
        key: "personal",
      });
      expect(state.listCalendars("other")).toHaveLength(1);
    } finally {
      state.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("says why a calendar would be refused before anything is written", () => {
    const state = new StateDatabase(":memory:");
    state.addCalendar(calendar("personal", "fp-home"));
    expect(state.calendarRefusal("work", "fp-home")).toMatchObject({ reason: "duplicate" });
    expect(state.calendarRefusal("work", "fp-office")).toBeUndefined();
    expect(state.listCalendars()).toHaveLength(1);
    state.close();
  });

  it("refuses a calendar this tenant already syncs, under any key or account (#10)", () => {
    const state = new StateDatabase(":memory:");
    expect(state.addCalendar(calendar("cal-family", "fp-family"), NOW)).toEqual({ added: true });
    expect(
      state.addCalendar(calendar("cal-family-again", "fp-family", { account: "account2" })),
    ).toEqual({ added: false, reason: "duplicate", key: "cal-family" });
    // The same key again is an update, not a second copy.
    expect(state.addCalendar(calendar("cal-family", "fp-family", { name: "Family" }))).toEqual({
      added: true,
    });
    expect(state.getCalendar("cal-family")?.name).toBe("Family");
    state.close();
  });

  it(`caps a tenant at ${String(MAX_CALENDARS)} calendars, without counting an update`, () => {
    const state = new StateDatabase(":memory:");
    for (let index = 0; index < MAX_CALENDARS; index += 1) {
      expect(state.addCalendar(calendar(`cal-${String(index)}`, `fp-${String(index)}`))).toEqual({
        added: true,
      });
    }
    expect(state.addCalendar(calendar("cal-extra", "fp-extra"))).toEqual({
      added: false,
      reason: "limit",
    });
    expect(state.addCalendar(calendar("cal-0", "fp-0", { destination: false }))).toEqual({
      added: true,
    });
    expect(state.getCalendar("cal-0")?.destination).toBe(false);
    state.close();
  });

  it("refuses a calendar another tenant syncs together with one of ours, not one alone", () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-overlap-"));
    const path = join(directory, "state.sqlite");
    const first = new StateDatabase(path, "first");
    const second = new StateDatabase(path, "second");
    try {
      first.addCalendar(calendar("cal-home", "fp-home"));
      first.addCalendar(calendar("cal-office", "fp-office"));
      first.addCalendar(calendar("cal-family", "fp-family"));

      // Sharing one calendar (a family calendar two people both mirror into) is fine.
      expect(second.addCalendar(calendar("cal-family", "fp-family"))).toEqual({ added: true });
      expect(second.addCalendar(calendar("cal-mine", "fp-mine"))).toEqual({ added: true });
      // A second shared one would mirror the same events twice.
      expect(second.addCalendar(calendar("cal-home", "fp-home"))).toEqual({
        added: false,
        reason: "conflict",
        tenant: "first",
      });
    } finally {
      first.close();
      second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("forgets everything kept for a removed calendar, and nothing of the others", () => {
    const state = new StateDatabase(":memory:");
    state.addCalendar(calendar("cal-a", "fp-a"));
    state.addCalendar(calendar("cal-b", "fp-b"));
    for (const key of ["cal-a", "cal-b"]) {
      state.putMapping({
        mappingKey: `block-${key}`,
        destinationKey: key,
        destinationEventId: `event-${key}`,
        destinationEtag: null,
        updatedAt: NOW.toISOString(),
      });
      state.addExclusionKeyword(key, "dentist");
      state.setState(`incremental:sync-token:${key}`, "token");
      state.upsertWatchChannel(
        {
          tenantId: "default",
          calendarKey: key,
          calendarId: `${key}@example.test`,
          channelId: `channel-${key}`,
          resourceId: "resource",
          tokenHash: "hash",
          address: "https://x",
          expiresAt: NOW.toISOString(),
          createdAt: NOW.toISOString(),
        },
        "default",
      );
    }

    state.removeCalendar("cal-a", ["incremental:sync-token:cal-a"]);

    expect(state.listCalendars().map((entry) => entry.key)).toEqual(["cal-b"]);
    expect(state.listMappings().map((mapping) => mapping.destinationKey)).toEqual(["cal-b"]);
    expect(state.listExclusionKeywords().map((row) => row.sourceKey)).toEqual(["cal-b"]);
    expect(state.listWatchChannels().map((channel) => channel.calendarKey)).toEqual(["cal-b"]);
    expect(state.getState("incremental:sync-token:cal-a")).toBeNull();
    expect(state.getState("incremental:sync-token:cal-b")).toBe("token");
    expect(state.listReadyTenants()).toEqual([]);
    state.close();
  });

  it("keeps an account's email once known, and finds the account by it", () => {
    const state = new StateDatabase(":memory:");
    state.upsertGoogleAccount("account1", " Someone@Example.TEST ", NOW);
    state.upsertGoogleAccount("account1", null, NOW);
    expect(state.getGoogleAccount("account1")?.email).toBe("someone@example.test");
    expect(state.findGoogleAccountByEmail("SOMEONE@example.test")?.slot).toBe("account1");
    state.deleteGoogleAccount("account1");
    expect(state.listGoogleAccounts()).toEqual([]);
    state.close();
  });
});

describe("calendar names", () => {
  const accounts = [
    {
      tenantId: "default",
      slot: "personal",
      email: "me@gmail.test",
      authorizedAt: "",
      verifiedAt: null,
    },
    {
      tenantId: "default",
      slot: "account1",
      email: "me@work.test",
      authorizedAt: "",
      verifiedAt: null,
    },
    { tenantId: "default", slot: "work", email: null, authorizedAt: "", verifiedAt: null },
  ];
  const record = (key: string, account: string, calendarId: string, name: string | null) => ({
    tenantId: "default",
    key,
    account,
    calendarId,
    name,
    accessRole: "owner",
    source: true,
    destination: true,
    addedAt: "",
    verifiedAt: null,
  });
  const calendars = [
    record("personal", "personal", "primary", "me@gmail.test"),
    record("cal-team", "account1", "team@group.test", "Team"),
    record("cal-mine", "account1", "me@work.test", "me@work.test"),
    record("work", "work", "primary", null),
  ];

  it("derives a stable, opaque key from the resolved calendar id", () => {
    expect(calendarKeyFor("Team@Group.test")).toBe(calendarKeyFor(" team@group.test "));
    expect(calendarKeyFor("team@group.test")).toMatch(/^cal-[0-9a-f]{12}$/u);
    expect(calendarKeyFor("team@group.test")).not.toContain("team");
  });

  it("names a calendar by its account, and by name unless it is the account's own", () => {
    expect(calendars.map((entry) => calendarLabel(entry, accounts))).toEqual([
      "me@gmail.test",
      "me@work.test / Team",
      "me@work.test",
      // Signed in before emails were kept and not checked since.
      "work",
    ]);
  });

  it("resolves what a person types to one calendar", () => {
    expect(resolveCalendarRef("me@work.test/team", calendars, accounts).key).toBe("cal-team");
    expect(resolveCalendarRef("ME@work.test / Team", calendars, accounts).key).toBe("cal-team");
    expect(resolveCalendarRef("me@work.test", calendars, accounts).key).toBe("cal-mine");
    expect(resolveCalendarRef("team@group.test", calendars, accounts).key).toBe("cal-team");
    expect(resolveCalendarRef("work", calendars, accounts).key).toBe("work");
    expect(() => resolveCalendarRef("me@work.test/Nope", calendars, accounts)).toThrow(
      CalendarRefError,
    );
    expect(resolveAccountRef("ME@work.test", accounts).slot).toBe("account1");
    expect(() => resolveAccountRef("nobody@x.test", accounts)).toThrow(/signed in: /u);
  });
});

/** The Calendar API surface the account flows use, faked per account. */
class FakeAuth extends GoogleAuthService {
  constructor(
    state: StateDatabase,
    tokens: TokenStore,
    private readonly lists: Record<string, calendar_v3.Schema$CalendarListEntry[]>,
  ) {
    super({ clientId: "client", clientSecret: "secret" }, tokens, state);
  }

  protected override calendarApi(slot: string): Promise<calendar_v3.Calendar> {
    const entries = this.lists[slot];
    if (entries === undefined) {
      return Promise.reject(new AuthenticationError(`${slot} is not authorized`));
    }
    const find = (calendarId: string) =>
      entries.find(
        (entry) => entry.id === calendarId || (calendarId === "primary" && entry.primary),
      );
    return Promise.resolve({
      calendarList: {
        get: ({ calendarId }: { calendarId: string }) => {
          const entry = find(calendarId);
          return entry === undefined
            ? Promise.reject(Object.assign(new Error("Not Found"), { code: 404 }))
            : Promise.resolve({ data: entry });
        },
        list: () => Promise.resolve({ data: { items: entries } }),
      },
    } as unknown as calendar_v3.Calendar);
  }
}

function tokenStore(): TokenStore & { stored: Map<string, string> } {
  const stored = new Map<string, string>();
  return {
    stored,
    getRefreshToken: (slot) => Promise.resolve(stored.get(slot) ?? null),
    setRefreshToken: (slot, token) => {
      stored.set(slot, token);
      return Promise.resolve();
    },
    deleteRefreshToken: (slot) => Promise.resolve(stored.delete(slot)),
  };
}

const WORK_CALENDARS: calendar_v3.Schema$CalendarListEntry[] = [
  { id: "me@work.test", summary: "me@work.test", accessRole: "owner", primary: true },
  { id: "team@group.test", summary: "Team", accessRole: "writer" },
  { id: "holidays@group.test", summary: "Holidays", accessRole: "reader" },
  { id: "boss@work.test", summary: "Boss", accessRole: "freeBusyReader" },
];

describe("account and calendar connection", () => {
  it("gives a new account the first free slot, and an account signed in again its own", async () => {
    const state = new StateDatabase(":memory:");
    const tokens = tokenStore();
    const auth = new FakeAuth(state, tokens, {});

    expect(await auth.adoptAccountToken("me@work.test", "token-1")).toMatchObject({
      slot: "account1",
      email: "me@work.test",
    });
    expect(await auth.adoptAccountToken("other@x.test", "token-2")).toMatchObject({
      slot: "account2",
    });
    expect(await auth.adoptAccountToken("ME@work.test", "token-3")).toMatchObject({
      slot: "account1",
    });
    expect(tokens.stored.get("account1")).toBe("token-3");
    expect(state.listGoogleAccounts()).toHaveLength(2);
    state.close();
  });

  it("refuses a seventh added account", async () => {
    const state = new StateDatabase(":memory:");
    const auth = new FakeAuth(state, tokenStore(), {});
    for (let index = 1; index <= 6; index += 1) {
      await auth.adoptAccountToken(`user${String(index)}@x.test`, "token");
    }
    await expect(auth.adoptAccountToken("user7@x.test", "token")).rejects.toThrow(/at most 6/u);
    state.close();
  });

  it("lists every calendar with what calsync could do with it", async () => {
    const state = new StateDatabase(":memory:");
    const auth = new FakeAuth(state, tokenStore(), { account1: WORK_CALENDARS });
    expect(await auth.availableCalendars("account1")).toEqual([
      expect.objectContaining({ calendarId: "me@work.test", primary: true, writable: true }),
      expect.objectContaining({ name: "Boss", writable: false, readable: false }),
      expect.objectContaining({ name: "Holidays", writable: false, readable: true }),
      expect.objectContaining({ name: "Team", writable: true, readable: true }),
    ]);
    state.close();
  });

  it("adds a writable calendar, a read-only one as a source only, and refuses the rest", async () => {
    const state = new StateDatabase(":memory:");
    state.upsertGoogleAccount("account1", "me@work.test", NOW);
    const auth = new FakeAuth(state, tokenStore(), { account1: WORK_CALENDARS });

    const team = await auth.connectCalendar("account1", "team@group.test");
    expect(team).toMatchObject({
      key: calendarKeyFor("team@group.test"),
      account: "account1",
      name: "Team",
      source: true,
      destination: true,
    });
    await expect(auth.connectCalendar("account1", "holidays@group.test")).rejects.toThrow(
      /--source-only/u,
    );
    expect(
      await auth.connectCalendar("account1", "holidays@group.test", {
        source: true,
        destination: false,
      }),
    ).toMatchObject({ source: true, destination: false });
    // Free/busy access shows busy times but not events, so there is nothing to read.
    await expect(
      auth.connectCalendar("account1", "boss@work.test", { source: true, destination: false }),
    ).rejects.toThrow(/cannot read/u);
    await expect(auth.connectCalendar("account1", "team@group.test")).resolves.toMatchObject({
      key: team.key,
    });
    expect(state.listCalendars()).toHaveLength(2);
    state.close();
  });

  it("refuses the same calendar reached through a second account (#10)", async () => {
    const state = new StateDatabase(":memory:");
    state.upsertGoogleAccount("account1", "me@work.test", NOW);
    state.upsertGoogleAccount("account2", "colleague@work.test", NOW);
    const auth = new FakeAuth(state, tokenStore(), {
      account1: WORK_CALENDARS,
      account2: [
        { id: "colleague@work.test", accessRole: "owner", primary: true },
        { id: "team@group.test", summary: "Team (shared)", accessRole: "writer" },
      ],
    });
    await auth.connectCalendar("account1", "team@group.test");
    await expect(auth.connectCalendar("account2", "team@group.test")).rejects.toThrow(
      /already synced through me@work\.test/u,
    );
    expect(state.listCalendars()).toEqual([
      expect.objectContaining({ key: calendarKeyFor("team@group.test"), account: "account1" }),
    ]);
    state.close();
  });

  it("learns a sign-in's email when checking it, and reports one that fails", async () => {
    const state = new StateDatabase(":memory:");
    state.upsertGoogleAccount("personal", null, NOW);
    state.upsertGoogleAccount("account1", "gone@x.test", NOW);
    const auth = new FakeAuth(state, tokenStore(), {
      personal: [{ id: "Me@Gmail.test", accessRole: "owner", primary: true }],
    });
    expect(await auth.checkAccount("personal")).toMatchObject({
      email: "me@gmail.test",
      valid: true,
    });
    expect(state.getGoogleAccount("personal")?.email).toBe("me@gmail.test");
    expect(await auth.checkAccount("account1")).toMatchObject({
      email: "gone@x.test",
      valid: false,
    });
    state.close();
  });

  it("flags a destination calendar that lost write access", async () => {
    const state = new StateDatabase(":memory:");
    state.upsertGoogleAccount("account1", "me@work.test", NOW);
    const lists = { account1: [...WORK_CALENDARS] };
    const auth = new FakeAuth(state, tokenStore(), lists);
    const team = await auth.connectCalendar("account1", "team@group.test");
    lists.account1 = lists.account1.map((entry) =>
      entry.id === "team@group.test" ? { ...entry, accessRole: "reader" } : entry,
    );
    expect(await auth.checkCalendar(team)).toMatchObject({
      valid: false,
      message: expect.stringContaining("no longer writable") as unknown,
    });
    state.close();
  });

  it("does not re-add a role calendar that was removed when its status is checked", async () => {
    const state = new StateDatabase(":memory:");
    state.adoptAccount("personal", "primary", "fp-home", NOW);
    state.removeCalendar("personal", []);
    const auth = new FakeAuth(state, tokenStore(), {});
    const status = await auth.getStatus("personal", "primary");
    expect(status).toMatchObject({
      valid: false,
      message: expect.stringContaining("not synced") as unknown,
    });
    expect(state.listCalendars()).toEqual([]);
    state.close();
  });

  it("checks a role calendar through the sign-in it moved to", async () => {
    const state = new StateDatabase(":memory:");
    state.adoptAccount("personal", "primary", "fp-home", NOW);
    state.upsertGoogleAccount("personal", "me@work.test", NOW);
    // Reconnected through the gateway: a fresh slot, adopted by email.
    state.upsertGoogleAccount("account2", "me@work.test", NOW);
    state.moveGoogleAccount("personal", "account2");
    const auth = new FakeAuth(state, tokenStore(), { account2: WORK_CALENDARS });
    await expect(auth.getStatus("personal", "primary")).resolves.toMatchObject({
      role: "personal",
      valid: true,
      account: "me@work.test",
      message: "readable and writable, signed in as me@work.test",
    });
    state.close();
  });

  it("refuses to log out a role whose sign-in serves other calendars", async () => {
    const state = new StateDatabase(":memory:");
    state.adoptAccount("personal", "primary", "fp-home", NOW);
    state.addCalendar({ key: "cal-family", account: "personal", calendarId: "family@group.test" });
    const tokens = tokenStore();
    tokens.stored.set("personal", "token");
    const auth = new FakeAuth(state, tokens, {});
    await expect(auth.logout("personal")).rejects.toThrow(/other calendars/u);
    expect(tokens.stored.get("personal")).toBe("token");
    state.close();
  });

  it("cleans up a role's calendar on logout, and revokes only an account no other sign-in uses", async () => {
    const revoke = vi
      .spyOn(google.auth.OAuth2.prototype, "revokeToken")
      .mockResolvedValue({} as never);
    const state = new StateDatabase(":memory:");
    state.adoptAccount("personal", "primary", "fp-home", NOW);
    state.adoptAccount("work", "primary", "fp-office", NOW);
    state.upsertGoogleAccount("personal", "me@home.test", NOW);
    state.upsertGoogleAccount("work", "me@work.test", NOW);
    // The same work account, signed in again for another tenant on this host.
    state.upsertGoogleAccount("work", "me@work.test", NOW, "other");
    const tokens = tokenStore();
    tokens.stored.set("personal", "home-token");
    tokens.stored.set("work", "work-token");
    const auth = new FakeAuth(state, tokens, {});
    const removed: string[] = [];
    const removeCalendar = (key: string) => {
      removed.push(key);
      state.removeCalendar(key, []);
      return Promise.resolve();
    };

    await expect(auth.logout("personal", removeCalendar)).resolves.toEqual({
      removed: true,
      revokeSkipped: false,
    });
    expect(revoke).toHaveBeenCalledWith("home-token");
    await expect(auth.logout("work", removeCalendar)).resolves.toEqual({
      removed: true,
      revokeSkipped: true,
    });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(removed).toEqual(["personal", "work"]);
    expect(state.listGoogleAccounts()).toEqual([]);
    revoke.mockRestore();
    state.close();
  });

  it("refuses an account's primary calendar its role already syncs as 'primary'", async () => {
    const state = new StateDatabase(":memory:");
    state.adoptAccount("personal", "primary", undefined, NOW);
    state.upsertGoogleAccount("personal", "me@work.test", NOW);
    const auth = new FakeAuth(state, tokenStore(), { personal: WORK_CALENDARS });
    await expect(auth.connectCalendar("personal", "me@work.test")).rejects.toThrow(
      /already connected/u,
    );
    await expect(auth.connectCalendar("personal", "team@group.test")).resolves.toMatchObject({
      account: "personal",
    });
    state.close();
  });

  it("adopts a gateway sign-in by the account it turns out to be", async () => {
    const state = new StateDatabase(":memory:");
    state.upsertGoogleAccount("personal", "me@gmail.test", NOW);
    state.addCalendar({ key: "personal", account: "personal", calendarId: "primary" });
    const tokens = tokenStore();
    tokens.stored.set("personal", "old-token");
    const auth = new FakeAuth(state, tokens, {
      account1: [{ id: "colleague@work.test", accessRole: "owner", primary: true }],
      account2: [{ id: "me@gmail.test", accessRole: "owner", primary: true }],
      personal: [{ id: "someone-else@x.test", accessRole: "owner", primary: true }],
    });

    expect(await auth.adoptSignIn("account1")).toMatchObject({
      status: "adopted",
      account: { slot: "account1", email: "colleague@work.test" },
    });
    // The same person again under a fresh slot: their calendars follow the new sign-in.
    expect(await auth.adoptSignIn("account2")).toMatchObject({ status: "replaced" });
    expect(state.getCalendar("personal")?.account).toBe("account2");
    expect(state.getGoogleAccount("personal")).toBeNull();
    expect(tokens.stored.has("personal")).toBe(false);
    // A slot recorded for one address is never rebound to another.
    state.upsertGoogleAccount("personal", "me-again@gmail.test", NOW);
    expect(await auth.adoptSignIn("personal")).toMatchObject({
      status: "mismatch",
      email: "someone-else@x.test",
    });
    expect(state.getGoogleAccount("personal")?.email).toBe("me-again@gmail.test");
    expect(await auth.adoptSignIn("account3")).toMatchObject({ status: "missing" });
    state.close();
  });

  it("keeps a free slot for each sign-in still in progress, across processes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "calsync-reserve-"));
    const path = join(directory, "state.sqlite");
    // The dashboard and the MCP server: two processes on one database.
    const dashboard = new StateDatabase(path);
    const assistant = new StateDatabase(path);
    dashboard.upsertGoogleAccount("account1", "a@x.test", NOW);
    const web = new FakeAuth(dashboard, tokenStore(), {});
    const mcp = new FakeAuth(assistant, tokenStore(), {
      account2: [{ id: "b@x.test", summary: "b@x.test", accessRole: "owner", primary: true }],
    });
    expect(web.reserveAccountSlot()).toBe("account2");
    expect(mcp.reserveAccountSlot()).toBe("account3");
    expect(web.freeAccountSlot()).toBe("account4");

    // The dashboard's sign-in finished; the MCP server's status records it.
    await expect(mcp.adoptReservedSignIns()).resolves.toMatchObject([{ status: "adopted" }]);
    expect(dashboard.getGoogleAccount("account2")?.email).toBe("b@x.test");
    expect(dashboard.listSignInReservations()).toEqual(["account3"]);
    // An unfinished one gives its slot back after an hour.
    expect(dashboard.listSignInReservations(new Date(Date.now() + 61 * 60_000))).toEqual([]);
    dashboard.close();
    assistant.close();
    rmSync(directory, { recursive: true });
  });

  it("remembers that a tenant signed in, even after it removed every sign-in", () => {
    const state = new StateDatabase(":memory:");
    expect(state.hasSignedIn()).toBe(false);
    state.upsertGoogleAccount("account1", "a@x.test", NOW);
    state.deleteGoogleAccount("account1");
    expect(state.hasSignedIn()).toBe(true);
    expect(state.hasSignedIn("other")).toBe(false);
    state.close();
  });

  it("forgets an unused sign-in locally without revoking it at Google", async () => {
    const state = new StateDatabase(":memory:");
    state.upsertGoogleAccount("account1", "me@work.test", NOW);
    const tokens = tokenStore();
    tokens.stored.set("account1", "token");
    const auth = new FakeAuth(state, tokens, { account1: WORK_CALENDARS });
    await auth.connectCalendar("account1", "team@group.test");
    await expect(auth.disconnectAccount("account1")).rejects.toThrow(/calendars first/u);

    state.removeCalendar(calendarKeyFor("team@group.test"), []);
    const revoke = vi.spyOn(GoogleAuthService.prototype, "logout");
    await auth.disconnectAccount("account1");
    expect(revoke).not.toHaveBeenCalled();
    expect(tokens.stored.has("account1")).toBe(false);
    expect(state.listGoogleAccounts()).toEqual([]);
    state.close();
  });
});
