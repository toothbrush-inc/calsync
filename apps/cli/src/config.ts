import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import { z } from "zod";

import type { SyncConfig } from "@calsync/engine";
import type { ScanGateLimits } from "./scanlimit.js";

export {
  accountRoles,
  type AccountConfig,
  type AccountRole,
  type SyncConfig,
} from "@calsync/engine";

export function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

loadDotenv({ path: join(repositoryRoot(), ".env"), quiet: true });

const timezoneSchema = z.string().trim().min(1).refine(isValidTimezone, {
  message: "must be a valid IANA timezone, such as America/Los_Angeles",
});

// An empty value means "unset", so clearing the variable turns push off.
const webhookUrlSchema = z
  .string()
  .trim()
  .refine((value) => value === "" || isHttpsUrl(value), {
    message: "must be an https:// URL; Google only posts to a valid TLS certificate",
  });

// Tenant ids flow into vault slot names ("<tenant>_<role>"), which allow only
// lowercase identifiers; underscore stays reserved as the slot separator.
const TENANT_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const TENANT_ID_MESSAGE =
  "tenant id must be lowercase letters, digits, and hyphens, starting with a letter";

const envSchema = z.object({
  CALSYNC_TENANT_ID: z
    .string()
    .trim()
    .regex(TENANT_ID_PATTERN, TENANT_ID_MESSAGE)
    .default("default"),
  CALSYNC_PERSONAL_CALENDAR_ID: z.string().trim().min(1),
  CALSYNC_WORK_CALENDAR_ID: z.string().trim().min(1),
  CALSYNC_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  CALSYNC_FULL_SYNC_INTERVAL_HOURS: z.coerce
    .number()
    .int()
    .positive()
    .max(24 * 30)
    .default(24),
  CALSYNC_WINDOW_PAST_DAYS: z.coerce.number().int().nonnegative().default(30),
  CALSYNC_WINDOW_FUTURE_DAYS: z.coerce.number().int().positive().default(365),
  CALSYNC_LOG_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(1024 * 1024 * 1024)
    .default(5 * 1024 * 1024),
  CALSYNC_LOG_BACKUPS: z.coerce.number().int().min(1).max(100).default(5),
  CALSYNC_TIMEZONE: timezoneSchema,
  CALSYNC_WEBHOOK_URL: webhookUrlSchema.optional(),
  CALSYNC_WEBHOOK_HOST: z.string().trim().min(1).default("127.0.0.1"),
  CALSYNC_WEBHOOK_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  CALSYNC_WEBHOOK_PATH: z.string().trim().min(1).optional(),
  CALSYNC_WEBHOOK_DEBOUNCE_SECONDS: z.coerce.number().int().min(0).max(300).default(8),
  CALSYNC_WEBHOOK_CHANNEL_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(30 * 24 * 60 * 60)
    .default(7 * 24 * 60 * 60),
  CALSYNC_WEBHOOK_RENEW_BEFORE_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(24 * 60 * 60)
    .default(60 * 60),
  CALSYNC_WEBHOOK_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(900),
  CALSYNC_EXCLUDE_PERSONAL_TO_WORK: z.string().optional(),
  CALSYNC_EXCLUDE_WORK_TO_PERSONAL: z.string().optional(),
  CALSYNC_EXCLUDE_PERSONAL_TO_WORK_KEYWORDS: z.string().optional(),
  CALSYNC_EXCLUDE_WORK_TO_PERSONAL_KEYWORDS: z.string().optional(),
});

const oauthEnvSchema = z.object({
  GOOGLE_OAUTH_CLIENT_ID: z.string().trim().min(1),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().trim().min(1),
});

/**
 * Push-notification settings. Present only when CALSYNC_WEBHOOK_URL is set;
 * without it the daemon stays on its poll timer.
 */
export interface WebhookConfig {
  /** Public HTTPS address registered with Google. */
  address: string;
  /** Loopback interface the receiver binds; a reverse proxy fronts it. */
  host: string;
  port: number;
  path: string;
  debounceMs: number;
  channelTtlSeconds: number;
  renewBeforeMs: number;
  /** Backstop pass interval while channels are armed. */
  pollIntervalMs: number;
}

export interface AppConfig extends SyncConfig {
  pollIntervalMs: number;
  webhook?: WebhookConfig;
  logging?: {
    maxBytes: number;
    backups: number;
  };
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Validates a tenant id from any source (env, --tenant, tenant/role prefix). */
export function parseTenantId(value: string): string {
  const trimmed = value.trim();
  if (!TENANT_ID_PATTERN.test(trimmed)) {
    throw new ConfigError(`Invalid tenant id "${value}": ${TENANT_ID_MESSAGE}`);
  }
  return trimmed;
}

/**
 * Resolves the tenant from CALSYNC_TENANT_ID alone, for commands that don't
 * need (or want to require) the full calendar configuration.
 */
export function defaultTenantId(env: NodeJS.ProcessEnv = process.env): string {
  const value = env["CALSYNC_TENANT_ID"]?.trim();
  return value === undefined || value.length === 0 ? "default" : parseTenantId(value);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const input = {
    ...env,
    CALSYNC_TIMEZONE: env["CALSYNC_TIMEZONE"] ?? systemTimezone(),
  };
  const result = envSchema.safeParse(input);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid calsync configuration: ${details}`);
  }

  const values = result.data;
  const webhook = webhookConfig(values);

  return {
    tenantId: values.CALSYNC_TENANT_ID,
    accounts: {
      personal: {
        tenantId: values.CALSYNC_TENANT_ID,
        role: "personal",
        calendarId: values.CALSYNC_PERSONAL_CALENDAR_ID,
      },
      work: {
        tenantId: values.CALSYNC_TENANT_ID,
        role: "work",
        calendarId: values.CALSYNC_WORK_CALENDAR_ID,
      },
    },
    pollIntervalMs: values.CALSYNC_POLL_INTERVAL_SECONDS * 1_000,
    ...(webhook === undefined ? {} : { webhook }),
    fullSyncIntervalMs: values.CALSYNC_FULL_SYNC_INTERVAL_HOURS * 60 * 60 * 1_000,
    window: {
      pastDays: values.CALSYNC_WINDOW_PAST_DAYS,
      futureDays: values.CALSYNC_WINDOW_FUTURE_DAYS,
    },
    timezone: values.CALSYNC_TIMEZONE,
    exclusions: {
      personalToWork: parseList(values.CALSYNC_EXCLUDE_PERSONAL_TO_WORK),
      workToPersonal: parseList(values.CALSYNC_EXCLUDE_WORK_TO_PERSONAL),
      personalToWorkKeywords: parseKeywords(values.CALSYNC_EXCLUDE_PERSONAL_TO_WORK_KEYWORDS),
      workToPersonalKeywords: parseKeywords(values.CALSYNC_EXCLUDE_WORK_TO_PERSONAL_KEYWORDS),
    },
    logging: {
      maxBytes: values.CALSYNC_LOG_MAX_BYTES,
      backups: values.CALSYNC_LOG_BACKUPS,
    },
  };
}

export interface WebConfig {
  host: string;
  port: number;
  secret?: string;
  connectUrl?: string;
  baseUrl?: string;
  /** Request header carrying a signed-in email, set by a trusted proxy. */
  identityHeader?: string;
  /** Email -> tenant overrides for identity-header sign-in. */
  identityTenants?: Record<string, string>;
}

/** "a@x.test=default,b@y.test=acme" -> { "a@x.test": "default", ... } */
export function parseIdentityTenants(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (entry === "") {
      continue;
    }
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new ConfigError(
        `Invalid CALSYNC_WEB_IDENTITY_TENANTS entry "${entry}": expected email=tenant`,
      );
    }
    const email = entry.slice(0, separator).trim().toLowerCase();
    map[email] = parseTenantId(entry.slice(separator + 1));
  }
  return map;
}

const webEnvSchema = z.object({
  CALSYNC_WEB_HOST: z.string().trim().min(1).default("127.0.0.1"),
  CALSYNC_WEB_PORT: z.coerce.number().int().min(0).max(65_535).default(8788),
  // Signing key for tenant onboarding links. Without it the dashboard serves
  // only the default tenant and should stay on loopback.
  CALSYNC_WEB_SECRET: z.string().trim().min(16).optional(),
  // External connect URL template ({tenant}, {role}) for gateway/brokered
  // deployments where grants are collected at the broker.
  CALSYNC_WEB_CONNECT_URL: z.string().trim().min(1).optional(),
  // Public base URL used when minting onboarding links.
  CALSYNC_WEB_BASE_URL: z.string().trim().min(1).optional(),
  // Trusted identity header (e.g. x-forwarded-user) set by the proxy after
  // its own sign-in check. Only meaningful behind such a proxy, which must
  // strip any client-supplied copy; never set it on a directly reachable
  // server. Requires CALSYNC_WEB_SECRET (multi-tenant mode).
  CALSYNC_WEB_IDENTITY_HEADER: z.string().trim().min(1).optional(),
  // Email=tenant overrides for identity sign-in (the operator's own address
  // maps to "default"); everyone else gets a tenant from a SHA-256 hash of
  // their email.
  CALSYNC_WEB_IDENTITY_TENANTS: z.string().trim().optional(),
});

export function loadWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const result = webEnvSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid calsync web configuration: ${details}`);
  }
  const values = result.data;
  return {
    host: values.CALSYNC_WEB_HOST,
    port: values.CALSYNC_WEB_PORT,
    ...(values.CALSYNC_WEB_SECRET === undefined ? {} : { secret: values.CALSYNC_WEB_SECRET }),
    ...(values.CALSYNC_WEB_CONNECT_URL === undefined
      ? {}
      : { connectUrl: values.CALSYNC_WEB_CONNECT_URL }),
    ...(values.CALSYNC_WEB_BASE_URL === undefined ? {} : { baseUrl: values.CALSYNC_WEB_BASE_URL }),
    ...(values.CALSYNC_WEB_IDENTITY_HEADER === undefined
      ? {}
      : { identityHeader: values.CALSYNC_WEB_IDENTITY_HEADER.toLowerCase() }),
    ...(values.CALSYNC_WEB_IDENTITY_TENANTS === undefined ||
    values.CALSYNC_WEB_IDENTITY_TENANTS === ""
      ? {}
      : { identityTenants: parseIdentityTenants(values.CALSYNC_WEB_IDENTITY_TENANTS) }),
  };
}

/**
 * How often the full-window passes — the dashboard's preview and stray-block
 * check, and the MCP tools behind them — may actually run. Each 0 turns its
 * layer off. The daemon's own passes never pass through the gate.
 */
const scanLimitEnvSchema = z.object({
  CALSYNC_SCAN_CACHE_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(60 * 60)
    .default(30),
  CALSYNC_SCAN_MIN_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(24 * 60 * 60)
    .default(60),
  CALSYNC_WRITE_MIN_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(24 * 60 * 60)
    .default(300),
});

export function loadScanGateLimits(env: NodeJS.ProcessEnv = process.env): ScanGateLimits {
  const result = scanLimitEnvSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid calsync scan limits: ${details}`);
  }
  const values = result.data;
  return {
    cacheMs: values.CALSYNC_SCAN_CACHE_SECONDS * 1_000,
    scanIntervalMs: values.CALSYNC_SCAN_MIN_INTERVAL_SECONDS * 1_000,
    writeIntervalMs: values.CALSYNC_WRITE_MIN_INTERVAL_SECONDS * 1_000,
  };
}

export function loadOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  const result = oauthEnvSchema.safeParse(env);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new ConfigError(`Missing Google OAuth configuration: ${fields}`);
  }
  return {
    clientId: result.data.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: result.data.GOOGLE_OAUTH_CLIENT_SECRET,
  };
}

export function stateDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env["CALSYNC_DATABASE_PATH"] ??
    join(homedir(), "Library", "Application Support", "calsync", "state.sqlite3")
  );
}

function webhookConfig(values: {
  CALSYNC_WEBHOOK_URL?: string | undefined;
  CALSYNC_WEBHOOK_HOST: string;
  CALSYNC_WEBHOOK_PORT: number;
  CALSYNC_WEBHOOK_PATH?: string | undefined;
  CALSYNC_WEBHOOK_DEBOUNCE_SECONDS: number;
  CALSYNC_WEBHOOK_CHANNEL_TTL_SECONDS: number;
  CALSYNC_WEBHOOK_RENEW_BEFORE_SECONDS: number;
  CALSYNC_WEBHOOK_POLL_INTERVAL_SECONDS: number;
}): WebhookConfig | undefined {
  const address = values.CALSYNC_WEBHOOK_URL;
  if (address === undefined || address === "") {
    return undefined;
  }
  return {
    address,
    host: values.CALSYNC_WEBHOOK_HOST,
    port: values.CALSYNC_WEBHOOK_PORT,
    path: values.CALSYNC_WEBHOOK_PATH ?? new URL(address).pathname,
    debounceMs: values.CALSYNC_WEBHOOK_DEBOUNCE_SECONDS * 1_000,
    channelTtlSeconds: values.CALSYNC_WEBHOOK_CHANNEL_TTL_SECONDS,
    renewBeforeMs: values.CALSYNC_WEBHOOK_RENEW_BEFORE_SECONDS * 1_000,
    pollIntervalMs: values.CALSYNC_WEBHOOK_POLL_INTERVAL_SECONDS * 1_000,
  };
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function parseList(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }

  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function parseKeywords(value: string | undefined): readonly string[] {
  return [...new Set(parseList(value).map((keyword) => keyword.toLowerCase()))];
}

function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
