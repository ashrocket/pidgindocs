import type { Env } from "../types";
import { theme } from "./theme";
import { sha256Hex } from "../auth-utils";
import type { ProfileData } from "../routes/profile";

// /profile — account page: canonical email, linked login identities
// (link/unlink), registered push devices (revoke), API key count. Server-
// rendered like every PidginDocs page; mutations go through the session-only JSON
// API with same-origin fetch, so the session cookie authenticates them.
//
// Linking uses the providers' in-page popup/callback modes rather than the
// login page's redirect mode: the providers' cross-site POST back would drop
// our SameSite=Lax session cookie, so a redirect flow could never tell WHICH
// account is linking. In-page credentials + a same-origin fetch keep the
// session attached. Nonce convention matches login: the provider gets
// sha256(nonce), the server gets the raw nonce and re-derives the hash
// (single-use, KV-enforced).

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Profile dates arrive as unix seconds (the wire contract shared with the
// Swift DTOs).
function fmtDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

const PROVIDER_LABELS: Record<string, string> = {
  primary: "Primary",
  apple: "Apple",
  google: "Google",
};

function platformLabel(platform: string): string {
  return platform === "macos" ? "Mac" : "iPhone / iPad";
}

// linkError renders as a visible flash under the link buttons — a failed link
// navigates back here with ?link_error=… so the page re-mints a FRESH nonce
// (the old one was consumed by verifyProviderAssertion even on rejected
// links; retrying with it would 401 "nonce already used").
export async function profilePage(env: Env, profile: ProfileData, linkError?: string): Promise<Response> {
  const origin = env.WORKER_URL || "";
  const rawNonce = crypto.randomUUID();
  const nonceHash = await sha256Hex(rawNonce);

  const identityRows = profile.identities
    .map((i) => {
      const label = PROVIDER_LABELS[i.provider] ?? i.provider;
      const badgeClass = i.primary ? "badge primary" : "badge";
      const meta = i.created_at ? `<span class="dim">linked ${esc(fmtDate(i.created_at))}</span>` : "";
      // User values ride in data attributes (double-quoted, esc()'d attribute
      // context) — never interpolated into JS string literals.
      const action = i.primary
        ? ""
        : `<button class="quiet-btn" data-unlink-email="${esc(i.email)}">Unlink</button>`;
      return `<div class="row">
      <span class="${badgeClass}">${esc(label)}</span>
      <span class="row-main">${esc(i.email)}</span>
      ${meta}
      ${action}
    </div>`;
    })
    .join("\n");

  const deviceRows = profile.devices.length
    ? profile.devices
        .map(
          (d) => `<div class="row">
      <span class="badge">${esc(platformLabel(d.platform))}</span>
      <span class="row-main mono">…${esc(d.token.slice(-8))}</span>
      <span class="dim">registered ${esc(fmtDate(d.created_at))}</span>
      <button class="quiet-btn" data-revoke-token="${esc(d.token)}">Revoke</button>
    </div>`
        )
        .join("\n")
    : `<p class="dim" style="margin:.4rem 0 0">No devices registered. Sign in on the iPhone or Mac app to receive pushes.</p>`;

  const googleLink = env.GOOGLE_WEB_CLIENT_ID
    ? `<script src="https://accounts.google.com/gsi/client" async defer onload="initGoogleLink()"></script>
  <div id="google-link-btn"></div>
  <script>
    function initGoogleLink() {
      google.accounts.id.initialize({
        client_id: ${JSON.stringify(env.GOOGLE_WEB_CLIENT_ID)},
        nonce: ${JSON.stringify(nonceHash)},
        callback: function (resp) { linkIdentity('google', resp.credential); }
      });
      google.accounts.id.renderButton(document.getElementById('google-link-btn'),
        { type: 'standard', size: 'medium', text: 'continue_with', theme: 'outline' });
    }
  </script>`
    : "";

  const appleLink = env.APPLE_WEB_SERVICE_ID
    ? `<script type="text/javascript" src="https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js"></script>
  <button class="link-btn" onclick="linkApple()">Link an Apple ID</button>
  <script>
    AppleID.auth.init({
      clientId: ${JSON.stringify(env.APPLE_WEB_SERVICE_ID)},
      scope: "email",
      redirectURI: ${JSON.stringify(origin + "/auth/oauth/apple/web")},
      nonce: ${JSON.stringify(nonceHash)},
      usePopup: true
    });
    function linkApple() {
      AppleID.auth.signIn().then(function (r) {
        linkIdentity('apple', r.authorization.id_token);
      }).catch(function () { /* user closed the popup */ });
    }
  </script>`
    : "";

  const linkSection =
    googleLink || appleLink
      ? `<div class="link-area">
    <p class="dim" style="margin:0 0 .6rem">Link another sign-in. You will sign in to the other account once to prove you own it.</p>
    <div style="display:flex;gap:.75rem;align-items:center;flex-wrap:wrap">${appleLink}${googleLink}</div>
    <div id="link-error" class="error"${linkError ? "" : ` style="display:none"`}>${linkError ? esc(linkError) : ""}</div>
  </div>`
      : `<p class="dim" style="margin:.6rem 0 0">Web sign-in providers are not configured on this server; link identities from the iPhone or Mac app instead.</p>`;

  return new Response(
    `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Profile · PidginDocs</title>
<style>
  body{font-family:Inter,-apple-system,sans-serif;background:${theme.sand};color:${theme.ink};margin:0;padding:1.5rem}
  main{max-width:720px;margin:0 auto}
  .header{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;flex-wrap:wrap;margin-bottom:1.25rem}
  h1{font-family:Georgia,serif;font-size:1.6rem;margin:0}
  .header-links a{color:${theme.primary};text-decoration:none;margin-left:1.2rem;font-size:.88rem}
  .header-links a:hover{text-decoration:underline}
  .card{background:${theme.paper};border-radius:12px;padding:1.25rem 1.4rem;margin-bottom:1rem;
    box-shadow:0 2px 20px rgba(43,31,24,.08)}
  h2{font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;color:${theme.dim};margin:0 0 .8rem;font-weight:600}
  .who{font-size:1.05rem;font-weight:600}
  .row{display:flex;align-items:center;gap:.75rem;padding:.55rem 0;border-bottom:1px solid ${theme.borderLight};flex-wrap:wrap}
  .row:last-of-type{border-bottom:none}
  .row-main{flex:1;min-width:12ch;overflow-wrap:anywhere}
  .mono{font-family:ui-monospace,Menlo,monospace;font-size:.85rem}
  .badge{font-size:.7rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;
    background:${theme.badgeMessageBg};color:${theme.badgeMessageText};border-radius:999px;padding:.15rem .6rem}
  .badge.primary{background:${theme.badgeAnsweredBg};color:${theme.badgeAnsweredText}}
  .pill{display:inline-block;font-size:.72rem;font-weight:700;border-radius:999px;padding:.15rem .6rem;
    background:${theme.badgeAnsweredBg};color:${theme.badgeAnsweredText};text-transform:capitalize}
  .dim{color:${theme.dim};font-size:.8rem}
  .quiet-btn{border:1px solid ${theme.line};background:${theme.surface};color:${theme.attention};
    border-radius:6px;padding:.3rem .7rem;font-size:.78rem;cursor:pointer}
  .quiet-btn:hover{border-color:${theme.attention}}
  .link-btn{border:1px solid ${theme.line};background:${theme.surface};color:${theme.ink};
    border-radius:6px;padding:.45rem .9rem;font-size:.85rem;cursor:pointer;font-weight:600}
  .link-area{margin-top:.9rem;padding-top:.9rem;border-top:1px solid ${theme.borderLight}}
  .error{color:${theme.error};font-size:.85rem;margin-top:.6rem}
  a{color:${theme.accent}}
</style></head>
<body>
<main>
<div class="header">
  <h1>Profile</h1>
  <div class="header-links"><a href="/inbox">Inbox</a><a href="/toc">Documents</a><a href="/setup">Setup</a><a href="/auth/logout">Logout</a></div>
</div>

<div class="card">
  <h2>Account</h2>
  <div class="who">${esc(profile.user.email)}</div>
  <p class="dim" style="margin:.35rem 0 0">
    <span class="pill">${esc(profile.user.status)}</span>
    &nbsp;member since ${esc(fmtDate(profile.user.created_at))}
    &nbsp;·&nbsp; ${profile.key_count} API key${profile.key_count === 1 ? "" : "s"} — <a href="/setup">manage on Setup</a>
  </p>
</div>

<div class="card">
  <h2>Linked sign-ins</h2>
  ${identityRows}
  ${linkSection}
</div>

<div class="card">
  <h2>Devices</h2>
  ${deviceRows}
</div>
</main>

<script>
  var RAW_NONCE = ${JSON.stringify(rawNonce)};

  function showLinkError(message) {
    var el = document.getElementById('link-error');
    if (!el) { alert(message); return; }
    el.textContent = message;
    el.style.display = 'block';
  }

  function linkIdentity(provider, idToken) {
    fetch('/api/identities', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: provider, id_token: idToken, nonce: RAW_NONCE })
    }).then(function (r) { return r.json(); }).then(function (body) {
      if (body.ok) { location.href = '/profile'; return; }
      // Navigate (don't just show): the nonce is single-use and was consumed
      // even on rejection, so the page must re-render with a fresh one.
      location.href = '/profile?link_error=' + encodeURIComponent(body.error || 'linking failed');
    }).catch(function () {
      location.href = '/profile?link_error=' + encodeURIComponent('linking failed — try again');
    });
  }

  function unlinkIdentity(email) {
    if (!confirm('Unlink ' + email + '? You will no longer be able to sign in with it.')) return;
    fetch('/api/identities', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email })
    }).then(function (r) { return r.json(); }).then(function (body) {
      if (body.ok) location.reload();
      else showLinkError(body.error || 'unlink failed');
    }).catch(function () { showLinkError('unlink failed — check your connection and try again'); });
  }

  function revokeDevice(token) {
    if (!confirm('Revoke this device? It will stop receiving push notifications until the app signs in again.')) return;
    fetch('/api/devices', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token })
    }).then(function (r) { return r.json(); }).then(function (body) {
      if (body.ok) location.reload();
      else showLinkError(body.error || 'revoke failed');
    }).catch(function () { showLinkError('revoke failed — check your connection and try again'); });
  }

  // Delegated handlers: user values reach JS via data attributes, never via
  // inline JS string literals.
  document.addEventListener('click', function (e) {
    var unlink = e.target.closest ? e.target.closest('[data-unlink-email]') : null;
    if (unlink) { unlinkIdentity(unlink.getAttribute('data-unlink-email')); return; }
    var revoke = e.target.closest ? e.target.closest('[data-revoke-token]') : null;
    if (revoke) { revokeDevice(revoke.getAttribute('data-revoke-token')); }
  });
</script>
</body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
