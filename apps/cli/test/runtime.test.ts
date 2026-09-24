import { describe, expect, it, vi } from "vitest";

import type { BrokeredToken, EgressEndpoint } from "@dvd-toy-box/vault";

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
