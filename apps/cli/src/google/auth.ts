import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";

import { EgressRequiredError, GrantError, LoopbackError, LoopbackServer } from "@dvd-toy-box/vault";
import { CodeChallengeMethod } from "google-auth-library";
import { google } from "googleapis";
import type { calendar_v3 } from "googleapis";

import type { AccountRole, OAuthConfig } from "../config.js";
import { StateDatabase } from "../storage/database.js";
import type { TokenStore } from "../storage/keychain.js";
import {
  createGoogleCalendarClient,
  googleApiErrorInfo,
  isRetryableGoogleError,
  type CalendarClient,
} from "./calendar.js";
import { createGoogleChannelClient, type ChannelClient } from "./channels.js";

export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
] as const;

export interface AccountStatus {
  role: AccountRole;
  configured: boolean;
  valid: boolean;
  calendarId: string;
  message: string;
  /** The calendar's real id once validated — for "primary", the Google
   * account's email, which is what tells a person which account they
   * connected. */
  account?: string;
  /** Another tenant on this host already syncing the same calendar pair.
   * Operator-facing: a tenant id derives from someone's sign-in, so surfaces
   * shown to the person report only that a conflict exists. */
  conflictsWith?: string;
}

export const PAIR_CONFLICT_MESSAGE =
  "these two calendars are already syncing under another calsync tenant on this host; " +
  "open that tenant's dashboard instead, or have it removed before connecting here";

/**
 * Identifies a calendar for equality across tenants without storing its id:
 * for "primary" the validated entry carries the account's email, which is
 * what two tenants on one Google account have in common.
 */
export function calendarFingerprint(
  entry: calendar_v3.Schema$CalendarListEntry,
  calendarId: string,
): string | undefined {
  const resolved =
    typeof entry.id === "string" && entry.id !== ""
      ? entry.id
      : calendarId === "primary"
        ? undefined
        : calendarId;
  return resolved === undefined
    ? undefined
    : createHash("sha256")
        .update(`calsync-calendar\0${resolved.trim().toLowerCase()}`)
        .digest("hex");
}

export interface AuthorizationOptions {
  openBrowser?: boolean;
  onAuthorizationUrl?: (url: string) => void;
  onBrowserOpenFailure?: (url: string, error: unknown) => void;
}

export interface ConnectStartResult {
  provider: "google";
  slot: AccountRole;
  url: string;
  expiresAt: string;
}

/** Shape google-auth-library's refreshHandler expects. */
export interface ExchangedToken {
  access_token: string;
  expiry_date: number;
}

/**
 * Broker-side token exchange: mints a short-lived access token for a role.
 * When set, API clients never read the refresh token in this process.
 */
export type TokenExchange = (role: AccountRole) => Promise<ExchangedToken>;

interface GoogleConnectSession {
  url: string;
  expiresAt: Date;
  complete(): Promise<void>;
  cancel(): void;
}

export class AuthenticationError extends Error {
  override readonly name = "AuthenticationError";
}

export class GoogleAuthService {
  private readonly pending = new Map<AccountRole, GoogleConnectSession>();

  constructor(
    private readonly oauth: OAuthConfig,
    private readonly tokens: TokenStore,
    private readonly state: StateDatabase,
    private readonly openBrowser: (url: string) => Promise<void> = openSystemBrowser,
    private readonly startLoopback: (
      role: AccountRole,
      state: string,
    ) => Promise<LoopbackServer> = (role, state) => startGoogleLoopback(role, process.env, state),
    private readonly tokenExchange?: TokenExchange,
    private readonly validateAccess: typeof validateCalendarAccess = validateCalendarAccess,
  ) {}

  async authorize(
    role: AccountRole,
    calendarId: string,
    options: AuthorizationOptions = {},
  ): Promise<void> {
    this.cancelConnect(role);
    const session = await this.createConnectSession(role, calendarId);
    try {
      await presentAuthorizationUrl(session.url, options, this.openBrowser);
      await session.complete();
    } catch (error) {
      session.cancel();
      if (error instanceof AuthenticationError) {
        throw error;
      }
      throw new AuthenticationError(authFailureMessage(error));
    }
  }

  async startConnect(
    role: AccountRole,
    calendarId: string,
    options: AuthorizationOptions = {},
  ): Promise<ConnectStartResult> {
    this.cancelConnect(role);
    const session = await this.createConnectSession(role, calendarId);
    this.pending.set(role, session);
    try {
      await presentAuthorizationUrl(session.url, options, this.openBrowser);
    } catch (error) {
      session.cancel();
      this.pending.delete(role);
      if (error instanceof AuthenticationError) {
        throw error;
      }
      throw new AuthenticationError(authFailureMessage(error));
    }
    void session.complete().then(
      () => {
        if (this.pending.get(role) === session) {
          this.pending.delete(role);
        }
      },
      (error: unknown) => {
        if (this.pending.get(role) === session) {
          this.pending.delete(role);
        }
        const message = error instanceof Error ? error.message : "connect failed";
        process.stderr.write(`calsync: connect_provider google:${role} failed: ${message}\n`);
      },
    );
    return {
      provider: "google",
      slot: role,
      url: session.url,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  cancelConnect(role: AccountRole): void {
    const session = this.pending.get(role);
    if (session !== undefined) {
      session.cancel();
      this.pending.delete(role);
    }
  }

  cancelPendingConnects(): void {
    for (const role of this.pending.keys()) {
      this.cancelConnect(role);
    }
  }

  async getStatus(role: AccountRole, configuredCalendarId: string): Promise<AccountStatus> {
    const account = this.state.getAccount(role);
    const calendarId = account?.calendarId ?? configuredCalendarId;

    let client: InstanceType<typeof google.auth.OAuth2>;
    if (this.tokenExchange !== undefined) {
      // Prove the credential up front so broker denials map to crisp statuses;
      // the broker caches, so the validate call below reuses this token.
      try {
        await this.tokenExchange(role);
      } catch (error) {
        const problem = describeExchangeFailure(role, error);
        return {
          role,
          configured: problem.configured,
          valid: false,
          calendarId,
          message: problem.message,
        };
      }
      client = this.exchangeClient(role);
    } else {
      let refreshToken: string | null;
      try {
        refreshToken = await this.tokens.getRefreshToken(role);
      } catch (error) {
        if (error instanceof GrantError) {
          return {
            role,
            configured: true,
            valid: false,
            calendarId,
            message: grantMissingMessage(role),
          };
        }
        if (error instanceof EgressRequiredError) {
          return {
            role,
            configured: true,
            valid: false,
            calendarId,
            message: brokerOnlyMessage(),
          };
        }
        throw error;
      }

      if (refreshToken === null) {
        return {
          role,
          configured: false,
          valid: false,
          calendarId,
          message: "not authorized",
        };
      }

      client = new google.auth.OAuth2(this.oauth.clientId, this.oauth.clientSecret);
      client.setCredentials({ refresh_token: refreshToken });
    }
    try {
      const entry = await this.validateAccess(client, calendarId);
      const resolvedAccount =
        typeof entry.id === "string" && entry.id !== "" ? entry.id : calendarId;
      const fingerprint = calendarFingerprint(entry, calendarId);
      let conflictsWith: string | undefined;
      if (account === null) {
        // First passing check is what records the account and, once both
        // roles have one, makes the daemon adopt the tenant: refuse here.
        const adoption = this.state.adoptAccount(role, calendarId, fingerprint);
        if (!adoption.adopted) {
          return {
            role,
            configured: true,
            valid: false,
            calendarId,
            message: PAIR_CONFLICT_MESSAGE,
            account: resolvedAccount,
            conflictsWith: adoption.conflictsWith,
          };
        }
      } else {
        conflictsWith = this.state.verifyAccount(role, fingerprint);
      }
      return {
        role,
        configured: true,
        valid: true,
        calendarId,
        message: "authorized and writable",
        account: resolvedAccount,
        ...(conflictsWith === undefined ? {} : { conflictsWith }),
      };
    } catch (error) {
      return {
        role,
        configured: true,
        valid: false,
        calendarId,
        message: authFailureMessage(error),
      };
    }
  }

  async logout(role: AccountRole): Promise<boolean> {
    this.cancelConnect(role);
    let refreshToken: string | null;
    try {
      refreshToken = await this.tokens.getRefreshToken(role);
    } catch (error) {
      if (!(error instanceof GrantError) && !(error instanceof EgressRequiredError)) {
        throw error;
      }
      // Token unreadable in this process; skip the Google revoke but still remove local state.
      refreshToken = null;
    }
    if (refreshToken !== null) {
      const client = new google.auth.OAuth2(this.oauth.clientId, this.oauth.clientSecret);
      try {
        await client.revokeToken(refreshToken);
      } catch {
        // Local removal must still succeed when Google already revoked the token or is unavailable.
      }
    }
    const deleted = await this.tokens.deleteRefreshToken(role);
    this.state.deleteAccount(role);
    return deleted || refreshToken !== null;
  }

  async createCalendarClient(role: AccountRole): Promise<CalendarClient> {
    return createGoogleCalendarClient(await this.calendarApi(role));
  }

  /**
   * Push channels ride the same grant as reads, so no extra scope is needed —
   * and under the broker the watch call mints its token the same way.
   */
  async createChannelClient(role: AccountRole): Promise<ChannelClient> {
    return createGoogleChannelClient(await this.calendarApi(role));
  }

  private async calendarApi(role: AccountRole): Promise<calendar_v3.Calendar> {
    if (this.tokenExchange !== undefined) {
      try {
        await this.tokenExchange(role);
      } catch (error) {
        throw new AuthenticationError(describeExchangeFailure(role, error).message);
      }
      return google.calendar({ version: "v3", auth: this.exchangeClient(role) });
    }
    let refreshToken: string | null;
    try {
      refreshToken = await this.tokens.getRefreshToken(role);
    } catch (error) {
      if (error instanceof GrantError) {
        throw new AuthenticationError(grantMissingMessage(role));
      }
      if (error instanceof EgressRequiredError) {
        throw new AuthenticationError(brokerOnlyMessage());
      }
      throw error;
    }
    if (refreshToken === null) {
      throw new AuthenticationError(`${role} is not authorized; run calsync auth ${role}`);
    }
    const client = new google.auth.OAuth2(this.oauth.clientId, this.oauth.clientSecret);
    client.setCredentials({ refresh_token: refreshToken });
    return google.calendar({ version: "v3", auth: client });
  }

  /** API client whose tokens come from the broker; never reads the refresh token. */
  private exchangeClient(role: AccountRole): InstanceType<typeof google.auth.OAuth2> {
    const exchange = this.tokenExchange;
    if (exchange === undefined) {
      throw new Error("token exchange is not configured");
    }
    const client = new google.auth.OAuth2(this.oauth.clientId, this.oauth.clientSecret);
    client.refreshHandler = () => exchange(role);
    return client;
  }

  private async createConnectSession(
    role: AccountRole,
    calendarId: string,
  ): Promise<GoogleConnectSession> {
    // The state is minted first so the callback listener can refuse anything
    // that does not carry it: on a public callback URL that is what stops a
    // stranger from aborting or racing a pending authorization.
    const oauthState = base64Url(randomBytes(24));
    const callback = await this.startLoopback(role, oauthState);
    const client = new google.auth.OAuth2(
      this.oauth.clientId,
      this.oauth.clientSecret,
      callback.redirectUri,
    );
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const url = client.generateAuthUrl({
      access_type: "offline",
      scope: [...GOOGLE_CALENDAR_SCOPES],
      prompt: "consent",
      code_challenge: challenge,
      code_challenge_method: CodeChallengeMethod.S256,
      state: oauthState,
    });

    return {
      url,
      expiresAt: callback.expiresAt,
      complete: async () => {
        try {
          const params = await callback.waitForParams();
          const denied = params.get("error");
          if (denied !== null) {
            throw new AuthenticationError(`Google authorization was denied: ${denied}`);
          }
          const code = params.get("code");
          const state = params.get("state");
          if (code === null || state === null) {
            throw new AuthenticationError("Invalid OAuth callback");
          }
          if (state !== oauthState) {
            throw new AuthenticationError("OAuth callback state did not match");
          }
          const response = await client.getToken({ code, codeVerifier: verifier });
          const refreshToken = response.tokens.refresh_token;
          if (refreshToken === null || refreshToken === undefined || refreshToken === "") {
            throw new AuthenticationError(
              "Google did not return a refresh token; revoke calsync access and authorize again",
            );
          }
          client.setCredentials({ refresh_token: refreshToken });
          const entry = await this.validateAccess(client, calendarId);
          const fingerprint = calendarFingerprint(entry, calendarId);
          // Checked before the token is kept, and again as the row is written.
          if (
            fingerprint !== undefined &&
            this.state.pairConflict(role, fingerprint) !== undefined
          ) {
            throw new AuthenticationError(PAIR_CONFLICT_MESSAGE);
          }
          await this.tokens.setRefreshToken(role, refreshToken);
          if (!this.state.adoptAccount(role, calendarId, fingerprint).adopted) {
            await this.tokens.deleteRefreshToken(role);
            throw new AuthenticationError(PAIR_CONFLICT_MESSAGE);
          }
        } catch (error) {
          if (error instanceof AuthenticationError) {
            throw error;
          }
          if (error instanceof LoopbackError) {
            throw new AuthenticationError(error.message);
          }
          throw new AuthenticationError(authFailureMessage(error));
        } finally {
          callback.close();
        }
      },
      cancel: () => {
        callback.close();
      },
    };
  }
}

export async function presentAuthorizationUrl(
  url: string,
  options: AuthorizationOptions,
  openBrowser: (url: string) => Promise<void>,
): Promise<void> {
  options.onAuthorizationUrl?.(url);
  if (options.openBrowser === false) {
    return;
  }

  try {
    await openBrowser(url);
  } catch (error) {
    if (options.onBrowserOpenFailure === undefined) {
      throw error;
    }
    options.onBrowserOpenFailure(url, error);
  }
}

/** Proves the calendar is reachable and writable; returns its list entry
 * (whose `id` resolves aliases such as "primary" to the real calendar id). */
export async function validateCalendarAccess(
  auth: InstanceType<typeof google.auth.OAuth2>,
  calendarId: string,
): Promise<calendar_v3.Schema$CalendarListEntry> {
  const calendar = google.calendar({ version: "v3", auth });
  let response: { data: calendar_v3.Schema$CalendarListEntry };
  try {
    response = await calendar.calendarList.get({ calendarId });
  } catch (error) {
    throw new AuthenticationError(authFailureMessage(error));
  }

  if (!isWritableAccessRole(response.data.accessRole)) {
    throw new AuthenticationError(
      `Calendar is not writable (access role: ${response.data.accessRole ?? "unknown"})`,
    );
  }
  return response.data;
}

export function isWritableAccessRole(role: string | null | undefined): boolean {
  return role === "writer" || role === "owner";
}

function authFailureMessage(error: unknown): string {
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    response?: { data?: { error?: string; error_description?: string } };
  };
  const oauthError = candidate.response?.data?.error;
  if (oauthError === "invalid_grant") {
    return "credentials were revoked or expired; run calsync auth again";
  }
  const googleError = googleApiErrorInfo(error);
  if (candidate.code === 401 || googleError.status === 401) {
    return "Google rejected the credentials; run calsync auth again";
  }
  if (googleError.status === 403 && isRetryableGoogleError(error)) {
    return `Google Calendar rate or quota limit prevented the access check${googleReason(googleError.reason)}; retry later`;
  }
  if (
    googleError.status === 403 &&
    googleError.reason !== undefined &&
    ["forbidden", "insufficientPermissions", "requiredAccessLevel"].includes(googleError.reason)
  ) {
    return `Google rejected the calendar permissions${googleReason(googleError.reason)}; verify access or run calsync auth again`;
  }
  if (googleError.status === 403) {
    return `Google rejected the calendar access check${googleReason(googleError.reason)}; inspect the Google API policy`;
  }
  return typeof candidate.message === "string"
    ? `Google authorization failed: ${candidate.message}`
    : "Google authorization failed";
}

function grantMissingMessage(role: AccountRole): string {
  return `connected but not granted to calsync; run calsync auth ${role} to re-grant`;
}

function brokerOnlyMessage(): string {
  return "secret reads are broker-only in this process; run calsync under the capability gateway";
}

function describeExchangeFailure(
  role: AccountRole,
  error: unknown,
): { configured: boolean; message: string } {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "not_connected") {
    return { configured: false, message: "not authorized" };
  }
  if (code === "grant_missing") {
    return { configured: true, message: grantMissingMessage(role) };
  }
  if (code === "token_revoked") {
    return {
      configured: true,
      message: `credentials were revoked or expired; run calsync auth ${role} again`,
    };
  }
  const detail = error instanceof Error ? error.message : "token exchange failed";
  return { configured: true, message: `broker token exchange failed: ${detail}` };
}

function googleReason(reason: string | undefined): string {
  return reason !== undefined && /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/.test(reason)
    ? ` (reason ${reason})`
    : "";
}

function openSystemBrowser(url: string): Promise<void> {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  return new Promise((resolve, reject) => {
    execFile(opener, [url], (error) => {
      if (error === null) {
        resolve();
      } else {
        reject(new Error(error.message, { cause: error }));
      }
    });
  });
}

const CONNECT_SUCCESS_TEXT = "calsync authorization complete. You can close this window.";
const DEFAULT_CONNECT_PORTS: Record<AccountRole, number> = { personal: 8801, work: 8802 };

/**
 * Local default: ephemeral loopback on 127.0.0.1 (desktop OAuth client).
 * Hosted (CALSYNC_CONNECT_BASE_URL set): fixed per-role port behind a reverse
 * proxy, advertising https://<base>/oauth2callback/<role> — which must be
 * pre-registered on a WEB-type Google OAuth client.
 */
export function startGoogleLoopback(
  role: AccountRole,
  env: NodeJS.ProcessEnv = process.env,
  state: string,
): Promise<LoopbackServer> {
  // The loopback settles only on a callback carrying this exact state, so it
  // must be the same value that goes into the authorize URL.
  const gate = { state };
  const base = env["CALSYNC_CONNECT_BASE_URL"];
  if (base === undefined || base.trim() === "") {
    return LoopbackServer.start({
      ...gate,
      path: "/oauth2callback",
      successText: CONNECT_SUCCESS_TEXT,
    });
  }
  const configuredPort = env[`CALSYNC_CONNECT_PORT_${role.toUpperCase()}`];
  return LoopbackServer.start({
    ...gate,
    path: `/oauth2callback/${role}`,
    successText: CONNECT_SUCCESS_TEXT,
    host: env["CALSYNC_CONNECT_BIND_HOST"] ?? "0.0.0.0",
    port:
      configuredPort !== undefined && configuredPort.trim() !== ""
        ? Number(configuredPort)
        : DEFAULT_CONNECT_PORTS[role],
    publicBaseUrl: base.trim(),
  });
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}
