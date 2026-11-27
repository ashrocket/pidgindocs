import { contentPolicy } from "../content-policy";
import { checkRateLimit } from "../ratelimit";
import { DIAGRAM_ZOOM, hasDiagram } from "../documents/diagram-zoom";
import { DOCUMENT_CONTENT_CSP as INTERACTIVE_CSP, documentContentCsp } from "../documents/content-security";
import { canReadResource, messageReadSql } from "../workspace-access";
import { Env } from "../types";
import { json } from "../utils";
import { verifySession, resolveApiKeyUser, resolveCallerUserId, unauthorized } from "../middleware";
import { sendOwnerEmail, emailWrapper } from "../email";
import { renderPreviewPng } from "../preview/render";
import { theme } from "../web/theme";
import { contentAttribute, documentBarId, editionSlug, versionBannerId } from "../wire-names";
import { pageHeaders } from "../page-csp";
import { UsageRefused, editionProductName, editionTicketResolver, reserveEditionUsage, editionWorkspaceSignInOnly } from "../edition-hooks";
import { DOCUMENT_FAMILY_SQL, documentFamilyBinds } from "../documents/family";
import { appPath, basePath } from "../base-path";
import { translationLanguages, type Language } from "../translation-languages";
import { operatorReader, type ReaderLabels } from "../documents/operator-reader";
import { linkSegment, linkSegments, requestLinkSegment } from "../short-links";
import { boardTicket, bulletinRules } from "../bulletin-lifecycle";

const ONE_HOUR = 60 * 60 * 1000;
const ONE_WEEK = 7 * 24 * ONE_HOUR;

export interface ShareDocData {
  url: string;
  title: string;
  expires_at: string | null;
  sharing_closes_at: string | null;
}

// --- HMAC token helpers (stateless magic links) ---

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function signToken(docId: string, expiresAt: number, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const data = new TextEncoder().encode(`${docId}:${expiresAt}`);
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyMagicToken(docId: string, expiresAt: number, token: string, secret: string): Promise<boolean> {
  if (Date.now() > expiresAt) return false;
  const expected = await signToken(docId, expiresAt, secret);
  // Constant-time compare (HMAC output is fixed-length, so length check is safe)
  if (token.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

// --- Access logging + email alerts ---

async function logAccess(env: Env, docId: string, event: string, request: Request): Promise<void> {
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
  const ua = request.headers.get("User-Agent") || "unknown";

  await env.DB.prepare(
    "INSERT INTO doc_access_log (doc_id, event, ip, user_agent) VALUES (?, ?, ?, ?)"
  ).bind(docId, event, ip, ua).run();
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function parseCreatedAt(value: string): number {
  const normalized =
    /z$|[+-]\d{2}:\d{2}$/i.test(value) ? value : `${value}Z`;
  return new Date(normalized).getTime();
}

const VALID_EVENTS = ["view", "right_click", "download_attempt", "screenshot_attempt", "print_attempt", "copy_attempt"] as const;
type DocEvent = (typeof VALID_EVENTS)[number];

function isValidEvent(e: string): e is DocEvent {
  return (VALID_EVENTS as readonly string[]).includes(e);
}

async function alertOwner(env: Env, docId: string, event: DocEvent, title: string, request: Request): Promise<void> {
  if (!env.OWNER_EMAIL) return;

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ua = request.headers.get("User-Agent") || "unknown";

  await sendOwnerEmail(
    env,
    `Doc alert: ${event} on "${escHtml(title)}"`,
    emailWrapper(`
      <div style="padding:0 40px 32px;">
        <p style="font-family:Georgia,'Times New Roman',serif;font-size:18px;font-weight:bold;color:${theme.ink};margin:0 0 16px;">${escHtml(event)}</p>
        <p style="font-size:15px;color:${theme.muted};line-height:1.6;margin:0 0 20px;">Detected on document <em>&ldquo;${escHtml(title)}&rdquo;</em></p>
        <table style="font-size:13px;color:${theme.muted};line-height:1.8;border-collapse:collapse;">
          <tr><td style="color:${theme.dim};padding-right:16px;white-space:nowrap;">IP</td><td><code style="background:#F0E1CF;padding:1px 5px;border-radius:3px;">${escHtml(ip)}</code></td></tr>
          <tr><td style="color:${theme.dim};padding-right:16px;white-space:nowrap;">UA</td><td><code style="background:#F0E1CF;padding:1px 5px;border-radius:3px;font-size:11px;">${escHtml(ua)}</code></td></tr>
          <tr><td style="color:${theme.dim};padding-right:16px;white-space:nowrap;">Time</td><td>${new Date().toISOString()}</td></tr>
          <tr><td style="color:${theme.dim};padding-right:16px;white-space:nowrap;">Doc</td><td><code style="background:#F0E1CF;padding:1px 5px;border-radius:3px;">${escHtml(docId)}</code></td></tr>
        </table>
      </div>`)
  );
}

// --- Client-side protection wrapper ---

const PROTECTION_STYLE = `<style>
  body { -webkit-user-select: none; user-select: none; }
  /* Mobile-first defenses: keep even non-responsive docs readable on phones.
     Injected after the doc's own head styles, so element defaults win but a
     doc's intentional higher-specificity rules still take precedence. */
  html { -webkit-text-size-adjust: 100%; }
  img, svg, video, canvas, iframe { max-width: 100%; height: auto; }
  table { max-width: 100%; display: block; overflow-x: auto; }
  pre { max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>`;

function protectionScript(docId: string, logEndpoint: string): string {
  return `<script>
(function() {
  var docId = ${JSON.stringify(docId)};
  var endpoint = ${JSON.stringify(logEndpoint)};

  function report(event) {
    navigator.sendBeacon(endpoint, new Blob([JSON.stringify({ doc_id: docId, event: event })], {type: 'application/json'}));
  }

  // Right-click
  document.addEventListener('contextmenu', function(e) { e.preventDefault(); report('right_click'); });

  // Keyboard shortcuts (Ctrl/Cmd + S, C) — log only; print (P) is allowed
  document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && ['s','c'].includes(e.key.toLowerCase())) {
      e.preventDefault();
      report(e.key.toLowerCase() === 's' ? 'download_attempt' : 'copy_attempt');
    }
    if (e.key === 'PrintScreen') { report('screenshot_attempt'); }
  });

  window.addEventListener('beforeprint', function() { report('print_attempt'); });
})();
</script>`;
}

const MOBILE_VIEWPORT = `<meta name="viewport" content="width=device-width, initial-scale=1">`;

// Interactive documents execute their scripts, so the CSP is the safety
// boundary instead of the protection wrapper: inline script/style may run,
// but nothing can reach the network (no fetch/XHR/WebSocket, no form posts,
// no external resources) — the page is self-contained or it doesn't work.


// Viewport injection only — no protection style/script, which would break
// interactive pages (user-select:none, blocked contextmenu, forced img/table CSS).
function ensureViewport(html: string): string {
  if (/<meta[^>]+name=["']viewport["']/i.test(html)) return html;
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/(<head[^>]*>)/i, `$1${MOBILE_VIEWPORT}`);
  }
  if (/<html[\s>]/i.test(html)) {
    return html.replace(/(<html[^>]*>)/i, `$1<head>${MOBILE_VIEWPORT}</head>`);
  }
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${MOBILE_VIEWPORT}
</head>
<body>
${html}
</body>
</html>`;
}

// Version banner: plain markup and a style block, no script, so it works under
// the document CSP and with the protection wrapper. Colors are explicit so it
// stays readable whatever the document's own theme is.
const versionBannerStyle = (): string => `<style>
  #${versionBannerId()} { display: block; box-sizing: border-box; margin: 0; padding: 8px 16px;
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-align: left;
    color: #1d3a39; background: #eaf2f2; border-bottom: 1px solid #c4d8d7; -webkit-user-select: text; user-select: text; }
  #${versionBannerId()}.${editionSlug()}-version-current { color: #3d4f4f; background: #f6f9f9; border-bottom-color: #e1eaea; }
  #${versionBannerId()} a { color: #1f5554; font-weight: 600; text-decoration: underline; }
  #${versionBannerId()} summary { cursor: pointer; display: list-item; }
  #${versionBannerId()} ol { margin: 6px 0 2px; padding-left: 22px; }
  #${versionBannerId()} li { margin: 2px 0; }
</style>`;

// The thin bar on a document page: the way back to the app, the share page and
// the reader. Like the version banner it is plain markup and a style block, no
// script, so it works under the document sandbox, and its colors are explicit
// so it stays readable whatever the document's own theme is. The sandbox lets
// the page call nothing, so sharing is a link to a first-party page, not a
// request. The bar is fixed, so a document's own body layout cannot move it;
// the root's padding keeps the first lines clear of it. It sits below the
// diagram zoom layer.
const documentBarStyle = (): string => `<style>
  html { box-sizing: border-box; padding-top: 40px; scroll-padding-top: 52px; }
  #${documentBarId()} { position: fixed; top: 0; left: 0; right: 0; z-index: 9998; box-sizing: border-box;
    height: 40px; margin: 0; padding: 0 max(16px, env(safe-area-inset-right)) 0 max(16px, env(safe-area-inset-left));
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: normal; text-transform: none;
    color: #1d3a39; background: #f6f9f9; border-bottom: 1px solid #d5e2e1; }
  #${documentBarId()} div { display: flex; align-items: center; gap: 20px; height: 100%; margin: 0 0 0 auto; padding: 0; }
  #${documentBarId()} a { display: inline-flex; align-items: center; gap: 6px; height: 100%; padding: 0 2px;
    color: #1f5554; font: inherit; text-decoration: none; white-space: nowrap; }
  #${documentBarId()} a:hover { text-decoration: underline; text-underline-offset: 3px; }
  #${documentBarId()} a:focus-visible { outline: 2px solid #1f5554; outline-offset: -6px; border-radius: 8px; }
  #${documentBarId()} [data-narrow] { display: none; }
  @media (max-width: 560px) { #${documentBarId()} [data-wide] { display: none; } #${documentBarId()} [data-narrow] { display: inline; } }
  @media (pointer: coarse) { html { padding-top: 44px; scroll-padding-top: 56px; } #${documentBarId()} { height: 44px; } }
  @media print { html { padding-top: 0; } #${documentBarId()} { display: none; } }
</style>`;

interface DocumentBarInput {
  base: string;
  docId: string;
  language: Language;
  /** A signed-in viewer gets the way back; a share link or a public page names the product instead. */
  signedIn: boolean;
  /** Whoever may ask for a share link: a personal document's owner, or a member reading a team document. */
  canShare: boolean;
  /** The signed link's own token and expiry, so the reader opens for the same viewer. */
  token?: { token: string; expires: string };
}

function documentBar(input: DocumentBarInput, translate?: ReaderLabels): string {
  const label = (key: string) => escHtml(translate ? translate(key, input.language, {}) : key);
  const page = appPath(input.base, `/docs/${encodeURIComponent(input.docId)}`);
  const query = new URLSearchParams({ reader: "1", reader_lang: input.language });
  if (input.token) { query.set("token", input.token.token); query.set("expires", input.token.expires); }
  const product = `<span translate="no">${escHtml(editionProductName())}</span>`;
  // A phone has no room for the long label in every language, so there the product's name stands for it.
  const lead = input.signedIn
    ? `<a href="${escHtml(appPath(input.base, "/workspace"))}"><span aria-hidden="true" translate="no">←</span><span data-wide>${label("Back to workspace")}</span><span data-narrow translate="no">${escHtml(editionProductName())}</span></a>`
    : product;
  const share = input.canShare ? `<a href="${escHtml(`${page}/share?reader_lang=${input.language}`)}">${label("Share")}</a>` : "";
  return `<nav id="${documentBarId()}" aria-label="${label("Document navigation")}">${lead}<div>${share}<a href="${escHtml(`${page}?${query}`)}">${label("Reader view")}</a></div></nav>`;
}

/** The page language: an allowed `reader_lang`, else the first allowed language the browser asks for, else English. */
function pageLanguage(request: Request, env: Env): Language {
  const allowed = translationLanguages(env);
  const wanted = [new URL(request.url).searchParams.get("reader_lang") ?? "",
    ...(request.headers.get("Accept-Language") ?? "").split(",").map(value => value.split(";")[0].trim().toLowerCase().split("-")[0])];
  for (const value of wanted) {
    const match = allowed.find(language => language === value);
    if (match) return match;
  }
  return "en";
}

function wrapHtml(html: string, docId: string, logEndpoint: string, banner = "", base = "", bar = ""): string {
  // The typesetter stores root-relative asset URLs ("/a/assets/mermaid.js", the sound module) in the
  // document. Under a base path they are served at the prefix, so fix them when the page is served.
  if (base) html = html.replace(/"\/a\/assets\//g, '"' + appPath(base, "/a/assets/"));
  const script = protectionScript(docId, logEndpoint);
  const bannerStyle = (bar ? documentBarStyle() : "") + (banner ? versionBannerStyle() : "");
  // The bar is fixed, so its place in the markup only sets reading order: first.
  const lead = bar + banner;
  // Every rendered diagram gets its own zoom, so readers never have to zoom the whole page.
  const zoom = hasDiagram(html) ? DIAGRAM_ZOOM : "";

  // If the doc is already a complete HTML document, inject into it.
  if (/<html[\s>]/i.test(html)) {
    // Guarantee a mobile viewport even when the authored doc omitted one —
    // otherwise phones render it at ~980px and the text is unreadable.
    const needsViewport = !/<meta[^>]+name=["']viewport["']/i.test(html);
    const headInject = `${needsViewport ? MOBILE_VIEWPORT : ""}${PROTECTION_STYLE}${bannerStyle}`;
    if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, `${headInject}</head>`);
    } else {
      // Complete <html> with no <head> — create one right after the opening tag.
      html = html.replace(/(<html[^>]*>)/i, `$1<head>${headInject}</head>`);
    }
    // Function replacements: banner text holds titles, which may contain "$".
    if (lead) {
      html = /<body[^>]*>/i.test(html)
        ? html.replace(/<body[^>]*>/i, (tag) => `${tag}${lead}`)
        : html.replace(/<\/head>/i, (tag) => `${tag}${lead}`);
    }
    html = html.replace(/<\/body>/i, () => `${zoom}${script}</body>`);
    return html;
  }

  // Otherwise, wrap as a full mobile-first document
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${MOBILE_VIEWPORT}
${PROTECTION_STYLE}
${bannerStyle}
</head>
<body>
${lead}
${html}
${zoom}
${script}
</body>
</html>`;
}

interface VersionRow { id: string; doc_version: number | null; title: string; created_at: string }

// Tells the reader where this version sits in its family: an older version
// points at the latest; the latest (v2+) lists the earlier ones. Only versions
// this viewer may open are named, and a share link (one version) gets none.
async function versionBanner(env: Env, docId: string, row: DocViewRow): Promise<string> {
  const version = row.doc_version ?? 1;
  if (row.via_token || row.in_app || (row.is_latest !== 0 && version <= 1)) return "";
  const viewer = row.viewer_id ?? "";
  const rows = await env.DB.prepare(
    `SELECT id, doc_version, title, created_at FROM messages
     WHERE ${DOCUMENT_FAMILY_SQL}
       AND ((public = 1 AND team_id IS NULL AND ? = 1) OR ${messageReadSql("messages")})
     ORDER BY COALESCE(doc_version, 1) DESC, created_at DESC, id DESC LIMIT 50`
  ).bind(
    ...documentFamilyBinds({ id: docId, doc_slug: row.doc_slug, team_id: row.team_id, user_id: row.user_id }),
    editionWorkspaceSignInOnly(env) ? 0 : 1, viewer, viewer
  ).all<VersionRow>();
  const family = rows.results ?? [];
  const latest = family[0];
  if (!latest) return "";
  const latestVersion = latest.doc_version ?? 1;
  if (latest.id !== docId) {
    if (latestVersion <= version) return "";
    return `<aside id="${versionBannerId()}" aria-label="Document version">This is version ${version}. ` +
      `A newer version (v${latestVersion}) of this document exists — ` +
      `<a href="${appPath(env, `/docs/${await linkSegment(env, { kind: "document", id: latest.id })}`)}" aria-label="Open version ${latestVersion}">open it</a></aside>`;
  }
  const earlier = family.slice(1).filter((entry) => (entry.doc_version ?? 1) < version);
  if (version <= 1 || earlier.length === 0) return "";
  const codes = await linkSegments(env, earlier.map((entry) => ({ kind: "document_version" as const, id: entry.id })), true);
  const items = earlier.map((entry) =>
    `<li><a href="${appPath(env, `/docs/${codes.get(`document_version:${entry.id}`)}`)}">Version ${entry.doc_version ?? 1}</a> · ` +
    `<time datetime="${escHtml(entry.created_at)}">${escHtml(entry.created_at.slice(0, 10))}</time>` +
    `${entry.title === latest.title ? "" : ` · ${escHtml(entry.title)}`}</li>`).join("");
  return `<aside id="${versionBannerId()}" class="${editionSlug()}-version-current" aria-label="Document version">` +
    `<details><summary>Version ${version} · earlier versions</summary><ol>${items}</ol></details></aside>`;
}

async function contentTag(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return `"${[...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

// --- Route handlers ---

interface DocViewRow {
  id: string;
  title?: string;
  public: number;
  created_at: string;
  doc_key: string | null;
  body: string | null;
  user_id: string | null;
  team_id: string | null;
  sharing: string;
  interactive: number;
  doc_slug?: string | null;
  doc_version?: number | null;
  is_latest?: number | null;
  // How this request was authorized: a signed link opens one version only.
  via_token?: boolean;
  // The Apple app sends its session as an Authorization header that its web
  // view does not repeat on link taps, and keeps each id's HTML for good. A
  // banner there would go stale and its links would open a 401, so the app's
  // copy has none (it shows versions from doc_version in its own lists).
  in_app?: boolean;
  viewer_id?: string | null;
}

function isAppSessionRequest(request: Request): boolean {
  const cookieSession = /(?:^|;\s*)session=/.test(request.headers.get("Cookie") ?? "");
  return !cookieSession && (request.headers.get("Authorization") ?? "").startsWith("Session ");
}

// Shared load + authorize for the static and interactive viewers. Returns the
// row, or the Response (404/401) that should be sent instead.
async function loadAuthorizedDoc(
  request: Request,
  env: Env,
  docId: string
): Promise<DocViewRow | Response> {
  const row = await env.DB.prepare(
    "SELECT id, title, public, created_at, doc_key, body, user_id, team_id, sharing, interactive, doc_slug, doc_version, is_latest FROM messages WHERE id = ? AND type = 'document'"
  ).bind(docId).first<DocViewRow>();

  if (!row) {
    return json({ ok: false, error: "document not found" }, 404);
  }

  if (row.public !== 1 || row.team_id || editionWorkspaceSignInOnly(env)) {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    const expires = url.searchParams.get("expires");

    // 1. Valid signed share link — anyone with the link may view (cross-user).
    let authorized = false;
    if (token && expires && !row.team_id && !editionWorkspaceSignInOnly(env)) {
      const expiresNum = parseInt(expires, 10);
      if (!isNaN(expiresNum)) {
        authorized = await verifyMagicToken(docId, expiresNum, token, env.DOC_SHARE_SECRET ?? env.API_KEY);
      }
    }
    // 2. Session/api-key auth — the viewer must be authenticated AND the doc
    //    must belong to THEM. Authenticated-but-not-owner is the leak this
    //    closes: scope the private read to the caller's own user_id. A foreign
    //    (or anonymous) request returns the not-found 404 used for unauthorized
    //    access, so we don't leak the existence of another user's private doc.
    if (!authorized) {
      const callerUserId = await resolveCallerUserId(request, env);
      if (!callerUserId) return unauthorized();
      if (!(row.public === 1 && !row.team_id) && !await canReadResource(env, callerUserId, row)) {
        return json({ ok: false, error: "document not found" }, 404);
      }
      return { ...row, viewer_id: callerUserId, in_app: isAppSessionRequest(request) };
    }
    return { ...row, via_token: true };
  }

  return { ...row, in_app: isAppSessionRequest(request) };
}

// Try R2 first, fall back to body content
async function loadDocHtml(env: Env, row: DocViewRow): Promise<string | null> {
  if (row.doc_key) {
    const obj = await env.DOCS.get(row.doc_key);
    if (obj) return obj.text();
  }
  return row.body;
}

export async function handleGetDoc(
  request: Request,
  env: Env,
  docId: string,
  ctx: ExecutionContext,
  readerLabels?: ReaderLabels,
): Promise<Response> {
  const rowOrResponse = await loadAuthorizedDoc(request, env, docId);
  if (rowOrResponse instanceof Response) return rowOrResponse;
  const row = rowOrResponse;
  const isPublic = row.public === 1;

  // Interactive docs live at /idoc/:id — redirect (after authorization, so an
  // unauthorized probe can't distinguish interactive docs) with the query
  // string intact so magic-token links keep working.
  if (row.interactive === 1) {
    const url = new URL(request.url);
    return Response.redirect(`${url.origin}${appPath(env, `/idoc/${requestLinkSegment(request, docId)}`)}${url.search}`, 302);
  }

  const rawHtml = await loadDocHtml(env, row);
  if (!rawHtml) {
    return json({ ok: false, error: "document has no content" }, 404);
  }

  // Log access (non-blocking)
  ctx.waitUntil(logAccess(env, docId, "view", request));

  const workerUrl = env.WORKER_URL || new URL(request.url).origin;
  const requestedReader = new URL(request.url).searchParams.get("reader") === "1";
  const banner = await versionBanner(env, docId, row);
  let wrapped: string;
  let contentSecurity = documentContentCsp(new URL(request.url).origin + appPath(env, "/a/assets/"));
  if (requestedReader) {
    // Authorization above is identical to the original viewer. Source links
    // name only this immutable id and, when used to authorize it, its signed
    // token. Arbitrary caller-supplied return paths are never reflected.
    const sourceQuery = new URLSearchParams();
    if (row.via_token) {
      const params = new URL(request.url).searchParams;
      sourceQuery.set("token", params.get("token")!);
      sourceQuery.set("expires", params.get("expires")!);
    }
    const sourceUrl = appPath(env, `/docs/${encodeURIComponent(docId)}`) + (sourceQuery.size ? `?${sourceQuery}` : "");
    type BoardContext = { project_id: string; parent_project_id: string | null; board_kind: string; seq: number; author: string; original_reference: string | null };
    // Only current team members receive board context; a document grant alone
    // does not expose the originating board's identifiers or author metadata.
    const context = row.viewer_id && row.team_id ? await env.DB.prepare(`
      SELECT e.project_id,p.parent_project_id,p.board_kind,e.seq,a.name AS author,d.original_reference
      FROM agent_board_documents d JOIN agent_board_entries e ON e.id=d.entry_id
      JOIN projects p ON p.id=e.project_id AND p.team_id=e.team_id
      JOIN agent_identities a ON a.id=e.agent_id
      JOIN team_memberships tm ON tm.team_id=e.team_id AND tm.user_id=?
      WHERE d.message_id=? AND e.team_id=?
        AND NOT EXISTS (SELECT 1 FROM agent_board_moderation moderation WHERE moderation.entry_id=e.id)
      LIMIT 1`).bind(row.viewer_id, docId, row.team_id).first<BoardContext>() : null;
    const returnQuery = context ? new URLSearchParams({ project: context.parent_project_id || context.project_id, view: "board", post: String(context.seq) }) : null;
    if (returnQuery && context?.parent_project_id) returnQuery.set("board", context.project_id);
    const ticket = context ? boardTicket(context.original_reference, row.body, bulletinRules(env), await editionTicketResolver(env, row.team_id!)) : null;
    const requestedLanguage = new URL(request.url).searchParams.get("reader_lang") as Language | null;
    const language = requestedLanguage && translationLanguages(env).includes(requestedLanguage) ? requestedLanguage : "en";
    // "View original" keeps a chosen language, so the original's bar reads the same.
    const originalUrl = language === requestedLanguage ? `${sourceUrl}${sourceQuery.size ? "&" : "?"}reader_lang=${language}` : sourceUrl;
    const reader = await operatorReader({ rawHtml, base: basePath(env), language, title: row.title || "Document", sourceUrl: originalUrl,
      returnUrl: appPath(env, "/workspace") + (returnQuery ? `?${returnQuery}` : ""),
      returnLabel: context?.board_kind === "commons" ? "Back to Bulletin" : "Back to workspace",
      author: context?.author, createdAt: row.created_at, ticket: ticket ? { key: ticket.key, url: ticket.appUrl ? appPath(env, ticket.appUrl) : ticket.url } : null,
      versionHtml: banner }, readerLabels);
    wrapped = reader.html;
    contentSecurity = reader.csp;
  } else {
    // The Apple app shows a document inside its own navigation and its web view
    // does not repeat the session header on link taps, so its copy has no bar.
    const params = new URL(request.url).searchParams;
    const bar = row.in_app ? "" : documentBar({ base: basePath(env), docId, language: pageLanguage(request, env), signedIn: !!row.viewer_id,
      canShare: !!row.viewer_id && (!!row.team_id || row.user_id === row.viewer_id),
      token: row.via_token ? { token: params.get("token")!, expires: params.get("expires")! } : undefined }, readerLabels);
    wrapped = wrapHtml(rawHtml, docId, `${workerUrl}/api/docs/log`, banner, basePath(env), bar);
  }
  // A document's content never changes for a given id, but its version banner
  // does once a newer version is published. Devices keep a copy briefly and
  // then revalidate: an unchanged page is a 304 with no transfer charged.
  const cacheControl = requestedReader || row.team_id || editionWorkspaceSignInOnly(env)
    ? "private, no-store"
    : isPublic ? "public, max-age=300, stale-while-revalidate=3600" : "private, max-age=300, stale-while-revalidate=86400";
  // The bar's labels follow the browser's language when the address names none.
  const vary: Record<string, string> = requestedReader ? {} : { Vary: "Accept-Language" };
  const etag = await contentTag(wrapped);
  if (request.headers.get("If-None-Match")?.split(/\s*,\s*/).some((tag) => tag.replace(/^W\//, "") === etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": cacheControl, ...vary } });
  }

  if (row.user_id) {
    try {
      await reserveEditionUsage(
        env,
        row.user_id,
        "transfer_bytes",
        new TextEncoder().encode(wrapped).byteLength,
        `doc:${docId}:transfer:${crypto.randomUUID()}`
      );
    } catch (error) {
      if (error instanceof UsageRefused) {
        return json({ ok: false, error: error.message }, error.status);
      }
      throw error;
    }
  }

  return new Response(wrapped, {
    headers: {
      // The exact size, so an edition's transfer meter can count the download without reading the body.
      "Content-Length": String(new TextEncoder().encode(wrapped).byteLength),
      "Content-Type": "text/html",
      // Typeset documents link this host's /a/assets/ scripts (mermaid, the
      // sound module); the sandboxed page can load those and nothing else.
      "Content-Security-Policy": contentSecurity,
      "Referrer-Policy": "no-referrer",
      "Cache-Control": cacheControl,
      ETag: etag,
      ...vary,
    },
  });
}

// Interactive document viewer — /idoc/:id. Serves the stored HTML without the
// protection wrapper so its scripts actually run (Claude-artifact-style pages:
// self-contained HTML+JS), gated by the same auth ladder as /docs/:id and
// fenced by INTERACTIVE_CSP instead.
export async function handleGetInteractiveDoc(
  request: Request,
  env: Env,
  docId: string,
  ctx: ExecutionContext
): Promise<Response> {
  const rowOrResponse = await loadAuthorizedDoc(request, env, docId);
  if (rowOrResponse instanceof Response) return rowOrResponse;
  const row = rowOrResponse;

  // Static docs are not served here — the wrapper-free path is opt-in at
  // publish time, never something a URL swap can grant.
  if (row.interactive !== 1) {
    return json({ ok: false, error: "document not found" }, 404);
  }

  const rawHtml = await loadDocHtml(env, row);
  if (!rawHtml) {
    return json({ ok: false, error: "document has no content" }, 404);
  }

  ctx.waitUntil(logAccess(env, docId, "view", request));

  const rendered = ensureViewport(rawHtml);
  if (row.user_id) {
    try {
      await reserveEditionUsage(
        env,
        row.user_id,
        "transfer_bytes",
        new TextEncoder().encode(rendered).byteLength,
        `idoc:${docId}:transfer:${crypto.randomUUID()}`
      );
    } catch (error) {
      if (error instanceof UsageRefused) {
        return json({ ok: false, error: error.message }, error.status);
      }
      throw error;
    }
  }

  return new Response(rendered, {
    headers: {
      "Content-Length": String(new TextEncoder().encode(rendered).byteLength),
      "Content-Type": "text/html",
      "Content-Security-Policy": INTERACTIVE_CSP,
      "Cache-Control": row.team_id || editionWorkspaceSignInOnly(env) ? "private, no-store" : row.public === 1 ? "public, max-age=3600" : "private, max-age=86400",
    },
  });
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildDescription(html: string | null, fallback: string): string {
  if (!html) return fallback;
  const text = stripHtml(html);
  if (!text) return fallback;
  const snippet = text.slice(0, 200);
  return text.length > 200 ? snippet.replace(/\s\S*$/, "") + "…" : snippet;
}

const BOT_UA_PATTERN =
  /facebookexternalhit|facebot|twitterbot|slackbot|linkedinbot|discordbot|whatsapp|telegrambot|skypeuripreview|pinterest|redditbot|embedly|vkshare|w3c_validator|bingpreview|mastodon|applebot|googlebot|bitlybot|quora|yandexbot/i;

function isSocialCrawler(request: Request): boolean {
  const ua = request.headers.get("User-Agent") || "";
  return BOT_UA_PATTERN.test(ua);
}

// Public preview endpoint — returns OG/Twitter Card meta tags for social crawlers,
// and redirects humans to the actual authenticated document URL.
export async function handlePreviewDoc(
  request: Request,
  env: Env,
  docId: string
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const expires = url.searchParams.get("expires");

  const row = await env.DB.prepare(
    "SELECT id, title, body, public, doc_key, created_at, user_id, team_id, sharing FROM messages WHERE id = ? AND type = 'document'"
  ).bind(docId).first<{
    sharing: string;
    id: string;
    title: string;
    body: string | null;
    public: number;
    doc_key: string | null;
    created_at: string;
    user_id: string | null;
    team_id: string | null;
  }>();

  if (!row) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  const isPublic = row.public === 1 && !row.team_id && !editionWorkspaceSignInOnly(env);
  const restricted = !!row.team_id || editionWorkspaceSignInOnly(env);
  const caller = restricted ? await resolveCallerUserId(request, env) : null;
  let authorized = restricted ? (!!caller && ((!row.team_id && row.public === 1) || await canReadResource(env, caller, row))) : isPublic;
  if (!authorized && !restricted && token && expires) {
    const expiresNum = parseInt(expires, 10);
    if (!isNaN(expiresNum)) {
      authorized = await verifyMagicToken(docId, expiresNum, token, env.DOC_SHARE_SECRET ?? env.API_KEY);
    }
  }
  if (!authorized) {
    return new Response("Link expired or invalid", {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Pull a snippet from R2-stored HTML (or body fallback) for the og:description
  let rawHtml: string | null = row.body;
  if (row.doc_key) {
    const obj = await env.DOCS.get(row.doc_key);
    if (obj) rawHtml = await obj.text();
  }

  const workerUrl = env.WORKER_URL || new URL(request.url).origin;
  const title = row.title || "Shared document";
  const description = buildDescription(rawHtml, `Shared via ${editionProductName()}`);
  const linkId = requestLinkSegment(request, docId);
  const previewUrl = `${workerUrl}/p/${linkId}${url.search}`;
  const contentUrl = isPublic
    ? `${workerUrl}/docs/${linkId}`
    : `${workerUrl}/docs/${linkId}${url.search}`;
  const ogImage = `${workerUrl}/p/${linkId}/og.png${url.search}`;

  const escTitle = escHtml(title);
  const escDesc = escHtml(description);
  const escPreviewUrl = escHtml(previewUrl);
  const escContentUrl = escHtml(contentUrl);
  const escImage = escHtml(ogImage);

  const isBot = isSocialCrawler(request);

  const head = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escTitle}</title>
<meta name="description" content="${escDesc}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${editionProductName()}">
<meta property="og:title" content="${escTitle}">
<meta property="og:description" content="${escDesc}">
<meta property="og:url" content="${escPreviewUrl}">
<meta property="og:image" content="${escImage}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escTitle}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escTitle}">
<meta name="twitter:description" content="${escDesc}">
<meta name="twitter:image" content="${escImage}">
<link rel="canonical" href="${escPreviewUrl}">`;

  // Bots just read meta tags; humans get redirected to the real doc.
  const body = isBot
    ? `<h1>${escTitle}</h1><p>${escDesc}</p>`
    : `<meta http-equiv="refresh" content="0;url=${escContentUrl}">
<style>body{font-family:-apple-system,sans-serif;background:#FBF7F0;color:${theme.ink};display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:2rem;text-align:center}.card{background:#fff;padding:2rem;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.06);max-width:480px}h1{font-family:Georgia,serif;margin:0 0 .75rem;font-size:1.35rem}p{color:${theme.dim};margin:0 0 1rem}a{color:${theme.accent};text-decoration:none;font-weight:600}</style>
<div class="card"><h1>${escTitle}</h1><p>Opening document…</p><a href="${escContentUrl}">Tap here if the page does not load.</a></div>
<script>window.location.replace(${JSON.stringify(contentUrl)});</script>`;

  return new Response(
    `<!DOCTYPE html><html lang="en"><head>${head}</head><body>${body}</body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": isPublic ? "public, max-age=600" : "private, no-store",
      },
    }
  );
}

// PNG preview image rendered via satori + resvg — used as og:image. Gated
// exactly like handlePreviewDoc (public docs, or a valid signed share token):
// the route comment in index.ts has always called this "public, token-gated",
// but until now the handler ignored the request entirely and rendered any
// document's title for anyone who knew (or guessed) its id.
export async function handlePreviewImage(
  request: Request,
  env: Env,
  docId: string
): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT id, title, public, user_id, team_id, sharing FROM messages WHERE id = ? AND type = 'document'"
  ).bind(docId).first<{ id: string; title: string; public: number; user_id: string | null; team_id: string | null; sharing: string }>();

  if (!row) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  const restricted = !!row.team_id || editionWorkspaceSignInOnly(env);
  const caller = restricted ? await resolveCallerUserId(request, env) : null;
  let authorized = restricted ? (!!caller && ((!row.team_id && row.public === 1) || await canReadResource(env, caller, row))) : row.public === 1;
  if (!authorized && !restricted) {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    const expires = url.searchParams.get("expires");
    if (token && expires) {
      const expiresNum = parseInt(expires, 10);
      if (!isNaN(expiresNum)) {
        authorized = await verifyMagicToken(docId, expiresNum, token, env.DOC_SHARE_SECRET ?? env.API_KEY);
      }
    }
  }
  if (!authorized) {
    return new Response("Link expired or invalid", {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const title = row.title || editionProductName();

  try {
    const { renderPreviewPng } = await import("../preview/render");
    const png = await renderPreviewPng({ title });
    return new Response(png, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": restricted ? "private, no-store" : "public, max-age=3600",
      },
    });
  } catch (err) {
    console.error("preview render failed", err);
    return new Response("preview render failed", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

// Generate a magic link for a doc (enforces 1-week window from creation)
// Accepts API key auth OR session auth (for browser-based TOC)
export async function handleShareDoc(
  request: Request,
  env: Env,
  docId: string
): Promise<Response> {
  // Resolve the caller's user id (session OR api key). Share-link generation is
  // owner-only, so we need the id — not just "is authenticated" — to scope the
  // SELECT in buildShareDocData to the caller's own doc.
  const callerUserId = await resolveCallerUserId(request, env);
  if (!callerUserId) {
    return unauthorized();
  }

  try {
    const data = await buildShareDocData(env, docId, request.url, callerUserId);
    return json({ ok: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "share generation failed";
    const status =
      message === "document not found"
        ? 404
        : message === "sharing window expired (1 week from creation)"
        ? 403
        : 500;
    return json({ ok: false, error: message }, status);
  }
}

// What buildShareDocData refuses, and the status a page gives for each. Its other errors are faults.
const SHARE_REFUSALS: Record<string, number> = {
  "document not found": 404,
  "sharing window expired (1 week from creation)": 403,
  "Publish to team before sharing this private document link.": 403,
};

const SHARE_PAGE_STYLE = `
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: ${theme.surface}; color: ${theme.ink}; }
  main { width: min(100%, 520px); background: ${theme.paper}; border: 1px solid #d5e2e1; border-radius: 12px; padding: 28px; box-sizing: border-box; }
  h1 { margin: 0 0 4px; font-size: 22px; line-height: 1.25; }
  p { margin: 0 0 16px; color: ${theme.muted}; overflow-wrap: anywhere; }
  input { display: block; box-sizing: border-box; width: 100%; min-height: 44px; margin: 0 0 12px; padding: 10px 12px; font: 14px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
    color: ${theme.ink}; background: ${theme.surface}; border: 1px solid #c4d8d7; border-radius: 8px; }
  button { min-height: 44px; margin: 0 8px 16px 0; padding: 10px 16px; font: inherit; font-weight: 600; font-size: 15px; line-height: 1.2; color: #fff; background: ${theme.primary};
    border: 1px solid ${theme.primary}; border-radius: 8px; cursor: pointer; }
  button[data-share] { color: ${theme.primary}; background: ${theme.paper}; }
  a { display: inline-flex; align-items: center; min-height: 44px; color: ${theme.accent}; font-weight: 600; }
  :focus-visible { outline: 3px solid ${theme.accent}; outline-offset: 2px; }
  p[role=status]:empty { margin: 0; }
  [hidden] { display: none; }
`;

// Copies with the clipboard where the browser has one; otherwise it selects the link for a manual copy.
const SHARE_PAGE_SCRIPT = `
  const field = document.querySelector("input"), state = document.querySelector("[role=status]");
  const copy = document.querySelector("button[data-copy]"), send = document.querySelector("button[data-share]");
  const select = () => { field.focus(); field.select(); state.textContent = copy.dataset.select; };
  copy.addEventListener("click", () => { if (!navigator.clipboard) return select(); navigator.clipboard.writeText(field.value).then(() => { state.textContent = copy.dataset.copied; }, select); });
  field.addEventListener("focus", () => field.select());
  if (navigator.share) { send.hidden = false; send.addEventListener("click", () => { navigator.share({ title: send.dataset.title, url: field.value }).catch(() => {}); }); }
`;

// The share page — GET /docs/:id/share. A document page is sandboxed and can
// call nothing, so its bar links here: a first-party page that makes the link
// for the signed-in viewer and shows it, under the same rules as the API.
export async function handleSharePage(request: Request, env: Env, docId: string, readerLabels?: ReaderLabels): Promise<Response> {
  const callerUserId = await resolveCallerUserId(request, env);
  if (!callerUserId) return unauthorized();
  const language = pageLanguage(request, env);
  const label = (key: string) => escHtml(readerLabels ? readerLabels(key, language, {}) : key);
  let data: ShareDocData | null = null;
  let refusal = "";
  let status = 200;
  try {
    data = await buildShareDocData(env, docId, request.url, callerUserId);
  } catch (error) {
    refusal = error instanceof Error ? error.message : "";
    status = SHARE_REFUSALS[refusal] ?? 500;
    if (status === 500) { console.error(error); refusal = "share generation failed"; }
  }
  const nonce = crypto.randomUUID().replaceAll("-", "");
  // A language the address chose goes back with the reader, so the document's bar reads the same.
  const chosen = new URL(request.url).searchParams.get("reader_lang") === language ? `?reader_lang=${language}` : "";
  const back = `<a href="${escHtml(appPath(env, `/docs/${encodeURIComponent(docId)}`) + chosen)}">${label("Back to document")}</a>`;
  const body = data
    ? `<p ${contentAttribute()}>${escHtml(data.title)}</p>
<input type="text" readonly value="${escHtml(data.url)}" aria-label="${label("Share link")}" translate="no">
<button type="button" data-copy data-copied="${label("Copied")}" data-select="${label("Select the link and copy it.")}">${label("Copy link")}</button><button type="button" data-share data-title="${escHtml(data.title)}" hidden>${label("Share")}</button>
<p role="status"></p>
<p>${label(data.expires_at ? "Anyone with this link can read this document for one hour." : "Only people who can already read this document can open this link.")}</p>
${back}<script nonce="${nonce}">${SHARE_PAGE_SCRIPT}</script>`
    : `<p role="alert">${label(refusal)}</p>${back}`;
  const html = `<!DOCTYPE html><html lang="${language}"><head><meta charset="utf-8">${MOBILE_VIEWPORT}<title>${label("Share link")} · ${escHtml(editionProductName())}</title><style>${SHARE_PAGE_STYLE}</style></head><body><main><h1>${label("Share link")}</h1>${body}</main></body></html>`;
  // The page can hold a link that opens the document for anyone, so nothing keeps a copy of it.
  return new Response(html, { status, headers: { ...pageHeaders(nonce), "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
}

export async function buildShareDocData(
  env: Env,
  docId: string,
  requestUrl: string | undefined,
  ownerUserId: string
): Promise<ShareDocData> {
  // Personal links require ownership; team URLs require current read access
  // and retain that check for every visitor. They never mint a bearer token.
  const row = await env.DB.prepare(
    `SELECT id, title, created_at, user_id, team_id, sharing, type,
      ${contentPolicy().documentSharedSql?.("messages") ?? "0"} AS role_shared
      FROM messages WHERE id = ? AND doc_key IS NOT NULL AND ${messageReadSql("messages")}`
  ).bind(docId, ownerUserId, ownerUserId).first<{ id: string; title: string; created_at: string; user_id: string; team_id: string | null; sharing: string; type: string; role_shared: number }>();

  if (!row) {
    throw new Error("document not found");
  }

  if (row.team_id && row.sharing !== "shared" && !row.role_shared) throw new Error("Publish to team before sharing this private document link.");
  if (row.team_id || editionWorkspaceSignInOnly(env)) {
    if (!await canReadResource(env, ownerUserId, row)) throw new Error("document not found");
    const origin = env.WORKER_URL || (requestUrl ? new URL(requestUrl).origin : "");
    return { url: `${origin}/docs/${await linkSegment(env, { kind: "document", id: docId })}`, title: row.title, expires_at: null, sharing_closes_at: null };
  }
  const createdAt = parseCreatedAt(row.created_at);
  if (Date.now() > createdAt + ONE_WEEK) {
    throw new Error("sharing window expired (1 week from creation)");
  }

  const expiresAt = Date.now() + ONE_HOUR;
  const token = await signToken(docId, expiresAt, env.DOC_SHARE_SECRET ?? env.API_KEY);
  const workerUrl = env.WORKER_URL || (requestUrl ? new URL(requestUrl).origin : "");
  const shareUrl = `${workerUrl}/p/${await linkSegment(env, { kind: "document_version", id: docId })}?token=${token}&expires=${expiresAt}`;

  return {
    url: shareUrl,
    title: row.title,
    expires_at: new Date(expiresAt).toISOString(),
    sharing_closes_at: new Date(createdAt + ONE_WEEK).toISOString(),
  };
}

// Client-side event logging endpoint (beacon)
export async function handleDocLog(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  let body: { doc_id?: string; event?: string };
  try {
    body = (await request.json()) as { doc_id?: string; event?: string };
  } catch {
    return new Response("ok", { status: 200 });
  }

  if (!body.doc_id || !body.event || !isValidEvent(body.event)) {
    return new Response("ok", { status: 200 });
  }

  // Verify doc exists before logging (prevents junk rows)
  const row = await env.DB.prepare(
    "SELECT id, title, user_id, team_id, public, sharing, type FROM messages WHERE id = ? AND doc_key IS NOT NULL"
  ).bind(body.doc_id).first<{ id: string; title: string; user_id: string | null; team_id: string | null; public: number; sharing: string; type: string }>();
  if (!row) return new Response("ok", { status: 200 });
  if (row.team_id || editionWorkspaceSignInOnly(env)) {
    const caller = await resolveCallerUserId(request, env);
    if (!caller || ((row.team_id || row.public !== 1) && !await canReadResource(env, caller, row))) return unauthorized();
  }

  const alertEvents: DocEvent[] = ["download_attempt", "screenshot_attempt", "print_attempt", "copy_attempt"];

  ctx.waitUntil(
    (async () => {
      await logAccess(env, body.doc_id!, body.event!, request);
      if (alertEvents.includes(body.event as DocEvent) && await checkRateLimit(env, `doc-alert:${body.doc_id}`, 5, 3600)) {
        await alertOwner(env, body.doc_id!, body.event as DocEvent, row.title, request);
      }
    })()
  );

  return new Response("ok", { status: 200 });
}

// Version history for a doc family identified by doc_slug
export async function handleGetDocVersions(
  request: Request,
  env: Env
): Promise<Response> {
  const sessionEmail = await verifySession(request.headers, env.SESSIONS, env);
  let userId: string | null = null;

  if (sessionEmail) {
    const u = await env.DB.prepare(
      "SELECT id, email FROM users WHERE email = ? AND status = 'active'"
    ).bind(sessionEmail.toLowerCase()).first<{ id: string; email: string }>();
    if (!u) return unauthorized();
    userId = u.id;
  } else {
    const authedUser = await resolveApiKeyUser(request.headers, env);
    if (!authedUser) return unauthorized();
    userId = authedUser.userId;
  }

  // A version family is a slug within one audience (see DOCUMENT_FAMILY_SQL),
  // so the list is resolved from one document: ?id= (any version's id), or a
  // ?slug= that names exactly one family this caller can read.
  const params = new URL(request.url).searchParams;
  const id = params.get("id");
  const slug = params.get("slug");
  if (!id && !slug) return json({ ok: false, error: "id or slug required" }, 400);

  type Anchor = { sharing: string; id: string; doc_slug: string | null; team_id: string | null; user_id: string | null };
  let anchor: Anchor | null;
  if (id) {
    anchor = await env.DB.prepare("SELECT id, doc_slug, team_id, user_id, sharing FROM messages WHERE id = ? AND type = 'document'")
      .bind(id).first<Anchor>();
    if (!anchor || !await canReadResource(env, userId, anchor)) return json({ ok: false, error: "document not found" }, 404);
  } else {
    const candidates = (await env.DB.prepare(
      `SELECT id, doc_slug, team_id, user_id, sharing FROM messages
       WHERE type = 'document' AND (doc_slug = ? OR (doc_slug IS NULL AND id = ?)) AND ${messageReadSql("messages")}
       ORDER BY created_at ASC LIMIT 200`
    ).bind(slug, slug, userId, userId).all<Anchor>()).results ?? [];
    const audiences = new Set(candidates.map((row) => row.team_id ? `team:${row.team_id}` : `user:${row.user_id}`));
    if (audiences.size > 1) {
      return json({ ok: false, error: "this slug names more than one document you can read; pass id instead" }, 400);
    }
    anchor = candidates[0] ?? null;
    if (!anchor) return json({ ok: true, data: [] });
  }

  const rows = await env.DB.prepare(
    `SELECT id, title, doc_version, is_latest, created_at
     FROM messages
     WHERE ${DOCUMENT_FAMILY_SQL} AND ${messageReadSql("messages")}
     ORDER BY COALESCE(doc_version, 1) DESC, created_at DESC`
  ).bind(...documentFamilyBinds(anchor), userId, userId).all();

  return json({ ok: true, data: rows.results });
}
