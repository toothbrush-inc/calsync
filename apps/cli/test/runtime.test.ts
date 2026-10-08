import { describe, expect, it, vi } from "vitest";

import type { BrokeredToken, EgressEndpoint } from "@dvd-toy-box/vault";

import { loadConfig } from "../src/config.js";
import { withStoredCalendars } from "../src/calendars.js";
import { brokeredExchangeFor } from "../src/runtime.js";

const egress: EgressEndpoint = { url: "https://egress.test", token: "egress-token" };

describe("brokeredExchangeFor", () => {
  it("requests tenant-scoped broker slots, keeping bare roles for the default tenant", async () => {
    const slots: string[] = [];
    const mint = vi.fn(
      (_endpoint: EgressEndpoint, request: { provider: string; slot?: string }) => {
        slots.push(request.slot ?? "");
        const token: BrokeredToken = {
          accessToken: "short-lived",
          expiresAt: "2026-08-28T12:00:00.000Z",
        };
        return Promise.resolve(token);
      },
    );

    const defaultExchange = brokeredExchangeFor(egress, "default", mint);
    const acmeExchange = brokeredExchangeFor(egress, "acme", mint);

    const minted = await defaultExchange("personal");
    await defaultExchange("work");
    await acmeExchange("personal");
    await acmeExchange("work");

    expect(slots).toEqual(["personal", "work", "acme_personal", "acme_work"]);
    expect(minted).toEqual({
      access_token: "short-lived",
      expiry_date: Date.parse("2026-08-28T12:00:00.000Z"),
    });
  });
});

describe("withStoredCalendars", () => {
  const config = loadConfig({
    CALSYNC_PERSONAL_CALENDAR_ID: "primary",
    CALSYNC_WORK_CALENDAR_ID: "primary",
    CALSYNC_TIMEZONE: "UTC",
  });

  it("syncs the two environment calendars until any calendar is connected", () => {
    expect(withStoredCalendars(config, [], []).calendars.map((calendar) => calendar.key)).toEqual([
      "personal",
      "work",
    ]);
  });

  it("stays without calendars once a signed-in tenant removed them all", () => {
    const signedIn = [
      { tenantId: "default", slot: "personal", email: null, authorizedAt: "", verifiedAt: null },
    ];
    expect(withStoredCalendars(config, [], signedIn).calendars).toEqual([]);
  });

  it("then syncs exactly the connected calendars, each through its sign-in", () => {
    const stored = withStoredCalendars(
      config,
      [
        {
          tenantId: "default",
          key: "work",
          account: "work",
          calendarId: "primary",
          name: null,
          accessRole: "owner",
          source: true,
          destination: true,
          addedAt: "",
          verifiedAt: null,
        },
        {
          tenantId: "default",
          key: "cal-team",
          account: "account1",
          calendarId: "team@group.test",
          name: "Team",
          accessRole: "reader",
          source: true,
          destination: false,
          addedAt: "",
          verifiedAt: null,
        },
      ],
      [],
    );
    expect(stored.calendars).toEqual([
      { key: "work", account: "work", calendarId: "primary", source: true, destination: true },
      {
        key: "cal-team",
        account: "account1",
        calendarId: "team@group.test",
        source: true,
        destination: false,
      },
    ]);
    // The role sign-ins stay available for `calsync auth`.
    expect(stored.accounts.personal.calendarId).toBe("primary");
  });
});
