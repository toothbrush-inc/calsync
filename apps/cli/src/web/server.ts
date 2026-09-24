import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type {
  AccountRole,
  DedupeResult,
  ReconcileLog,
  ReconcileSourceDetail,
  ReconcileTimeRange,
  StoredSyncSummary,
  StrayBlockKind,
  SyncReconcileResult,
} from "@calsync/engine";
import { accountRoles } from "@calsync/engine";
import { tenantForIdentity } from "@dvd-toy-box/vault";

import { parseTenantId, ConfigError } from "../config.js";
import type { ScanGate, ScanOperation } from "../scanlimit.js";
import type {
  ExclusionChangeInput,
  ExclusionChangeResult,
  ExclusionSnapshot,
} from "../exclusions.js";
import type { AccountStatus, ConnectStartResult } from "../google/auth.js";
import { tokenSlot, type AccountRecord } from "../storage/index.js";
import { LockTimeoutError } from "../sync/service.js";
import { renderAccessPage, renderDashboardPage } from "./page.js";

export { tenantForIdentity };

/**
 * Onboarding dashboard: shows which calendars a tenant has connected, links
 * them to Google Calendar, offers connect for missing ones, and reports
 * whether the daemon is actively syncing, and lets them manage exclusions
 * the same way the CLI and MCP tools do. Serves privacy-safe data only:
 * aggregates, keywords the person chose, and opaque keys. The one exception
 * is the dry-run preview, which the person runs on purpose to decide what to
 * exclude: it returns source titles, like `sync --dry-run --verbose`, is
 * never cached or logged, and only answers a same-origin POST. The stray-block
 * cleanup is the one other write the page can ask for; it touches nothing
 * but calsync's own busy blocks and reports them as times only.
 *
 * Tenancy: with a secret configured, a person arrives once with a signed,
 * short-lived link (`/?t=<link token>`), which is exchanged for a session
 * cookie and stripped from the URL; every later request rides the cookie.
 * Link and session tokens are distinct kinds, so a link cannot be replayed
 * as a session and a cookie cannot be turned back into a link. Behind a
 * proxy that signs people in itself, an identity header (`identityHeader`)
 * is the other way in: the email names the tenant, via `identityTenants` or
 * a collision-resistant hash of the address, so a store's own login opens
 * the right dashboard with no link at all. Without a secret the server is
 * single-tenant for local use and should stay bound to loopback; in that
 * mode there is no cookie to defend, so every request must also name a
 * loopback host (or the bound address) in `Host`. A DNS-rebound page
 * otherwise looks same-origin to the browser and to the `Origin`/`Host`
 * comparison alike.
 */

export interface WebTenantRuntime {
  getStatus(role: AccountRole, calendarId: string): Promise<AccountStatus>;
  startConnect(role: AccountRole, calendarId: string): Promise<ConnectStartResult>;
  listAccounts(): AccountRecord[];
  syncSummary(): StoredSyncSummary;
  /** Same view as `calsync exclude list` and the MCP `list_exclusions` tool. */
  listExclusions(): ExclusionSnapshot;
  /** Same semantics as `calsync exclude add|remove` and the MCP tools: keys
   * carry their own direction, keywords need `from`; mixing is allowed. */
  changeExclusions(action: "add" | "remove", input: ExclusionChangeInput): ExclusionChangeResult;
  /** One dry-run pass with per-source details, as `sync --dry-run --verbose`
   * collects them. Rejects with LockTimeoutError once `lockTimeoutMs` passes
   * with a real sync still holding the lock. */
  previewSync(options: {
    lockTimeoutMs: number;
  }): Promise<{ result: SyncReconcileResult; sources: ReconcileSourceDetail[] }>;
  /** One stray-block cleanup pass, as `calsync dedupe [--dry-run]` runs it, with
   * the operations it recorded. Rejects with LockTimeoutError once
   * `lockTimeoutMs` passes with a real sync still holding the lock. */
  dedupe(options: {
    dryRun: boolean;
    lockTimeoutMs: number;
  }): Promise<{ result: DedupeResult; operations: ReconcileLog[] }>;
  close(): void;
}

export interface WebServerOptions {
  host: string;
  port: number;
  defaultTenantId: string;
  /** HMAC secret for signed tenant links; absent → default tenant only. */
  secret?: string;
  /**
   * External connect URL template with {slot}, {tenant}, and {role}
   * placeholders. {slot} expands via the tokenSlot contract — bare role for
   * the default tenant, "<tenant>_<role>" otherwise — matching what the
   * gateway's connect flow expects. Set under the gateway, where grants are
   * collected at the broker instead of by calsync's own OAuth flow.
   */
  connectUrl?: string;
  /** Mark the session cookie `Secure`. Set when the dashboard is served over
   * HTTPS (the hosted case); leave off for plain-HTTP loopback use. */
  secureCookies?: boolean;
  /** Lower-case name of a request header carrying a signed-in email, set by
   * a trusted proxy that strips any client-supplied copy. Honoured only in
   * multi-tenant mode (with `secret`). */
  identityHeader?: string;
  /** Email -> tenant overrides for identity sign-in (the operator's own
   * address usually maps to "default"). */
  identityTenants?: Record<string, string>;
  defaultCalendarIds: Record<AccountRole, string>;
  /** Bounds how often the full-window passes may run, and serves the repeat
   * click from the last one. Absent → unbounded, as before. */
  scanGate?: ScanGate;
  daemonLockPath: string;
  daemonIsRunning: (daemonLockPath: string) => boolean;
  runtimeFor: (tenantId: string) => WebTenantRuntime;
  onLog?: (line: string) => void;
}

export interface WebAccountView {
  role: AccountRole;
  connected: boolean;
  valid: boolean;
  calendarId: string | null;
  calendarUrl: string | null;
  /** The Google account (primary calendar id) behind a valid connection. */
  account: string | null;
  message: string;
  /** Another tenant on this host syncs the same calendar pair. A flag only:
   * a tenant id derives from someone else's sign-in and is never sent. */
  conflict: boolean;
}

export interface WebStatusView {
  tenant: string;
  overall: "syncing" | "daemon-offline" | "setup";
  daemonRunning: boolean;
  accounts: WebAccountView[];
  lastFullSyncAt: string | null;
  lastResult: {
    converged: boolean;
    personalToWorkActive: number;
    workToPersonalActive: number;
  } | null;
  connectMode: "local" | "external";
}

export type WebPreviewStatus =
  "mirrored" | "excluded-keyword" | "excluded-occurrence" | "excluded-series" | "excluded-legacy";

/** One source event as the dry-run preview shows it: the title the person
 * needs to recognise it, when it is, and the keys that would exclude it. */
export interface WebPreviewEvent {
  direction: "personalToWork" | "workToPersonal";
  title: string | null;
  when: ReconcileTimeRange;
  recurring: boolean;
  status: WebPreviewStatus;
  keys: { occurrence: string; series: string };
}

export interface WebPreviewView {
  ranAt: string;
  planned: { created: number; updated: number; deleted: number; repaired: number };
  converged: boolean;
  mirrors: SyncReconcileResult["mirrors"];
  events: WebPreviewEvent[];
}

/** One stray busy block: the calendar it sits on, when, and whether it
 * doubles another block or stands alone with no event behind it. Managed
 * blocks are all titled "Busy", so there is no title to leak. */
export interface WebDedupeRemoval {
  calendar: AccountRole;
  when: ReconcileTimeRange;
  kind: StrayBlockKind;
}

export interface WebDedupeView {
  ranAt: string;
  /** False for a dry run: `removals` are what a real run would delete. */
  applied: boolean;
  /** Managed busy blocks checked on each calendar. */
  inspected: Record<AccountRole, number>;
  removals: WebDedupeRemoval[];
}

const STRAY_KINDS: Partial<Record<ReconcileLog["reason"], StrayBlockKind>> = {
  "duplicate-busy-block": "duplicate",
  "phantom-busy-block": "phantom",
};

const MAX_BODY_BYTES = 4 * 1024;
/** 180 days: long enough to make the dashboard a bookmark, short enough that
 * a shared machine's access lapses. A fresh tenant link renews it any time. */
const COOKIE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
/** A minted onboarding link is meant to be opened soon, not kept: it travels
 * in chat and browser history, so it goes stale on its own. */
export const LINK_TTL_SECONDS_DEFAULT = 7 * 24 * 60 * 60;
/** Live validation calls Google per role; the page polls, so one answer is
 * shared for a few seconds rather than fanning out per request. */
const STATUS_CACHE_MS = 5_000;
/**
 * How long a scan waits for the reconcile lock before giving the browser a
 * 409 to retry. Without a bound `acquireLockWaiting` polls forever, so a click
 * that lands during a daemon pass holds its connection open for the length of
 * that pass instead of answering. The MCP path deliberately keeps waiting —
 * it reports progress and has no connection to tie up.
 */
const LOCK_TIMEOUT_MS = 5_000;

export type WebTokenKind = "link" | "session";

export class WebServer {
  #server: Server | undefined;
  readonly #runtimes = new Map<string, WebTenantRuntime>();
  readonly #statusCache = new Map<string, { at: number; view: Promise<WebStatusView> }>();
  /** One dry run per tenant at a time; a second click joins the running one. */
  readonly #previews = new Map<string, Promise<WebPreviewView>>();
  /** Likewise for stray-block checks and removals, keyed by tenant and mode. */
  readonly #dedupes = new Map<string, Promise<WebDedupeView>>();

  constructor(private readonly options: WebServerOptions) {}

  async listen(): Promise<number> {
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        this.#log({ event: "web_request_failed", error: errorName(error) });
        if (!response.headersSent) {
          respondJson(response, 500, { error: "internal" });
        }
      });
    });
    this.#server = server;
    return await new Promise<number>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(error);
      };
      server.once("error", onError);
      server.listen(this.options.port, this.options.host, () => {
        server.off("error", onError);
        const address = server.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
  }

  async close(): Promise<void> {
    for (const runtime of this.#runtimes.values()) {
      runtime.close();
    }
    this.#runtimes.clear();
    const server = this.#server;
    if (server === undefined) {
      return;
    }
    this.#server = undefined;
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const secret = this.options.secret;
    // Single-tenant mode has no session cookie, so the `Host` header is the
    // one thing that tells a request through the bound loopback address
    // from one a DNS-rebound page made to `attacker.example:<port>`.
    if (secret === undefined && !isLocalHostHeader(request, this.options.host)) {
      this.#log({ event: "web_host_rejected" });
      respondJson(response, 421, { error: "misdirected" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const isHome = request.method === "GET" && url.pathname === "/";

    // Redeem an onboarding link: verify, set the session cookie, and send the
    // browser back to a clean `/` so the token leaves the address bar,
    // history and any referrer.
    const link = url.searchParams.get("t");
    if (isHome && secret !== undefined && link !== null) {
      const tenant = verifyWebToken(link, secret, { kind: "link" });
      if (tenant === null) {
        this.#log({ event: "web_link_rejected" });
        response.writeHead(403, htmlHeaders()).end(renderAccessPage());
        return;
      }
      const session = signWebToken(tenant, secret, {
        kind: "session",
        ttlSeconds: COOKIE_MAX_AGE_SECONDS,
      });
      this.#log({ event: "web_link_redeemed", tenant });
      response
        .writeHead(303, {
          Location: "/",
          "Set-Cookie":
            `calsync_web=${session}; Path=/; HttpOnly; SameSite=Strict` +
            `; Max-Age=${String(COOKIE_MAX_AGE_SECONDS)}` +
            (this.options.secureCookies === true ? "; Secure" : ""),
        })
        .end();
      return;
    }

    const tenant = this.#tenantFor(request);
    if (tenant === null) {
      // A cookie that no longer verifies (an older format, a rotated secret)
      // is worse than none: the proxy routes cookie-bearing requests straight
      // here, past its own sign-in check. Drop it and send the browser round
      // once more, clean; `fresh` stops that from ever looping.
      const staleCookie = secret !== undefined && cookieValue(request, "calsync_web") !== null;
      if (staleCookie && isHome && !url.searchParams.has("fresh")) {
        this.#log({ event: "web_cookie_cleared" });
        response
          .writeHead(303, {
            Location: "/?fresh=1",
            "Set-Cookie": "calsync_web=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
          })
          .end();
        return;
      }
      // A browser landing without a link (say, from the app index) gets a
      // human explanation; API callers get the JSON error.
      if (isHome) {
        response.writeHead(403, htmlHeaders()).end(renderAccessPage());
        return;
      }
      respondJson(response, 403, { error: "missing or invalid tenant token" });
      return;
    }

    if (isHome) {
      response.writeHead(200, htmlHeaders()).end(renderDashboardPage());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      // `fresh` skips the short cache: the page asks for it right after a
      // connection lands, when the last cached answer is by definition stale.
      respondJson(response, 200, await this.#status(tenant, url.searchParams.has("fresh")));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/connect") {
      if (!isSameOriginJson(request)) {
        respondJson(response, 403, { error: "cross-site request refused" });
        return;
      }
      await this.#connect(tenant, request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/exclusions") {
      respondJson(response, 200, this.#runtime(tenant).listExclusions());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/exclusions") {
      if (!isSameOriginJson(request)) {
        respondJson(response, 403, { error: "cross-site request refused" });
        return;
      }
      await this.#changeExclusions(tenant, request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/preview") {
      if (!isSameOriginJson(request)) {
        respondJson(response, 403, { error: "cross-site request refused" });
        return;
      }
      await this.#preview(tenant, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/dedupe") {
      if (!isSameOriginJson(request)) {
        respondJson(response, 403, { error: "cross-site request refused" });
        return;
      }
      await this.#dedupe(tenant, request, response);
      return;
    }
    respondJson(response, 404, { error: "not found" });
  }

  /** Resolves and validates the tenant this request may act on: the session
   * cookie, else the proxy's identity header. Links are redeemed at `/`,
   * never accepted by the API. */
  #tenantFor(request: IncomingMessage): string | null {
    const secret = this.options.secret;
    if (secret === undefined) {
      return this.options.defaultTenantId;
    }
    const cookie = cookieValue(request, "calsync_web");
    if (cookie !== null) {
      const fromCookie = verifyWebToken(cookie, secret, { kind: "session" });
      if (fromCookie !== null) {
        return fromCookie;
      }
    }
    const header = this.options.identityHeader;
    if (header === undefined) {
      return null;
    }
    const value = request.headers[header];
    const email = Array.isArray(value) ? value[0] : value;
    if (email === undefined || email.trim() === "") {
      return null;
    }
    const derived = tenantForIdentity(email, this.options.identityTenants);
    if (derived === null) {
      return null;
    }
    // An address hashes to a well-formed id, but the shared helper also
    // slugifies a value with no "@" in it, which can yield underscores or a
    // leading digit. Those are not tenant ids here: they would name state no
    // CLI command can reach, and `tokenSlot` reads "<tenant>_<role>". A
    // header that is not an email is a misconfigured proxy, not a tenant.
    try {
      return parseTenantId(derived);
    } catch (error) {
      if (error instanceof ConfigError) {
        this.#log({ event: "web_identity_rejected" });
        return null;
      }
      throw error;
    }
  }

  #status(tenant: string, fresh = false): Promise<WebStatusView> {
    const now = Date.now();
    const cached = this.#statusCache.get(tenant);
    if (!fresh && cached !== undefined && now - cached.at < STATUS_CACHE_MS) {
      return cached.view;
    }
    const view = this.#liveStatus(tenant);
    this.#statusCache.set(tenant, { at: now, view });
    view.catch(() => {
      this.#statusCache.delete(tenant);
    });
    return view;
  }

  async #liveStatus(tenant: string): Promise<WebStatusView> {
    const runtime = this.#runtime(tenant);
    const stored = new Map(runtime.listAccounts().map((account) => [account.role, account]));
    const accounts = await Promise.all(
      accountRoles.map(async (role): Promise<WebAccountView> => {
        const calendarId = stored.get(role)?.calendarId ?? this.options.defaultCalendarIds[role];
        let status: AccountStatus;
        try {
          // Live validation; in brokered mode a passing check also records
          // the account row, which is what makes the daemon adopt the tenant.
          status = await runtime.getStatus(role, calendarId);
        } catch (error) {
          status = {
            role,
            configured: stored.has(role),
            valid: false,
            calendarId,
            message: errorName(error),
          };
        }
        return {
          role,
          connected: status.configured,
          valid: status.valid,
          calendarId: status.configured ? status.calendarId : null,
          calendarUrl: status.configured ? calendarUrl(status.account ?? status.calendarId) : null,
          account: status.valid ? (status.account ?? null) : null,
          message: status.message,
          conflict: status.conflictsWith !== undefined,
        };
      }),
    );
    const daemonRunning = this.options.daemonIsRunning(this.options.daemonLockPath);
    const allValid = accounts.every((account) => account.valid);
    const summary = runtime.syncSummary();
    return {
      tenant,
      overall: !allValid ? "setup" : daemonRunning ? "syncing" : "daemon-offline",
      daemonRunning,
      accounts,
      lastFullSyncAt: summary.lastFullSyncAt,
      lastResult:
        summary.lastResult === null
          ? null
          : {
              converged: summary.lastResult.converged,
              personalToWorkActive: summary.lastResult.mirrors.personalToWork.active,
              workToPersonalActive: summary.lastResult.mirrors.workToPersonal.active,
            },
      connectMode: this.options.connectUrl === undefined ? "local" : "external",
    };
  }

  async #connect(
    tenant: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody(request);
    const role = body === null ? undefined : body["role"];
    if (role !== "personal" && role !== "work") {
      respondJson(response, 400, { error: "role must be personal or work" });
      return;
    }
    const template = this.options.connectUrl;
    if (template !== undefined) {
      respondJson(response, 200, {
        url: template
          .replaceAll("{slot}", tokenSlot(role, tenant))
          .replaceAll("{tenant}", tenant)
          .replaceAll("{role}", role),
        external: true,
      });
      return;
    }
    const runtime = this.#runtime(tenant);
    const calendarId =
      runtime.listAccounts().find((account) => account.role === role)?.calendarId ??
      this.options.defaultCalendarIds[role];
    // The pending OAuth session (and its callback listener) lives on the
    // cached runtime, so it survives past this request until the user
    // finishes in the browser.
    const started = await runtime.startConnect(role, calendarId);
    respondJson(response, 200, {
      url: started.url,
      expiresAt: started.expiresAt,
      external: false,
    });
  }

  /**
   * `{ action, keys?, keywords?, from? }` — the MCP tools' input shape, so
   * the page, an assistant and the terminal all speak the same language.
   * Validation errors (a malformed key, a keyword batch without `from`) come
   * back as 400 with the same message the CLI prints.
   */
  async #changeExclusions(
    tenant: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody(request);
    if (body === null) {
      respondJson(response, 400, { error: "expected a JSON object" });
      return;
    }
    const action = body["action"];
    if (action !== "add" && action !== "remove") {
      respondJson(response, 400, { error: "action must be add or remove" });
      return;
    }
    const keys = stringList(body["keys"]);
    const keywords = stringList(body["keywords"]);
    const from = body["from"];
    if (keys === null || keywords === null) {
      respondJson(response, 400, { error: "keys and keywords must be lists of strings" });
      return;
    }
    if (from !== undefined && from !== "personal" && from !== "work") {
      respondJson(response, 400, { error: "from must be personal or work" });
      return;
    }
    try {
      const result = this.#runtime(tenant).changeExclusions(action, {
        ...(keys === undefined ? {} : { keys }),
        ...(keywords === undefined ? {} : { keywords }),
        ...(from === undefined ? {} : { from }),
      });
      this.#log({
        event: "web_exclusions_changed",
        tenant,
        action,
        added: result.added.length,
        removed: result.removed.length,
      });
      respondJson(response, 200, { action, ...result });
    } catch (error) {
      if (error instanceof Error) {
        respondJson(response, 400, { error: error.message });
        return;
      }
      throw error;
    }
  }

  /**
   * A dry run on request. Titles ride back to the browser that asked and
   * nowhere else: not the status cache, not the log. Lock contention with a
   * live sync is a 409 the page can retry, not a failure.
   */
  async #preview(tenant: string, response: ServerResponse): Promise<void> {
    const gate = this.options.scanGate;
    // Only this handler writes the "preview" entry, so it owns the shape.
    const cached = gate?.cached(tenant, "preview") as WebPreviewView | undefined;
    if (cached !== undefined) {
      respondJson(response, 200, cached);
      return;
    }
    if (gate !== undefined && !this.#admit(tenant, "scan", "preview", response)) {
      return;
    }
    let pending = this.#previews.get(tenant);
    if (pending === undefined) {
      pending = this.#runPreview(tenant).finally(() => {
        this.#previews.delete(tenant);
      });
      this.#previews.set(tenant, pending);
    }
    try {
      respondJson(response, 200, await pending);
    } catch (error) {
      if (error instanceof LockTimeoutError) {
        respondJson(response, 409, { error: "a sync is running right now; try again in a moment" });
        return;
      }
      this.#log({ event: "web_preview_failed", tenant, error: errorName(error) });
      respondJson(response, 502, {
        error: error instanceof Error ? error.message : "preview failed",
      });
    }
  }

  async #runPreview(tenant: string): Promise<WebPreviewView> {
    const { result, sources } = await this.#runtime(tenant).previewSync({
      lockTimeoutMs: LOCK_TIMEOUT_MS,
    });
    this.#log({ event: "web_preview", tenant, sources: sources.length });
    // Recorded here, once the pass has actually read both calendars: a
    // request that gave up waiting for the lock never reached Google and
    // must not spend the tenant's allowance.
    this.options.scanGate?.record(tenant, "scan");
    const view: WebPreviewView = {
      ranAt: new Date().toISOString(),
      planned: {
        created: result.created,
        updated: result.updated,
        deleted: result.deleted,
        repaired: result.repaired,
      },
      converged: result.converged,
      mirrors: result.mirrors,
      events: sources.map(previewEvent),
    };
    this.options.scanGate?.remember(tenant, "preview", view);
    return view;
  }

  /**
   * `{ apply?: boolean }` — a check by default, a removal when `apply` is
   * true. Either way the pass reads both calendars afresh, so what a removal
   * reports is what it actually deleted, not what an earlier check listed.
   * Times only come back; a busy lock is a 409 the page can retry.
   */
  async #dedupe(tenant: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    if (body === null) {
      respondJson(response, 400, { error: "expected a JSON object" });
      return;
    }
    const apply = body["apply"] ?? false;
    if (typeof apply !== "boolean") {
      respondJson(response, 400, { error: "apply must be a boolean" });
      return;
    }
    const gate = this.options.scanGate;
    if (!apply) {
      // Only this handler writes the "dedupe" entry, so it owns the shape.
      const cached = gate?.cached(tenant, "dedupe") as WebDedupeView | undefined;
      if (cached !== undefined) {
        respondJson(response, 200, cached);
        return;
      }
    }
    if (gate !== undefined && !this.#admit(tenant, apply ? "write" : "scan", "dedupe", response)) {
      return;
    }
    const key = `${tenant}:${apply ? "apply" : "check"}`;
    let pending = this.#dedupes.get(key);
    if (pending === undefined) {
      pending = this.#runDedupe(tenant, apply).finally(() => {
        this.#dedupes.delete(key);
      });
      this.#dedupes.set(key, pending);
    }
    try {
      respondJson(response, 200, await pending);
    } catch (error) {
      if (error instanceof LockTimeoutError) {
        respondJson(response, 409, { error: "a sync is running right now; try again in a moment" });
        return;
      }
      this.#log({ event: "web_dedupe_failed", tenant, applied: apply, error: errorName(error) });
      respondJson(response, 502, {
        error: error instanceof Error ? error.message : "stray-block cleanup failed",
      });
    }
  }

  async #runDedupe(tenant: string, apply: boolean): Promise<WebDedupeView> {
    const { result, operations } = await this.#runtime(tenant).dedupe({
      dryRun: !apply,
      lockTimeoutMs: LOCK_TIMEOUT_MS,
    });
    const removals: WebDedupeRemoval[] = [];
    for (const operation of operations) {
      const kind = STRAY_KINDS[operation.reason];
      if (kind !== undefined && operation.timeRange !== undefined) {
        removals.push({ calendar: operation.destinationRole, when: operation.timeRange, kind });
      }
    }
    this.#log({
      event: "web_dedupe",
      tenant,
      applied: apply,
      inspected: result.inspected.personal + result.inspected.work,
      removed: result.deleted,
    });
    const gate = this.options.scanGate;
    // Recorded once the pass has read both calendars, so a request that gave
    // up waiting for the lock keeps the tenant's allowance.
    gate?.record(tenant, apply ? "write" : "scan");
    const view: WebDedupeView = {
      ranAt: new Date().toISOString(),
      applied: apply,
      inspected: result.inspected,
      removals,
    };
    if (apply) {
      // The blocks just went away, so the cached check now describes a
      // calendar that no longer exists. This run is the fresher answer.
      gate?.invalidate(tenant, "dedupe");
    } else {
      gate?.remember(tenant, "dedupe", view);
    }
    return view;
  }

  /**
   * Answers 429 when a tenant is still inside its gap, and returns false so
   * the caller stops. A wait is not a failure, so the reply carries the
   * seconds remaining — as a body field the page counts down from, and as the
   * `Retry-After` header anything else would look for.
   */
  #admit(
    tenant: string,
    operation: ScanOperation,
    what: "preview" | "dedupe",
    response: ServerResponse,
  ): boolean {
    const decision = this.options.scanGate?.check(tenant, operation) ?? { allowed: true };
    if (decision.allowed) {
      return true;
    }
    this.#log({
      event: "scan_rate_limited",
      tenant,
      operation: what,
      retryAfter: decision.retryAfterSeconds,
    });
    response
      .writeHead(429, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Retry-After": String(decision.retryAfterSeconds),
      })
      .end(
        JSON.stringify({
          error: `that reads both calendars, so it runs at most once in a while; try again in ${String(decision.retryAfterSeconds)}s`,
          retryAfter: decision.retryAfterSeconds,
        }),
      );
    return false;
  }

  #runtime(tenant: string): WebTenantRuntime {
    let runtime = this.#runtimes.get(tenant);
    if (runtime === undefined) {
      runtime = this.options.runtimeFor(tenant);
      this.#runtimes.set(tenant, runtime);
    }
    return runtime;
  }

  #log(entry: Record<string, unknown>): void {
    this.options.onLog?.(JSON.stringify(entry));
  }
}

export interface SignWebTokenOptions {
  /** "link" (default) is what gets handed out; "session" lives in the cookie. */
  kind?: WebTokenKind;
  /** Lifetime in seconds; defaults to a week for links. */
  ttlSeconds?: number;
  /** Unix seconds; injectable for tests. */
  now?: number;
}

/**
 * `<kind>.<tenant>.<expires>.<hex hmac>` — a signed, expiring tenant token.
 * The kind is under the signature, so a link cannot be presented as a
 * session cookie or the other way round. Tenant ids never contain a dot.
 */
export function signWebToken(
  tenantId: string,
  secret: string,
  options: SignWebTokenOptions = {},
): string {
  const tenant = parseTenantId(tenantId);
  const kind = options.kind ?? "link";
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const expiresAt = now + (options.ttlSeconds ?? LINK_TTL_SECONDS_DEFAULT);
  return `${kind}.${tenant}.${String(expiresAt)}.${tokenSignature(kind, tenant, expiresAt, secret)}`;
}

export interface VerifyWebTokenOptions {
  /** Refuse tokens of any other kind. */
  kind?: WebTokenKind;
  /** Unix seconds; injectable for tests. */
  now?: number;
}

/** Returns the tenant when the token verifies and has not expired, null otherwise. */
export function verifyWebToken(
  token: string,
  secret: string,
  options: VerifyWebTokenOptions = {},
): string | null {
  const parts = token.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const [kind, rawTenant, rawExpires, signature] = parts as [string, string, string, string];
  if (kind !== "link" && kind !== "session") {
    return null;
  }
  if (options.kind !== undefined && kind !== options.kind) {
    return null;
  }
  let tenant: string;
  try {
    tenant = parseTenantId(rawTenant);
  } catch (error) {
    if (error instanceof ConfigError) {
      return null;
    }
    throw error;
  }
  if (!/^[0-9]{1,12}$/u.test(rawExpires)) {
    return null;
  }
  const expiresAt = Number(rawExpires);
  const provided = Buffer.from(signature, "hex");
  const expected = Buffer.from(tokenSignature(kind, tenant, expiresAt, secret), "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (expiresAt <= now) {
    return null;
  }
  return tenant;
}

/**
 * tenantForIdentity is re-exported from `@dvd-toy-box/vault` above — the
 * shared collision-resistant email→id mapping used by calsync tenants and
 * gateway profile dirs.
 */

/** Full onboarding URL for one tenant, for the signup flow to hand out. */
export function webLink(
  baseUrl: string,
  tenantId: string,
  secret: string,
  ttlSeconds: number = LINK_TTL_SECONDS_DEFAULT,
): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}/?t=${signWebToken(tenantId, secret, { kind: "link", ttlSeconds })}`;
}

/**
 * Deep link into Google Calendar. Calendar email ids get the documented
 * base64 `cid` form; aliases like "primary" fall back to the calendar home,
 * which opens as the signed-in account's own calendar.
 */
export function calendarUrl(calendarId: string): string {
  if (!calendarId.includes("@")) {
    return "https://calendar.google.com/calendar/";
  }
  const cid = Buffer.from(calendarId, "utf8").toString("base64").replace(/=+$/u, "");
  return `https://calendar.google.com/calendar/u/0/r?cid=${cid}`;
}

function tokenSignature(
  kind: WebTokenKind,
  tenant: string,
  expiresAt: number,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${kind}.${tenant}.${String(expiresAt)}`)
    .digest("hex");
}

/**
 * A state-changing call must come from this dashboard's own page. The cookie
 * is SameSite=Strict already; this is the second lock: the request must be
 * JSON (a plain HTML form cannot send that) and, when the browser says where
 * it came from, it must be this origin.
 */
function isSameOriginJson(request: IncomingMessage): boolean {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return false;
  }
  const fetchSite = headerString(request.headers["sec-fetch-site"]);
  if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
    return false;
  }
  const origin = headerString(request.headers.origin);
  const host = headerString(request.headers.host);
  if (origin !== undefined && origin !== "null") {
    try {
      if (host === undefined || new URL(origin).host !== host) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Loopback names a browser may legitimately put in `Host` for a local
 * dashboard, plus the address the server was bound to when it is a concrete
 * one. A wildcard bind (`0.0.0.0`, `::`) adds nothing: without a secret the
 * dashboard is meant for the machine it runs on.
 */
function isLocalHostHeader(request: IncomingMessage, boundHost: string): boolean {
  const host = headerString(request.headers.host);
  if (host === undefined || host === "") {
    return false;
  }
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  return allowedLocalHostnames(boundHost).has(hostname.toLowerCase());
}

const WILDCARD_BIND_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

function allowedLocalHostnames(boundHost: string): Set<string> {
  const allowed = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const bound = boundHost.trim().toLowerCase();
  if (bound !== "" && !WILDCARD_BIND_HOSTS.has(bound)) {
    // URL.hostname keeps IPv6 literals bracketed; match that form.
    allowed.add(bound.includes(":") && !bound.startsWith("[") ? `[${bound}]` : bound);
  }
  return allowed;
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function cookieValue(request: IncomingMessage, name: string): string | null {
  const header = request.headers.cookie;
  if (header === undefined) {
    return null;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      return null;
    }
    chunks.push(buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function previewEvent(source: ReconcileSourceDetail): WebPreviewEvent {
  return {
    direction: source.sourceRole === "personal" ? "personalToWork" : "workToPersonal",
    title: source.sourceTitle ?? null,
    when: source.timeRange,
    recurring: source.isRecurring,
    status:
      source.exclusionReason === undefined ? "mirrored" : `excluded-${source.exclusionReason}`,
    keys: source.exclusionKeys,
  };
}

/** A JSON field that must be absent or a list of strings; null when it is neither. */
function stringList(value: unknown): string[] | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return null;
  }
  return value;
}

/**
 * The dashboard shell is static, but it is the page that asks for the
 * preview, so it gets the same no-store and no-sniff treatment as the data.
 */
function htmlHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
  };
}

function respondJson(response: ServerResponse, status: number, payload: unknown): void {
  response
    .writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      // The preview answer carries event titles. Nothing here is cacheable in
      // any case, and saying so keeps a proxy or a back-button from holding
      // one person's calendar.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    })
    .end(JSON.stringify(payload));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
