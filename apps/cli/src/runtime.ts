import {
  brokeredToken,
  egressFromEnv,
  openVault,
  type EgressEndpoint,
  type Vault,
} from "@dvd-toy-box/vault";

import type { AccountRole } from "@calsync/engine";

import {
  loadConfig,
  loadOAuthConfig,
  stateDatabasePath,
  type AppConfig,
  type OAuthConfig,
} from "./config.js";
import { GOOGLE_CALENDAR_SCOPES, GoogleAuthService, type TokenExchange } from "./google/auth.js";
import { RotatingFileLogger, serviceLogPath } from "./logging.js";
import {
  MacOsKeychainTokenStore,
  StateDatabase,
  tokenSlot,
  VaultTokenStore,
  type AccountRecord,
} from "./storage/index.js";
import {
  daemonLockPathFor,
  DefaultSyncService,
  SyncDaemon,
  syncLockPathFor,
  type DaemonTenant,
  type SyncService,
} from "./sync/service.js";

export const CALSYNC_VERSION = "0.1.0";

/** Rewrites the configured tenant when a CLI --tenant override is given. */
function applyTenant(config: AppConfig, tenantId?: string): AppConfig {
  if (tenantId === undefined || tenantId === config.tenantId) {
    return config;
  }
  return {
    ...config,
    tenantId,
    accounts: {
      personal: { ...config.accounts.personal, tenantId },
      work: { ...config.accounts.work, tenantId },
    },
  };
}

export interface LiveAppRuntime {
  auth: GoogleAuthService;
  state: StateDatabase;
  sync: SyncService;
}

export function createAuthRuntime(tenantId?: string): LiveAppRuntime {
  const oauth = loadOAuthConfig();
  const databasePath = stateDatabasePath();
  const config = applyTenant(loadConfig(), tenantId);
  const state = new StateDatabase(databasePath, config.tenantId);
  const vault = openVault();
  // Under the gateway, mint short-lived access tokens from the broker instead
  // of reading refresh tokens in this process. Broker slots follow the same
  // tenant scoping as the local vault (tokenSlot), so one broker can hold
  // grants for every tenant on the host.
  const egress = egressFromEnv();
  const auth = authServiceFor(oauth, vault, state, config.tenantId, egress);
  const logger = new RotatingFileLogger(serviceLogPath(), {
    maxBytes: config.logging?.maxBytes ?? 5 * 1024 * 1024,
    backups: config.logging?.backups ?? 5,
  });
  const writeLog = logger.write.bind(logger);
  const base = new DefaultSyncService(
    config,
    auth,
    state,
    syncLockPathFor(databasePath, config.tenantId),
    writeLog,
  );
  return {
    auth,
    state,
    sync: {
      once: (options) => base.once(options),
      rebuild: (options) => base.rebuild(options),
      cleanup: (options) => base.cleanup(options),
      dedupe: (options) => base.dedupe(options),
      // One daemon serves every authorized tenant on this host; the accounts
      // table is re-consulted before every pass round, so tenants signed up
      // while the daemon runs are picked up without a restart.
      start: (options) =>
        buildDaemon(oauth, vault, databasePath, config, base, state, egress, writeLog).start(
          options,
        ),
    },
  };
}

function authServiceFor(
  oauth: OAuthConfig,
  vault: Vault,
  state: StateDatabase,
  tenantId: string,
  egress: EgressEndpoint | null,
): GoogleAuthService {
  // The legacy Keychain fallback only exists (and only constructs) on macOS.
  const legacy =
    process.platform === "darwin"
      ? new MacOsKeychainTokenStore(undefined, undefined, undefined, tenantId)
      : undefined;
  const tokens = new VaultTokenStore(vault, legacy, GOOGLE_CALENDAR_SCOPES, tenantId);
  const tokenExchange = egress === null ? undefined : brokeredExchangeFor(egress, tenantId);
  return new GoogleAuthService(oauth, tokens, state, undefined, undefined, tokenExchange);
}

/**
 * Broker exchange for one tenant. The default tenant keeps the bare role
 * slots, so an existing single-user gateway keeps working; other tenants ask
 * the broker for "<tenant>_<role>" — the gateway must store grants under the
 * same slots (the tokenSlot contract shared with the local vault).
 */
export function brokeredExchangeFor(
  egress: EgressEndpoint,
  tenantId: string,
  mint: typeof brokeredToken = brokeredToken,
): TokenExchange {
  return async (role: AccountRole) => {
    const token = await mint(egress, { provider: "google", slot: tokenSlot(role, tenantId) });
    return { access_token: token.accessToken, expiry_date: Date.parse(token.expiresAt) };
  };
}

function buildDaemon(
  oauth: OAuthConfig,
  vault: Vault,
  databasePath: string,
  config: AppConfig,
  base: DefaultSyncService,
  baseState: StateDatabase,
  egress: EgressEndpoint | null,
  writeLog: (line: string) => void,
): SyncDaemon {
  const baseTenant = base.daemonTenant();
  const extras = new Map<string, { tenant: DaemonTenant; close: () => void }>();

  // Re-consulted before every pass round, so a tenant that authorizes while
  // the daemon runs joins the loop without a restart — and one whose accounts
  // go away (or change calendars) is rebuilt or retired.
  const liveTenants = (): readonly DaemonTenant[] => {
    const ready = new Set(baseState.listReadyTenants());
    ready.delete(config.tenantId);
    for (const [tenantId, entry] of extras) {
      if (!ready.has(tenantId)) {
        extras.delete(tenantId);
        entry.close();
        writeLog(JSON.stringify({ event: "tenant_retired", tenant: tenantId }));
      }
    }
    for (const tenantId of ready) {
      const tenantConfig = configForTenant(config, tenantId, baseState.listAccounts(tenantId));
      if (tenantConfig === undefined) {
        continue;
      }
      const cached = extras.get(tenantId);
      if (cached !== undefined) {
        if (sameCalendars(cached.tenant.calendarIds, tenantConfig)) {
          continue;
        }
        extras.delete(tenantId);
        cached.close();
      }
      // Each tenant authenticates with its own vault tokens — or, under the
      // gateway, its own tenant-scoped broker slots. State connections live
      // until the tenant retires.
      const tenantState = new StateDatabase(databasePath, tenantId);
      const tenantAuth = authServiceFor(oauth, vault, tenantState, tenantId, egress);
      extras.set(tenantId, {
        tenant: new DefaultSyncService(
          tenantConfig,
          tenantAuth,
          tenantState,
          syncLockPathFor(databasePath, tenantId),
          writeLog,
        ).daemonTenant(),
        close: () => {
          tenantState.close();
        },
      });
      writeLog(
        JSON.stringify({
          event: cached === undefined ? "tenant_discovered" : "tenant_updated",
          tenant: tenantId,
        }),
      );
    }
    return [baseTenant, ...[...extras.values()].map((entry) => entry.tenant)];
  };

  return new SyncDaemon(
    config,
    liveTenants,
    (channelId) => baseState.getWatchChannelByChannelId(channelId),
    // One box-wide daemon lock, regardless of which tenant the env names.
    daemonLockPathFor(syncLockPathFor(databasePath)),
    writeLog,
  );
}

function sameCalendars(
  calendarIds: Record<"personal" | "work", string>,
  config: AppConfig,
): boolean {
  return (
    calendarIds.personal === config.accounts.personal.calendarId &&
    calendarIds.work === config.accounts.work.calendarId
  );
}

/**
 * Per-tenant sync configuration: shared env settings plus the calendar IDs
 * the tenant's accounts were authorized against.
 *
 * The shared `timezone` is safe for tenants in different timezones: it only
 * shapes how Google formats list responses and feeds the sync fingerprint.
 * Event identity canonicalizes datetimes to UTC instants, window bounds are
 * absolute instants, and mirrored busy blocks copy each source event's own
 * times and timezone — so nothing tenant-visible depends on it.
 */
function configForTenant(
  base: AppConfig,
  tenantId: string,
  accounts: readonly AccountRecord[],
): AppConfig | undefined {
  const personal = accounts.find((account) => account.role === "personal");
  const work = accounts.find((account) => account.role === "work");
  if (personal === undefined || work === undefined) {
    return undefined;
  }
  return {
    ...base,
    tenantId,
    accounts: {
      personal: { tenantId, role: "personal", calendarId: personal.calendarId },
      work: { tenantId, role: "work", calendarId: work.calendarId },
    },
  };
}
