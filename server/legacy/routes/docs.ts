import { Env } from "../types";
import { json } from "../utils";
import { verifySession, resolveApiKeyUser, resolveCallerUserId, unauthorized } from "../middleware";
import { sendOwnerEmail, emailWrapper } from "../email";
import { renderPreviewPng } from "../preview/render";
import { theme } from "../web/theme";

const ONE_HOUR = 60 * 60 * 1000;
const ONE_WEEK = 7 * 24 * ONE_HOUR;

export interface ShareDocData {
  url: string;
  title: string;
  expires_at: string;
  sharing_closes_at: string;
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
  #pidgin-share-link {
    position: fixed;
    bottom: 10px;
    right: 14px;
    font-size: 11px;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    color: rgba(0,0,0,0.3);
    text-decoration: none;
    z-index: 9999;
  }
  #pidgin-share-link:hover { color: rgba(0,0,0,0.55); }
  @media print { #pidgin-share-link { display: none; } }
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

function shareLink(docId: string): string {
  const shareEndpoint = escHtml(`/api/docs/${encodeURIComponent(docId)}/share`);

  return `<a href="#" id="pidgin-share-link" data-share-endpoint="${shareEndpoint}" onclick="(function(e){
  e.preventDefault();
  var link = e.currentTarget;
  var endpoint = link.getAttribute('data-share-endpoint');
  if (!endpoint) { return; }
  link.textContent = '…';
  fetch(endpoint, { method: 'POST', credentials: 'same-origin' })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (!d.ok) { link.textContent = '↗ share'; return; }
      var url = d.data.url;
      if (navigator.share) {
        navigator.share({ title: document.title || 'Document', url: url })
          .then(function(){ link.textContent = '↗ share'; })
          .catch(function(){ link.textContent = '↗ share'; });
      } else {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(url)
            .then(function(){
              link.textContent = '✓ copied';
              setTimeout(function(){ link.textContent = '↗ share'; }, 2000);
            })
            .catch(function(){ link.textContent = '↗ share'; });
        } else {
          link.textContent = 'link ready';
        }
      }
    })
    .catch(function(){ link.textContent = '↗ share'; });
})(event)">↗ share</a>`;
}

const MOBILE_VIEWPORT = `<meta name="viewport" content="width=device-width, initial-scale=1">`;

// Interactive documents execute their scripts, so the CSP is the safety
// boundary instead of the protection wrapper: inline script/style may run,
// but nothing can reach the network (no fetch/XHR/WebSocket, no form posts,
// no external resources) — the page is self-contained or it doesn't work.
const INTERACTIVE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; media-src data: blob:; " +
  "connect-src 'none'; form-action 'none'; base-uri 'none'";

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

function wrapHtml(html: string, docId: string, logEndpoint: string): string {
  const script = protectionScript(docId, logEndpoint);
  const share = shareLink(docId);

  // If the doc is already a complete HTML document, inject into it.
  if (/<html[\s>]/i.test(html)) {
    // Guarantee a mobile viewport even when the authored doc omitted one —
    // otherwise phones render it at ~980px and the text is unreadable.
    const needsViewport = !/<meta[^>]+name=["']viewport["']/i.test(html);
    const headInject = `${needsViewport ? MOBILE_VIEWPORT : ""}${PROTECTION_STYLE}`;
    if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, `${headInject}</head>`);
    } else {
      // Complete <html> with no <head> — create one right after the opening tag.
      html = html.replace(/(<html[^>]*>)/i, `$1<head>${headInject}</head>`);
    }
    html = html.replace(/<\/body>/i, `${share}${script}</body>`);
    return html;
  }

  // Otherwise, wrap as a full mobile-first document
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${MOBILE_VIEWPORT}
${PROTECTION_STYLE}
</head>
<body>
${html}
${share}
${script}
</body>
</html>`;
}

// --- Route handlers ---

interface DocViewRow {
  public: number;
  created_at: string;
  doc_key: string | null;
  body: string | null;
  user_id: string | null;
  interactive: number;
}

// Shared load + authorize for the static and interactive viewers. Returns the
// row, or the Response (404/401) that should be sent instead.
async function loadAuthorizedDoc(
  request: Request,
  env: Env,
  docId: string
): Promise<DocViewRow | Response> {
  const row = await env.DB.prepare(
    "SELECT public, created_at, doc_key, body, user_id, interactive FROM messages WHERE id = ? AND type = 'document'"
  ).bind(docId).first<DocViewRow>();

  if (!row) {
    return json({ ok: false, error: "document not found" }, 404);
  }

  if (row.public !== 1) {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    const expires = url.searchParams.get("expires");

    // 1. Valid signed share link — anyone with the link may view (cross-user).
    let authorized = false;
    if (token && expires) {
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
      if (callerUserId !== row.user_id) {
        return json({ ok: false, error: "document not found" }, 404);
      }
    }
  }

  return row;
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
  ctx: ExecutionContext
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
    return Response.redirect(`${url.origin}/idoc/${docId}${url.search}`, 302);
  }

  const rawHtml = await loadDocHtml(env, row);
  if (!rawHtml) {
    return json({ ok: false, error: "document has no content" }, 404);
  }

  // Log access (non-blocking)
  ctx.waitUntil(logAccess(env, docId, "view", request));

  const workerUrl = env.WORKER_URL || new URL(request.url).origin;
  const wrapped = wrapHtml(rawHtml, docId, `${workerUrl}/api/docs/log`);

  return new Response(wrapped, {
    headers: {
      "Content-Type": "text/html",
      // A document's content never changes for a given message id, so let the
      // owner's device cache it — reopening a doc (or reading offline) is
      // instant instead of a D1 + R2 round trip every time.
      "Cache-Control": isPublic ? "public, max-age=3600" : "private, max-age=86400",
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
  return new Response(rendered, {
    headers: {
      "Content-Type": "text/html",
      "Content-Security-Policy": INTERACTIVE_CSP,
      "Cache-Control": row.public === 1 ? "public, max-age=3600" : "private, max-age=86400",
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
    "SELECT id, title, body, public, doc_key, created_at FROM messages WHERE id = ? AND type = 'document'"
  ).bind(docId).first<{
    id: string;
    title: string;
    body: string | null;
    public: number;
    doc_key: string | null;
    created_at: string;
  }>();

  if (!row) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  const isPublic = row.public === 1;
  let authorized = isPublic;
  if (!authorized && token && expires) {
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
  const description = buildDescription(rawHtml, "Shared via PidginDocs");
  const previewUrl = `${workerUrl}/p/${docId}${url.search}`;
  const contentUrl = isPublic
    ? `${workerUrl}/docs/${docId}`
    : `${workerUrl}/docs/${docId}${url.search}`;
  const ogImage = `${workerUrl}/p/${docId}/og.png${url.search}`;

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
<meta property="og:site_name" content="PidginDocs">
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
    "SELECT title, public FROM messages WHERE id = ? AND type = 'document'"
  ).bind(docId).first<{ title: string; public: number }>();

  if (!row) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  let authorized = row.public === 1;
  if (!authorized) {
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

  const title = row.title || "PidginDocs";

  try {
    const { renderPreviewPng } = await import("../preview/render");
    const png = await renderPreviewPng({ title });
    return new Response(png, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=3600",
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

export async function buildShareDocData(
  env: Env,
  docId: string,
  requestUrl: string | undefined,
  ownerUserId: string
): Promise<ShareDocData> {
  // Scope share-link generation to the caller's OWN doc. Unlike viewing (which
  // has legitimate cross-user paths via public docs and signed links), minting a
  // share link has no cross-user case — you can only share what you own. The
  // user_id filter is in the WHERE here so a foreign id matches no row and falls
  // through to the "document not found" 404, never exposing another user's doc.
  const row = await env.DB.prepare(
    "SELECT id, title, created_at FROM messages WHERE id = ? AND doc_key IS NOT NULL AND user_id = ?"
  ).bind(docId, ownerUserId).first<{ id: string; title: string; created_at: string }>();

  if (!row) {
    throw new Error("document not found");
  }

  const createdAt = parseCreatedAt(row.created_at);
  if (Date.now() > createdAt + ONE_WEEK) {
    throw new Error("sharing window expired (1 week from creation)");
  }

  const expiresAt = Date.now() + ONE_HOUR;
  const token = await signToken(docId, expiresAt, env.DOC_SHARE_SECRET ?? env.API_KEY);
  const workerUrl = env.WORKER_URL || (requestUrl ? new URL(requestUrl).origin : "");
  const shareUrl = `${workerUrl}/p/${docId}?token=${token}&expires=${expiresAt}`;

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
    "SELECT title FROM messages WHERE id = ? AND doc_key IS NOT NULL"
  ).bind(body.doc_id).first<{ title: string }>();
  if (!row) return new Response("ok", { status: 200 });

  const alertEvents: DocEvent[] = ["download_attempt", "screenshot_attempt", "print_attempt", "copy_attempt"];

  ctx.waitUntil(
    (async () => {
      await logAccess(env, body.doc_id!, body.event!, request);
      if (alertEvents.includes(body.event as DocEvent)) {
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
  const sessionEmail = await verifySession(request.headers, env.SESSIONS);
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

  const slug = new URL(request.url).searchParams.get("slug");
  if (!slug) return json({ ok: false, error: "slug required" }, 400);

  const userFilter = "doc_slug = ? AND user_id = ?";

  const rows = await env.DB.prepare(
    `SELECT id, title, doc_version, is_latest, created_at
     FROM messages
     WHERE type = 'document' AND ${userFilter}
     ORDER BY created_at DESC`
  ).bind(slug, userId).all();

  return json({ ok: true, data: rows.results });
}
