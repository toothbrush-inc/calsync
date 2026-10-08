import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";

import { EgressRequiredError, GrantError, LoopbackError, LoopbackServer } from "@dvd-toy-box/vault";
import { CodeChallengeMethod } from "google-auth-library";
import { google } from "googleapis";
import type { calendar_v3 } from "googleapis";

import { accountSlots, MAX_CALENDARS, type AccountRole, type OAuthConfig } from "../config.js";
import { calendarKeyFor } from "../calendars.js";
import {
  StateDatabase,
  type CalendarRecord,
  type CalendarRefusal,
  type GoogleAccountRecord,
} from "../storage/database.js";
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
  "these calendars are already syncing under another calsync tenant on this host; " +
  "open that tenant's dashboard instead, or have it removed before connecting here";

/** Why a calendar could not be added, in words for the person adding it. */
export function calendarRefusalMessage(refusal: CalendarRefusal): string {
  switch (refusal.reason) {
    case "conflict":
      return PAIR_CONFLICT_MESSAGE;
    case "duplicate":
      return "that calendar is already connected; each calendar can be synced once";
    case "limit":
      return `calsync syncs at most ${String(MAX_CALENDARS)} calendars; remove one first`;
  }
}

/** A Google sign-in this tenant holds, and how its last check went. */
export interface GoogleAccountStatus {
  slot: string;
  email: string | null;
  valid: boolean;
  message: string;
}

/** A connected calendar and how its last check went. */
export interface CalendarStatus {
  calendar: CalendarRecord;
  valid: boolean;
  message: string;
  /** Another tenant on this host syncs this calendar alongside one of ours. Operator-facing. */
  conflictsWith?: string;
}

/** What recording a sign-in someone else finished came to. */
export type SignInAdoption =
  /** A new account, now signed in. */
  | { status: "adopted"; account: GoogleAccountRecord }
  /** An account already signed in elsewhere, moved onto this sign-in. */
  | { status: "replaced"; account: GoogleAccountRecord }
  /** The slot belongs to another address; nothing changed. */
  | { status: "mismatch"; account: GoogleAccountRecord; email: string }
  /** No usable token under the slot yet. */
  | { status: "missing"; message: string };

/** A calendar a signed-in account can see, and whether calsync can use it. */
export interface AvailableCalendar {
  calendarId: string;
  name: string;
  accessRole: string;
  primary: boolean;
  /** Writable, so it can receive busy blocks as well as share them. */
  writable: boolean;
  /** Readable in full, so its busy time can be shared. */
  readable: boolean;
}

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

export interface LogoutResult {
  removed: boolean;
  /** Another sign-in on this host is the same Google account, so Google was not asked to revoke. */
  revokeSkipped: boolean;
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
export type TokenExchange = (slot: string) => Promise<ExchangedToken>;

interface GoogleConnectSession<T = void> {
  url: string;
  expiresAt: Date;
  complete(): Promise<T>;
  cancel(): void;
}

/**
 * What a connect does with the refresh token Google returned, given an API
 * client already holding it. Throws AuthenticationError to refuse it.
 */
type TokenHandler<T> = (
  client: InstanceType<typeof google.auth.OAuth2>,
  refreshToken: string,
) => Promise<T>;

export class AuthenticationError extends Error {
  override readonly name = "AuthenticationError";
}

/** How long a sign-in keeps its slot while the person is at Google. */
const SIGN_IN_RESERVATION_MS = 60 * 60 * 1_000;

export class GoogleAuthService {
  /** Connects started without waiting for them, by slot. */
  private readonly pending = new Map<string, GoogleConnectSession<unknown>>();

  constructor(
    private readonly oauth: OAuthConfig,
    private readonly tokens: TokenStore,
    private readonly state: StateDatabase,
    private readonly openBrowser: (url: string) => Promise<void> = openSystemBrowser,
    private readonly startLoopback: (slot: string, state: string) => Promise<LoopbackServer> = (
      slot,
      state,
    ) => startGoogleLoopback(slot, process.env, state),
    private readonly tokenExchange?: TokenExchange,
    private readonly validateAccess: typeof validateCalendarAccess = validateCalendarAccess,
  ) {}

  async authorize(
    role: AccountRole,
    calendarId: string,
    options: AuthorizationOptions = {},
  ): Promise<void> {
    this.cancelConnect(role);
    const session = await this.roleConnectSession(role, calendarId);
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
    const session = await this.roleConnectSession(role, calendarId);
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

  cancelConnect(slot: string): void {
    const session = this.pending.get(slot);
    if (session !== undefined) {
      session.cancel();
      this.pending.delete(slot);
    }
  }

  cancelPendingConnects(): void {
    for (const slot of this.pending.keys()) {
      this.cancelConnect(slot);
    }
  }

  /**
   * Starts signing in one more Google account and returns the consent URL
   * without waiting: the dashboard's local mode, where the person finishes in
   * another tab. The account is recorded when they do (see connectAccount).
   */
  async startAccountConnect(): Promise<{ slot: string; url: string; expiresAt: string }> {
    await this.refreshUnknownEmails();
    const { slot, release } = this.signInSlot();
    let session: GoogleConnectSession<GoogleAccountRecord>;
    try {
      session = await this.createConnectSession(slot, async (client, refreshToken) =>
        this.adoptAccountToken(await primaryEmail(client), refreshToken, slot),
      );
    } catch (error) {
      release();
      throw error;
    }
    this.pending.set(slot, session);
    void session.complete().then(
      () => {
        if (this.pending.get(slot) === session) {
          this.pending.delete(slot);
        }
        release();
      },
      (error: unknown) => {
        if (this.pending.get(slot) === session) {
          this.pending.delete(slot);
        }
        release();
        const message = error instanceof Error ? error.message : "connect failed";
        process.stderr.write(`calsync: account sign-in failed: ${message}\n`);
      },
    );
    return { slot, url: session.url, expiresAt: session.expiresAt.toISOString() };
  }

  /**
   * The slot a local sign-in waits under. A free one is reserved, so a second
   * sign-in started meanwhile, here or in another process, takes another.
   * With none free, only an account already signed in can finish (it lands
   * on its own slot), so the wait shares the first slot's key and replaces
   * any other such wait.
   */
  private signInSlot(): { slot: string; release: () => void } {
    const reserved = this.reserveAccountSlot();
    if (reserved !== undefined) {
      return {
        slot: reserved,
        release: () => {
          this.state.releaseSignInSlot(reserved);
        },
      };
    }
    const slot = accountSlots[0];
    this.cancelConnect(slot);
    return { slot, release: () => undefined };
  }

  /** The slot a new sign-in would take, if any is free: no account has it and no sign-in is waiting on it. */
  freeAccountSlot(): string | undefined {
    const reserved = new Set(this.state.listSignInReservations());
    return accountSlots.find(
      (slot) => !reserved.has(slot) && this.state.getGoogleAccount(slot) === null,
    );
  }

  /**
   * Holds a free slot for a sign-in that finishes elsewhere (the gateway's
   * consent flow) for an hour; undefined when none is free. Every process on
   * this host sees the hold, and adoptReservedSignIns records the sign-in.
   */
  reserveAccountSlot(): string | undefined {
    return this.state.reserveSignInSlot(
      accountSlots,
      new Date(Date.now() + SIGN_IN_RESERVATION_MS),
    );
  }

  /**
   * Records the reserved sign-ins that finished, whichever process handed
   * them out. One that has not finished stays reserved until it expires.
   */
  async adoptReservedSignIns(): Promise<SignInAdoption[]> {
    const adopted: SignInAdoption[] = [];
    for (const slot of this.state.listSignInReservations()) {
      if (this.state.getGoogleAccount(slot) !== null) {
        this.state.releaseSignInSlot(slot);
        continue;
      }
      const result = await this.adoptSignIn(slot).catch(() => undefined);
      if (result !== undefined && result.status !== "missing") {
        adopted.push(result);
      }
    }
    return adopted;
  }

  /**
   * Records a sign-in someone else finished — the gateway's connect flow,
   * which stores the token under `slot` and sends the person back. Learns the
   * account from the token itself. A Google account already signed in under
   * another slot moves there, calendars and all, and its old token is
   * forgotten locally (never revoked at Google, which would cut off this new
   * one too). A slot recorded for a different address is never rebound to
   * whoever signed in: that is "mismatch", and nothing changes.
   */
  async adoptSignIn(slot: string): Promise<SignInAdoption> {
    let email: string;
    try {
      email = await primaryEmail(await this.calendarApi(slot));
    } catch (error) {
      return {
        status: "missing",
        message: error instanceof Error ? error.message : authFailureMessage(error),
      };
    }
    const current = this.state.getGoogleAccount(slot);
    if (current?.email != null && current.email !== email) {
      this.state.releaseSignInSlot(slot);
      return { status: "mismatch", account: current, email };
    }
    const existing = this.state.findGoogleAccountByEmail(email);
    if (existing !== null && existing.slot !== slot) {
      this.state.moveGoogleAccount(existing.slot, slot);
      this.state.upsertGoogleAccount(slot, email);
      await this.tokens.deleteRefreshToken(existing.slot);
    } else {
      this.state.upsertGoogleAccount(slot, email);
    }
    this.state.releaseSignInSlot(slot);
    const account = this.state.getGoogleAccount(slot);
    if (account === null) {
      return { status: "missing", message: "the account was not recorded; try again" };
    }
    return {
      status: existing !== null && existing.slot !== slot ? "replaced" : "adopted",
      account,
    };
  }

  /** Sign-ins from before calsync kept emails learn theirs. */
  private async refreshUnknownEmails(): Promise<void> {
    await Promise.all(
      this.state
        .listGoogleAccounts()
        .filter((account) => account.email === null)
        .map((account) => this.checkAccount(account.slot)),
    );
  }

  async getStatus(role: AccountRole, configuredCalendarId: string): Promise<AccountStatus> {
    const stored = this.state.getCalendar(role);
    if (stored !== null && stored.account !== role) {
      // The role's account signed in again under another slot (a gateway
      // reconnect always takes a fresh one): that sign-in syncs it now.
      return this.roleStatusThrough(role, stored);
    }
    const account = this.state.getAccount(role);
    const calendarId = account?.calendarId ?? configuredCalendarId;
    // A check only adopts a role never signed in (a connect the gateway
    // finished): one whose calendar was removed stays removed.
    if (account === null && this.state.getGoogleAccount(role) !== null) {
      return {
        role,
        configured: true,
        valid: false,
        calendarId,
        message: `signed in, but its calendar is not synced; run calsync auth ${role} to sync it again`,
      };
    }

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
            message: calendarRefusalMessage(adoption.refusal),
            account: resolvedAccount,
            ...(adoption.refusal.reason === "conflict"
              ? { conflictsWith: adoption.refusal.tenant }
              : {}),
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

  private async roleStatusThrough(
    role: AccountRole,
    calendar: CalendarRecord,
  ): Promise<AccountStatus> {
    const checked = await this.checkCalendar(calendar);
    const email = this.state.getGoogleAccount(calendar.account)?.email ?? null;
    return {
      role,
      configured: true,
      valid: checked.valid,
      calendarId: calendar.calendarId,
      message: checked.valid
        ? `${checked.message}, signed in as ${email ?? calendar.account}`
        : checked.message,
      ...(email === null ? {} : { account: email }),
      ...(checked.conflictsWith === undefined ? {} : { conflictsWith: checked.conflictsWith }),
    };
  }

  /**
   * Signs a role out. `removeCalendar` runs first, while the sign-in still
   * works, to delete the role calendar's busy blocks and what calsync kept
   * for it. Google revokes every token this OAuth client holds for the
   * account, not only this one, so the revoke is skipped while another
   * sign-in on this host (in any tenant) is the same account.
   */
  async logout(
    role: AccountRole,
    removeCalendar?: (calendarKey: string) => Promise<void>,
  ): Promise<LogoutResult> {
    // Revoking would cut off every calendar this sign-in serves, not only the role's.
    if (
      this.state
        .listCalendars()
        .some((calendar) => calendar.account === role && calendar.key !== role)
    ) {
      throw new AuthenticationError(
        `other calendars sync through the ${role} sign-in; remove them with calsync calendar remove first`,
      );
    }
    if (removeCalendar !== undefined && this.state.getCalendar(role) !== null) {
      await removeCalendar(role);
    }
    this.cancelConnect(role);
    const email = this.state.getGoogleAccount(role)?.email ?? null;
    const sharedWith =
      email === null
        ? []
        : this.state
            .signInsWithEmail(email)
            .filter((other) => other.tenantId !== this.state.tenantId || other.slot !== role);
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
    const revoke = sharedWith.length === 0;
    if (refreshToken !== null && revoke) {
      const client = new google.auth.OAuth2(this.oauth.clientId, this.oauth.clientSecret);
      try {
        await client.revokeToken(refreshToken);
      } catch {
        // Local removal must still succeed when Google already revoked the token or is unavailable.
      }
    }
    const deleted = await this.tokens.deleteRefreshToken(role);
    this.state.deleteAccount(role);
    return {
      removed: deleted || refreshToken !== null,
      revokeSkipped: refreshToken !== null && !revoke,
    };
  }

  /** Calendar API client for the sign-in in `slot`. */
  async createCalendarClient(slot: string): Promise<CalendarClient> {
    return createGoogleCalendarClient(await this.calendarApi(slot));
  }

  /**
   * Push channels ride the same grant as reads, so no extra scope is needed —
   * and under the broker the watch call mints its token the same way.
   */
  async createChannelClient(slot: string): Promise<ChannelClient> {
    return createGoogleChannelClient(await this.calendarApi(slot));
  }

  /**
   * Signs in one more Google account. The slot is settled once Google says
   * which account it is: an account already signed in keeps its slot (its
   * token is replaced), anything else takes the first free account slot.
   * Calendars are added separately, with connectCalendar.
   */
  async connectAccount(options: AuthorizationOptions = {}): Promise<GoogleAccountRecord> {
    // Sign-ins from before calsync kept emails learn theirs first, so signing
    // the same Google account in again finds its slot instead of taking a new one.
    await this.refreshUnknownEmails();
    const { slot, release } = this.signInSlot();
    try {
      const session = await this.createConnectSession(slot, async (client, refreshToken) =>
        this.adoptAccountToken(await primaryEmail(client), refreshToken, slot),
      );
      try {
        await presentAuthorizationUrl(session.url, options, this.openBrowser);
        return await session.complete();
      } catch (error) {
        session.cancel();
        if (error instanceof AuthenticationError) {
          throw error;
        }
        throw new AuthenticationError(authFailureMessage(error));
      }
    } finally {
      release();
    }
  }

  /**
   * Keeps a freshly signed-in account's token: under the slot that email
   * already has, else the slot reserved for this sign-in, else the first
   * free one.
   */
  async adoptAccountToken(
    email: string,
    refreshToken: string,
    reserved?: string,
  ): Promise<GoogleAccountRecord> {
    const slot =
      this.state.findGoogleAccountByEmail(email)?.slot ??
      (reserved !== undefined && this.state.getGoogleAccount(reserved) === null
        ? reserved
        : this.freeAccountSlot());
    if (slot === undefined) {
      throw new AuthenticationError(
        `calsync holds at most ${String(accountSlots.length)} added Google accounts; remove one first`,
      );
    }
    await this.tokens.setRefreshToken(slot, refreshToken);
    this.state.upsertGoogleAccount(slot, email);
    const account = this.state.getGoogleAccount(slot);
    if (account === null) {
      throw new AuthenticationError("the account was not recorded; try again");
    }
    return account;
  }

  /** Every calendar the account in `slot` can see, with what calsync could do with it. */
  async availableCalendars(slot: string): Promise<AvailableCalendar[]> {
    const api = await this.calendarApi(slot);
    const calendars: AvailableCalendar[] = [];
    let pageToken: string | undefined;
    try {
      do {
        const response = await api.calendarList.list({
          minAccessRole: "reader",
          showHidden: true,
          ...(pageToken === undefined ? {} : { pageToken }),
        });
        for (const entry of response.data.items ?? []) {
          if (typeof entry.id !== "string" || entry.id === "") {
            continue;
          }
          const accessRole = entry.accessRole ?? "unknown";
          calendars.push({
            calendarId: entry.id,
            name: entry.summaryOverride ?? entry.summary ?? entry.id,
            accessRole,
            primary: entry.primary === true,
            writable: isWritableAccessRole(accessRole),
            readable: isReadableAccessRole(accessRole),
          });
        }
        pageToken = response.data.nextPageToken ?? undefined;
      } while (pageToken !== undefined);
    } catch (error) {
      throw new AuthenticationError(authFailureMessage(error));
    }
    return calendars.sort(
      (left, right) =>
        Number(right.primary) - Number(left.primary) || left.name.localeCompare(right.name),
    );
  }

  /**
   * Adds a calendar the account in `slot` can see. Receiving busy blocks
   * needs write access; sharing busy time needs to read its events.
   */
  async connectCalendar(
    slot: string,
    calendarId: string,
    roles: { source: boolean; destination: boolean } = { source: true, destination: true },
  ): Promise<CalendarRecord> {
    if (!roles.source && !roles.destination) {
      throw new AuthenticationError("a calendar must share busy time, receive it, or both");
    }
    if (this.state.getGoogleAccount(slot) === null) {
      throw new AuthenticationError("that Google account is not signed in");
    }
    const api = await this.calendarApi(slot);
    let entry: calendar_v3.Schema$CalendarListEntry;
    try {
      entry = (await api.calendarList.get({ calendarId })).data;
    } catch (error) {
      throw new AuthenticationError(authFailureMessage(error));
    }
    const accessRole = entry.accessRole ?? undefined;
    if (roles.destination && !isWritableAccessRole(accessRole)) {
      throw new AuthenticationError(
        `calsync cannot write busy blocks to that calendar (access role: ${accessRole ?? "unknown"}); add it with --source-only to share its busy time only`,
      );
    }
    if (!isReadableAccessRole(accessRole)) {
      throw new AuthenticationError(
        `calsync cannot read that calendar's events (access role: ${accessRole ?? "unknown"})`,
      );
    }
    const resolvedId = typeof entry.id === "string" && entry.id !== "" ? entry.id : calendarId;
    // A role's calendar is stored by its alias, "primary"; it is the same
    // calendar as this account's primary, whatever its fingerprint says.
    const role = this.state
      .listCalendars()
      .find((calendar) => calendar.account === slot && calendar.calendarId === "primary");
    if (role !== undefined && entry.primary === true) {
      throw new AuthenticationError(
        calendarRefusalMessage({ added: false, reason: "duplicate", key: role.key }),
      );
    }
    const key = calendarKeyFor(resolvedId);
    const existing = this.state.getCalendar(key);
    if (existing !== null && existing.account !== slot) {
      const through = this.state.getGoogleAccount(existing.account)?.email ?? existing.account;
      throw new AuthenticationError(
        `that calendar is already synced through ${through}; remove it first to switch accounts`,
      );
    }
    const result = this.state.addCalendar({
      key,
      account: slot,
      calendarId: resolvedId,
      name: entry.summaryOverride ?? entry.summary ?? null,
      accessRole: accessRole ?? null,
      source: roles.source,
      destination: roles.destination,
      fingerprint: calendarFingerprint(entry, calendarId),
    });
    if (!result.added) {
      throw new AuthenticationError(calendarRefusalMessage(result));
    }
    const record = this.state.getCalendar(key);
    if (record === null) {
      throw new AuthenticationError("the calendar was not recorded; try again");
    }
    return record;
  }

  /**
   * Checks one sign-in: that its token still works, and which account it is.
   * Learns the email of sign-ins recorded before calsync kept it.
   */
  async checkAccount(slot: string): Promise<GoogleAccountStatus> {
    const account = this.state.getGoogleAccount(slot);
    try {
      const api = await this.calendarApi(slot);
      const email = await primaryEmail(api);
      this.state.verifyGoogleAccount(slot, email);
      return { slot, email, valid: true, message: "signed in" };
    } catch (error) {
      return {
        slot,
        email: account?.email ?? null,
        valid: false,
        message: error instanceof AuthenticationError ? error.message : authFailureMessage(error),
      };
    }
  }

  /** Checks one connected calendar is still reachable with the access its roles need. */
  async checkCalendar(calendar: CalendarRecord): Promise<CalendarStatus> {
    try {
      const api = await this.calendarApi(calendar.account);
      const entry = (await api.calendarList.get({ calendarId: calendar.calendarId })).data;
      const accessRole = entry.accessRole ?? undefined;
      if (calendar.destination && !isWritableAccessRole(accessRole)) {
        return {
          calendar,
          valid: false,
          message: `no longer writable (access role: ${accessRole ?? "unknown"})`,
        };
      }
      if (!isReadableAccessRole(accessRole)) {
        return {
          calendar,
          valid: false,
          message: `no longer readable (access role: ${accessRole ?? "unknown"})`,
        };
      }
      const fingerprint = calendarFingerprint(entry, calendar.calendarId);
      this.state.verifyCalendar(calendar.key, {
        fingerprint,
        name: entry.summaryOverride ?? entry.summary ?? null,
        accessRole: accessRole ?? null,
      });
      const refreshed = this.state.getCalendar(calendar.key) ?? calendar;
      const conflictsWith =
        fingerprint === undefined
          ? undefined
          : this.state.calendarConflict(fingerprint, calendar.key);
      return {
        calendar: refreshed,
        valid: true,
        message: calendar.destination ? "readable and writable" : "readable",
        ...(conflictsWith === undefined ? {} : { conflictsWith }),
      };
    } catch (error) {
      return {
        calendar,
        valid: false,
        message: error instanceof AuthenticationError ? error.message : authFailureMessage(error),
      };
    }
  }

  /**
   * Forgets a sign-in that no calendar uses any more: its local token and its
   * row. Google's grant is left alone — revoking it would also cut off every
   * other tenant or device signed in to the same Google account with this
   * client.
   */
  async disconnectAccount(slot: string): Promise<void> {
    if (this.state.listCalendars().some((calendar) => calendar.account === slot)) {
      throw new AuthenticationError("remove that account's calendars first");
    }
    await this.tokens.deleteRefreshToken(slot);
    this.state.deleteGoogleAccount(slot);
  }

  /** The Calendar API as the sign-in in `slot`. Tests substitute a fake. */
  protected async calendarApi(slot: string): Promise<calendar_v3.Calendar> {
    if (this.tokenExchange !== undefined) {
      try {
        await this.tokenExchange(slot);
      } catch (error) {
        throw new AuthenticationError(describeExchangeFailure(slot, error).message);
      }
      return google.calendar({ version: "v3", auth: this.exchangeClient(slot) });
    }
    let refreshToken: string | null;
    try {
      refreshToken = await this.tokens.getRefreshToken(slot);
    } catch (error) {
      if (error instanceof GrantError) {
        throw new AuthenticationError(grantMissingMessage(slot));
      }
      if (error instanceof EgressRequiredError) {
        throw new AuthenticationError(brokerOnlyMessage());
      }
      throw error;
    }
    if (refreshToken === null) {
      throw new AuthenticationError(`${slot} is not authorized; ${reauthorizeHint(slot)}`);
    }
    const client = new google.auth.OAuth2(this.oauth.clientId, this.oauth.clientSecret);
    client.setCredentials({ refresh_token: refreshToken });
    return google.calendar({ version: "v3", auth: client });
  }

  /** API client whose tokens come from the broker; never reads the refresh token. */
  private exchangeClient(slot: string): InstanceType<typeof google.auth.OAuth2> {
    const exchange = this.tokenExchange;
    if (exchange === undefined) {
      throw new Error("token exchange is not configured");
    }
    const client = new google.auth.OAuth2(this.oauth.clientId, this.oauth.clientSecret);
    client.refreshHandler = () => exchange(slot);
    return client;
  }

  /** A role's sign-in, which also adds the role's one calendar. */
  private roleConnectSession(role: AccountRole, calendarId: string): Promise<GoogleConnectSession> {
    return this.createConnectSession(role, async (client, refreshToken) => {
      const entry = await this.validateAccess(client, calendarId);
      const fingerprint = calendarFingerprint(entry, calendarId);
      // Checked before the token is touched, and again as the row is written.
      const refusal = this.state.calendarRefusal(role, fingerprint);
      if (refusal !== undefined) {
        throw new AuthenticationError(calendarRefusalMessage(refusal));
      }
      const previous = await this.tokens.getRefreshToken(role).catch(() => null);
      await this.tokens.setRefreshToken(role, refreshToken);
      const adoption = this.state.adoptAccount(role, calendarId, fingerprint);
      if (!adoption.adopted) {
        // Lost a race: put back the sign-in other calendars may still use.
        await (previous === null
          ? this.tokens.deleteRefreshToken(role)
          : this.tokens.setRefreshToken(role, previous));
        throw new AuthenticationError(calendarRefusalMessage(adoption.refusal));
      }
    });
  }

  private async createConnectSession<T>(
    slot: string,
    onToken: TokenHandler<T>,
  ): Promise<GoogleConnectSession<T>> {
    // The state is minted first so the callback listener can refuse anything
    // that does not carry it: on a public callback URL that is what stops a
    // stranger from aborting or racing a pending authorization.
    const oauthState = base64Url(randomBytes(24));
    const callback = await this.startLoopback(slot, oauthState);
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
          return await onToken(client, refreshToken);
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

/** Can read event details; a free/busy reader sees only busy times. */
export function isReadableAccessRole(role: string | null | undefined): boolean {
  return role === "reader" || isWritableAccessRole(role);
}

/**
 * The signed-in account's address: the id of its primary calendar. Needs
 * only the calendar-list scope calsync already holds.
 */
async function primaryEmail(
  source: InstanceType<typeof google.auth.OAuth2> | calendar_v3.Calendar,
): Promise<string> {
  const api = "calendarList" in source ? source : google.calendar({ version: "v3", auth: source });
  let id: string | null | undefined;
  try {
    id = (await api.calendarList.get({ calendarId: "primary" })).data.id;
  } catch (error) {
    throw new AuthenticationError(authFailureMessage(error));
  }
  if (typeof id !== "string" || id === "") {
    throw new AuthenticationError("Google did not say which account this is");
  }
  return id.trim().toLowerCase();
}

/** How to sign a slot in again. */
function reauthorizeHint(slot: string): string {
  return slot === "personal" || slot === "work"
    ? `run calsync auth ${slot}`
    : "run calsync account add and sign in to that account again";
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

function grantMissingMessage(slot: string): string {
  return `connected but not granted to calsync; ${reauthorizeHint(slot)} to re-grant`;
}

function brokerOnlyMessage(): string {
  return "secret reads are broker-only in this process; run calsync under the capability gateway";
}

function describeExchangeFailure(
  slot: string,
  error: unknown,
): { configured: boolean; message: string } {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "not_connected") {
    return { configured: false, message: "not authorized" };
  }
  if (code === "grant_missing") {
    return { configured: true, message: grantMissingMessage(slot) };
  }
  if (code === "token_revoked") {
    return {
      configured: true,
      message: `credentials were revoked or expired; ${reauthorizeHint(slot)}`,
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
const DEFAULT_CONNECT_PORTS: Readonly<Record<string, number>> = { personal: 8801, work: 8802 };

/**
 * Local default: ephemeral loopback on 127.0.0.1 (desktop OAuth client).
 * Hosted (CALSYNC_CONNECT_BASE_URL set): fixed per-slot port behind a reverse
 * proxy, advertising https://<base>/oauth2callback/<slot> — which must be
 * pre-registered on a WEB-type Google OAuth client. Only the two role slots
 * have default ports; an account slot needs CALSYNC_CONNECT_PORT_<SLOT>.
 */
export function startGoogleLoopback(
  slot: string,
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
  const configuredPort = env[`CALSYNC_CONNECT_PORT_${slot.toUpperCase()}`];
  const port =
    configuredPort !== undefined && configuredPort.trim() !== ""
      ? Number(configuredPort)
      : DEFAULT_CONNECT_PORTS[slot];
  if (port === undefined) {
    return Promise.reject(
      new AuthenticationError(
        `no callback port for ${slot} behind CALSYNC_CONNECT_BASE_URL; set CALSYNC_CONNECT_PORT_${slot.toUpperCase()} and route /oauth2callback/${slot} to it`,
      ),
    );
  }
  return LoopbackServer.start({
    ...gate,
    path: `/oauth2callback/${slot}`,
    successText: CONNECT_SUCCESS_TEXT,
    host: env["CALSYNC_CONNECT_BIND_HOST"] ?? "0.0.0.0",
    port,
    publicBaseUrl: base.trim(),
  });
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}
