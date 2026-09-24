import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ConfigError,
  defaultTenantId,
  loadConfig,
  parseTenantId,
  repositoryRoot,
} from "../src/config.js";

describe("repositoryRoot", () => {
  it("resolves the checkout root from this module, not process cwd", () => {
    const root = repositoryRoot();

    expect(root).toBe(resolve(fileURLToPath(new URL("../../..", import.meta.url))));
    expect(existsSync(join(root, "package.json"))).toBe(true);
    expect(existsSync(join(root, "packages", "engine", "package.json"))).toBe(true);
    expect(existsSync(join(root, "node_modules", "@dvd-toy-box", "vault", "package.json"))).toBe(
      true,
    );
    expect(existsSync(join(root, "apps", "cli", "package.json"))).toBe(true);
  });
});

describe("tenant ids", () => {
  it("rejects tenant ids that cannot form vault token slots", () => {
    expect(parseTenantId("acme-2")).toBe("acme-2");
    expect(() => parseTenantId("Acme Corp")).toThrow(ConfigError);
    expect(() => parseTenantId("has_underscore")).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        CALSYNC_PERSONAL_CALENDAR_ID: "personal@example.com",
        CALSYNC_WORK_CALENDAR_ID: "work@example.com",
        CALSYNC_TENANT_ID: "Bad Tenant",
      }),
    ).toThrow(ConfigError);
  });

  it("resolves the default tenant without full configuration", () => {
    expect(defaultTenantId({})).toBe("default");
    expect(defaultTenantId({ CALSYNC_TENANT_ID: " acme " })).toBe("acme");
    expect(() => defaultTenantId({ CALSYNC_TENANT_ID: "Bad Tenant" })).toThrow(ConfigError);
  });
});

describe("loadConfig", () => {
  it("loads required accounts and applies safe defaults", () => {
    const config = loadConfig({
      CALSYNC_PERSONAL_CALENDAR_ID: "personal@example.com",
      CALSYNC_WORK_CALENDAR_ID: "work@example.com",
      CALSYNC_TIMEZONE: "America/Los_Angeles",
    });

    expect(config.accounts.personal).toEqual({
      tenantId: "default",
      role: "personal",
      calendarId: "personal@example.com",
    });
    expect(config.accounts.work).toEqual({
      tenantId: "default",
      role: "work",
      calendarId: "work@example.com",
    });
    expect(config.pollIntervalMs).toBe(60_000);
    expect(config.fullSyncIntervalMs).toBe(86_400_000);
    expect(config.logging).toEqual({ maxBytes: 5 * 1024 * 1024, backups: 5 });
    expect(config.window).toEqual({ pastDays: 30, futureDays: 365 });
    expect(config.exclusions.personalToWork).toEqual([]);
    expect(config.exclusions.personalToWorkKeywords).toEqual([]);
  });

  it("normalizes optional per-direction exclusions", () => {
    const config = loadConfig({
      CALSYNC_PERSONAL_CALENDAR_ID: "personal",
      CALSYNC_WORK_CALENDAR_ID: "work",
      CALSYNC_TIMEZONE: "UTC",
      CALSYNC_EXCLUDE_PERSONAL_TO_WORK: "focus, travel, focus",
      CALSYNC_EXCLUDE_WORK_TO_PERSONAL: " on-call ",
      CALSYNC_EXCLUDE_PERSONAL_TO_WORK_KEYWORDS: " Team Sync, [VIP], team sync, , C++ ",
      CALSYNC_EXCLUDE_WORK_TO_PERSONAL_KEYWORDS: " Confidential ",
    });

    expect(config.exclusions.personalToWork).toEqual(["focus", "travel"]);
    expect(config.exclusions.workToPersonal).toEqual(["on-call"]);
    expect(config.exclusions.personalToWorkKeywords).toEqual(["team sync", "[vip]", "c++"]);
    expect(config.exclusions.workToPersonalKeywords).toEqual(["confidential"]);
  });

  it("reports invalid configuration without exposing values", () => {
    expect(() =>
      loadConfig({
        CALSYNC_PERSONAL_CALENDAR_ID: "",
        CALSYNC_WORK_CALENDAR_ID: "private-calendar-id",
        CALSYNC_TIMEZONE: "not/a-timezone",
      }),
    ).toThrow(ConfigError);

    try {
      loadConfig({
        CALSYNC_PERSONAL_CALENDAR_ID: "",
        CALSYNC_WORK_CALENDAR_ID: "private-calendar-id",
        CALSYNC_TIMEZONE: "UTC",
      });
    } catch (error) {
      expect(String(error)).not.toContain("private-calendar-id");
    }
  });

  it("validates full-sync cadence and bounded log rotation settings", () => {
    expect(() =>
      loadConfig({
        CALSYNC_PERSONAL_CALENDAR_ID: "personal",
        CALSYNC_WORK_CALENDAR_ID: "work",
        CALSYNC_TIMEZONE: "UTC",
        CALSYNC_FULL_SYNC_INTERVAL_HOURS: "0",
        CALSYNC_LOG_MAX_BYTES: "100",
        CALSYNC_LOG_BACKUPS: "0",
      }),
    ).toThrow(ConfigError);

    const config = loadConfig({
      CALSYNC_PERSONAL_CALENDAR_ID: "personal",
      CALSYNC_WORK_CALENDAR_ID: "work",
      CALSYNC_TIMEZONE: "UTC",
      CALSYNC_FULL_SYNC_INTERVAL_HOURS: "12",
      CALSYNC_LOG_MAX_BYTES: "2048",
      CALSYNC_LOG_BACKUPS: "3",
    });
    expect(config.fullSyncIntervalMs).toBe(43_200_000);
    expect(config.logging).toEqual({ maxBytes: 2_048, backups: 3 });
  });
});

describe("webhook configuration", () => {
  const base = {
    CALSYNC_PERSONAL_CALENDAR_ID: "personal",
    CALSYNC_WORK_CALENDAR_ID: "work",
    CALSYNC_TIMEZONE: "UTC",
  };

  it("leaves push off when no address is configured", () => {
    expect(loadConfig(base).webhook).toBeUndefined();
    expect(loadConfig({ ...base, CALSYNC_WEBHOOK_URL: "  " }).webhook).toBeUndefined();
  });

  it("derives the loopback path from the public address and defaults the rest", () => {
    const config = loadConfig({
      ...base,
      CALSYNC_WEBHOOK_URL: "https://calsync.example.test/gcal/webhook",
    });

    expect(config.webhook).toEqual({
      address: "https://calsync.example.test/gcal/webhook",
      host: "127.0.0.1",
      port: 8787,
      path: "/gcal/webhook",
      debounceMs: 8_000,
      channelTtlSeconds: 604_800,
      renewBeforeMs: 3_600_000,
      pollIntervalMs: 900_000,
    });
    // The poll timer stays configured as the degraded fallback.
    expect(config.pollIntervalMs).toBe(60_000);
  });

  it("accepts an explicit forwarded path and port", () => {
    const config = loadConfig({
      ...base,
      CALSYNC_WEBHOOK_URL: "https://calsync.example.test/hooks/gcal",
      CALSYNC_WEBHOOK_PATH: "/internal/gcal",
      CALSYNC_WEBHOOK_PORT: "9100",
      CALSYNC_WEBHOOK_POLL_INTERVAL_SECONDS: "300",
    });

    expect(config.webhook?.path).toBe("/internal/gcal");
    expect(config.webhook?.port).toBe(9100);
    expect(config.webhook?.pollIntervalMs).toBe(300_000);
  });

  it("refuses an address Google could not deliver to", () => {
    expect(() =>
      loadConfig({ ...base, CALSYNC_WEBHOOK_URL: "http://calsync.example.test/hook" }),
    ).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, CALSYNC_WEBHOOK_URL: "calsync.example.test" })).toThrow(
      ConfigError,
    );
  });
});
