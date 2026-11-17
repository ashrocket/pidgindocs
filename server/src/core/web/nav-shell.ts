/**
 * Navigation shell for signed-in pages: Open Quickly palette (Cmd/Ctrl+K), recently
 * viewed items kept in this browser, and favorites stars backed by /api/favorites.
 *
 * One <style> and one inline <script> are injected into each first-party page. The script
 * defines window.appNav before the page's own scripts run, so client-side apps can call
 * appNav.record(), appNav.starHTML() and appNav.sync() while they render.
 *
 * Never inject this into a sandboxed page (/a/:id, /docs/:id, /idoc/:id). Those run in an
 * opaque origin with no cookies, storage or network, so the shell could not work there.
 */

import { editionSlug } from "../wire-names";
import { basePath, clientBase, routePath } from "../base-path";
import { editionArticles } from "../help/edition-text";

export type NavKind = "doc" | "artifact" | "message" | "runbook" | "audio" | "help";

export interface NavItem {
  kind: NavKind;
  id: string;
  title: string;
  /**
   * Canonical path for the recents list, for example /messages/<id>. Always prefix-free (route space, routePath(...)):
   * recents and favorites outlive a base path, and the shell adds the base itself when it links.
   */
  url: string;
}

export interface NavCommand {
  label: string; url: string; kw: string; tenant?: boolean; admin?: boolean; personal?: boolean;
}
let editionCommands: readonly NavCommand[] = [];
/** Installed once by a deployment entry; core and Solo start without edition commands. */
export function installNavCommands(commands: readonly NavCommand[]): void { editionCommands = [...commands]; }

export interface NavShellOptions {
  /** Commands supplied by this deployment's edition. */
  commands?: readonly NavCommand[];
  /** Page nonce, when the page CSP allows only nonce scripts. */
  nonce?: string;
  /** Accent color for pressed stars and focus rings. Must be a hex color. */
  accent?: string;
  /**
   * Public sites have no personal inbox or documents, and no /help/<slug> pages. The palette lists help
   * articles only when this is explicitly false: a page that leaves it out may be on the public site.
   */
  publicSite?: boolean;
  /** Signed-in user. Recents are kept per user, so saved accounts in one browser do not see each other's titles. */
  userId?: string;
  /** The item this page shows. It is recorded as recently viewed. */
  item?: NavItem;
  /** Owner or admin of the current team: the palette offers People. */
  canManagePeople?: boolean;
  /** The deployment's URL path prefix from basePath(env): "" or "/name". The shell defines window.APP_BASE from it. */
  base?: string;
}

const esc = (value: unknown): string =>
  String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const CLOCK_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>`;
const HELP_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.4"/><circle cx="12" cy="17" r=".6" fill="currentColor"/></svg>`;

// Help articles for the palette: slug and title only (about 1 KB), so every signed-in page stays small.
/** The help articles for the palette, with this edition's names. */
const helpPalette = () => editionArticles().map(({ slug, title }) => ({ slug, title }));

/** Header button that opens the palette. Place it at the trailing end of a page's nav. */
export function navButton(): string {
  return `<button type="button" class="dnav-btn" data-dnav-open aria-label="Recents and favorites" title="Recents and favorites (⌘K)" aria-haspopup="dialog">${CLOCK_ICON}</button>`;
}

/** Favorite star for a page that shows one item. The shell fills in its state. */
export function navStar(item: Pick<NavItem, "kind" | "id" | "title">, reveal = false): string {
  return `<button type="button" class="dnav-star${reveal ? " dnav-reveal" : ""}" data-dnav-star data-kind="${esc(item.kind)}" data-id="${esc(item.id)}" data-title="${esc(item.title)}" aria-pressed="false" aria-label="Favorite ${esc(item.title)}" title="Add to favorites">☆</button>`;
}

const PAGE_CSS = `
:root{--dnav-accent:#1f6f6b}
.dnav-btn{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;padding:0;margin:0;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer;flex:none;vertical-align:middle;-webkit-tap-highlight-color:transparent}
.dnav-btn:hover{background:rgba(0,0,0,.07)}
.dnav-star{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;margin:0;border:0;border-radius:6px;background:transparent;color:inherit;font:400 18px/1 system-ui,sans-serif;opacity:.55;cursor:pointer;flex:none;vertical-align:middle;-webkit-tap-highlight-color:transparent}
.dnav-star:hover{opacity:1;background:rgba(0,0,0,.06)}
.dnav-star[aria-pressed=true]{color:var(--dnav-accent);opacity:1}
.dnav-btn:focus-visible,.dnav-star:focus-visible{outline:3px solid var(--dnav-accent);outline-offset:2px;opacity:1}
.dnav-reveal[aria-pressed=false]{opacity:0}
[data-dnav-host]:hover .dnav-reveal,[data-dnav-host]:focus-within .dnav-reveal{opacity:.55}
[data-dnav-host]:hover .dnav-reveal:hover{opacity:1}
@media (hover:none){.dnav-reveal[aria-pressed=false]{opacity:.55}}
@media (pointer:coarse){.dnav-btn,.dnav-star{min-width:44px;min-height:44px}}
@media print{.dnav-btn,.dnav-star{display:none}}
`;

// Everything inside the shadow root. Page styles cannot reach it and it cannot restyle the page.
const SHADOW_CSS = `
:host{all:initial;color-scheme:light}
*{box-sizing:border-box}
.scrim{position:fixed;inset:0;z-index:2147483000;background:rgba(20,28,36,.38);display:flex;justify-content:center;align-items:flex-start;padding:12vh 16px 16px;font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#18242e}
.scrim[hidden]{display:none}
.panel{width:min(600px,100%);max-height:min(540px,76vh);display:flex;flex-direction:column;background:#fff;border:1px solid #d5dde3;border-radius:14px;box-shadow:0 18px 50px rgba(15,25,35,.28);overflow:hidden}
.search{display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid #e3e8ec}
.search svg{flex:none;color:#6b7a86}
.close{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;padding:0;border:0;border-radius:8px;background:transparent;color:inherit;font:24px/1 system-ui,sans-serif;cursor:pointer}
.close:hover{background:#f1f5f7}
.close:focus-visible{outline:3px solid var(--dnav-accent,#1f6f6b);outline-offset:-3px}
input{flex:1;min-width:0;height:52px;border:0;outline:0;background:transparent;font:inherit;font-size:17px;color:inherit}
input::placeholder{color:#7b8893}
.list{overflow-y:auto;padding:6px 8px 8px;margin:0;list-style:none;overscroll-behavior:contain}
.group{padding:10px 10px 4px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#5c6b77}
.empty{padding:6px 10px 10px;color:#5c6b77}
.opt{margin:0;list-style:none}
.opt a{display:flex;align-items:center;gap:10px;min-height:40px;padding:6px 10px;border-radius:8px;color:inherit;text-decoration:none}
.opt[aria-selected=true] a{background:var(--dnav-accent,#1f6f6b);color:#fff}
.opt .kind{flex:none;min-width:76px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#5c6b77}
.opt[aria-selected=true] .kind{color:rgba(255,255,255,.85)}
.opt .kind svg{vertical-align:-2px;margin-right:4px}
.opt .title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.opt .star{flex:none;color:var(--dnav-accent,#1f6f6b)}
.opt[aria-selected=true] .star{color:#fff}
.hints{display:flex;gap:14px;flex-wrap:wrap;padding:9px 16px;border-top:1px solid #e3e8ec;font-size:12px;color:#5c6b77;background:#f7f9fa}
kbd{font:inherit;font-weight:600}
.toast{position:fixed;z-index:2147483001;left:50%;bottom:20px;transform:translateX(-50%);max-width:calc(100vw - 32px);padding:10px 16px;border-radius:10px;background:#18242e;color:#fff;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25)}
.toast[hidden]{display:none}
.pill{position:fixed;z-index:2147482000;right:14px;bottom:14px;width:40px;height:40px;display:flex;align-items:center;justify-content:center;border:1px solid #d5dde3;border-radius:999px;background:#fff;color:#18242e;box-shadow:0 2px 10px rgba(15,25,35,.15);cursor:pointer;padding:0;font:inherit}
.pill:hover{background:#f1f5f7}
.pill:focus-visible{outline:3px solid var(--dnav-accent,#1f6f6b);outline-offset:2px}
.pill[hidden]{display:none}
@media (pointer:coarse){.pill{width:44px;height:44px}}
@media print{.pill,.scrim,.toast{display:none}}
@media (max-width:600px){.scrim{padding:calc(env(safe-area-inset-top,0px) + 8px) 16px 16px}.panel{width:100%;max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px)}.opt a{min-height:44px}input{font-size:16px}.hints{display:none}}
@media (prefers-reduced-motion:no-preference){.scrim:not([hidden]){animation:fade .12s ease-out}@keyframes fade{from{opacity:0}to{opacity:1}}}
`;

/**
 * The palette's Help group: articles whose title or slug words contain every typed word, at most 5, in corpus
 * order, leaving out slugs already shown under Recently viewed. "help" itself is ignored when other words remain,
 * so "help codex" finds the Codex article. Plain ES5, no backticks or "${" in the code it produces, so it sits in SHELL_JS
 * and tests can run it. The rows carry prefix-free paths (routePath): the shell adds the base where it links.
 */
export const HELP_ROWS_JS = String.raw`
function helpRows(list, tokens, skip) {
  var words = tokens.filter(function (t) { return t !== "help"; }), out = [];
  if (!words.length) words = tokens;
  if (!words.length || !Array.isArray(list)) return out;
  for (var i = 0; i < list.length && out.length < 5; i++) {
    var h = list[i];
    if (!h || typeof h.slug !== "string" || typeof h.title !== "string" || (skip && skip[h.slug])) continue;
    var text = (h.title + " " + h.slug.replace(/-/g, " ")).toLowerCase(), ok = true;
    for (var j = 0; j < words.length; j++) if (text.indexOf(words[j]) < 0) { ok = false; break; }
    if (ok) out.push({ kind: "help", id: h.slug, title: h.title, url: "${routePath("/help/")}" + encodeURIComponent(h.slug) });
  }
  return out;
}
`;

// Plain ES5-style code. It must not contain backticks or ${ so it can sit in a template string. The one exception is
// ${routePath("/x")}: TypeScript evaluates it, and the script receives the prefix-free path, to which appUrl() adds APP_BASE.
const SHELL_JS = String.raw`
(function(){
  if (window.appNav) return;
  var CFG = __CFG__;
  var MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
  var KEY = __RECENTS__ + location.host + APP_BASE + (CFG.user ? ":" + CFG.user : "");
  var CAP = 60;
  var KIND_LABEL = { doc: "Doc", artifact: "Artifact", message: "Post", runbook: "Runbook", audio: "Audio", run: "Run", help: "Help" };
  var GOTO = [
    { label: "Workspace", url: "${routePath("/workspace")}", kw: "projects" },
    { label: "Runbooks", url: "${routePath("/runbooks")}", kw: "guides" },
    { label: "Get started", url: "${routePath("/welcome")}", kw: "welcome onboarding setup checklist connect agents key", tenant: true },
    { label: "Agent homebase", url: "${routePath("/agents")}", kw: "agents providers workforce catalog", tenant: true },
    { label: "Help", url: "${routePath("/help")}", kw: "guide guides articles how to question ask assistant support справка помощь", tenant: true },
    { label: "People", url: "${routePath("/people")}", kw: "members invitations invite team agent access", tenant: true, admin: true },
    { label: "Mentions", url: "${routePath("/mentions")}", kw: "replies" },
    { label: "Inbox", url: "${routePath("/inbox")}", kw: "personal messages", personal: true },
    { label: "Handoffs", url: "${routePath("/workspace?view=handoffs")}", kw: "handoffs" },
    { label: "Docs", url: "${routePath("/toc")}", kw: "documents my documents", personal: true },
    { label: "Artifacts", url: "${routePath("/artifacts")}", kw: "pages widgets my artifacts" },
    { label: "Audio", url: "${routePath("/audio")}", kw: "commute listen back podcast narration" },
    { label: "Settings", url: "${routePath("/settings")}", kw: "account teams profile" }
  ].concat(CFG.commands || []).filter(function (g) { return !(CFG.publicSite && (g.personal || g.tenant)) && !(g.admin && !CFG.canManagePeople); });
  /* Help articles ({slug, title}); empty unless the page said it is not on the public site. */
  var HELP = CFG.publicSite || !Array.isArray(CFG.help) ? [] : CFG.help;
  __HELP_ROWS__

  var favs = [], favMap = {}, favState = "idle", favPromise = null, busy = {};
  var host = null, root = null, els = {}, openState = null;

  function okUrl(u) { return typeof u === "string" && /^\/(?!\/)/.test(u) && u.indexOf("\\") < 0; }
  /* Recents, favorites and the Go to list hold prefix-free app paths; the base is added only where a link is made. */
  function appUrl(u) { return APP_BASE + u; }
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function validEntry(e) { return e && typeof e.id === "string" && typeof e.kind === "string" && typeof e.title === "string" && okUrl(e.url); }

  /* Recently viewed: this browser only. Every storage call can fail (private windows, blocked data). */
  function readRecents() {
    try { var v = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(v) ? v.filter(validEntry) : []; } catch (e) { return []; }
  }
  function writeRecents(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {} }
  function record(entry) {
    if (!entry || !entry.id || !entry.kind || !okUrl(entry.url)) return;
    var title = String(entry.title || "").replace(/\s+/g, " ").trim().slice(0, 160);
    if (!title) return;
    var list = readRecents().filter(function (x) { return !(x.kind === entry.kind && x.id === entry.id); });
    list.unshift({ kind: String(entry.kind), id: String(entry.id), title: title, url: entry.url, at: Date.now() });
    writeRecents(list.slice(0, CAP));
  }

  /* Favorites */
  function request(method, path, body) {
    return fetch(path, { method: method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || j.ok === false) throw new Error(j.error || "Request failed"); return j; }); });
  }
  function rebuildMap() { favMap = {}; favs.forEach(function (f) { favMap[f.key] = f; }); }
  function loadFavs(force) {
    if (favPromise) return favPromise;
    if (favState === "ready" && !force) return Promise.resolve();
    favPromise = request("GET", APP_BASE + "/api/favorites").then(function (j) {
      favs = (j.data && j.data.favorites) || []; rebuildMap(); favState = "ready";
    }).catch(function () { if (favState !== "ready") favState = "error"; }).then(function () { favPromise = null; syncStars(); if (openState) renderList(); });
    return favPromise;
  }
  function starHTML(kind, id, title, reveal) {
    return '<button type="button" class="dnav-star' + (reveal ? " dnav-reveal" : "") + '" data-dnav-star data-kind="' + esc(kind) + '" data-id="' + esc(id) + '" data-title="' + esc(title) + '" aria-pressed="false" aria-label="Favorite ' + esc(title) + '" title="Add to favorites">☆</button>';
  }
  function paintStar(btn, on) {
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.textContent = on ? "★" : "☆";
    btn.title = on ? "Remove from favorites" : "Add to favorites";
  }
  function syncStars(scope) {
    var stars = (scope || document).querySelectorAll ? (scope || document).querySelectorAll("[data-dnav-star]") : [];
    if (stars.length && favState === "idle") { favState = "loading"; loadFavs(true); return; }
    if (favState === "idle" || favState === "loading") return;
    for (var i = 0; i < stars.length; i++) paintStar(stars[i], !!favMap[stars[i].dataset.kind + ":" + stars[i].dataset.id]);
  }
  function paintAll() { syncStars(document); }
  function toggleStar(btn) {
    var kind = btn.dataset.kind, id = btn.dataset.id, key = kind + ":" + id, title = btn.dataset.title || "";
    if (busy[key]) return;
    busy[key] = true;
    var was = btn.getAttribute("aria-pressed") === "true";
    var before = favs.slice();
    if (was) { favs = favs.filter(function (f) { return f.key !== key; }); }
    else { favs = favs.concat([{ kind: kind, item_id: id, key: key, title: title, url: "", position: 1e9 }]); }
    rebuildMap(); paintAll();
    var done = was ? request("DELETE", APP_BASE + "/api/favorites/" + encodeURIComponent(kind) + "/" + encodeURIComponent(id))
                   : request("PUT", APP_BASE + "/api/favorites/" + encodeURIComponent(kind) + "/" + encodeURIComponent(id), { title: title });
    done.then(function (j) {
      if (was) favs = favs.filter(function (f) { return f.key !== key; });
      else if (j.data && j.data.favorite) {
        var found = false;
        favs = favs.map(function (f) { if (f.key === key) { found = true; return j.data.favorite; } return f; });
        if (!found) favs.push(j.data.favorite);
      }
      rebuildMap();
    }).catch(function () {
      favs = before; rebuildMap(); paintAll();
      toast(was ? "Could not remove the favorite. Try again." : "Could not save the favorite. Try again.");
    }).then(function () { delete busy[key]; paintAll(); });
  }

  /* Shadow DOM: palette, toast and the fallback button */
  function ensureHost() {
    if (host) return;
    host = document.createElement("div");
    host.setAttribute("data-dnav-root", "");
    root = host.attachShadow({ mode: "open" });
    var nav = MAC ? "⌘" : "Ctrl+";
    root.innerHTML =
      "<style>" + __SHADOW_CSS__ + "</style>" +
      '<button type="button" class="pill" hidden aria-label="Recents and favorites" title="Recents and favorites (' + nav + 'K)" aria-haspopup="dialog">' + __CLOCK__ + "</button>" +
      '<div class="scrim" hidden><div class="panel" role="dialog" aria-modal="true" aria-label="Open quickly">' +
      '<div class="search"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>' +
      '<input type="text" role="combobox" aria-expanded="true" aria-controls="dnav-list" aria-autocomplete="list" aria-label="Search sections, favorites, recent items and help articles" placeholder="Search" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go"><button type="button" class="close" aria-label="Close"><span aria-hidden="true">×</span></button></div>' +
      '<ul class="list" id="dnav-list" role="listbox" aria-label="Results"></ul>' +
      '<div class="hints"><span><kbd>↩</kbd> open</span><span><kbd>' + nav + '↩</kbd> new tab</span><span><kbd>esc</kbd> close</span></div></div></div>' +
      '<div class="toast" role="status" aria-live="polite" hidden></div>';
    els.pill = root.querySelector(".pill"); els.scrim = root.querySelector(".scrim");
    els.close = root.querySelector(".close");
    els.close.addEventListener("click", function () { closePalette(); });
    els.scrim.addEventListener("keydown", function (e) {
      if (e.key === "Tab" && openState) {
        e.preventDefault();
        (root.activeElement === els.close ? els.input : els.close).focus();
      }
    });
    els.input = root.querySelector("input"); els.list = root.querySelector(".list"); els.toast = root.querySelector(".toast");
    els.pill.addEventListener("click", function () { openPalette(els.pill); });
    els.scrim.addEventListener("mousedown", function (e) { if (e.target === els.scrim) closePalette(); });
    els.input.addEventListener("input", function () { openState.active = 0; renderList(); });
    els.input.addEventListener("keydown", onInputKey);
    els.list.addEventListener("mousemove", function (e) {
      var li = e.target.closest && e.target.closest("[role=option]");
      if (li && openState && openState.active !== Number(li.dataset.index)) { openState.active = Number(li.dataset.index); markActive(false); }
    });
    els.list.addEventListener("click", function (e) {
      var li = e.target.closest && e.target.closest("[role=option]");
      if (!li || !openState) return;
      var item = openState.rows[Number(li.dataset.index)];
      if (item) noteOpened(item);
      closePalette(true);
    });
    document.body.appendChild(host);
  }
  var toastTimer = 0;
  function toast(message) {
    ensureHost();
    els.toast.textContent = message; els.toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { els.toast.hidden = true; }, 3500);
  }

  function match(text, tokens) { var t = text.toLowerCase(); for (var i = 0; i < tokens.length; i++) if (t.indexOf(tokens[i]) < 0) return false; return true; }
  function noteOpened(item) { if (item.id && item.kind) record({ kind: item.kind, id: item.id, title: item.title, url: item.url }); }

  function buildRows() {
    var q = els.input.value.trim().toLowerCase(), tokens = q ? q.split(/\s+/) : [];
    var groups = [];
    if (tokens.length) {
      var go = GOTO.filter(function (g) { return match(g.label + " " + g.kw, tokens); }).map(function (g) { return { kind: "", label: "Go to", title: g.label, url: g.url }; });
      if (go.length) groups.push({ name: "Go to", items: go });
    }
    var fav = favs.filter(function (f) { return okUrl(f.url) && (!tokens.length || match(f.title + " " + (KIND_LABEL[f.kind] || ""), tokens)); })
      .map(function (f) { return { kind: f.kind, id: f.item_id, title: f.title, url: f.url, star: true }; });
    var recents = readRecents().filter(function (r) { return !tokens.length || match(r.title + " " + (KIND_LABEL[r.kind] || ""), tokens); })
      .map(function (r) { return { kind: r.kind, id: r.id, title: r.title, url: r.url, star: !!favMap[r.kind + ":" + r.id] }; });
    var limit = tokens.length ? 30 : 8;
    groups.push({ name: "Favorites", items: fav.slice(0, limit), empty: tokens.length ? "" : (favState === "loading" ? "Loading…" : "No favorites yet. Use the star on any item.") });
    groups.push({ name: "Recently viewed", items: recents.slice(0, tokens.length ? 30 : 10), empty: tokens.length ? "" : "Nothing viewed yet." });
    /* Help comes last, so the person's own favorites and recents stay first. */
    if (tokens.length) {
      var shown = {};
      recents.slice(0, 30).forEach(function (r) { if (r.kind === "help") shown[r.id] = 1; });
      var help = helpRows(HELP, tokens, shown);
      if (help.length) groups.push({ name: "Help", items: help });
    }
    return groups;
  }

  function renderList() {
    if (!openState) return;
    var groups = buildRows(), rows = [], any = false;
    els.list.textContent = "";
    groups.forEach(function (g) {
      if (!g.items.length && !g.empty) return;
      var head = document.createElement("li"); head.className = "group"; head.setAttribute("role", "presentation"); head.textContent = g.name; els.list.appendChild(head);
      if (!g.items.length) { var e = document.createElement("li"); e.className = "empty"; e.setAttribute("role", "presentation"); e.textContent = g.empty; els.list.appendChild(e); return; }
      any = true;
      g.items.forEach(function (item) {
        var index = rows.length; rows.push(item);
        var li = document.createElement("li"); li.className = "opt"; li.setAttribute("role", "option"); li.id = "dnav-opt-" + index; li.dataset.index = String(index);
        var a = document.createElement("a"); a.href = appUrl(item.url); a.tabIndex = -1;
        var kind = document.createElement("span"); kind.className = "kind"; kind.textContent = item.kind ? (KIND_LABEL[item.kind] || item.kind) : "Go to";
        if (item.kind === "help") kind.insertAdjacentHTML("afterbegin", __HELP_ICON__);
        var title = document.createElement("span"); title.className = "title"; title.textContent = item.title;
        a.appendChild(kind); a.appendChild(title);
        if (item.star) { var s = document.createElement("span"); s.className = "star"; s.setAttribute("aria-hidden", "true"); s.textContent = "★"; a.appendChild(s); }
        li.appendChild(a); els.list.appendChild(li);
      });
    });
    if (!any && els.input.value.trim()) {
      var none = document.createElement("li"); none.className = "empty"; none.setAttribute("role", "presentation"); none.textContent = "No match."; els.list.appendChild(none);
    }
    openState.rows = rows;
    if (openState.active >= rows.length) openState.active = Math.max(0, rows.length - 1);
    markActive(true);
  }
  function markActive(scroll) {
    var opts = els.list.querySelectorAll("[role=option]");
    for (var i = 0; i < opts.length; i++) opts[i].setAttribute("aria-selected", i === openState.active ? "true" : "false");
    var cur = opts[openState.active];
    if (cur) { els.input.setAttribute("aria-activedescendant", cur.id); if (scroll) cur.scrollIntoView({ block: "nearest" }); }
    else els.input.removeAttribute("aria-activedescendant");
  }
  function onInputKey(e) {
    if (e.isComposing) return;
    var n = openState.rows.length;
    if (e.key === "ArrowDown") { e.preventDefault(); if (n) { openState.active = (openState.active + 1) % n; markActive(true); } }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (n) { openState.active = (openState.active - 1 + n) % n; markActive(true); } }
    else if (e.key === "Enter") {
      e.preventDefault();
      var item = openState.rows[openState.active];
      if (!item) return;
      noteOpened(item);
      if (e.metaKey || e.ctrlKey) { window.open(appUrl(item.url), "_blank", "noopener"); closePalette(true); }
      else { closePalette(true); location.assign(appUrl(item.url)); }
    }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePalette(); }
  }
  function openPalette(from) {
    ensureHost();
    if (openState) { els.input.focus(); return; }
    openState = { rows: [], active: 0, from: from || document.activeElement };
    els.input.value = ""; els.scrim.hidden = false; els.pill.hidden = true;
    if (favState === "idle") favState = "loading";
    renderList(); els.input.focus();
    loadFavs(true);
  }
  function closePalette(keepFocus) {
    if (!openState) return;
    var from = openState.from; openState = null;
    els.scrim.hidden = true; els.input.value = "";
    if (els.pill && !document.querySelector("[data-dnav-open]")) els.pill.hidden = false;
    if (!keepFocus && from && from.focus && from.isConnected) { try { from.focus(); } catch (e) {} }
  }
  function togglePalette(from) { if (openState) closePalette(); else openPalette(from); }

  /* Wiring */
  window.addEventListener("keydown", function (e) {
    if (e.defaultPrevented) return;
    /* ⌘K on the Mac; Ctrl+K elsewhere. On the Mac, Ctrl+K stays the text "delete to end of line". */
    var paletteChord = /Mac|iPhone|iPad|iPod/.test(navigator.platform || "") ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (paletteChord && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K")) {
      if (document.querySelector("dialog[open]")) return; /* A modal dialog owns the page until it closes. */
      e.preventDefault(); togglePalette(document.activeElement);
    }
    else if (e.key === "Escape" && openState) { closePalette(); }
  });
  document.addEventListener("click", function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    var star = t.closest("[data-dnav-star]");
    if (star) { e.preventDefault(); e.stopPropagation(); toggleStar(star); return; }
    var open = t.closest("[data-dnav-open]");
    if (open) { e.preventDefault(); togglePalette(open); return; }
  }, true);
  function noteLink(e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a || a.origin !== location.origin) return;
    var p = a.pathname;
    if (APP_BASE) { if (p.indexOf(APP_BASE + "/") !== 0) return; p = p.slice(APP_BASE.length); }
    var m = /^\/(?:api\/)?(a|docs|idoc|messages|audio)\/([A-Za-z0-9_-]+)\/?$/.exec(p);
    if (!m) return;
    var holder = a.closest("[data-dnav-title]");
    var title = a.getAttribute("data-dnav-title") || (holder && holder.getAttribute("data-dnav-title")) || "";
    if (!title) return;
    var kind = m[1] === "a" ? "artifact" : m[1] === "messages" ? "message" : m[1] === "audio" ? "audio" : "doc";
    record({ kind: kind, id: m[2], title: title, url: (kind === "artifact" ? "${routePath("/a/")}" : kind === "message" ? "${routePath("/messages/")}" : kind === "audio" ? "${routePath("/audio/")}" : "${routePath("/docs/")}") + m[2] });
  }
  document.addEventListener("click", noteLink, true);
  document.addEventListener("auxclick", noteLink, true);

  function ready() {
    var tip = (MAC ? "⌘" : "Ctrl+") + "K";
    var buttons = document.querySelectorAll("[data-dnav-open]");
    for (var i = 0; i < buttons.length; i++) buttons[i].title = "Recents and favorites (" + tip + ")";
    if (!buttons.length) { ensureHost(); els.pill.hidden = false; }
    if (CFG.item) record(CFG.item);
    syncStars(document);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready); else ready();

  window.appNav = { record: record, starHTML: starHTML, sync: syncStars, open: function () { openPalette(document.activeElement); } };
})();
`;

/** The <style> and <script> that make up the shell. */
export function navShell(options: NavShellOptions = {}): string {
  const accent = options.accent && /^#[0-9a-fA-F]{3,8}$/.test(options.accent) ? options.accent : "";
  const base = basePath({ BASE_PATH: options.base });
  const config = JSON.stringify({ commands: options.commands ?? editionCommands, publicSite: options.publicSite === true, item: options.item ?? null, user: options.userId ?? "", canManagePeople: options.canManagePeople === true, help: options.publicSite === false ? helpPalette() : [], base }).replace(/</g, "\\u003c");
  // The config goes in last: it carries titles, and a title that spells a placeholder must stay text.
  const script = SHELL_JS
    .replace("__HELP_ROWS__", () => HELP_ROWS_JS.trim())
    .replace("__SHADOW_CSS__", () => JSON.stringify(SHADOW_CSS.replace(/\n/g, "")).replace(/</g, "\\u003c"))
    .replace("__CLOCK__", () => JSON.stringify(CLOCK_ICON).replace(/</g, "\\u003c"))
    .replace("__HELP_ICON__", () => JSON.stringify(HELP_ICON).replace(/</g, "\\u003c"))
    .replace(/__RECENTS__/, () => JSON.stringify(`${editionSlug()}.recents.v1:`))
    .replace("__CFG__", () => config);
  const nonce = options.nonce ? ` nonce="${esc(options.nonce)}"` : "";
  const root = accent ? `:root{--dnav-accent:${accent}}` : "";
  return `<style data-dnav>${PAGE_CSS.replace(/\n/g, "")}${root}</style><script${nonce} data-dnav>${clientBase(base)}${script}</script>`;
}

/** Add the shell to a finished HTML response. Other responses pass through unchanged. */
export async function withNavShell(response: Response, options: NavShellOptions = {}): Promise<Response> {
  if (!(response.headers.get("Content-Type") || "").includes("text/html")) return response;
  // A page whose policy allows only nonce scripts needs the shell script to carry that nonce.
  const nonce = options.nonce || /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(response.headers.get("Content-Security-Policy") || "")?.[1];
  const html = await response.text();
  return new Response(injectNavShell(html, nonce ? { ...options, nonce } : options), { status: response.status, headers: new Headers(response.headers) });
}

/** Put the shell right after <body> so window.appNav exists before the page's own scripts run. */
export function injectNavShell(html: string, options: NavShellOptions = {}): string {
  const shell = navShell(options);
  const body = /<body[^>]*>/i.exec(html);
  if (body) return html.slice(0, body.index + body[0].length) + shell + html.slice(body.index + body[0].length);
  return html + shell;
}
