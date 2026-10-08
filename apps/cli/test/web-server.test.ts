import { request as httpRequest } from "node:http";

import { describe, expect, it } from "vitest";

import type { ReconcileLog, ReconcileSourceDetail, StoredSyncSummary } from "@calsync/engine";

import type { ExclusionChangeResult, ExclusionSnapshot } from "../src/exclusions.js";
import type { AccountStatus, ConnectStartResult } from "../src/google/auth.js";
import type { CalendarRecord, GoogleAccountRecord } from "../src/storage/index.js";
import {
  calendarUrl,
  signWebToken,
  tenantForIdentity,
  verifyWebToken,
  webLink,
  WebServer,
  type WebDedupeView,
  type WebPreviewView,
  type WebServerOptions,
  type WebStatusView,
  type WebTenantRuntime,
} from "../src/web/server.js";
import { LockTimeoutError } from "../src/sync/service.js";
import { ScanGate, type ScanGateStore } from "../src/scanlimit.js";

/** The gate persists to `sync_state`; these tests only need it to remember. */
function memoryScanStore(): ScanGateStore {
  const rows = new Map<string, string>();
  return {
    getState: (key) => rows.get(key) ?? null,
    setState: (key, value) => {
      rows.set(key, value);
    },
  };
}

type FakeRuntime = WebTenantRuntime & {
  closed: boolean;
  everSignedIn: boolean;
  tenantId: string;
  signIns: GoogleAccountRecord[];
  calendars: CalendarRecord[];
  /** Slots handed to gateway sign-ins, as the shared database holds them. */
  reserved: string[];
  exclusionCalls: { action: "add" | "remove"; input: unknown }[];
  dedupeCalls: { dryRun: boolean; lockTimeoutMs: number }[];
  previewCalls: { lockTimeoutMs: number }[];
};

function signIn(tenantId: string, slot: string, email: string): GoogleAccountRecord {
  return {
    tenantId,
    slot,
    email,
    authorizedAt: "2026-08-28T10:00:00.000Z",
    verifiedAt: "2026-08-28T10:00:00.000Z",
  };
}

function calendarRecord(
  tenantId: string,
  key: string,
  account: string,
  calendarId: string,
  extra: Partial<CalendarRecord> = {},
): CalendarRecord {
  return {
    tenantId,
    key,
    account,
    calendarId,
    name: null,
    accessRole: "owner",
    source: true,
    destination: true,
    addedAt: "2026-08-28T10:00:00.000Z",
    verifiedAt: "2026-08-28T10:00:00.000Z",
    ...extra,
  };
}

const previewSource: ReconcileSourceDetail = {
  sourceKey: "personal",
  sourceTitle: "Dentist",
  timeRange: {
    kind: "timed",
    start: "2026-09-18T15:00:00-07:00",
    end: "2026-09-18T16:00:00-07:00",
  },
  exclusionKeys: {
    occurrence: "calsync-exclude:v1:p2w:occ:one",
    series: "calsync-exclude:v1:p2w:series:one",
  },
  isRecurring: true,
};

const duplicateRemoval: ReconcileLog = {
  operation: "delete",
  destinationKey: "work",
  reason: "duplicate-busy-block",
  timeRange: {
    kind: "timed",
    start: "2026-09-18T15:00:00-07:00",
    end: "2026-09-18T16:00:00-07:00",
  },
  dryRun: true,
};

function fakeRuntime(tenantId: string, overrides: Partial<WebTenantRuntime> = {}): FakeRuntime {
  const runtime: FakeRuntime = {
    tenantId,
    closed: false,
    everSignedIn: true,
    hasSignedIn: () => runtime.everSignedIn,
    signIns: [
      signIn(tenantId, "personal", `${tenantId}-personal@example.com`),
      signIn(tenantId, "work", `${tenantId}-work@example.com`),
    ],
    calendars: [
      calendarRecord(tenantId, "personal", "personal", "primary"),
      calendarRecord(tenantId, "work", "work", "primary"),
    ],
    getStatus: (role, calendarId) =>
      Promise.resolve<AccountStatus>({
        role,
        configured: false,
        valid: false,
        calendarId,
        message: "not authorized",
      }),
    startConnect: (role) =>
      Promise.resolve<ConnectStartResult>({
        provider: "google",
        slot: role,
        url: `https://accounts.google.com/consent/${tenantId}/${role}`,
        expiresAt: "2026-08-28T12:00:00.000Z",
      }),
    listGoogleAccounts: () => runtime.signIns,
    listCalendars: () => runtime.calendars,
    checkAccount: (slot) =>
      Promise.resolve({
        slot,
        email: runtime.signIns.find((entry) => entry.slot === slot)?.email ?? null,
        valid: true,
        message: "signed in",
      }),
    checkCalendar: (calendar) =>
      Promise.resolve({ calendar, valid: true, message: "readable and writable" }),
    reserved: [],
    freeAccountSlot: () =>
      ["account1", "account2", "account3"].find(
        (slot) =>
          !runtime.reserved.includes(slot) && !runtime.signIns.some((entry) => entry.slot === slot),
      ),
    reserveAccountSlot: () => {
      const slot = runtime.freeAccountSlot();
      if (slot !== undefined) {
        runtime.reserved.push(slot);
      }
      return slot;
    },
    adoptReservedSignIns: async () => {
      const adopted = [];
      for (const slot of [...runtime.reserved]) {
        adopted.push(await runtime.adoptSignIn(slot));
      }
      return adopted;
    },
    startAccountConnect: () =>
      Promise.resolve({
        slot: "account1",
        url: `https://accounts.google.com/consent/${tenantId}/account`,
        expiresAt: "2026-08-28T12:00:00.000Z",
      }),
    adoptSignIn: (slot) => {
      runtime.reserved = runtime.reserved.filter((reserved) => reserved !== slot);
      const account = signIn(tenantId, slot, `${slot}@example.com`);
      runtime.signIns.push(account);
      return Promise.resolve({ status: "adopted" as const, account });
    },
    availableCalendars: () =>
      Promise.resolve([
        {
          calendarId: "primary-id@example.com",
          name: "primary-id@example.com",
          accessRole: "owner",
          primary: true,
          writable: true,
          readable: true,
        },
        {
          calendarId: "team@group.example.com",
          name: "Team",
          accessRole: "reader",
          primary: false,
          writable: false,
          readable: true,
        },
      ]),
    connectCalendar: (slot, calendarId, roles) => {
      const added = calendarRecord(tenantId, "cal-team", slot, calendarId, {
        name: "Team",
        accessRole: "reader",
        source: roles.source,
        destination: roles.destination,
      });
      runtime.calendars.push(added);
      return Promise.resolve(added);
    },
    setCalendarRoles: (key, roles) => {
      runtime.calendars = runtime.calendars.map((calendar) =>
        calendar.key === key
          ? { ...calendar, source: roles.source, destination: roles.destination }
          : calendar,
      );
    },
    removeCalendar: (key) => {
      runtime.calendars = runtime.calendars.filter((calendar) => calendar.key !== key);
      return Promise.resolve({ created: 0, updated: 0, deleted: 3, repaired: 0 });
    },
    disconnectAccount: (slot) => {
      runtime.signIns = runtime.signIns.filter((entry) => entry.slot !== slot);
      return Promise.resolve();
    },
    syncSummary: (): StoredSyncSummary => ({
      lastFullSyncAt: "2026-08-28T09:00:00.000Z",
      lastResult: {
        created: 0,
        updated: 0,
        deleted: 0,
        repaired: 0,
        failed: 0,
        converged: true,
        destinations: {
          work: { active: 4, duplicateSuppressed: 0 },
          personal: { active: 2, duplicateSuppressed: 0 },
        },
        sources: {
          personal: { excluded: 1 },
          work: { excluded: 0 },
        },
      },
    }),
    listExclusions: (): ExclusionSnapshot => ({
      keywords: [
        { value: "dentist", source: "personal", origin: "cli" },
        { value: "confidential", source: "work", origin: "env" },
      ],
      keys: [{ value: "calsync-exclude:v1:p2w:occ:abc", source: "personal", origin: "cli" }],
    }),
    changeExclusions: (action, input): ExclusionChangeResult => {
      runtime.exclusionCalls.push({ action, input });
      if (input.keys?.includes("bogus")) {
        throw new Error('Invalid exclusion key "bogus"');
      }
      return {
        added: action === "add" ? [{ kind: "keyword", value: "x", source: "personal" }] : [],
        alreadyPresent: [],
        removed: action === "remove" ? [{ kind: "keyword", value: "x", source: "personal" }] : [],
        missing: [],
      };
    },
    exclusionCalls: [],
    dedupeCalls: [],
    previewCalls: [],
    dedupe: ({ dryRun, lockTimeoutMs }) => {
      runtime.dedupeCalls.push({ dryRun, lockTimeoutMs });
      return Promise.resolve({
        result: {
          created: 0,
          updated: 0,
          deleted: 2,
          repaired: 0,
          failed: 0,
          inspected: { personal: 2, work: 5 },
          duplicates: { personal: 0, work: 1 },
          phantoms: { personal: 1, work: 0 },
        },
        operations: [
          { ...duplicateRemoval, dryRun },
          {
            ...duplicateRemoval,
            dryRun,
            reason: "phantom-busy-block",
            destinationKey: "personal",
          },
          // Never a stray-block removal: the view must leave it out.
          { ...duplicateRemoval, reason: "source-no-longer-desired", sourceTitles: ["Dentist"] },
        ],
      });
    },
    previewSync: ({ lockTimeoutMs }) => {
      runtime.previewCalls.push({ lockTimeoutMs });
      return Promise.resolve({
        result: {
          created: 1,
          updated: 0,
          deleted: 0,
          repaired: 0,
          failed: 0,
          converged: true,
          destinations: {
            work: { active: 1, duplicateSuppressed: 0 },
            personal: { active: 0, duplicateSuppressed: 0 },
          },
          sources: {
            personal: { excluded: 1 },
            work: { excluded: 0 },
          },
        },
        sources: [
          previewSource,
          {
            ...previewSource,
            sourceKey: "work",
            sourceTitle: "Confidential staffing",
            exclusionReason: "keyword",
            isRecurring: false,
          },
        ],
      });
    },
    close: () => {
      runtime.closed = true;
    },
    ...overrides,
  };
  return runtime;
}

async function startServer(
  overrides: Partial<WebServerOptions> = {},
): Promise<{ base: string; server: WebServer; runtimes: FakeRuntime[] }> {
  const runtimes: FakeRuntime[] = [];
  const server = new WebServer({
    host: "127.0.0.1",
    port: 0,
    defaultTenantId: "default",
    defaultCalendarIds: { personal: "primary", work: "primary" },
    daemonLockPath: "/tmp/absent.daemon.lock",
    daemonIsRunning: () => true,
    runtimeFor: (tenantId) => {
      const runtime = fakeRuntime(tenantId);
      runtimes.push(runtime);
      return runtime;
    },
    ...overrides,
  });
  const port = await server.listen();
  return { base: `http://127.0.0.1:${String(port)}`, server, runtimes };
}

/** `fetch` silently drops a custom `Host`, so the Host-check tests speak raw
 * HTTP. `host: undefined` sends the request with no Host header at all. */
function rawRequest(
  base: string,
  path: string,
  options: {
    method?: string;
    host?: string | undefined;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; text: string }> {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method ?? "GET",
        setHost: false,
        headers: {
          ...(options.host === undefined ? {} : { Host: options.host }),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

describe("web onboarding server", () => {
  it("serves the dashboard shell and a privacy-safe status view", async () => {
    const { base, server } = await startServer();
    try {
      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("calsync");

      const status = (await (await fetch(`${base}/api/status`)).json()) as WebStatusView;
      expect(status.tenant).toBe("default");
      expect(status.overall).toBe("syncing");
      expect(status.daemonRunning).toBe(true);
      expect(status.signIns.map((entry) => [entry.email, entry.calendars])).toEqual([
        ["default-personal@example.com", 1],
        ["default-work@example.com", 1],
      ]);
      expect(status.calendars[0]).toMatchObject({
        key: "personal",
        label: "default-personal@example.com",
        account: "default-personal@example.com",
        shares: true,
        receives: true,
        writable: true,
        valid: true,
        conflict: false,
      });
      expect(status.calendars[0]?.calendarUrl).toContain(
        "https://calendar.google.com/calendar/u/0/r?cid=",
      );
      expect(status.maxCalendars).toBe(6);
      expect(status.canAddAccount).toBe(true);
      expect(status.lastFullSyncAt).toBe("2026-08-28T09:00:00.000Z");
      expect(status.lastResult).toEqual({
        converged: true,
        blocks: { work: 4, personal: 2 },
      });
    } finally {
      await server.close();
    }
  });

  it("reports setup below two calendars and daemon-offline when the daemon is down", async () => {
    const oneCalendar = await startServer({
      runtimeFor: (tenantId) => {
        const runtime = fakeRuntime(tenantId);
        runtime.calendars = runtime.calendars.slice(0, 1);
        return runtime;
      },
    });
    try {
      const status = (await (
        await fetch(`${oneCalendar.base}/api/status`)
      ).json()) as WebStatusView;
      expect(status.overall).toBe("setup");
      expect(status.calendars).toHaveLength(1);
    } finally {
      await oneCalendar.server.close();
    }

    const offline = await startServer({ daemonIsRunning: () => false });
    try {
      const status = (await (await fetch(`${offline.base}/api/status`)).json()) as WebStatusView;
      expect(status.overall).toBe("daemon-offline");
    } finally {
      await offline.server.close();
    }
  });

  it("adopts a role the gateway connected before anything was stored", async () => {
    const adopted: string[] = [];
    const { base, server } = await startServer({
      runtimeFor: (tenantId) => {
        const runtime = fakeRuntime(tenantId, {
          getStatus: (role, calendarId) => {
            adopted.push(role);
            return Promise.resolve<AccountStatus>({
              role,
              configured: false,
              valid: false,
              calendarId,
              message: "not authorized",
            });
          },
        });
        runtime.signIns = [];
        runtime.calendars = [];
        runtime.everSignedIn = false;
        return runtime;
      },
    });
    try {
      const status = (await (await fetch(`${base}/api/status`)).json()) as WebStatusView;
      expect(adopted.sort()).toEqual(["personal", "work"]);
      expect(status.overall).toBe("setup");
      expect(status.signIns).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("flags a calendar conflict without naming the other tenant", async () => {
    const { base, server } = await startServer({
      runtimeFor: (tenantId) =>
        fakeRuntime(tenantId, {
          checkCalendar: (calendar) =>
            Promise.resolve({
              calendar,
              valid: true,
              message: "readable and writable",
              ...(calendar.key === "work" ? { conflictsWith: "i-someone-elses-tenant" } : {}),
            }),
        }),
    });
    try {
      const response = await fetch(`${base}/api/status`);
      const text = await response.text();
      const status = JSON.parse(text) as WebStatusView;
      expect(status.calendars.map((calendar) => calendar.conflict)).toEqual([false, true]);
      expect(text).not.toContain("i-someone-elses-tenant");
    } finally {
      await server.close();
    }
  });

  it("keeps a status view even when live validation throws", async () => {
    const { base, server } = await startServer({
      runtimeFor: (tenantId) =>
        fakeRuntime(tenantId, {
          checkCalendar: () => Promise.reject(new Error("network down")),
        }),
    });
    try {
      const status = (await (await fetch(`${base}/api/status`)).json()) as WebStatusView;
      expect(status.overall).toBe("setup");
      expect(status.calendars[0]?.valid).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("starts local sign-ins and keeps the tenant runtime alive for them", async () => {
    const { base, server, runtimes } = await startServer();
    const post = (body: unknown) =>
      fetch(`${base}/api/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      const added = (await (await post({ action: "connect" })).json()) as {
        url: string;
        external: boolean;
      };
      expect(added).toMatchObject({
        external: false,
        url: "https://accounts.google.com/consent/default/account",
      });
      // A role signs in again through its own flow, which re-adds its calendar.
      const again = (await (await post({ action: "reconnect", slot: "work" })).json()) as {
        url: string;
      };
      expect(again.url).toBe("https://accounts.google.com/consent/default/work");
      expect((await post({ action: "reconnect", slot: "corporate" })).status).toBe(400);
      expect((await post({ action: "nonsense" })).status).toBe(400);
      expect(runtimes).toHaveLength(1);
      expect(runtimes[0]?.closed).toBe(false);
    } finally {
      await server.close();
    }
    expect(runtimes[0]?.closed).toBe(true);
  });

  it("sends sign-ins to the gateway's template for the tenant's slot, and adopts them back", async () => {
    const secret = "0123456789abcdef";
    const { base, server, runtimes } = await startServer({
      secret,
      connectUrl: "https://gw.example.test/auth/google/connect?slot={slot}",
    });
    try {
      const post = async (tenant: string, body: unknown) => {
        const response = await fetch(`${base}/api/accounts`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            cookie: `calsync_web=${signWebToken(tenant, secret, { kind: "session" })}`,
          },
          body: JSON.stringify(body),
        });
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      };
      expect((await post("default", { action: "connect" })).body).toEqual({
        url: "https://gw.example.test/auth/google/connect?slot=account1",
        external: true,
      });
      expect((await post("acme", { action: "connect" })).body["url"]).toBe(
        "https://gw.example.test/auth/google/connect?slot=acme_account1",
      );
      // Reconnecting never hands the gateway an existing account's slot: a
      // different Google account picked there would take its calendars over.
      expect((await post("acme", { action: "reconnect", slot: "personal" })).body["url"]).toBe(
        "https://gw.example.test/auth/google/connect?slot=acme_account2",
      );

      // The gateway sends the person back with ?connected=acme_account1.
      const adopted = await post("acme", { action: "adopt", slot: "acme_account1" });
      expect(adopted.body).toEqual({ status: "adopted", email: "account1@example.com" });
      const acme = runtimes.find((runtime) => runtime.tenantId === "acme");
      expect(acme?.signIns.map((entry) => entry.slot)).toContain("account1");
      // Another tenant's slot is not this tenant's to adopt.
      expect((await post("acme", { action: "adopt", slot: "other_account2" })).status).toBe(400);

      const status = (await (
        await fetch(`${base}/api/status`, {
          headers: { cookie: `calsync_web=${signWebToken("acme", secret, { kind: "session" })}` },
        })
      ).json()) as WebStatusView;
      expect(status.connectMode).toBe("external");
      expect(status.signIns.map((entry) => entry.slot)).toContain("account1");
    } finally {
      await server.close();
    }
  });

  it("adopts a gateway sign-in on status when the person never came back to say so", async () => {
    const { base, server, runtimes } = await startServer({
      connectUrl: "https://gw.example.test/auth/google/connect?slot={slot}",
    });
    try {
      await fetch(`${base}/api/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "connect" }),
      });
      // Finished in another browser: no ?connected, no adopt call.
      const status = (await (await fetch(`${base}/api/status?fresh=1`)).json()) as WebStatusView;
      expect(status.signIns.map((entry) => entry.slot)).toContain("account1");
      expect(runtimes[0]?.signIns.filter((entry) => entry.slot === "account1")).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("is not syncing until one calendar shares busy time and another receives it", async () => {
    const { base, server } = await startServer({
      runtimeFor: (tenantId) => {
        const runtime = fakeRuntime(tenantId);
        runtime.calendars = runtime.calendars.map((calendar) => ({
          ...calendar,
          destination: false,
        }));
        return runtime;
      },
    });
    try {
      const status = (await (await fetch(`${base}/api/status`)).json()) as WebStatusView;
      expect(status.overall).toBe("setup");
    } finally {
      await server.close();
    }
    // An unused, signed-out sign-in does not hold syncing up.
    const spare = await startServer({
      runtimeFor: (tenantId) => {
        const runtime = fakeRuntime(tenantId);
        runtime.signIns.push(signIn(tenantId, "account1", "spare@example.com"));
        runtime.checkAccount = (slot) =>
          Promise.resolve({ slot, email: null, valid: slot !== "account1", message: "x" });
        return runtime;
      },
    });
    try {
      const status = (await (await fetch(`${spare.base}/api/status`)).json()) as WebStatusView;
      expect(status.overall).toBe("syncing");
    } finally {
      await spare.server.close();
    }
  });

  it("adds, re-roles and removes calendars, refusing what a calendar cannot do", async () => {
    let busy = false;
    const { base, server, runtimes } = await startServer({
      runtimeFor: (tenantId) => {
        const runtime = fakeRuntime(tenantId, {});
        const remove = runtime.removeCalendar.bind(runtime);
        runtime.removeCalendar = (key, options) =>
          busy ? Promise.reject(new LockTimeoutError()) : remove(key, options);
        runtimes.push(runtime);
        return runtime;
      },
    });
    const post = async (body: unknown) => {
      const response = await fetch(`${base}/api/calendars`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    try {
      const available = (await (
        await fetch(`${base}/api/calendars/available?account=work`)
      ).json()) as { calendars: { name: string; synced: boolean }[] };
      expect(available.calendars.map((entry) => [entry.name, entry.synced])).toEqual([
        // The role's own calendar is stored as "primary", and is that account's primary.
        ["primary-id@example.com", true],
        ["Team", false],
      ]);
      expect((await fetch(`${base}/api/calendars/available?account=nobody`)).status).toBe(400);

      expect(
        (
          await post({
            action: "add",
            account: "work",
            calendarId: "team@group.example.com",
            shares: true,
            receives: false,
          })
        ).body,
      ).toEqual({ key: "cal-team" });
      // Read-only: it cannot be made to receive busy blocks.
      expect((await post({ action: "update", key: "cal-team", receives: true })).status).toBe(400);
      expect(
        (await post({ action: "update", key: "personal", shares: true, receives: false })).status,
      ).toBe(200);
      expect(runtimes[0]?.calendars.find((entry) => entry.key === "personal")?.destination).toBe(
        false,
      );

      busy = true;
      expect((await post({ action: "remove", key: "cal-team" })).status).toBe(409);
      busy = false;
      expect((await post({ action: "remove", key: "cal-team" })).body).toEqual({
        removed: "cal-team",
        deleted: 3,
      });
      expect((await post({ action: "remove", key: "cal-team" })).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("redeems a signed link for a session cookie and refuses everything else", async () => {
    const secret = "0123456789abcdef";
    const { base, server, runtimes } = await startServer({ secret, secureCookies: true });
    try {
      expect((await fetch(`${base}/api/status`)).status).toBe(403);
      // The API never takes a token from the URL, valid or not.
      expect((await fetch(`${base}/api/status?t=acme.deadbeef`)).status).toBe(403);
      expect((await fetch(`${base}/api/status?t=${signWebToken("acme", secret)}`)).status).toBe(
        403,
      );
      expect(
        (
          await fetch(`${base}/?t=${signWebToken("acme", "wrong-secret-1234")}`, {
            redirect: "manual",
          })
        ).status,
      ).toBe(403);
      // An expired link, and a session token dressed up as a link, are both refused.
      const stale = signWebToken("acme", secret, { ttlSeconds: 60, now: 1_000_000 });
      expect((await fetch(`${base}/?t=${stale}`, { redirect: "manual" })).status).toBe(403);
      const sessionAsLink = signWebToken("acme", secret, { kind: "session" });
      expect((await fetch(`${base}/?t=${sessionAsLink}`, { redirect: "manual" })).status).toBe(403);

      // A browser landing without a link gets an explanation, not JSON.
      const landing = await fetch(`${base}/`);
      expect(landing.status).toBe(403);
      expect(landing.headers.get("content-type")).toContain("text/html");
      expect(await landing.text()).toContain("personal link");

      // The real link: cookie set, token gone from the URL.
      const link = signWebToken("acme", secret);
      const redeem = await fetch(`${base}/?t=${link}`, { redirect: "manual" });
      expect(redeem.status).toBe(303);
      expect(redeem.headers.get("location")).toBe("/");
      const setCookie = redeem.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("calsync_web=session.acme.");
      expect(setCookie).not.toContain(link);
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).toContain("Secure");
      expect(setCookie).toContain("Max-Age=15552000");
      const cookie = setCookie.split(";")[0] ?? "";

      const page = await fetch(`${base}/`, { headers: { cookie } });
      expect(page.status).toBe(200);
      const viaCookie = await fetch(`${base}/api/status`, { headers: { cookie } });
      const status = (await viaCookie.json()) as WebStatusView;
      expect(status.tenant).toBe("acme");
      expect(runtimes.map((runtime) => runtime.tenantId)).toEqual(["acme"]);

      // A link pasted into the cookie is not a session.
      const linkAsCookie = await fetch(`${base}/api/status`, {
        headers: { cookie: `calsync_web=${link}` },
      });
      expect(linkAsCookie.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("opens the signed-in person's tenant from the proxy's identity header", async () => {
    const secret = "0123456789abcdef";
    const guestTenant = tenantForIdentity("ana.b@example.com");
    if (guestTenant === null) {
      throw new Error("expected hash tenant for ana.b@example.com");
    }
    expect(guestTenant).toBe("i4248cc593102d6944c982776b98b8d40");
    const { base, server, runtimes } = await startServer({
      secret,
      identityHeader: "x-forwarded-user",
      identityTenants: { "owner@example.com": "default" },
    });
    try {
      // No header, no link: still locked.
      expect((await fetch(`${base}/api/status`)).status).toBe(403);
      const owner = await fetch(`${base}/api/status`, {
        headers: { "x-forwarded-user": "Owner@Example.com" },
      });
      expect(((await owner.json()) as WebStatusView).tenant).toBe("default");
      const guest = await fetch(`${base}/api/status`, {
        headers: { "x-forwarded-user": "ana.b@example.com" },
      });
      expect(((await guest.json()) as WebStatusView).tenant).toBe(guestTenant);
      const page = await fetch(`${base}/`, {
        headers: { "x-forwarded-user": "ana.b@example.com" },
      });
      expect(page.status).toBe(200);
      // A valid session cookie still wins over the header.
      const cookie = `calsync_web=${signWebToken("acme", secret, { kind: "session" })}`;
      const both = await fetch(`${base}/api/status`, {
        headers: { "x-forwarded-user": "ana.b@example.com", cookie },
      });
      expect(((await both.json()) as WebStatusView).tenant).toBe("acme");
      expect(runtimes.map((runtime) => runtime.tenantId).sort()).toEqual([
        "acme",
        "default",
        guestTenant,
      ]);
    } finally {
      await server.close();
    }
  });

  it("refuses an identity that slugifies to something no tenant id may be", async () => {
    // An address always hashes to a well-formed id, but the shared helper
    // also slugifies a value with no "@", which can yield underscores or a
    // leading digit. Those are not tenant ids here: `tokenSlot` reads
    // "<tenant>_<role>", and no CLI command could name the state again.
    const { base, server, runtimes } = await startServer({
      secret: "0123456789abcdef",
      identityHeader: "x-forwarded-user",
    });
    try {
      for (const value of ["123 user", "Some Name", "owner_at_example_com"]) {
        const response = await fetch(`${base}/api/status`, {
          headers: { "x-forwarded-user": value },
        });
        expect(response.status).toBe(403);
      }
      expect(runtimes).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("ignores the identity header unless it is configured, and in single-tenant mode", async () => {
    const secret = "0123456789abcdef";
    const locked = await startServer({ secret });
    try {
      const r = await fetch(`${locked.base}/api/status`, {
        headers: { "x-forwarded-user": "a@example.com" },
      });
      expect(r.status).toBe(403);
    } finally {
      await locked.server.close();
    }
    const single = await startServer({ identityHeader: "x-forwarded-user" });
    try {
      const r = await fetch(`${single.base}/api/status`, {
        headers: { "x-forwarded-user": "a@example.com" },
      });
      expect(((await r.json()) as WebStatusView).tenant).toBe("default");
    } finally {
      await single.server.close();
    }
  });

  it("clears a cookie that no longer verifies and retries once, clean", async () => {
    const secret = "0123456789abcdef";
    const { base, server } = await startServer({ secret });
    try {
      const stale = await fetch(`${base}/`, {
        headers: { cookie: "calsync_web=acme.deadbeef" },
        redirect: "manual",
      });
      expect(stale.status).toBe(303);
      expect(stale.headers.get("location")).toBe("/?fresh=1");
      expect(stale.headers.get("set-cookie")).toContain("Max-Age=0");
      // If the cookie somehow survives, the retry explains instead of looping.
      const again = await fetch(`${base}/?fresh=1`, {
        headers: { cookie: "calsync_web=acme.deadbeef" },
        redirect: "manual",
      });
      expect(again.status).toBe(403);
      // API calls never redirect.
      const api = await fetch(`${base}/api/status`, {
        headers: { cookie: "calsync_web=acme.deadbeef" },
      });
      expect(api.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("leaves the cookie non-Secure for plain-HTTP loopback use", async () => {
    const secret = "0123456789abcdef";
    const { base, server } = await startServer({ secret });
    try {
      const redeem = await fetch(`${base}/?t=${signWebToken("acme", secret)}`, {
        redirect: "manual",
      });
      expect(redeem.headers.get("set-cookie")).not.toContain("Secure");
    } finally {
      await server.close();
    }
  });

  it("refuses a connect request that did not come from its own page", async () => {
    const { base, server } = await startServer();
    try {
      const post = async (headers: Record<string, string>): Promise<number> =>
        (
          await fetch(`${base}/api/accounts`, {
            method: "POST",
            headers,
            body: JSON.stringify({ action: "connect" }),
          })
        ).status;
      // A plain HTML form cannot send JSON, so a non-JSON body is not ours.
      expect(await post({ "Content-Type": "application/x-www-form-urlencoded" })).toBe(403);
      expect(
        await post({ "Content-Type": "application/json", Origin: "https://evil.example" }),
      ).toBe(403);
      expect(
        await post({ "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" }),
      ).toBe(403);
      const host = new URL(base).host;
      expect(await post({ "Content-Type": "application/json", Origin: `http://${host}` })).toBe(
        200,
      );
      expect(
        await post({ "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }),
      ).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("lists and changes exclusions through the same contract as the CLI and MCP tools", async () => {
    const { base, server, runtimes } = await startServer();
    try {
      const page = await (await fetch(`${base}/`)).text();
      expect(page).toContain('id="exclusions"');

      const snapshot = (await (await fetch(`${base}/api/exclusions`)).json()) as ExclusionSnapshot;
      expect(snapshot.keywords).toHaveLength(2);
      expect(snapshot.keys[0]).toMatchObject({ origin: "cli", source: "personal" });

      const post = async (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
        fetch(`${base}/api/exclusions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(body),
        });

      const added = await post({ action: "add", keywords: ["dentist, therapy"], from: "personal" });
      expect(added.status).toBe(200);
      expect(await added.json()).toMatchObject({
        action: "add",
        added: [{ kind: "keyword" }],
      });
      const removed = await post({ action: "remove", keys: ["calsync-exclude:v1:p2w:occ:abc"] });
      expect(removed.status).toBe(200);
      expect(runtimes[0]?.exclusionCalls).toEqual([
        { action: "add", input: { keywords: ["dentist, therapy"], from: "personal" } },
        { action: "remove", input: { keys: ["calsync-exclude:v1:p2w:occ:abc"] } },
      ]);

      // Validation failures carry the CLI's own message, as a 400.
      const invalid = await post({ action: "add", keys: ["bogus"] });
      expect(invalid.status).toBe(400);
      expect(((await invalid.json()) as { error: string }).error).toContain(
        "Invalid exclusion key",
      );
      expect((await post({ action: "purge" })).status).toBe(400);
      expect((await post({ action: "add", keys: "not-a-list" })).status).toBe(400);
      expect((await post({ action: "add", keywords: ["x"], from: "boss" })).status).toBe(400);
      expect(runtimes[0]?.exclusionCalls).toHaveLength(3);

      // Same CSRF lock as connect: a cross-site or non-JSON request is refused.
      expect(
        (await post({ action: "add", keys: [] }, { Origin: "https://evil.example" })).status,
      ).toBe(403);
      expect(
        (
          await fetch(`${base}/api/exclusions`, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: "{}",
          })
        ).status,
      ).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("refuses requests whose Host is not local in single-tenant mode (DNS rebinding)", async () => {
    const { base, server } = await startServer();
    try {
      // A page at attacker.example:<port> rebound to 127.0.0.1 sends a Host
      // and Origin that agree with each other, and Sec-Fetch-Site says
      // same-origin. Only the Host itself gives it away.
      const rebound = {
        host: "attacker.example:8788",
        headers: { Origin: "http://attacker.example:8788", "Sec-Fetch-Site": "same-origin" },
      };
      const status = await rawRequest(base, "/api/status", rebound);
      expect(status.status).toBe(421);
      expect(status.text).not.toContain("default-personal@example.com");
      const preview = await rawRequest(base, "/api/preview", {
        ...rebound,
        method: "POST",
        headers: { ...rebound.headers, "Content-Type": "application/json" },
        body: "{}",
      });
      expect(preview.status).toBe(421);
      expect(preview.text).not.toContain("Dentist");
      expect((await rawRequest(base, "/", rebound)).status).toBe(421);
      expect((await rawRequest(base, "/api/exclusions", rebound)).status).toBe(421);
      // Node itself answers a request with no Host header with 400.
      expect((await rawRequest(base, "/api/status", { host: undefined })).status).toBe(400);
      expect((await rawRequest(base, "/api/status", { host: "192.168.1.20:8788" })).status).toBe(
        421,
      );

      // Loopback names the person could type stay welcome.
      for (const host of ["localhost:8788", "127.0.0.1:8788", "[::1]:8788", "LOCALHOST"]) {
        expect((await rawRequest(base, "/api/status", { host })).status).toBe(200);
      }
    } finally {
      await server.close();
    }
  });

  it("accepts a concrete bound address as Host, but never a wildcard bind", async () => {
    // Bound to 127.0.0.1 in both cases so the test stays off the LAN; the
    // option under test is only what `host` adds to the allow-list.
    const wildcard = await startServer({ host: "0.0.0.0" });
    try {
      expect(
        (await rawRequest(wildcard.base, "/api/status", { host: "0.0.0.0:8788" })).status,
      ).toBe(421);
      expect(
        (await rawRequest(wildcard.base, "/api/status", { host: "127.0.0.1:8788" })).status,
      ).toBe(200);
    } finally {
      await wildcard.server.close();
    }
  });

  it("leaves the Host check to the proxy and cookie in multi-tenant mode", async () => {
    const secret = "web-secret-0123456789";
    const { base, server } = await startServer({ secret });
    try {
      const cookie = `calsync_web=${signWebToken("acme", secret, { kind: "session" })}`;
      const hosted = await rawRequest(base, "/api/status", {
        host: "calsync.example.com",
        headers: { cookie },
      });
      expect(hosted.status).toBe(200);
      expect((JSON.parse(hosted.text) as WebStatusView).tenant).toBe("acme");
    } finally {
      await server.close();
    }
  });

  it("runs a dry-run preview on request, with titles, and refuses it any other way", async () => {
    const { base, server } = await startServer();
    try {
      const post = async (headers: Record<string, string> = {}): Promise<Response> =>
        fetch(`${base}/api/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: "{}",
        });
      const response = await post();
      expect(response.status).toBe(200);
      const view = (await response.json()) as WebPreviewView;
      expect(view.planned).toEqual({ created: 1, updated: 0, deleted: 0, repaired: 0 });
      expect(view.events).toEqual([
        {
          source: "personal",
          title: "Dentist",
          when: previewSource.timeRange,
          recurring: true,
          status: "mirrored",
          keys: previewSource.exclusionKeys,
        },
        expect.objectContaining({
          source: "work",
          title: "Confidential staffing",
          status: "excluded-keyword",
        }),
      ]);

      // Titles are only ever an answer to a deliberate same-origin POST.
      expect((await fetch(`${base}/api/preview`)).status).toBe(404);
      expect((await post({ Origin: "https://evil.example" })).status).toBe(403);
      const status = await (await fetch(`${base}/api/status`)).text();
      expect(status).not.toContain("Dentist");
    } finally {
      await server.close();
    }
  });

  it("joins concurrent preview clicks into one dry run and reports a busy lock as 409", async () => {
    let runs = 0;
    let release: (() => void) | undefined;
    let arrived: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstArrived = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const { base, server } = await startServer({
      runtimeFor: (tenantId) =>
        fakeRuntime(tenantId, {
          previewSync: async (options) => {
            runs += 1;
            if (runs > 1) {
              throw new LockTimeoutError("lock held");
            }
            arrived?.();
            await gate;
            return await fakeRuntime(tenantId).previewSync(options);
          },
        }),
    });
    try {
      const post = (): Promise<Response> =>
        fetch(`${base}/api/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
      const burst = Promise.all([post(), post(), post()]);
      // Let the first click reach the runtime and the other two queue behind it.
      await firstArrived;
      await new Promise((resolve) => setTimeout(resolve, 50));
      release?.();
      expect((await burst).map((response) => response.status)).toEqual([200, 200, 200]);
      expect(runs).toBe(1);
      expect((await post()).status).toBe(409);
    } finally {
      await server.close();
    }
  });

  it("bounds how long a scan waits for the reconcile lock", async () => {
    // Without a timeout `acquireLockWaiting` polls forever, so the 409 these
    // handlers document could never fire: a click landing during a daemon
    // pass held its connection for the length of that pass instead.
    const { base, server, runtimes } = await startServer();
    try {
      const post = (path: string, body: string): Promise<Response> =>
        fetch(`${base}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
      expect((await post("/api/dedupe", "{}")).status).toBe(200);
      expect((await post("/api/preview", "{}")).status).toBe(200);
      for (const call of runtimes[0]?.dedupeCalls ?? []) {
        expect(call.lockTimeoutMs).toBeGreaterThan(0);
      }
      for (const call of runtimes[0]?.previewCalls ?? []) {
        expect(call.lockTimeoutMs).toBeGreaterThan(0);
      }
      expect(runtimes[0]?.dedupeCalls).toEqual([{ dryRun: true, lockTimeoutMs: 5_000 }]);
      expect(runtimes[0]?.previewCalls).toEqual([{ lockTimeoutMs: 5_000 }]);
    } finally {
      await server.close();
    }
  });

  it("serves the repeat click from the last scan, then holds the next one off", async () => {
    const time = { at: 1_000_000 };
    const gate = new ScanGate(
      memoryScanStore(),
      { cacheMs: 30_000, scanIntervalMs: 60_000, writeIntervalMs: 300_000 },
      () => time.at,
    );
    const { base, server, runtimes } = await startServer({ scanGate: gate });
    try {
      const check = (): Promise<Response> =>
        fetch(`${base}/api/dedupe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });

      const first = await check();
      expect(first.status).toBe(200);
      const body = (await first.json()) as WebDedupeView;
      expect(runtimes[0]?.dedupeCalls).toHaveLength(1);

      // Inside the cache window: the same answer, and no second pass.
      time.at += 5_000;
      const cached = await check();
      expect(cached.status).toBe(200);
      expect(await cached.json()).toEqual(body);
      expect(runtimes[0]?.dedupeCalls).toHaveLength(1);

      // Past the cache but inside the gap: refused, with the wait.
      time.at += 30_000;
      const denied = await check();
      expect(denied.status).toBe(429);
      expect(denied.headers.get("retry-after")).toBe("25");
      expect((await denied.json()) as { retryAfter: number }).toMatchObject({ retryAfter: 25 });
      expect(runtimes[0]?.dedupeCalls).toHaveLength(1);

      // Past the gap: a fresh pass.
      time.at += 25_000;
      expect((await check()).status).toBe(200);
      expect(runtimes[0]?.dedupeCalls).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it("keeps the preview and the stray-block check on separate allowances", async () => {
    const time = { at: 1_000_000 };
    const gate = new ScanGate(
      memoryScanStore(),
      { cacheMs: 0, scanIntervalMs: 60_000, writeIntervalMs: 300_000 },
      () => time.at,
    );
    const { base, server, runtimes } = await startServer({ scanGate: gate });
    try {
      const post = (path: string): Promise<Response> =>
        fetch(`${base}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
      expect((await post("/api/dedupe")).status).toBe(200);
      // Both are read-only passes, so they share the "scan" gap by design.
      expect((await post("/api/preview")).status).toBe(429);
      expect(runtimes[0]?.previewCalls).toHaveLength(0);

      time.at += 60_000;
      expect((await post("/api/preview")).status).toBe(200);
      expect(runtimes[0]?.previewCalls).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("does not let a pruning apply serve a stale check afterwards", async () => {
    const gate = new ScanGate(memoryScanStore(), {
      cacheMs: 30_000,
      scanIntervalMs: 0,
      writeIntervalMs: 0,
    });
    const { base, server, runtimes } = await startServer({ scanGate: gate });
    try {
      const post = (body: string): Promise<Response> =>
        fetch(`${base}/api/dedupe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
      expect((await post("{}")).status).toBe(200);
      expect(runtimes[0]?.dedupeCalls).toHaveLength(1);

      // The apply removed the blocks the cached check listed.
      expect((await post(JSON.stringify({ apply: true }))).status).toBe(200);
      const after = await post("{}");
      expect(after.status).toBe(200);
      expect(((await after.json()) as WebDedupeView).applied).toBe(false);
      // A real third pass, not the check cached before the removal.
      expect(runtimes[0]?.dedupeCalls).toEqual([
        { dryRun: true, lockTimeoutMs: 5_000 },
        { dryRun: false, lockTimeoutMs: 5_000 },
        { dryRun: true, lockTimeoutMs: 5_000 },
      ]);
    } finally {
      await server.close();
    }
  });

  it("gives each tenant its own allowance", async () => {
    const secret = "0123456789abcdef";
    const gate = new ScanGate(memoryScanStore(), {
      cacheMs: 0,
      scanIntervalMs: 60_000,
      writeIntervalMs: 300_000,
    });
    const { base, server } = await startServer({ secret, scanGate: gate });
    try {
      const check = (tenant: string): Promise<Response> =>
        fetch(`${base}/api/dedupe`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            cookie: `calsync_web=${signWebToken(tenant, secret, { kind: "session" })}`,
          },
          body: "{}",
        });
      expect((await check("acme")).status).toBe(200);
      expect((await check("acme")).status).toBe(429);
      expect((await check("other")).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("checks for and removes stray busy blocks as times only, on a same-origin POST", async () => {
    const { base, server, runtimes } = await startServer();
    try {
      const post = async (body: string, headers: Record<string, string> = {}): Promise<Response> =>
        fetch(`${base}/api/dedupe`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body,
        });
      const check = await post("{}");
      expect(check.status).toBe(200);
      const checked = (await check.json()) as WebDedupeView;
      expect(checked).toEqual({
        ranAt: expect.any(String) as string,
        applied: false,
        inspected: { personal: 2, work: 5 },
        removals: [
          { calendar: "work", when: duplicateRemoval.timeRange, kind: "duplicate" },
          { calendar: "personal", when: duplicateRemoval.timeRange, kind: "phantom" },
        ],
      });
      expect(JSON.stringify(checked)).not.toContain("Dentist");

      const removal = await post(JSON.stringify({ apply: true }));
      expect(removal.status).toBe(200);
      expect(((await removal.json()) as WebDedupeView).applied).toBe(true);
      expect(runtimes[0]?.dedupeCalls).toEqual([
        { dryRun: true, lockTimeoutMs: 5_000 },
        { dryRun: false, lockTimeoutMs: 5_000 },
      ]);

      expect((await post(JSON.stringify({ apply: "yes" }))).status).toBe(400);
      expect((await post("not json")).status).toBe(400);
      expect((await fetch(`${base}/api/dedupe`)).status).toBe(404);
      expect((await post("{}", { Origin: "https://evil.example" })).status).toBe(403);
      expect(runtimes[0]?.dedupeCalls).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it("reports a busy sync lock during stray-block cleanup as 409 and other failures as 502", async () => {
    let calls = 0;
    const { base, server } = await startServer({
      runtimeFor: (tenantId) =>
        fakeRuntime(tenantId, {
          dedupe: () => {
            calls += 1;
            return Promise.reject(
              calls === 1 ? new LockTimeoutError("lock held") : new Error("Google said no"),
            );
          },
        }),
    });
    try {
      const post = (): Promise<Response> =>
        fetch(`${base}/api/dedupe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apply: true }),
        });
      expect((await post()).status).toBe(409);
      const failed = await post();
      expect(failed.status).toBe(502);
      expect(((await failed.json()) as { error: string }).error).toBe("Google said no");
    } finally {
      await server.close();
    }
  });

  it("shares one live status check across a burst of polls", async () => {
    let calls = 0;
    const { base, server } = await startServer({
      runtimeFor: (tenantId) =>
        fakeRuntime(tenantId, {
          checkCalendar: (calendar) => {
            calls += 1;
            return Promise.resolve({ calendar, valid: true, message: "readable and writable" });
          },
        }),
    });
    try {
      await Promise.all([1, 2, 3].map(() => fetch(`${base}/api/status`)));
      await fetch(`${base}/api/status`);
      // Two calendars, validated once, no matter how many tabs are polling.
      expect(calls).toBe(2);
      // Right after a connection lands, the page asks for a fresh answer.
      await fetch(`${base}/api/status?fresh=1`);
      expect(calls).toBe(4);
    } finally {
      await server.close();
    }
  });
});

describe("web helpers", () => {
  it("signs and verifies expiring, kind-bound tenant tokens", () => {
    const secret = "0123456789abcdef";
    const now = 1_700_000_000;
    const token = signWebToken("acme", secret, { now });
    expect(token).toMatch(/^link\.acme\.1700604800\.[0-9a-f]{64}$/u);
    expect(verifyWebToken(token, secret, { now })).toBe("acme");
    expect(verifyWebToken(token, secret, { now, kind: "link" })).toBe("acme");
    expect(verifyWebToken(token, secret, { now, kind: "session" })).toBeNull();
    expect(verifyWebToken(token, secret, { now: now + 7 * 86_400 })).toBeNull();
    expect(verifyWebToken(token, "another-secret-99", { now })).toBeNull();
    // Tampering with the expiry or the kind breaks the signature.
    expect(verifyWebToken(token.replace("1700604800", "1800604800"), secret, { now })).toBeNull();
    expect(verifyWebToken(token.replace(/^link/u, "session"), secret, { now })).toBeNull();
    // Old-format and malformed tokens are simply invalid.
    expect(verifyWebToken("acme.deadbeef", secret, { now })).toBeNull();
    expect(verifyWebToken("link.acme.nope.abcd", secret, { now })).toBeNull();
    expect(verifyWebToken("link.Bad Tenant.1700604800.abcd", secret, { now })).toBeNull();
    expect(webLink("https://calsync.example.test/", "acme", secret, 3600)).toMatch(
      /^https:\/\/calsync\.example\.test\/\?t=link\.acme\.\d+\.[0-9a-f]{64}$/u,
    );
  });

  it("derives collision-resistant tenant ids from emails", () => {
    expect(tenantForIdentity("Ana.B@Example.com")).toBe("i4248cc593102d6944c982776b98b8d40");
    expect(tenantForIdentity("ana-b@example.com")).toBe("i8b5313038e8fbab2a34a2f8ae58801b3");
    expect(tenantForIdentity("Ana.B@Example.com")).not.toBe(tenantForIdentity("ana-b@example.com"));
    expect(tenantForIdentity("123@example.com")).toMatch(/^i[0-9a-f]{32}$/u);
    expect(tenantForIdentity("owner@example.com", { "owner@example.com": "default" })).toBe(
      "default",
    );
    expect(tenantForIdentity("   ")).toBeNull();
    const long = "x".repeat(200) + "@example.com";
    const longer = "x".repeat(201) + "@example.com";
    expect(tenantForIdentity(long)).toMatch(/^i[0-9a-f]{32}$/u);
    expect(tenantForIdentity(long)).not.toBe(tenantForIdentity(longer));
  });

  it("links calendar emails via cid and aliases to the calendar home", () => {
    expect(calendarUrl("primary")).toBe("https://calendar.google.com/calendar/");
    expect(calendarUrl("dvd@example.com")).toBe(
      `https://calendar.google.com/calendar/u/0/r?cid=${Buffer.from("dvd@example.com").toString("base64").replace(/=+$/u, "")}`,
    );
  });
});
