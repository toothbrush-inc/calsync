import { CALSYNC_STORE } from "../capability.js";

const storeDescription = CALSYNC_STORE.description
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

/**
 * Shown to a browser that lands without a valid tenant link — for example
 * from a bare bookmark or the platform's app index before first onboarding.
 * Static text only; it names no tenants and leaks nothing.
 */
export function renderAccessPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#128197;</text></svg>">
<title>calsync</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0; background: #f6f7f9; color: #1c2430;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 560px; margin: 0 auto; padding: 72px 20px; }
  h1 { font-size: 22px; margin: 0 0 6px; letter-spacing: -0.01em; }
  p { color: #5b6675; margin: 0 0 12px; }
  .card {
    background: #fff; border: 1px solid #e3e7ec; border-radius: 10px;
    padding: 20px 22px; margin-top: 20px;
  }
  .card p:last-child { margin-bottom: 0; }
</style>
</head>
<body>
<main>
  <h1>calsync</h1>
  <p>${storeDescription}</p>
  <div class="card">
    <p><strong>This dashboard is opened with a personal link.</strong></p>
    <p>Links are good for a week from when they were sent; once opened, this browser stays signed in for six months. If yours has expired, ask for a fresh one.</p>
    <p>Your link signs you in and keeps this page remembering you afterwards —
    if you've used it on this browser before, it may simply have expired.</p>
    <p>Ask whoever runs this calsync for your link, then open it once and
    bookmark the page.</p>
  </div>
</main>
</body>
</html>
`;
}

/**
 * The onboarding dashboard shell. Static HTML only: every dynamic value is
 * fetched from /api/status by the inline script and rendered via textContent,
 * so nothing tenant-provided is ever interpolated into markup.
 */
export function renderDashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#128197;</text></svg>">
<title>calsync</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0; background: #f6f7f9; color: #1c2430;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 640px; margin: 0 auto; padding: 40px 20px 64px; }
  h1 { font-size: 22px; margin: 0; letter-spacing: -0.01em; }
  .sub { color: #5b6675; margin: 4px 0 24px; }
  .banner {
    border-radius: 10px; padding: 14px 18px; margin-bottom: 24px;
    font-weight: 600; display: flex; align-items: center; gap: 10px;
  }
  .banner .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .banner[data-state="syncing"] { background: #e5f4ea; color: #14652f; }
  .banner[data-state="syncing"] .dot { background: #1d9d4b; }
  .banner[data-state="daemon-offline"] { background: #fdf3e0; color: #7a5410; }
  .banner[data-state="daemon-offline"] .dot { background: #e0a52c; }
  .banner[data-state="setup"] { background: #e8f0fe; color: #1c4587; }
  .banner[data-state="setup"] .dot { background: #4285f4; }
  .banner[data-state="loading"] { background: #eceff3; color: #5b6675; }
  .banner[data-state="loading"] .dot { background: #9aa5b1; }
  .card {
    background: #fff; border: 1px solid #e3e7ec; border-radius: 10px;
    padding: 18px 20px; margin-bottom: 14px;
  }
  .card h2 { font-size: 15px; margin: 0 0 2px; text-transform: capitalize; }
  .card .status { color: #5b6675; margin: 0 0 10px; }
  .card .calendar { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px; color: #384453; word-break: break-all; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  a.open { color: #1a63d0; text-decoration: none; white-space: nowrap; }
  a.open:hover { text-decoration: underline; }
  button.connect {
    background: #1a63d0; color: #fff; border: 0; border-radius: 8px;
    padding: 8px 16px; font: inherit; font-weight: 600; cursor: pointer;
  }
  button.connect:disabled { background: #9db9e8; cursor: default; }
  button.link {
    background: none; border: 1px solid #cfd6de; color: #384453; border-radius: 8px;
    padding: 7px 12px; font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap;
  }
  button.link:hover { border-color: #9aa5b1; }
  .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
  .hint { color: #5b6675; font-size: 13px; margin: 8px 0 0; }
  .account { color: #384453; font-size: 13px; margin: 6px 0 0; }
  .account strong { font-weight: 600; color: #1c2430; }
  .share { margin-top: 12px; display: none; gap: 8px; }
  .share[data-open] { display: flex; }
  .share input {
    flex: 1; min-width: 0; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
    padding: 7px 9px; border: 1px solid #cfd6de; border-radius: 6px; color: #384453; background: #f6f7f9;
  }
  .guide { color: #5b6675; font-size: 13px; margin: 6px 0 20px; }
  .summary { color: #5b6675; font-size: 13px; margin-top: 20px; }
  .summary strong { color: #1c2430; font-weight: 600; }
  .error { color: #a3372c; margin-top: 16px; }
  .footer { margin-top: 28px; font-size: 12px; color: #9aa5b1; }
  details.advanced { margin-top: 32px; }
  details.advanced > summary {
    cursor: pointer; font-weight: 600; font-size: 15px; color: #384453;
    padding: 12px 14px; border: 1px solid #e3e7ec; border-radius: 10px; background: #fff;
    list-style: none; display: flex; align-items: center; gap: 10px;
  }
  details.advanced > summary::-webkit-details-marker { display: none; }
  details.advanced > summary::before {
    content: ""; width: 7px; height: 7px; border-right: 2px solid #9aa5b1; border-bottom: 2px solid #9aa5b1;
    transform: rotate(-45deg); transition: transform 0.15s; flex: none; margin-left: 2px;
  }
  details.advanced[open] > summary::before { transform: rotate(45deg); }
  details.advanced > summary .summary-hint { font-weight: 400; color: #5b6675; font-size: 13px; }
  details.advanced[open] > summary { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
  .section { margin-top: 32px; }
  details.advanced > .section:first-of-type { margin-top: 20px; }
  .cli { color: #5b6675; font-size: 13px; margin: -6px 0 14px; }
  .section h2 { font-size: 17px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .section .lead { color: #5b6675; margin: 0 0 14px; }
  .direction { margin-bottom: 14px; }
  .direction h3 { font-size: 14px; margin: 0 0 2px; }
  .direction .who { color: #5b6675; font-size: 13px; margin: 0 0 10px; }
  .group { display: flex; align-items: baseline; gap: 10px; margin: 6px 0; }
  .group .label { flex: none; width: 88px; color: #5b6675; font-size: 13px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
  .chips .none { color: #9aa5b1; font-size: 13px; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
    background: #f1f3f6; border: 1px solid #e3e7ec; border-radius: 999px;
    padding: 3px 6px 3px 10px; font-size: 13px; color: #1c2430;
  }
  .chip .value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip.key .value { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .chip .scope { color: #5b6675; }
  .chip .origin { color: #7a5410; background: #fdf3e0; border-radius: 999px; padding: 0 7px; font-size: 11px; }
  .chip button {
    background: none; border: 0; color: #5b6675; font: inherit; font-size: 15px; line-height: 1;
    cursor: pointer; padding: 0 4px; border-radius: 999px;
  }
  .chip button:hover { color: #a3372c; background: #fbe9e6; }
  .chip button:disabled { color: #cfd6de; cursor: default; }
  form.add { margin-top: 12px; }
  form.add label { display: block; font-size: 13px; color: #384453; margin-bottom: 4px; }
  form.add .fields { display: flex; gap: 8px; flex-wrap: wrap; }
  form.add input[type="text"], form.add textarea, form.add select {
    font: inherit; font-size: 14px; padding: 7px 9px; border: 1px solid #cfd6de; border-radius: 8px;
    color: #1c2430; background: #fff; min-width: 0;
  }
  form.add input[type="text"] { flex: 1; }
  form.add textarea {
    width: 100%; box-sizing: border-box; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
    min-height: 64px; resize: vertical;
  }
  form.add button { align-self: flex-start; }
  .note { color: #14652f; font-size: 13px; margin: -4px 0 14px; }
  .note[data-kind="error"], .hint[data-kind="error"] { color: #a3372c; }
  .hint[data-kind="ok"] { color: #14652f; }
  form.inline { margin-top: 10px; display: flex; gap: 8px; }
  form.inline input[type="text"] { flex: 1; font-size: 13px; padding: 6px 9px; }
  form.inline button { padding: 6px 12px; }
  .preview-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .preview-toolbar .hint { margin: 0; }
  .preview-filters { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 14px 0 4px; }
  .preview-filters input[type="text"] {
    flex: 1; min-width: 160px; font: inherit; font-size: 13px; padding: 6px 9px;
    border: 1px solid #cfd6de; border-radius: 8px;
  }
  .preview-filters label { font-size: 13px; color: #384453; display: flex; gap: 6px; align-items: center; }
  .dedupe-apply { margin-top: 14px; padding-top: 14px; border-top: 1px solid #eef1f4; }
  .dedupe-apply[hidden] { display: none; }
  .dedupe-apply button.connect { background: #a3372c; }
  .dedupe-apply button.connect:disabled { background: #d9a49e; }
  .events { list-style: none; margin: 0; padding: 0; }
  .event {
    display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; align-items: center;
    padding: 8px 0; border-top: 1px solid #eef1f4;
  }
  .event:first-child { border-top: 0; }
  .event .main { min-width: 0; }
  .event .title { font-weight: 600; overflow-wrap: anywhere; }
  .event .when { color: #5b6675; font-size: 13px; }
  .event[data-status^="excluded"] .title { color: #5b6675; font-weight: 500; text-decoration: line-through; }
  .badge {
    display: inline-block; font-size: 11px; border-radius: 999px; padding: 0 7px; margin-left: 6px;
    background: #eceff3; color: #5b6675; vertical-align: 1px; white-space: nowrap;
  }
  .badge.excluded { background: #fdf3e0; color: #7a5410; }
  .event-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .event-actions button.link { padding: 4px 9px; font-size: 12px; }
  .event-actions .why { color: #9aa5b1; font-size: 12px; white-space: nowrap; }
  .events .empty { color: #9aa5b1; font-size: 13px; padding: 6px 0; }
  @media (max-width: 520px) {
    .event { grid-template-columns: 1fr; }
    .event-actions { justify-content: flex-start; }
  }
</style>
</head>
<body>
<main>
  <h1>calsync</h1>
  <p class="sub">${storeDescription}</p>
  <div id="banner" class="banner" data-state="loading"><span class="dot"></span><span id="banner-text">Checking sync status…</span></div>
  <div id="cards"></div>
  <p class="guide">Each calendar is connected with the Google account that owns it, so you sign in twice: once as your personal account, once as your work account. Google asks which account to use each time. If a calendar's account lives in another browser or profile, use "Copy link" and open it there.</p>
  <p id="summary" class="summary"></p>
  <p id="error" class="error" hidden></p>

  <details class="advanced" id="advanced">
  <summary>Advanced<span class="summary-hint">Exclusions, a dry-run preview, pruning duplicates</span></summary>
  <section class="section" id="exclusions">
    <h2>Exclusions</h2>
    <p class="lead">Events that match stay on their own calendar and are never mirrored. Keywords match anywhere in a title, case-insensitively, the same as <code>calsync exclude add --keyword</code>.</p>
    <div id="exclusion-lists"></div>
    <p id="exclusion-note" class="note" hidden></p>
    <div class="card">
      <form class="add" id="add-keys">
        <label for="key-input">Exclude specific events by key</label>
        <textarea id="key-input" placeholder="calsync-exclude:v1:p2w:occ:…" spellcheck="false"></textarea>
        <div class="fields"><button class="connect" type="submit">Add</button></div>
        <p class="hint">Paste opaque keys, one per line, from <code>calsync sync --once --dry-run --verbose</code> or an assistant's preview. Or skip the keys: run a preview below and click Exclude next to an event.</p>
      </form>
    </div>
  </section>

  <section class="section" id="preview">
    <h2>Preview a sync</h2>
    <p class="lead">A dry run reads both calendars and lists every event in the sync window, so you can see what would be mirrored and pick what to exclude. Nothing is written. Titles appear only here, only when you run it, and never leave this page.</p>
    <p class="cli">Same as <code>calsync sync --once --dry-run --verbose</code> in the terminal.</p>
    <div class="card">
      <div class="preview-toolbar">
        <button id="run-preview" class="connect" type="button">Run dry run</button>
        <p id="preview-status" class="hint"></p>
      </div>
      <div id="preview-results" hidden>
        <p id="preview-summary" class="summary"></p>
        <div class="preview-filters">
          <input id="preview-filter" type="text" placeholder="Filter by title" autocomplete="off">
          <label><input id="preview-hide-excluded" type="checkbox"> Hide excluded</label>
        </div>
        <div id="preview-lists"></div>
      </div>
    </div>
  </section>

  <section class="section" id="dedupe">
    <h2>Prune duplicates</h2>
    <p class="lead">A reinstall, a calendar switch, or an event Google re-created under a new identity can leave an old busy block behind: next to its replacement as a duplicate, or on its own as a phantom once the event it mirrored moved or went away. A check reads both calendars and lists every block calsync made that no live event stands behind. Pruning them deletes only those blocks: every mirror of a live event stays, and your real events are never touched.</p>
    <p class="cli">Same as <code>calsync dedupe</code> in the terminal.</p>
    <div class="card">
      <div class="preview-toolbar">
        <button id="run-dedupe" class="connect" type="button">Check for stray blocks</button>
        <p id="dedupe-status" class="hint"></p>
      </div>
      <div id="dedupe-results" hidden>
        <p id="dedupe-summary" class="summary"></p>
        <div id="dedupe-lists"></div>
        <div id="dedupe-apply" class="preview-toolbar dedupe-apply" hidden>
          <button id="apply-dedupe" class="connect" type="button">Prune stray blocks</button>
          <p class="hint">Reads both calendars again and deletes the stray blocks it finds, so the list above may shift a little if a sync ran in between. Nothing else changes.</p>
        </div>
      </div>
    </div>
  </section>
  </details>
  <p class="footer">Only opaque busy blocks are mirrored — titles, guests, and details never leave your calendars.</p>
</main>
<script>
(() => {
  const banner = document.getElementById("banner");
  const bannerText = document.getElementById("banner-text");
  const cards = document.getElementById("cards");
  const summary = document.getElementById("summary");
  const errorLine = document.getElementById("error");
  const BANNERS = {
    "syncing": "Actively syncing — your calendars are being mirrored.",
    "daemon-offline": "Calendars connected, but the sync service is not running.",
    "setup": "Connect your calendars below to start syncing.",
  };
  let fastUntil = 0;
  let timer;

  function relative(iso) {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms) || ms < 0) return "just now";
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + "m ago";
    const hours = Math.round(minutes / 60);
    if (hours < 48) return hours + "h ago";
    return Math.round(hours / 24) + "d ago";
  }

  function card(account) {
    const div = document.createElement("div");
    div.className = "card";
    const title = document.createElement("h2");
    title.textContent = account.role + " calendar";
    const status = document.createElement("p");
    status.className = "status";
    status.textContent = account.message;
    const row = document.createElement("div");
    row.className = "row";
    const calendar = document.createElement("span");
    calendar.className = "calendar";
    calendar.textContent = account.account ?? account.calendarId ?? "not connected";
    row.append(calendar);
    const actions = document.createElement("div");
    actions.className = "actions";
    row.append(actions);
    div.append(title, status, row);
    if (account.valid && account.calendarUrl) {
      const link = document.createElement("a");
      link.className = "open";
      link.href = account.calendarUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "Open in Google Calendar ↗";
      actions.append(link);
      if (account.account) {
        const who = document.createElement("p");
        who.className = "account";
        who.append("Connected as ");
        const strong = document.createElement("strong");
        strong.textContent = account.account;
        who.append(strong);
        div.append(who);
      }
      if (account.conflict) {
        const warn = document.createElement("p");
        warn.className = "hint";
        warn.dataset.kind = "error";
        warn.textContent = "Another calsync sign-in on this host syncs these same two calendars, so every event is mirrored twice. Ask whoever runs this calsync to remove one of them.";
        div.append(warn);
      }
    } else {
      const button = document.createElement("button");
      button.className = "connect";
      button.textContent = account.connected ? "Reconnect" : "Connect";
      button.addEventListener("click", () => connect(account.role, button));
      const copy = document.createElement("button");
      copy.className = "link";
      copy.textContent = "Copy link";
      copy.title = "Get the connect link to open in another browser or profile";
      const share = document.createElement("div");
      share.className = "share";
      copy.addEventListener("click", () => shareLink(account.role, copy, share));
      actions.append(button, copy);
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "Sign in with the Google account that owns your " + account.role + " calendar.";
      div.append(hint, share);
    }
    return div;
  }

  async function connectUrl(role) {
    const response = await fetch("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.url) throw new Error(payload.error || "connect failed");
    return payload;
  }

  async function connect(role, button) {
    button.disabled = true;
    button.textContent = "Waiting for Google…";
    try {
      const payload = await connectUrl(role);
      fastUntil = Date.now() + 3 * 60 * 1000;
      if (payload.external) {
        // The gateway brings the browser back here once consent is done.
        window.location.assign(payload.url);
        return;
      }
      window.open(payload.url, "_blank", "noreferrer");
      schedule(5000);
    } catch (error) {
      button.disabled = false;
      button.textContent = "Connect";
      showError(String(error.message || error));
    }
  }

  async function shareLink(role, button, share) {
    button.disabled = true;
    try {
      const payload = await connectUrl(role);
      share.replaceChildren();
      const input = document.createElement("input");
      input.readOnly = true;
      input.value = payload.url;
      input.addEventListener("focus", () => input.select());
      const copy = document.createElement("button");
      copy.className = "link";
      copy.textContent = "Copy";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(payload.url);
          copy.textContent = "Copied";
        } catch {
          input.focus();
          input.select();
          copy.textContent = "Select and copy";
        }
      });
      share.append(input, copy);
      share.dataset.open = "1";
      input.focus();
      input.select();
      if (!payload.external) {
        fastUntil = Date.now() + 3 * 60 * 1000;
        schedule(5000);
      }
    } catch (error) {
      showError(String(error.message || error));
    } finally {
      button.disabled = false;
    }
  }

  function showError(message) {
    errorLine.textContent = message;
    errorLine.hidden = false;
  }

  const exclusionLists = document.getElementById("exclusion-lists");
  const exclusionNote = document.getElementById("exclusion-note");
  const DIRECTIONS = [
    { id: "personalToWork", from: "personal", title: "Personal → work",
      who: "Personal events kept off your work calendar." },
    { id: "workToPersonal", from: "work", title: "Work → personal",
      who: "Work events kept off your personal calendar." },
  ];
  const APPLY_HINT = "The next sync pass applies this.";

  function keyScope(value) {
    return value.includes(":series:") ? "whole series" : "one occurrence";
  }

  function directionFrom(direction) {
    return direction === "personalToWork" ? "personal" : "work";
  }

  function chip(kind, entry) {
    const span = document.createElement("span");
    span.className = "chip " + kind;
    span.title = entry.value;
    if (kind === "key") {
      const scope = document.createElement("span");
      scope.className = "scope";
      scope.textContent = keyScope(entry.value);
      span.append(scope);
    }
    const value = document.createElement("span");
    value.className = "value";
    // Keys are long and opaque; the tail is enough to tell two apart.
    value.textContent = kind === "key" ? "…" + entry.value.slice(-12) : entry.value;
    span.append(value);
    if (entry.origin === "env") {
      const origin = document.createElement("span");
      origin.className = "origin";
      origin.textContent = ".env";
      origin.title = "Set in .env; edit that file to change it.";
      span.append(origin);
    } else {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", "Stop excluding " + entry.value);
      remove.addEventListener("click", () => {
        remove.disabled = true;
        const body = kind === "key"
          ? { action: "remove", keys: [entry.value] }
          : { action: "remove", keywords: [entry.value], from: directionFrom(entry.direction) };
        void changeExclusions(body);
      });
      span.append(remove);
    }
    return span;
  }

  function group(label, kind, entries) {
    const row = document.createElement("div");
    row.className = "group";
    const name = document.createElement("span");
    name.className = "label";
    name.textContent = label;
    const chips = document.createElement("div");
    chips.className = "chips";
    if (entries.length === 0) {
      const none = document.createElement("span");
      none.className = "none";
      none.textContent = "none";
      chips.append(none);
    } else {
      chips.append(...entries.map((entry) => chip(kind, entry)));
    }
    row.append(name, chips);
    return row;
  }

  // Each direction gets its own keyword box, so "from" is never a choice to make.
  function keywordForm(direction) {
    const form = document.createElement("form");
    form.className = "add inline";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Add keywords: dentist, therapy, school pickup";
    input.autocomplete = "off";
    input.setAttribute("aria-label", "Keywords to exclude from " + direction.from);
    const button = document.createElement("button");
    button.className = "connect";
    button.type = "submit";
    button.textContent = "Add";
    form.append(input, button);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (input.value.trim() === "") return;
      button.disabled = true;
      const ok = await changeExclusions({ action: "add", keywords: [input.value], from: direction.from });
      button.disabled = false;
      if (ok) input.value = "";
    });
    return form;
  }

  function directionCard(direction) {
    const card = document.createElement("div");
    card.className = "card direction";
    const title = document.createElement("h3");
    title.textContent = direction.title;
    const who = document.createElement("p");
    who.className = "who";
    who.textContent = direction.who;
    card.append(title, who);
    return card;
  }

  function renderExclusions(snapshot) {
    exclusionLists.replaceChildren(...DIRECTIONS.map((direction) => {
      const card = directionCard(direction);
      card.append(
        group("Keywords", "keyword", snapshot.keywords.filter((entry) => entry.direction === direction.id)),
        group("Events", "key", snapshot.keys.filter((entry) => entry.direction === direction.id)),
        keywordForm(direction),
      );
      return card;
    }));
  }

  async function loadExclusions() {
    try {
      const response = await fetch("/api/exclusions");
      if (!response.ok) throw new Error("status " + response.status);
      renderExclusions(await response.json());
    } catch (error) {
      note("Could not load exclusions: " + String(error.message || error), "error");
    }
  }

  // Feedback lands next to whatever was clicked: the lists, or a preview row.
  function note(message, kind, target) {
    const line = target || exclusionNote;
    line.textContent = message;
    line.dataset.kind = kind || "ok";
    line.hidden = false;
  }

  // "Added 2 keywords, 1 event." — the same tallies the CLI prints.
  function tally(items) {
    const parts = [];
    for (const [kind, word] of [["keyword", "keyword"], ["key", "event"]]) {
      const n = items.filter((item) => item.kind === kind).length;
      if (n) parts.push(n + " " + (n === 1 ? word : word + "s"));
    }
    return parts.join(", ");
  }

  function describe(result) {
    const parts = [];
    if (result.added.length) parts.push("Added " + tally(result.added) + ".");
    if (result.alreadyPresent.length) parts.push("Already excluded: " + tally(result.alreadyPresent) + ".");
    if (result.removed.length) parts.push("Removed " + tally(result.removed) + ".");
    if (result.missing.length) parts.push("Not found: " + tally(result.missing) + " (set in .env?).");
    if (result.added.length || result.removed.length) parts.push(APPLY_HINT);
    return parts.join(" ") || "No change.";
  }

  async function changeExclusions(body, target) {
    try {
      const response = await fetch("/api/exclusions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "request failed");
      note(describe(payload), "ok", target);
      return true;
    } catch (error) {
      note(String(error.message || error), "error", target);
      return false;
    } finally {
      void loadExclusions();
    }
  }

  document.getElementById("add-keys").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.getElementById("key-input");
    const keys = input.value.split(/[\\s,]+/).map((key) => key.trim()).filter(Boolean);
    if (keys.length === 0) return;
    if (await changeExclusions({ action: "add", keys })) input.value = "";
  });

  // ---- Dry-run preview ----
  const runPreview = document.getElementById("run-preview");
  const previewStatus = document.getElementById("preview-status");
  const previewResults = document.getElementById("preview-results");
  const previewSummary = document.getElementById("preview-summary");
  const previewLists = document.getElementById("preview-lists");
  const previewFilter = document.getElementById("preview-filter");
  const previewHideExcluded = document.getElementById("preview-hide-excluded");
  let previewEvents = [];

  const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
  // Stray blocks can be years old or years out, so their dates carry the year.
  const dateYearFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

  function formatWhen(when, dayFmt = dateFmt) {
    if (when.kind === "all-day") {
      // All-day ranges are dates with an exclusive end.
      const start = new Date(when.start.slice(0, 10) + "T00:00:00");
      const end = new Date(when.end.slice(0, 10) + "T00:00:00");
      end.setDate(end.getDate() - 1);
      return dayFmt.format(start) + (end > start ? " – " + dayFmt.format(end) : "") + " · all day";
    }
    const start = new Date(when.start);
    const end = new Date(when.end);
    const sameDay = start.toDateString() === end.toDateString();
    return dayFmt.format(start) + ", " + timeFmt.format(start) + "–" + timeFmt.format(end) +
      (sameDay ? "" : " (" + dayFmt.format(end) + ")");
  }

  const STATUS_LABEL = {
    "excluded-keyword": "excluded by keyword",
    "excluded-occurrence": "excluded",
    "excluded-series": "series excluded",
    "excluded-legacy": "excluded in .env",
  };

  function eventActions(event, row) {
    const actions = document.createElement("div");
    actions.className = "event-actions";
    const button = (label, body, next) => {
      const b = document.createElement("button");
      b.className = "link";
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", async () => {
        b.disabled = true;
        if (await changeExclusions(body, previewStatus)) {
          event.status = next;
          row.replaceWith(eventRow(event));
        } else {
          b.disabled = false;
        }
      });
      return b;
    };
    if (event.status === "mirrored") {
      actions.append(button("Exclude", { action: "add", keys: [event.keys.occurrence] }, "excluded-occurrence"));
      if (event.recurring) {
        actions.append(button("Exclude series", { action: "add", keys: [event.keys.series] }, "excluded-series"));
      }
    } else if (event.status === "excluded-occurrence") {
      actions.append(button("Include again", { action: "remove", keys: [event.keys.occurrence] }, "mirrored"));
    } else if (event.status === "excluded-series") {
      actions.append(button("Include series again", { action: "remove", keys: [event.keys.series] }, "mirrored"));
    } else {
      const why = document.createElement("span");
      why.className = "why";
      why.textContent = event.status === "excluded-keyword" ? "remove the keyword above to include it" : "edit .env to include it";
      actions.append(why);
    }
    return actions;
  }

  function eventRow(event) {
    const li = document.createElement("li");
    li.className = "event";
    li.dataset.status = event.status;
    const main = document.createElement("div");
    main.className = "main";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = event.title ?? "(untitled)";
    main.append(title);
    if (event.recurring) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "repeats";
      main.append(badge);
    }
    if (event.status !== "mirrored") {
      const badge = document.createElement("span");
      badge.className = "badge excluded";
      badge.textContent = STATUS_LABEL[event.status] || event.status;
      main.append(badge);
    }
    const when = document.createElement("div");
    when.className = "when";
    when.textContent = formatWhen(event.when);
    main.append(when);
    li.append(main, eventActions(event, li));
    return li;
  }

  function renderPreviewLists() {
    const needle = previewFilter.value.trim().toLowerCase();
    const hideExcluded = previewHideExcluded.checked;
    previewLists.replaceChildren(...DIRECTIONS.map((direction) => {
      const card = directionCard(direction);
      const list = document.createElement("ul");
      list.className = "events";
      const events = previewEvents
        .filter((event) => event.direction === direction.id)
        .filter((event) => !needle || (event.title || "").toLowerCase().includes(needle))
        .filter((event) => !hideExcluded || event.status === "mirrored");
      if (events.length === 0) {
        const empty = document.createElement("li");
        empty.className = "empty";
        empty.textContent = previewEvents.some((event) => event.direction === direction.id)
          ? "No events match the filter."
          : "No events in the sync window.";
        list.append(empty);
      } else {
        list.append(...events.map(eventRow));
      }
      card.append(list);
      return card;
    }));
  }

  function renderPreview(view) {
    previewEvents = view.events.slice().sort((a, b) => a.when.start.localeCompare(b.when.start));
    const planned = view.planned.created + view.planned.updated + view.planned.deleted + view.planned.repaired;
    const parts = [
      planned === 0 ? "No changes planned" : planned + (planned === 1 ? " operation" : " operations") + " planned",
      previewEvents.length + " events in the sync window",
      view.mirrors.personalToWork.active + " would be mirrored to work, " + view.mirrors.workToPersonal.active + " to personal",
    ];
    previewSummary.textContent = parts.join(" · ") + ".";
    previewResults.hidden = false;
    renderPreviewLists();
  }

  // A 429 from a scan is a wait, not a failure: the server says how many
  // seconds are left, so the button counts down instead of going red.
  function countdown(button, label, seconds, onDone) {
    let left = seconds;
    button.disabled = true;
    const tick = () => {
      if (left <= 0) {
        button.disabled = false;
        button.textContent = label;
        onDone && onDone();
        return;
      }
      button.textContent = label + " in " + left + "s";
      left -= 1;
      window.setTimeout(tick, 1000);
    };
    tick();
  }

  runPreview.addEventListener("click", async () => {
    runPreview.disabled = true;
    delete previewStatus.dataset.kind;
    previewStatus.textContent = "Reading both calendars… this can take a minute.";
    try {
      const response = await fetch("/api/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const payload = await response.json();
      if (response.status === 429) {
        previewStatus.textContent = payload.error;
        countdown(runPreview, "Run again", payload.retryAfter || 60);
        return;
      }
      if (!response.ok) throw new Error(payload.error || "preview failed");
      renderPreview(payload);
      previewStatus.textContent = "Ran " + relative(payload.ranAt) + ". Exclusions made here apply on the next sync; run again to confirm.";
      runPreview.disabled = false;
      runPreview.textContent = "Run again";
    } catch (error) {
      previewStatus.dataset.kind = "error";
      previewStatus.textContent = "Preview failed: " + String(error.message || error);
      runPreview.disabled = false;
      runPreview.textContent = "Run again";
    }
  });
  previewFilter.addEventListener("input", renderPreviewLists);
  previewHideExcluded.addEventListener("change", renderPreviewLists);

  // ---- Prune duplicates ----
  const runDedupe = document.getElementById("run-dedupe");
  const applyDedupe = document.getElementById("apply-dedupe");
  const dedupeApply = document.getElementById("dedupe-apply");
  const dedupeStatus = document.getElementById("dedupe-status");
  const dedupeResults = document.getElementById("dedupe-results");
  const dedupeSummary = document.getElementById("dedupe-summary");
  const dedupeLists = document.getElementById("dedupe-lists");
  const CALENDARS = [
    { id: "work", title: "Work calendar", who: "Busy blocks calsync mirrored here from your personal calendar." },
    { id: "personal", title: "Personal calendar", who: "Busy blocks calsync mirrored here from your work calendar." },
  ];

  function plural(n, word) {
    return n + " " + (n === 1 ? word : word + "s");
  }

  function removalRow(removal) {
    const li = document.createElement("li");
    li.className = "event";
    const main = document.createElement("div");
    main.className = "main";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = "Busy";
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = removal.kind === "phantom" ? "phantom · no event behind it" : "duplicate";
    const when = document.createElement("div");
    when.className = "when";
    when.textContent = formatWhen(removal.when, dateYearFmt);
    main.append(title, badge, when);
    li.append(main);
    return li;
  }

  function renderDedupe(view) {
    const found = view.removals.length;
    const checked = view.inspected.personal + view.inspected.work;
    const duplicates = view.removals.filter((removal) => removal.kind === "duplicate").length;
    const breakdown = found === 0 ? "" :
      " (" + plural(duplicates, "duplicate") + ", " + plural(found - duplicates, "phantom") + ")";
    if (view.applied) {
      dedupeSummary.textContent = found === 0
        ? "Nothing to prune · " + plural(checked, "busy block") + " checked."
        : "Pruned " + plural(found, "stray busy block") + breakdown + ".";
    } else {
      dedupeSummary.textContent = (found === 0 ? "No stray blocks" : plural(found, "stray busy block") + breakdown) +
        " found · " + plural(checked, "busy block") + " checked.";
    }
    dedupeLists.replaceChildren(...CALENDARS.flatMap((calendar) => {
      const removals = view.removals
        .filter((removal) => removal.calendar === calendar.id)
        .sort((a, b) => a.when.start.localeCompare(b.when.start));
      if (removals.length === 0) return [];
      const card = document.createElement("div");
      card.className = "card direction";
      const title = document.createElement("h3");
      title.textContent = calendar.title;
      const who = document.createElement("p");
      who.className = "who";
      who.textContent = calendar.who;
      const list = document.createElement("ul");
      list.className = "events";
      list.append(...removals.map(removalRow));
      card.append(title, who, list);
      return [card];
    }));
    dedupeApply.hidden = view.applied || found === 0;
    applyDedupe.textContent = "Prune " + plural(found, "stray block");
    dedupeResults.hidden = false;
  }

  async function dedupe(apply) {
    runDedupe.disabled = true;
    applyDedupe.disabled = true;
    delete dedupeStatus.dataset.kind;
    dedupeStatus.textContent = apply
      ? "Pruning stray blocks…"
      : "Reading both calendars… this can take a minute.";
    try {
      const response = await fetch("/api/dedupe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apply }),
      });
      const payload = await response.json();
      if (response.status === 429) {
        dedupeStatus.textContent = payload.error;
        countdown(apply ? applyDedupe : runDedupe, apply ? "Prune stray blocks" : "Check again", payload.retryAfter || 60, () => {
          runDedupe.disabled = false;
          applyDedupe.disabled = false;
        });
        return;
      }
      if (!response.ok) throw new Error(payload.error || (apply ? "removal failed" : "check failed"));
      renderDedupe(payload);
      if (apply) {
        dedupeStatus.dataset.kind = "ok";
        dedupeStatus.textContent = "Done. Google Calendar may take a moment to catch up; check again any time.";
      } else {
        dedupeStatus.textContent = "Checked " + relative(payload.ranAt) + ".";
      }
    } catch (error) {
      dedupeStatus.dataset.kind = "error";
      dedupeStatus.textContent = (apply ? "Pruning failed: " : "Check failed: ") + String(error.message || error);
    } finally {
      // A countdown owns the buttons until it finishes; re-enabling here
      // would hand them straight back.
      if (!runDedupe.textContent.includes(" in ") && !applyDedupe.textContent.includes(" in ")) {
        runDedupe.disabled = false;
        applyDedupe.disabled = false;
        runDedupe.textContent = "Check again";
      }
    }
  }

  runDedupe.addEventListener("click", () => { void dedupe(false); });
  applyDedupe.addEventListener("click", () => { void dedupe(true); });

  let wantFresh = false;

  async function refresh() {
    try {
      const response = await fetch(wantFresh ? "/api/status?fresh=1" : "/api/status");
      wantFresh = false;
      if (!response.ok) throw new Error("status " + response.status);
      const status = await response.json();
      errorLine.hidden = true;
      banner.dataset.state = status.overall;
      bannerText.textContent = BANNERS[status.overall] || status.overall;
      cards.replaceChildren(...status.accounts.map(card));
      const parts = [];
      if (status.lastFullSyncAt) parts.push("Last full sync " + relative(status.lastFullSyncAt));
      if (status.lastResult) {
        parts.push(
          status.lastResult.personalToWorkActive + " busy blocks mirrored to work, " +
          status.lastResult.workToPersonalActive + " to personal",
        );
      }
      summary.textContent = parts.join(" · ");
    } catch (error) {
      showError("Could not reach calsync: " + String(error.message || error));
    }
    schedule(Date.now() < fastUntil ? 5000 : 60000);
  }

  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(refresh, delay);
  }

  // Landing back here after a consent: the last cached status predates the
  // connection by definition, so ask for a fresh one, poll quickly for a
  // couple of minutes, and drop the marker from the address bar. The cards
  // themselves say what happened; no extra banner.
  const landing = new URLSearchParams(window.location.search);
  if (landing.has("connected") || landing.has("fresh")) {
    wantFresh = true;
    fastUntil = Date.now() + 2 * 60 * 1000;
    window.history.replaceState(null, "", "/");
  }
  void refresh();
  void loadExclusions();
})();
</script>
</body>
</html>
`;
}
