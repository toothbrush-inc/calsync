import { EgressRequiredError, GrantError } from "@dvd-toy-box/vault";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  AuthenticationError,
  calendarFingerprint,
  GOOGLE_CALENDAR_SCOPES,
  GoogleAuthService,
  PAIR_CONFLICT_MESSAGE,
  isWritableAccessRole,
  presentAuthorizationUrl,
  startGoogleLoopback,
  type TokenExchange,
} from "../src/google/auth.js";
import { serviceLogPath } from "../src/logging.js";
import { StateDatabase } from "../src/storage/database.js";
import type { TokenStore } from "../src/storage/keychain.js";

function untouchableTokens(): { store: TokenStore; getRefreshToken: ReturnType<typeof vi.fn> } {
  const getRefreshToken = vi.fn(() => Promise.reject(new Error("token store must not be read")));
  const store: TokenStore = {
    getRefreshToken,
    setRefreshToken: vi.fn(() => Promise.resolve()),
    deleteRefreshToken: vi.fn(() => Promise.resolve(false)),
  };
  return { store, getRefreshToken };
}

function codedError(code: string, message: string): Error {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  return error;
}

function withState<T>(run: (state: StateDatabase) => Promise<T>): Promise<T> {
  const state = new StateDatabase(":memory:");
  return run(state).finally(() => {
    state.close();
  });
}

describe("Google authentication policy", () => {
  it("requests event read/write and calendar-list metadata only", () => {
    expect(GOOGLE_CALENDAR_SCOPES).toEqual([
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    ]);
  });

  it("accepts only calendar roles that permit event writes", () => {
    expect(isWritableAccessRole("owner")).toBe(true);
    expect(isWritableAccessRole("writer")).toBe(true);
    expect(isWritableAccessRole("reader")).toBe(false);
    expect(isWritableAccessRole("freeBusyReader")).toBe(false);
    expect(isWritableAccessRole(undefined)).toBe(false);
  });

  it("prints the authorization URL without opening a browser in manual mode", async () => {
    const onAuthorizationUrl = vi.fn();
    const openBrowser = vi.fn(() => Promise.resolve());

    await presentAuthorizationUrl(
      "https://accounts.google.com/o/oauth2/v2/auth?state=state",
      { openBrowser: false, onAuthorizationUrl },
      openBrowser,
    );

    expect(onAuthorizationUrl).toHaveBeenCalledWith(
      "https://accounts.google.com/o/oauth2/v2/auth?state=state",
    );
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("keeps authorization running and reports the URL when browser opening fails", async () => {
    const error = new Error("no browser");
    const onBrowserOpenFailure = vi.fn();

    await expect(
      presentAuthorizationUrl(
        "https://accounts.google.com/o/oauth2/v2/auth?state=state",
        { onBrowserOpenFailure },
        () => Promise.reject(error),
      ),
    ).resolves.toBeUndefined();

    expect(onBrowserOpenFailure).toHaveBeenCalledWith(
      "https://accounts.google.com/o/oauth2/v2/auth?state=state",
      error,
    );
  });

  it("builds local ephemeral or hosted fixed-port loopbacks by env", async () => {
    const local = await startGoogleLoopback("personal", {}, "local-state");
    try {
      expect(local.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
      expect(local.state).toBe("local-state");
    } finally {
      local.close();
    }

    const hosted = await startGoogleLoopback(
      "work",
      {
        CALSYNC_CONNECT_BASE_URL: "https://gw.example.com/",
        CALSYNC_CONNECT_BIND_HOST: "127.0.0.1",
        CALSYNC_CONNECT_PORT_WORK: "0",
      },
      "hosted-state",
    );
    try {
      expect(hosted.redirectUri).toBe("https://gw.example.com/oauth2callback/work");
      expect(hosted.state).toBe("hosted-state");
    } finally {
      hosted.close();
    }
  });

  it("serviceLogPath honors CALSYNC_LOG_PATH", () => {
    expect(serviceLogPath("/home/x", { CALSYNC_LOG_PATH: "/data/calsync/logs/calsync.log" })).toBe(
      "/data/calsync/logs/calsync.log",
    );
    expect(serviceLogPath("/home/x", {})).toContain("Library");
  });

  it("maps broker token-exchange failures to crisp statuses without touching the token store", async () => {
    const cases: [string, { configured: boolean; contains: string }][] = [
      ["not_connected", { configured: false, contains: "not authorized" }],
      ["grant_missing", { configured: true, contains: "not granted to calsync" }],
      ["token_revoked", { configured: true, contains: "revoked or expired" }],
      ["egress_unreachable", { configured: true, contains: "broker token exchange failed" }],
    ];
    for (const [code, expected] of cases) {
      await withState(async (state) => {
        const { store, getRefreshToken } = untouchableTokens();
        const exchange: TokenExchange = vi.fn(() =>
          Promise.reject(codedError(code, `broker said ${code}`)),
        );
        const auth = new GoogleAuthService(
          { clientId: "client", clientSecret: "secret" },
          store,
          state,
          undefined,
          undefined,
          exchange,
        );
        const status = await auth.getStatus("personal", "primary");
        expect(status.configured).toBe(expected.configured);
        expect(status.valid).toBe(false);
        expect(status.message).toContain(expected.contains);
        expect(getRefreshToken).not.toHaveBeenCalled();
      });
    }
  });

  it("builds exchange-backed calendar clients without reading the refresh token", async () => {
    await withState(async (state) => {
      const { store, getRefreshToken } = untouchableTokens();
      const exchange: TokenExchange = vi.fn(() =>
        Promise.resolve({ access_token: "ya29.short", expiry_date: Date.now() + 3_600_000 }),
      );
      const auth = new GoogleAuthService(
        { clientId: "client", clientSecret: "secret" },
        store,
        state,
        undefined,
        undefined,
        exchange,
      );
      const client = await auth.createCalendarClient("work");
      expect(client).toBeDefined();
      expect(exchange).toHaveBeenCalledWith("work");
      expect(getRefreshToken).not.toHaveBeenCalled();

      const failing = new GoogleAuthService(
        { clientId: "client", clientSecret: "secret" },
        untouchableTokens().store,
        state,
        undefined,
        undefined,
        () => Promise.reject(codedError("token_revoked", "dead")),
      );
      await expect(failing.createCalendarClient("work")).rejects.toThrow(AuthenticationError);
      await expect(failing.createCalendarClient("work")).rejects.toThrow(/revoked or expired/);
    });
  });

  it("maps broker-only mode without an exchange to an actionable status", async () => {
    await withState(async (state) => {
      const tokens: TokenStore = {
        getRefreshToken: vi.fn(() => Promise.reject(new EgressRequiredError("broker-only"))),
        setRefreshToken: vi.fn(() => Promise.resolve()),
        deleteRefreshToken: vi.fn(() => Promise.resolve(false)),
      };
      const auth = new GoogleAuthService({ clientId: "c", clientSecret: "s" }, tokens, state);
      const status = await auth.getStatus("personal", "primary");
      expect(status).toMatchObject({ configured: true, valid: false });
      expect(status.message).toContain("broker-only");
      expect(status.message).toContain("capability gateway");
    });
  });

  describe("calendar pair guard", () => {
    // Each role's configured calendar alias resolves to a different Google
    // account, the same two for every tenant.
    const CALENDAR = { personal: "home-alias", work: "office-alias" } as const;
    const RESOLVES_TO: Record<string, string> = {
      "home-alias": "Me@Gmail.com",
      "office-alias": "me@corp.example",
    };

    /** One tenant's auth service over a shared database, every check passing. */
    function tenantAuth(path: string, tenantId: string) {
      const state = new StateDatabase(path, tenantId);
      const auth = new GoogleAuthService(
        { clientId: "client", clientSecret: "secret" },
        untouchableTokens().store,
        state,
        undefined,
        undefined,
        () => Promise.resolve({ access_token: "ya29.short", expiry_date: Date.now() + 60_000 }),
        (_client, calendarId) =>
          Promise.resolve({ id: RESOLVES_TO[calendarId] ?? calendarId, accessRole: "owner" }),
      );
      const check = (role: "personal" | "work") => auth.getStatus(role, CALENDAR[role]);
      return { check, state };
    }

    async function withSharedDatabase(run: (path: string) => Promise<void>): Promise<void> {
      const directory = mkdtempSync(join(tmpdir(), "calsync-guard-"));
      try {
        await run(join(directory, "state.sqlite3"));
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }

    it("fingerprints the resolved calendar, not the alias, and never stores the address", () => {
      const mine = calendarFingerprint({ id: "Me@Gmail.com" }, "primary");
      expect(mine).toMatch(/^[0-9a-f]{64}$/u);
      expect(mine).toBe(calendarFingerprint({ id: " me@gmail.com " }, "primary"));
      expect(mine).not.toBe(calendarFingerprint({ id: "you@gmail.com" }, "primary"));
      expect(calendarFingerprint({}, "team@group.calendar.google.com")).toMatch(/^[0-9a-f]{64}$/u);
      // "primary" with no resolved id says nothing about whose calendar it is.
      expect(calendarFingerprint({}, "primary")).toBeUndefined();
    });

    it("refuses a second tenant on the same two calendars, so the daemon never adopts it", async () => {
      await withSharedDatabase(async (path) => {
        const first = tenantAuth(path, "default");
        const second = tenantAuth(path, "i39b86");
        try {
          for (const role of ["personal", "work"] as const) {
            await expect(first.check(role)).resolves.toMatchObject({
              valid: true,
              message: "authorized and writable",
            });
          }

          // Both roles checked at once, as the dashboard and `calsync status` do:
          // one lands first and is recorded, the one that completes the pair is not.
          const statuses = await Promise.all([second.check("personal"), second.check("work")]);
          const refused = statuses.filter((status) => !status.valid);
          expect(refused).toHaveLength(1);
          expect(refused[0]).toMatchObject({
            configured: true,
            message: PAIR_CONFLICT_MESSAGE,
            conflictsWith: "default",
          });
          expect(second.state.listAccounts()).toHaveLength(1);
          expect(second.state.listReadyTenants()).toEqual(["default"]);

          // Polling again changes nothing; removing the first tenant frees the pair.
          await expect(second.check(refused[0]?.role ?? "work")).resolves.toMatchObject({
            valid: false,
            conflictsWith: "default",
          });
          first.state.deleteAccount("personal");
          first.state.deleteAccount("work");
          await expect(second.check(refused[0]?.role ?? "work")).resolves.toMatchObject({
            valid: true,
          });
          expect(second.state.listReadyTenants()).toEqual(["i39b86"]);
        } finally {
          first.state.close();
          second.state.close();
        }
      });
    });

    it("warns about two established tenants on one pair without unseating either", async () => {
      await withSharedDatabase(async (path) => {
        const first = tenantAuth(path, "default");
        const second = tenantAuth(path, "i39b86");
        try {
          // Rows written before the guard existed carry no fingerprint.
          for (const state of [first.state, second.state]) {
            state.upsertAccount("personal", CALENDAR.personal);
            state.upsertAccount("work", CALENDAR.work);
          }
          await first.check("personal");
          await first.check("work");
          await second.check("personal");
          const status = await second.check("work");
          expect(status).toMatchObject({
            valid: true,
            message: "authorized and writable",
            conflictsWith: "default",
          });
          await expect(first.check("work")).resolves.toMatchObject({
            valid: true,
            conflictsWith: "i39b86",
          });
        } finally {
          first.state.close();
          second.state.close();
        }
      });
    });
  });

  it("reports a missing grant as an actionable status instead of failing", async () => {
    const tokens: TokenStore = {
      getRefreshToken: vi.fn(() => Promise.reject(new GrantError("not granted"))),
      setRefreshToken: vi.fn(() => Promise.resolve()),
      deleteRefreshToken: vi.fn(() => Promise.resolve(false)),
    };
    const state = new StateDatabase(":memory:");
    try {
      const auth = new GoogleAuthService(
        { clientId: "client", clientSecret: "secret" },
        tokens,
        state,
      );

      await expect(auth.getStatus("personal", "primary")).resolves.toMatchObject({
        role: "personal",
        configured: true,
        valid: false,
        message: "connected but not granted to calsync; run calsync auth personal to re-grant",
      });
    } finally {
      state.close();
    }
  });
});
