// The OAuth consent page.
//
// The page shows which client asks for access, where the code goes and which
// scopes it asks for. It holds a single-use request id, so these headers keep
// other pages from reading it: no frames (frame-ancestors and
// X-Frame-Options), no script, and no store in a cache. The opener policy
// "same-origin-allow-popups" puts this page in its own browsing context group
// when another page opened it, so that page keeps no window handle to it.
// The buttons take clicks only after a short delay. Then a page that opens
// this page under the pointer cannot turn a double click into Allow.
// There is no form-action: after Allow or Deny, the browser follows a
// redirect to the client, and form-action would block that redirect.
import { theme } from "./theme";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
};

const SCOPE_TEXT: Record<string, string> = {
  mcp: "Use PidginDocs as you through its agent tools: your messages, documents and artifacts.",
  offline_access: "Stay connected after this sign-in, with a refresh token.",
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// Where the client gets the code. A loopback address is a program on the
// computer that opened this page.
function redirectTarget(redirectUri: string): string {
  try {
    const url = new URL(redirectUri);
    if (LOOPBACK_HOSTS.has(url.hostname)) return `a program on this computer (${url.host})`;
    if (url.protocol === "http:" || url.protocol === "https:") return url.host;
    return url.host ? `${url.protocol}//${url.host}` : url.protocol;
  } catch {
    return redirectUri;
  }
}

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · PidginDocs</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:${theme.sand};
    color:${theme.ink};display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:16px}
  .card{background:${theme.paper};border:1px solid ${theme.line};border-radius:8px;padding:2rem;max-width:440px;width:100%}
  h1{font-size:1.5rem;line-height:1.2;margin:0 0 1rem}
  p,li{color:${theme.muted};font-size:.95rem;line-height:1.5}
  p{margin:0 0 1rem}
  ul{margin:0 0 1.25rem;padding-left:1.2rem}
  strong{color:${theme.ink};overflow-wrap:anywhere}
  .warn{color:${theme.attention}}
  .actions{display:flex;gap:.75rem;animation:arm .8s step-end both}
  @keyframes arm{from{pointer-events:none}}
  button{flex:1;padding:.75rem;border-radius:6px;font-size:.95rem;font-weight:600;cursor:pointer;
    border:1px solid ${theme.primary}}
  .allow{background:${theme.primary};color:${theme.paper}}
  .deny{background:${theme.surface};color:${theme.ink}}
</style></head><body><div class="card">${body}</div></body></html>`,
    { status, headers: PAGE_HEADERS }
  );
}

export interface ConsentPageInput {
  requestId: string;
  clientName?: string;
  redirectUri: string;
  scope: string;
  email: string;
}

export function oauthConsentPage(input: ConsentPageInput): Response {
  const name = input.clientName?.trim() ? input.clientName.trim() : "An app with no name";
  const scopes = input.scope.split(/\s+/).filter(Boolean);
  const scopeItems = scopes
    .map((scope) => `<li>${esc(SCOPE_TEXT[scope] ?? `Scope "${scope}"`)}</li>`)
    .join("");
  return page(
    "Allow access?",
    `<h1>Allow access to your PidginDocs account?</h1>
<p><strong>${esc(name)}</strong> asks to use the PidginDocs account <strong>${esc(input.email)}</strong>.
The app gave this name itself.</p>
<p>PidginDocs sends the access code to <strong>${esc(redirectTarget(input.redirectUri))}</strong>.</p>
<p>It asks to:</p>
<ul>${scopeItems}</ul>
<p class="warn">Allow only if you started this sign-in yourself.</p>
<form method="POST" action="/oauth/consent">
  <input type="hidden" name="request_id" value="${esc(input.requestId)}">
  <div class="actions">
    <button class="deny" type="submit" name="decision" value="deny">Deny</button>
    <button class="allow" type="submit" name="decision" value="allow">Allow</button>
  </div>
</form>`
  );
}

export function oauthConsentExpiredPage(status = 400): Response {
  return page(
    "Sign-in expired",
    `<h1>This sign-in request expired</h1>
<p>The request is not valid now, or you used it already. Go back to the app or agent and start the sign-in again.</p>`,
    status
  );
}
