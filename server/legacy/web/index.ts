import type { CommuteBriefingListItem } from "../commute/store";
import type { SetupStatus } from "../setup/status";
import type { Env } from "../types";
import { sha256Hex, encodeOAuthWebState } from "../auth-utils";
import { compileDesignSystem } from "../documents/design-system";
import { BUILTIN_DESIGN_SYSTEMS } from "../documents/styles";
import { theme } from "./theme";

export function walkTopicPage(): Response {
  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Walk Topic</title>
<style>
  :root{
    --sand:${theme.sand};
    --paper:${theme.paper};
    --ink:${theme.ink};
    --muted:${theme.muted};
    --forest:${theme.primary};
    --deep:${theme.ink};
    --foam:#E5EDD8;
    --line:${theme.line};
  }
  *{box-sizing:border-box}
  body{
    margin:0;
    font-family:Inter,-apple-system,sans-serif;
    color:var(--ink);
    background:
      radial-gradient(circle at top right, rgba(90,107,58,.15), transparent 22%),
      linear-gradient(180deg, #EFE4CC 0%, ${theme.sand} 52%, #E0D4BC 100%);
    min-height:100vh;
  }
  main{max-width:860px;margin:0 auto;padding:48px 24px 72px}
  .shell{
    background:rgba(250,244,232,.92);
    border:1px solid var(--line);
    border-radius:24px;
    box-shadow:0 16px 40px rgba(43,31,24,.08);
    overflow:hidden;
  }
  .hero{
    padding:34px 34px 28px;
    background:
      radial-gradient(circle at top left, rgba(90,107,58,.18), transparent 28%),
      linear-gradient(180deg, rgba(250,244,232,.95), rgba(232,220,200,.96));
    border-bottom:1px solid var(--line);
  }
  .eyebrow{
    display:inline-block;
    font-size:.74rem;
    text-transform:uppercase;
    letter-spacing:.16em;
    color:var(--forest);
    font-weight:800;
    margin-bottom:14px;
  }
  h1{
    margin:0 0 14px;
    font-family:Georgia,serif;
    font-size:2.35rem;
    line-height:1.02;
    color:var(--deep);
    max-width:10ch;
  }
  .lede{
    font-size:1.03rem;
    line-height:1.8;
    color:var(--muted);
    max-width:58ch;
  }
  .body{padding:30px 34px 36px}
  .prompt{
    padding:22px 24px;
    border-radius:18px;
    background:var(--foam);
    color:var(--deep);
    margin-bottom:22px;
  }
  .prompt strong{
    display:block;
    font-size:1rem;
    margin-bottom:8px;
  }
  p{
    margin:0 0 18px;
    font-size:1rem;
    line-height:1.78;
    color:var(--ink);
  }
  ul{
    margin:0 0 22px 18px;
    padding:0;
  }
  li{
    margin:0 0 12px;
    line-height:1.72;
    color:var(--muted);
  }
  code{
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    background:rgba(43,31,24,.06);
    color:var(--deep);
    border-radius:6px;
    padding:2px 6px;
    font-size:.9em;
  }
  .footer{
    margin-top:28px;
    font-size:.85rem;
    color:var(--muted);
  }
  @media (max-width:700px){
    .hero,.body{padding:24px}
    h1{font-size:1.9rem}
  }
</style></head><body>
<main>
  <section class="shell">
    <div class="hero">
      <div class="eyebrow">Walk Topic</div>
      <h1>What should disappear next?</h1>
      <p class="lede">You already know the pattern: <code>pb</code> removes copy friction, <code>look</code> removes screenshot dragging, and history safety removes the little panic of shell residue. So here is the question worth turning over while you walk.</p>
    </div>
    <div class="body">
      <div class="prompt">
        <strong>If Seashells is really about managing the membrane between the agent and your shell, what is the next mechanical ritual that should vanish completely?</strong>
        Not the next clever feature. The next boring hand-motion you still perform even though the agent is standing right there.
      </div>

      <p>A good answer probably has three properties. First, it happens often enough that you barely notice it anymore. Second, it feels too small to justify a tool until you imagine never doing it again. Third, it sits exactly at the seam between cognition and mechanics: not the hard thinking, just the little transfer step that keeps interrupting it.</p>

      <ul>
        <li>Do you still reshape agent output before pasting it into the shell, an editor, Jira, or Slack?</li>
        <li>Do you still clean up environment state by hand after context switches?</li>
        <li>Do you still recover "what was I just doing?" from tabs, history, and half-finished commands instead of asking one shell-native tool to reconstruct it?</li>
        <li>Do you still translate screenshots, logs, clipboard scraps, and shell state into each other manually?</li>
      </ul>

      <p>The brand question hiding underneath is simple too: maybe <strong>Seashells</strong> is not really a family of tiny tools. Maybe it is a promise that anything repetitive at the edge of your shell should become a verb. Not a dashboard. Not a framework. Just a verb that makes the hand-motion go away.</p>

      <p>So the useful walk answer is not "what should we build?" It is "what action should become so natural that it deserves a one-syllable command?"</p>

      <p class="footer">PidginDocs public note · March 29, 2026</p>
    </div>
  </section>
</main>
</body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

export async function loginPage(env: Env, error?: string, next?: string): Promise<Response> {
  const origin = env.WORKER_URL || "";
  // Raw nonce shared by both web SSO buttons — hashed for the provider (replay
  // hardening, same convention as the native app's Sign in with Apple button),
  // raw value threaded back to the server via the redirect target so
  // verifyProviderIdToken can re-derive and compare the hash.
  const rawNonce = crypto.randomUUID();
  const nonceHash = await sha256Hex(rawNonce);

  // Google's login_uri must byte-for-byte match a registered "Authorized
  // redirect URI" (no query string was registered), so next/nonce can't ride
  // on the URL the way Apple's state does on its POST body. Instead they're
  // stashed in a short-lived cookie the browser resends on Google's cross-site
  // POST back to this same path (hence SameSite=None, not Lax — Lax cookies
  // are withheld on cross-site POSTs).
  const googleButton = env.GOOGLE_WEB_CLIENT_ID
    ? `<script src="https://accounts.google.com/gsi/client" async defer></script>
  <div id="g_id_onload"
    data-client_id="${esc(env.GOOGLE_WEB_CLIENT_ID)}"
    data-ux_mode="redirect"
    data-login_uri="${esc(origin)}/auth/oauth/google/web"
    data-nonce="${nonceHash}"></div>
  <div class="g_id_signin" data-type="standard" data-size="large" data-theme="outline" data-text="signin_with" data-shape="rectangular" data-logo_alignment="left" style="margin-bottom:.6rem"></div>`
    : "";
  const googleStateCookie = env.GOOGLE_WEB_CLIENT_ID
    ? `pidgin_g_oauth=${encodeOAuthWebState({ next, nonce: rawNonce })}; Path=/auth/oauth/google/web; HttpOnly; Secure; SameSite=None; Max-Age=600`
    : undefined;

  const appleButton = env.APPLE_WEB_SERVICE_ID
    ? `<script type="text/javascript" src="https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js"></script>
  <div id="appleid-signin" data-color="black" data-border="true" data-type="sign-in" data-width="375" data-height="44" style="width:375px;height:44px;margin-bottom:.6rem"></div>
  <script>
    AppleID.auth.init({
      clientId: ${JSON.stringify(env.APPLE_WEB_SERVICE_ID)},
      scope: "email",
      redirectURI: ${JSON.stringify(origin + "/auth/oauth/apple/web")},
      state: ${JSON.stringify(encodeOAuthWebState({ next, nonce: rawNonce }))},
      nonce: ${JSON.stringify(nonceHash)},
      usePopup: false
    });
  </script>`
    : "";

  const ssoSection = googleButton || appleButton
    ? `<div style="margin:1.25rem 0 0">
    <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:.75rem">
      <div style="flex:1;height:1px;background:${theme.line}"></div>
      <span style="font-size:.78rem;color:${theme.dim}">or</span>
      <div style="flex:1;height:1px;background:${theme.line}"></div>
    </div>
    ${appleButton}
    ${googleButton}
  </div>`
    : "";

  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PidginDocs</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:
    linear-gradient(180deg,#dfe9db 0%,${theme.sand} 42%,${theme.surface} 100%);
    color:${theme.ink};display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:24px}
  .card{position:relative;background:rgba(254,252,247,.94);border:1px solid ${theme.line};border-radius:8px;
    padding:2.2rem;max-width:420px;width:100%;box-shadow:0 20px 54px rgba(16,35,53,.14);overflow:hidden}
  .card:before{content:"";position:absolute;inset:0 0 auto;height:7px;background:linear-gradient(90deg,#0b5788 0 68%,#f05243 68% 76%,#bfe8f6 76% 100%)}
  .brand{display:flex;align-items:center;gap:.8rem;margin-bottom:1.1rem}
  .brand img{width:64px;height:64px;border-radius:15px;box-shadow:0 10px 26px rgba(16,35,53,.16)}
  h1{font-size:2rem;line-height:1.05;letter-spacing:0;margin:0;color:${theme.ink}}
  p{color:${theme.muted};font-size:.95rem;line-height:1.55;margin:0 0 1.5rem}
  input{width:100%;padding:.7rem 1rem;border:1px solid ${theme.line};border-radius:6px;
    font-size:.95rem;margin-bottom:1rem;background:${theme.surface};color:${theme.ink}}
  input:focus{outline:2px solid rgba(28,95,196,.18);border-color:${theme.accent}}
  button{width:100%;padding:.75rem;background:${theme.primary};color:${theme.paper};border:none;
    border-radius:6px;font-size:.9rem;font-weight:600;cursor:pointer}
  button:hover{background:${theme.primaryDeep}}
  .error{color:${theme.error};font-size:.85rem;margin-bottom:1rem}
  a{color:${theme.accent};font-weight:700;text-decoration:none}
  a:hover{text-decoration:underline}
</style></head><body>
<div class="card">
  <div class="brand">
    <img src="/assets/app-icon.jpg" alt="" width="64" height="64">
    <h1>PidginDocs</h1>
  </div>
  <p>Enter your email to receive a PidginDocs login link.</p>
  ${error ? `<div class="error">${error}</div>` : ""}
  <form method="POST" action="/auth/login-form">
    <input type="hidden" name="next" value="${esc(next || "")}">
    <input type="email" name="email" placeholder="you@email.com" required>
    <button type="submit">Send Login Link</button>
  </form>
  ${ssoSection}
  <p style="margin:1.25rem 0 0;font-size:.85rem"><a href="/onboarding">Instance information</a></p>
</div></body></html>`,
    {
      headers: {
        "Content-Type": "text/html",
        ...(googleStateCookie ? { "Set-Cookie": googleStateCookie } : {}),
      },
    }
  );
}

// Shown when a non-member tries to sign in. PidginDocs is invite-only with no
// public sign-up, so we say so plainly instead of leaving them at a login form.
export function membersOnlyPage(): Response {
  return new Response(
    `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Members only · PidginDocs</title>
<style>
  body{font-family:Inter,-apple-system,sans-serif;background:${theme.sand};color:${theme.ink};
    display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:1rem;box-sizing:border-box}
  .card{background:${theme.paper};border-radius:12px;padding:2.5rem;max-width:380px;width:100%;
    box-shadow:0 2px 20px rgba(43,31,24,.08);text-align:center}
  h1{font-family:Georgia,serif;font-size:1.5rem;margin:0 0 .25rem;color:${theme.ink}}
  .kicker{font-size:.7rem;letter-spacing:3px;color:${theme.dim};text-transform:uppercase;margin-bottom:1.25rem}
  p{color:${theme.muted};font-size:.92rem;line-height:1.55;margin:0 0 1rem}
  a{color:${theme.primary};font-weight:600;text-decoration:none}
</style></head><body>
<div class="card">
  <h1>PidginDocs</h1>
  <p><strong>Sorry — PidginDocs is a members-only service.</strong></p>
  <p>There's no public sign-up. If you were invited, sign in with the same email your inviter used.</p>
  <p><a href="/auth/login-form">← Back to sign in</a></p>
</div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

export function inboxPage(messages: any[], filters: { typeFilter?: string; unreadOnly?: boolean; offset?: number; hasMore?: boolean; instanceCount?: number; pendingCount?: number; projectFilter?: string; repliedFilter?: string; sourceFilter?: string } = {}): Response {
  const { typeFilter = "", unreadOnly = false, offset = 0, hasMore = false, instanceCount, pendingCount, projectFilter = "", repliedFilter = "", sourceFilter = "" } = filters;
  const unreadCount = messages.filter((m: any) => !m.read).length;
  const rows = messages
    .map(
      (m: any) => {
        const isUnread = !m.read;
        const isUrgent = m.priority === "urgent";
        const rawBody = m.body ? m.body.replace(/<[^>]*>/g, "") : "";
        const bodySnippet = rawBody ? esc(rawBody.slice(0, 120)) : "";
        const hasMore = rawBody.length > 120;
        const visualCount = Number(m.visual_count || 0);
        const replySection = m.type === "question"
          ? m.reply
            ? `<div class="reply-done"><span class="reply-label">Replied:</span> ${esc(m.reply)}</div>`
            : `<div class="reply-form" id="reply-${m.id}">
                <input type="text" class="reply-input" id="reply-input-${m.id}" placeholder="Type your reply..." onkeydown="if(event.key==='Enter')sendReply('${m.id}')">
                <button class="reply-btn" onclick="sendReply('${m.id}')">Reply</button>
              </div>`
          : "";
        return `<tr class="${[isUnread ? "unread" : "", isUrgent ? "urgent" : ""].filter(Boolean).join(" ")}" id="row-${m.id}">
          <td><span class="badge ${m.type}${m.type === "question" && m.reply ? " answered" : ""}">${m.type === "question" && m.reply ? "answered" : m.type}</span></td>
          <td>
            ${m.type === "document"
              ? `<a href="/api/docs/${m.id}">${isUrgent ? '<span class="priority-dot"></span>' : ""}${esc(m.title)}</a>`
              : `<strong><a href="/messages/${m.id}">${isUrgent ? '<span class="priority-dot"></span>' : ""}${esc(m.title)}</a></strong>`}
            ${visualCount > 0 ? `<span class="visual-count">${visualCount} visual${visualCount === 1 ? "" : "s"}</span>` : ""}
            ${bodySnippet ? `<div class="body-preview" id="preview-${m.id}">${bodySnippet}${hasMore ? `<span class="more-link" onclick="expandBody('${m.id}')">… <span style="color:${theme.accent};cursor:pointer">more</span></span>` : ""}</div>
            ${hasMore ? `<div class="body-full" id="full-${m.id}" style="display:none">${esc(rawBody)}</div>` : ""}` : ""}
            ${m.source_url ? `<div class="source-link"><a href="${esc(m.source_url)}" target="_blank" rel="noopener">↗ ${esc(m.source_url.replace(/^https?:\/\//, "").slice(0, 60))}</a></div>` : ""}
            ${replySection}
          </td>
          <td class="dim">${esc(m.instance_project)}</td>
          <td class="dim" title="${esc(m.instance_source || "")} · ${esc(m.instance_session_id || "")}">${esc(m.instance_model)}</td>
          <td class="dim ts" data-ts="${m.created_at}" title="${new Date(m.created_at).toLocaleString()}">${new Date(m.created_at).toLocaleString()}</td>
          <td style="white-space:nowrap">
            ${!isUnread ? `<button class="unread-btn" onclick="markUnread('${m.id}', this)" title="Mark unread">●</button>` : ""}
            <button class="pri-btn" onclick="togglePriority('${m.id}', '${m.priority}', this)" title="${isUrgent ? "Downgrade to normal" : "Upgrade to urgent"}">${isUrgent ? "↓" : "↑"}</button>
            <button class="del-btn" onclick="deleteMessage('${m.id}', this)" title="Delete">✕</button>
          </td>
        </tr>`;
      }
    )
    .join("");

  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PidginDocs - Inbox</title>
<style>
  body{font-family:Inter,-apple-system,sans-serif;background:${theme.sand};color:${theme.ink};margin:0;padding:2rem}
  .header{display:flex;justify-content:space-between;align-items:center;max-width:900px;margin:0 auto 2rem;gap:1rem;flex-wrap:wrap}
  h1{font-family:Georgia,serif;font-size:1.5rem;color:${theme.ink};margin:0}
  a{color:${theme.primary};text-decoration:none}a:hover{text-decoration:underline}
  table{width:100%;max-width:900px;margin:0 auto;border-collapse:collapse;font-size:.88rem}
  th{text-align:left;padding:.5rem .75rem;background:${theme.ink};color:${theme.sand};font-size:.75rem;
    text-transform:uppercase;letter-spacing:.04em;position:sticky;top:0;z-index:5}
  th:first-child{border-radius:6px 0 0 0}th:last-child{border-radius:0 6px 0 0}
  td{padding:.55rem .75rem;border-bottom:1px solid ${theme.line}}
  .dim{color:${theme.dim}}
  .badge{display:inline-block;padding:.1rem .4rem;border-radius:3px;font-size:.72rem;
    font-weight:600;text-transform:uppercase}
  .badge.message{background:${theme.badgeMessageBg};color:#7A8B6F}
  .badge.question{background:${theme.badgeQuestionBg};color:${theme.badgeQuestionText}}
  .badge.document{background:${theme.badgeDocumentBg};color:${theme.muted}}
  .badge.status{background:${theme.badgeStatusBg};color:${theme.badgeStatusText}}
  .badge.answered{background:${theme.badgeAnsweredBg};color:${theme.badgeAnsweredText}}
  .empty{text-align:center;color:${theme.dim};padding:3rem;font-size:.95rem}
  .body-preview{color:${theme.dim};font-size:.82rem;margin-top:.25rem;line-height:1.4}
  .visual-count{display:inline-block;margin-left:.45rem;padding:.08rem .4rem;border-radius:999px;background:${theme.badgeStatusBg};color:${theme.badgeStatusText};font-size:.68rem;font-weight:650;vertical-align:middle}
  .source-link{font-size:.78rem;margin-top:.25rem}
  .source-link a{color:${theme.badgeStatusText};text-decoration:none}
  .source-link a:hover{text-decoration:underline}
  .body-full{color:${theme.ink};font-size:.88rem;margin-top:.35rem;line-height:1.6;
    white-space:pre-wrap;word-break:break-word;background:rgba(43,31,24,.04);
    padding:.5rem .7rem;border-radius:6px;border-left:2px solid rgba(43,31,24,.12)}
  .reply-form{display:flex;gap:.4rem;margin-top:.5rem;align-items:center}
  .reply-input{flex:1;padding:.4rem .6rem;border:1px solid ${theme.line};border-radius:5px;font-size:.82rem;background:${theme.paper}}
  .reply-btn{padding:.4rem .8rem;background:${theme.primary};color:${theme.paper};border:none;border-radius:5px;
    font-size:.78rem;font-weight:600;cursor:pointer;white-space:nowrap}
  .reply-btn:hover{background:#4A5A2E}
  .reply-btn:disabled{opacity:.6;cursor:wait}
  .reply-done{margin-top:.4rem;font-size:.82rem;color:${theme.badgeAnsweredText};background:#f0f5ed;padding:.35rem .6rem;border-radius:5px}
  .reply-label{font-weight:600}
  tr.unread td{background:#FFFCF9}
  tr.unread{border-left:3px solid ${theme.accent}}
  tr.urgent td{background:#FFF8F5}
  tr.urgent{border-left:3px solid ${theme.accent}}
  tr.unread.urgent td{background:#FFF5F0}
  .priority-dot{display:inline-block;width:7px;height:7px;border-radius:50%;
    background:${theme.accent};margin-right:.35rem;vertical-align:middle}
  .unread-badge{display:inline-block;background:${theme.accent};color:#fff;border-radius:999px;
    font-size:.72rem;font-weight:700;padding:.1rem .5rem;vertical-align:middle;margin-left:.45rem}
  .mark-read-btn{padding:.35rem .75rem;background:transparent;border:1px solid ${theme.accent};
    color:${theme.accent};border-radius:5px;font-size:.78rem;font-weight:600;cursor:pointer}
  .mark-read-btn:hover{background:${theme.accent};color:#fff}
  .filter-bar{display:flex;gap:.6rem;align-items:center;max-width:900px;margin:0 auto 1rem;flex-wrap:wrap}
  .filter-bar input[type=search]{padding:.35rem .65rem;border:1px solid ${theme.borderLight};border-radius:5px;
    font-size:.82rem;background:#fff;color:${theme.ink};min-width:160px;outline:none}
  .filter-bar select,.filter-bar button{padding:.35rem .65rem;border:1px solid ${theme.borderLight};border-radius:5px;
    font-size:.82rem;background:#fff;color:${theme.ink};cursor:pointer}
  .filter-bar button{background:${theme.ink};color:#FBF7F0;border-color:${theme.ink}}
  .filter-bar button:hover{background:#5a4540}
  .filter-pill{display:inline-flex;align-items:center;gap:.35rem;padding:.2rem .6rem;
    border-radius:999px;background:#F0DDD6;color:${theme.accent};font-size:.78rem;font-weight:600}
  .del-btn,.unread-btn,.pri-btn{background:none;border:none;cursor:pointer;font-size:.85rem;
    padding:.1rem .35rem;border-radius:3px;opacity:0}
  .del-btn{color:#C0A89E}
  .unread-btn{color:#8A9FCA;font-size:.65rem}
  .pri-btn{color:#B8935A;font-size:.8rem}
  tr:hover .del-btn,tr:hover .unread-btn,tr:hover .pri-btn{opacity:1}
  .del-btn:hover{background:#F0DDD6;color:${theme.accent}}
  .unread-btn:hover{background:${theme.badgeStatusBg};color:${theme.badgeStatusText}}
  .pri-btn:hover{background:${theme.badgeQuestionBg};color:${theme.badgeQuestionText}}
  .new-banner{display:none;position:sticky;top:0;z-index:10;background:${theme.accent};color:#fff;
    text-align:center;padding:.5rem;font-size:.85rem;font-weight:600;cursor:pointer}
  .new-banner.show{display:block}
  .new-banner:hover{background:#a85540}
</style></head><body>
<div class="new-banner" id="new-banner" onclick="location.reload()">New messages — click to refresh</div>
<div class="filter-bar" style="margin-bottom:.25rem">
  <input type="search" id="inbox-search" placeholder="Search messages…" oninput="filterRows(this.value)" style="flex:1;min-width:180px">
</div>
<form class="filter-bar" method="GET" action="/inbox">
  <select name="type" onchange="this.form.submit()">
    <option value="" ${!typeFilter ? "selected" : ""}>All types</option>
    <option value="message" ${typeFilter === "message" ? "selected" : ""}>Messages</option>
    <option value="question" ${typeFilter === "question" ? "selected" : ""}>Questions</option>
    <option value="status" ${typeFilter === "status" ? "selected" : ""}>Status</option>
    <option value="document" ${typeFilter === "document" ? "selected" : ""}>Documents</option>
  </select>
  <input type="text" name="project" placeholder="Project…" value="${esc(projectFilter)}" style="width:120px;padding:.35rem .6rem;border:1px solid ${theme.borderLight};border-radius:5px;font-size:.82rem" onchange="this.form.submit()">
  <input type="text" name="source" placeholder="Source…" value="${esc(sourceFilter)}" style="width:100px;padding:.35rem .6rem;border:1px solid ${theme.borderLight};border-radius:5px;font-size:.82rem" onchange="this.form.submit()">
  <label style="display:flex;align-items:center;gap:.3rem;font-size:.82rem;cursor:pointer">
    <input type="checkbox" name="unread" value="true" ${unreadOnly ? "checked" : ""} onchange="this.form.submit()"> Unread only
  </label>
  <a href="/inbox?type=question&replied=false" style="font-size:.78rem;padding:.35rem .6rem;border-radius:5px;background:${theme.badgeQuestionBg};color:${theme.badgeQuestionText};font-weight:600;text-decoration:none">Pending questions${pendingCount != null && pendingCount > 0 ? ` <span style="background:${theme.badgeQuestionText};color:#fff;border-radius:9px;padding:.05rem .4rem;font-size:.7rem;font-weight:700">${pendingCount}</span>` : ""}</a>
  ${typeFilter || unreadOnly || projectFilter || repliedFilter || sourceFilter ? `<a href="/inbox" style="font-size:.78rem;color:${theme.accent}">Clear filters</a>` : ""}
</form>
  <div class="header">
  <h1>PidginDocs${messages.length > 0 && unreadCount > 0 ? `<span class="unread-badge">${unreadCount}</span>` : ""}</h1>
  <div style="display:flex;gap:.75rem;align-items:center;flex-wrap:wrap">
    ${unreadCount > 0 ? `<button class="mark-read-btn" onclick="markAllRead()">Mark all read</button>` : ""}
    <a href="/workspace">Workspace</a>
    <a href="/toc">Documents</a>
    <a href="/commute">Commute</a>
    <a href="/registry">Instances${instanceCount != null && instanceCount > 0 ? ` <span style="background:${theme.badgeAnsweredText};color:#fff;border-radius:9px;padding:.05rem .4rem;font-size:.72rem;font-weight:700">${instanceCount}</span>` : ""}</a>
    <a href="/stats">Stats</a>
    <a href="/profile">Profile</a>
    <a href="/setup">Setup</a>
    <a href="/auth/logout">Logout</a>
  </div>
</div>
${
  messages.length === 0 && offset === 0
    ? '<div class="empty">No messages yet. Your Claude sessions will post here.</div>'
    : messages.length === 0
      ? '<div class="empty">No messages match the current filters.</div>'
      : `<table>
          <thead><tr><th>Type</th><th>Title</th><th>Project</th><th>Model</th><th>Time</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
}
${(() => {
  const params = new URLSearchParams();
  if (typeFilter) params.set("type", typeFilter);
  if (projectFilter) params.set("project", projectFilter);
  if (unreadOnly) params.set("unread", "true");
  if (repliedFilter) params.set("replied", repliedFilter);
  const base = "/inbox" + (params.toString() ? "?" + params.toString() : "");
  const prevOffset = Math.max(0, offset - 50);
  const nextOffset = offset + 50;
  if (!hasMore && offset === 0) return "";
  return `<div style="display:flex;gap:.75rem;justify-content:center;padding:1rem;max-width:900px;margin:0 auto">
    ${offset > 0 ? `<a href="${base}${base.includes("?") ? "&" : "?"}offset=${prevOffset}" style="color:${theme.accent};text-decoration:none;font-size:.88rem">← Newer</a>` : ""}
    ${offset > 0 ? `<span style="font-size:.82rem;color:${theme.dim}">Page ${Math.floor(offset / 50) + 1}</span>` : ""}
    ${hasMore ? `<a href="${base}${base.includes("?") ? "&" : "?"}offset=${nextOffset}" style="color:${theme.accent};text-decoration:none;font-size:.88rem">Older →</a>` : ""}
  </div>`;
})()}
<script>
function filterRows(query) {
  var q = query.toLowerCase().trim();
  var rows = document.querySelectorAll('tbody tr');
  var visible = 0;
  rows.forEach(function(row) {
    var text = row.textContent.toLowerCase();
    var show = !q || text.includes(q);
    row.style.display = show ? '' : 'none';
    if (show) visible++;
  });
}
function expandBody(messageId) {
  var preview = document.getElementById('preview-' + messageId);
  var full = document.getElementById('full-' + messageId);
  if (preview) preview.style.display = 'none';
  if (full) full.style.display = 'block';
  var row = document.getElementById('row-' + messageId);
  if (row && row.classList.contains('unread')) {
    row.classList.remove('unread');
    fetch('/api/messages/' + messageId, { method: 'PATCH', credentials: 'same-origin' }).catch(function(){});
  }
}
async function markUnread(messageId, btn) {
  btn.disabled = true;
  try {
    var res = await fetch('/api/messages/' + messageId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ read: false })
    });
    if (res.ok) {
      var row = document.getElementById('row-' + messageId);
      if (row) { row.classList.add('unread'); btn.remove(); }
    } else { btn.disabled = false; }
  } catch (e) { btn.disabled = false; }
}
async function togglePriority(messageId, currentPriority, btn) {
  var newPriority = currentPriority === 'urgent' ? 'normal' : 'urgent';
  btn.disabled = true;
  try {
    var res = await fetch('/api/messages/' + messageId + '/priority', {
      method: 'PATCH', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: newPriority }),
    });
    if (res.ok) {
      var row = document.getElementById('row-' + messageId);
      if (row) {
        if (newPriority === 'urgent') { row.classList.add('urgent'); btn.textContent = '↓'; btn.title = 'Downgrade to normal'; }
        else { row.classList.remove('urgent'); btn.textContent = '↑'; btn.title = 'Upgrade to urgent'; }
        btn.setAttribute('onclick', "togglePriority('" + messageId + "','" + newPriority + "',this)");
      }
    }
  } catch (e) {}
  btn.disabled = false;
}
async function deleteMessage(messageId, btn) {
  btn.disabled = true;
  try {
    var res = await fetch('/api/messages/' + messageId, { method: 'DELETE', credentials: 'same-origin' });
    if (res.ok) {
      var row = document.getElementById('row-' + messageId);
      if (row) row.remove();
    } else { btn.disabled = false; }
  } catch (e) { btn.disabled = false; }
}
async function markAllRead() {
  var btn = document.querySelector('.mark-read-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Marking...'; }
  try {
    var res = await fetch('/api/messages/read-all', { method: 'PATCH', credentials: 'same-origin' });
    if (res.ok) { location.reload(); }
    else if (btn) { btn.disabled = false; btn.textContent = 'Mark all read'; }
  } catch (e) { if (btn) { btn.disabled = false; btn.textContent = 'Mark all read'; } }
}
(function startPolling() {
  var initialUnread = ${unreadCount};
  function poll() {
    fetch('/api/messages?limit=1', { credentials: 'same-origin' })
      .then(function(r) {
        var c = parseInt(r.headers.get('X-Unread-Count') || '0', 10);
        if (c > initialUnread) { document.getElementById('new-banner').classList.add('show'); }
      })
      .catch(function(){});
  }
  setInterval(poll, 30000);
})();
async function sendReply(messageId) {
  var input = document.getElementById('reply-input-' + messageId);
  var btn = input.parentElement.querySelector('.reply-btn');
  if (!input.value.trim()) return;
  btn.disabled = true;
  btn.textContent = 'Sending...';
  try {
    var res = await fetch('/api/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ message_id: messageId, reply: input.value.trim() })
    });
    var data = await res.json();
    if (data.ok) {
      var form = document.getElementById('reply-' + messageId);
      form.innerHTML = '<div class="reply-done"><span class="reply-label">Replied:</span> ' + input.value.trim().replace(/</g,'&lt;') + '</div>';
    } else {
      btn.textContent = data.error || 'Failed';
      btn.disabled = false;
    }
  } catch (e) {
    btn.textContent = 'Error';
    btn.disabled = false;
  }
}
(function stampRelTimes() {
  function relTime(iso) {
    var delta = (Date.now() - new Date(iso).getTime()) / 1000;
    if (delta < 60) return 'just now';
    if (delta < 3600) return Math.floor(delta / 60) + 'm ago';
    if (delta < 86400) return Math.floor(delta / 3600) + 'h ago';
    if (delta < 86400 * 7) return Math.floor(delta / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString();
  }
  document.querySelectorAll('td.ts').forEach(function(td) {
    td.textContent = relTime(td.dataset.ts);
  });
  setInterval(function() {
    document.querySelectorAll('td.ts').forEach(function(td) {
      td.textContent = relTime(td.dataset.ts);
    });
  }, 60000);
})();
(function keyNav() {
  var rows = [];
  var cur = -1;
  function getRows() { return Array.from(document.querySelectorAll('tbody tr[id^="row-"]')); }
  function highlight(idx) {
    rows = getRows();
    if (cur >= 0 && rows[cur]) rows[cur].style.outline = '';
    cur = Math.max(0, Math.min(idx, rows.length - 1));
    if (rows[cur]) {
      rows[cur].style.outline = '2px solid ${theme.accent}';
      rows[cur].scrollIntoView({ block: 'nearest' });
    }
  }
  function rowId(row) { return row.id.replace('row-', ''); }
  document.addEventListener('keydown', function(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    rows = getRows();
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); highlight(cur < 0 ? 0 : cur + 1); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); highlight(cur <= 0 ? 0 : cur - 1); }
    else if ((e.key === 'Enter' || e.key === 'o') && cur >= 0 && rows[cur]) {
      var id = rowId(rows[cur]);
      var more = document.getElementById('preview-' + id);
      if (more) expandBody(id);
    } else if (e.key === 'r' && cur >= 0 && rows[cur]) {
      var id = rowId(rows[cur]);
      var inp = document.getElementById('reply-input-' + id);
      if (inp) { inp.focus(); e.preventDefault(); }
    } else if (e.key === 'd' && cur >= 0 && rows[cur]) {
      var btn = rows[cur].querySelector('.del-btn');
      if (btn) { deleteMessage(rowId(rows[cur]), btn); }
    } else if (e.key === 'p' && cur >= 0 && rows[cur]) {
      var priBtnEl = rows[cur].querySelector('.pri-btn');
      if (priBtnEl) { priBtnEl.click(); }
    } else if (e.key === '?') {
      alert('Keyboard shortcuts: j/k=navigate, Enter=expand, r=reply, d=delete, p=toggle priority');
    }
  });
})();
</script>
</body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

export function tocPage(docs: any[]): Response {
  const rows = docs
    .map(
      (d: any) =>
        `<div class="doc-card" data-id="${esc(d.id)}">
          <div class="doc-header">
            <span class="badge ${d.public ? "public" : "private"}">${d.public ? "public" : "private"}</span>
            <span class="doc-title">${esc(d.title)}</span>
          </div>
          <div class="doc-meta">
            ${esc(d.instance_project)} &middot; ${esc(d.instance_model)} &middot; <span class="ts" data-ts="${d.created_at + "Z"}" title="${new Date(d.created_at + "Z").toLocaleString()}">${new Date(d.created_at + "Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</span>
          </div>
          <div class="doc-actions">
            <a href="/api/docs/${esc(d.id)}" class="btn btn-view" target="_blank">View</a>
            <button class="share-link" data-doc-id="${esc(d.id)}" onclick="generateLink(this)">↗ share</button>
          </div>
          <div class="link-output" id="link-${esc(d.id)}" style="display:none">
            <input type="text" readonly class="link-field">
            <button class="share-link" onclick="copyLink(this)">copy</button>
            <span class="link-expiry"></span>
          </div>
        </div>`
    )
    .join("");

  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PidginDocs - Documents</title>
<style>
  body{font-family:Inter,-apple-system,sans-serif;background:${theme.sand};color:${theme.ink};margin:0;padding:2rem}
  .header{display:flex;justify-content:space-between;align-items:center;max-width:700px;margin:0 auto 2rem;gap:1rem;flex-wrap:wrap}
  h1{font-family:Georgia,serif;font-size:1.5rem;color:${theme.ink};margin:0}
  .header-links a{color:${theme.primary};text-decoration:none;margin-left:1.2rem;font-size:.88rem}
  .header-links a:hover{text-decoration:underline}
  .doc-card{background:${theme.paper};border-radius:10px;padding:1.2rem 1.5rem;margin:0 auto 1rem;max-width:700px;
    box-shadow:0 1px 8px rgba(43,31,24,.06)}
  .doc-header{display:flex;align-items:center;gap:.6rem;margin-bottom:.35rem}
  .doc-title{font-weight:600;font-size:.95rem;color:${theme.ink}}
  .doc-meta{color:${theme.dim};font-size:.78rem;margin-bottom:.75rem}
  .badge{display:inline-block;padding:.1rem .45rem;border-radius:3px;font-size:.68rem;
    font-weight:600;text-transform:uppercase;letter-spacing:.03em}
  .badge.public{background:${theme.badgeAnsweredBg};color:#5A6F50}
  .badge.private{background:${theme.badgeDocumentBg};color:${theme.muted}}
  .doc-actions{display:flex;gap:.5rem;flex-wrap:wrap}
  .btn{padding:.4rem .9rem;border-radius:5px;font-size:.8rem;font-weight:600;cursor:pointer;
    border:none;text-decoration:none;display:inline-block}
  .btn-view{background:${theme.ink};color:${theme.paper}}
  .btn-view:hover{background:#3D2E1A}
  .share-link{background:none;border:none;color:${theme.dim};cursor:pointer;padding:0;font-size:.75rem;
    font-family:inherit;text-decoration:none;display:inline-flex;align-items:center;gap:3px}
  .share-link:hover{color:${theme.primary}}
  .share-link:disabled{opacity:.55;cursor:wait}
  .link-output{margin-top:.5rem;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
  .link-field{flex:1;min-width:160px;padding:.3rem .5rem;border:1px solid ${theme.line};border-radius:4px;
    font-size:.72rem;font-family:monospace;color:${theme.ink};background:${theme.paper}}
  .link-expiry{font-size:.68rem;color:${theme.dim}}
  .empty{text-align:center;color:${theme.dim};padding:3rem;font-size:.95rem}
  .toast{position:fixed;bottom:2rem;left:50%;transform:translateX(-50%);background:${theme.ink};
    color:${theme.sand};padding:.6rem 1.2rem;border-radius:6px;font-size:.82rem;opacity:0;
    transition:opacity .3s;pointer-events:none}
  .toast.show{opacity:1}
</style></head><body>
<div class="header">
  <h1>Documents</h1>
  <div class="header-links"><a href="/inbox">Inbox</a><a href="/workspace">Workspace</a><a href="/commute">Commute</a><a href="/profile">Profile</a><a href="/setup">Setup</a><a href="/auth/logout">Logout</a></div>
</div>
${
  docs.length === 0
    ? '<div class="empty">No documents yet.</div>'
    : rows
}
<div class="toast" id="toast">Copied!</div>
<script>
async function generateLink(btn) {
  var docId = btn.dataset.docId;
  if (!docId) return;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    var res = await fetch('/api/docs/' + encodeURIComponent(docId) + '/share', { method: 'POST', credentials: 'same-origin' });
    var data = await res.json();
    if (!data.ok) {
      btn.textContent = '↗ share';
      btn.disabled = false;
      return;
    }
    var output = document.getElementById('link-' + docId);
    output.style.display = 'flex';
    output.querySelector('.link-field').value = data.data.url;
    output.querySelector('.link-expiry').textContent = 'exp. ' + new Date(data.data.expires_at).toLocaleTimeString();
    btn.textContent = '↺ refresh';
    btn.disabled = false;
  } catch (e) {
    btn.textContent = '↗ share';
    btn.disabled = false;
  }
}
function copyLink(btn) {
  var field = btn.parentElement.querySelector('.link-field');
  navigator.clipboard.writeText(field.value);
  var toast = document.getElementById('toast');
  toast.classList.add('show');
  setTimeout(function() { toast.classList.remove('show'); }, 1500);
}
(function stampRelTimes() {
  function relTime(iso) {
    var delta = (Date.now() - new Date(iso).getTime()) / 1000;
    if (delta < 60) return 'just now';
    if (delta < 3600) return Math.floor(delta / 60) + 'm ago';
    if (delta < 86400) return Math.floor(delta / 3600) + 'h ago';
    if (delta < 86400 * 7) return Math.floor(delta / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString();
  }
  document.querySelectorAll('.ts[data-ts]').forEach(function(el) { el.textContent = relTime(el.dataset.ts); });
})();
</script>
</body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

// Terminal.app-style visual gallery of the builtin document styles: each card
// is a live specimen rendered in the style's own palette and fonts, with its
// color chips and font pairing spelled out. Values come from the same compiler
// the typesetter uses, so the gallery can never drift from real documents.
function styleGalleryCards(): string {
  return BUILTIN_DESIGN_SYSTEMS.map((def) => {
    const compiled = compileDesignSystem(def);
    const v: Record<string, string> = {};
    for (const m of compiled.rootCss.matchAll(/(--ds-[a-z-]+):\s*([^;\n]+);/g)) {
      // font stacks arrive with double-quoted families; inline style attrs
      // below are double-quote delimited, so swap to single quotes.
      v[m[1]] = m[2].trim().replace(/"/g, "'");
    }
    const firstFamily = (stack: string | undefined): string =>
      (stack ?? "").split(",")[0]?.replace(/'/g, "").trim() || "system";
    const chip = (varName: string): string =>
      `<span title="${varName}: ${esc(v[varName] ?? "")}" style="width:17px;height:17px;border-radius:50%;background:${v[varName]};border:1px solid rgba(43,31,24,.18);display:inline-block"></span>`;
    return `<div title="${esc(def.voice ?? "")}" style="background:${v["--ds-bg"]};border:1px solid ${v["--ds-rule"]};border-radius:12px;padding:1.05rem 1.15rem;box-shadow:0 2px 12px rgba(43,31,24,.06)">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:.6rem;flex-wrap:wrap">
        <span style="font-family:${v["--ds-font-heading"]};color:${v["--ds-text"]};font-weight:700;font-size:1.02rem">${esc(def.displayName)}</span>
        <code style="font-family:${v["--ds-font-mono"]};font-size:.67rem;color:${v["--ds-text-muted"]};background:${v["--ds-surface"]};padding:2px 7px;border-radius:4px">${esc(def.name)}</code>
      </div>
      <p style="font-family:${v["--ds-font-body"]};color:${v["--ds-text"]};font-size:.86rem;line-height:1.55;margin:.55rem 0 .6rem">The quick brown pidgin lifts off at dawn. <span style="color:${v["--ds-accent"]};text-decoration:underline;text-underline-offset:3px">A link</span>, <code style="font-family:${v["--ds-font-mono"]};font-size:.78em;background:${v["--ds-surface"]};padding:1px 4px;border-radius:3px">code</code>, and <strong style="color:${v["--ds-positive"]}">a win</strong>.</p>
      <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap">
        ${chip("--ds-bg")}${chip("--ds-surface")}${chip("--ds-text")}${chip("--ds-text-muted")}${chip("--ds-accent")}${chip("--ds-rule")}${chip("--ds-positive")}
        <span style="margin-left:auto;font-family:${v["--ds-font-mono"]};font-size:.64rem;color:${v["--ds-text-faint"]}">${esc(firstFamily(v["--ds-font-heading"]))} · ${esc(firstFamily(v["--ds-font-body"]))}</span>
      </div>
      <p style="font-family:${v["--ds-font-body"]};color:${v["--ds-text-muted"]};font-size:.74rem;line-height:1.45;margin:.6rem 0 0">${esc(def.description)}</p>
    </div>`;
  }).join("\n");
}

export function setupPage(
  status: SetupStatus,
  opts?: {
    flash?: string;
    error?: string;
    apiKeys?: Array<{ key_prefix: string; label: string | null; created_at: string; last_used_at: string | null; key_hash: string }>;
    newKey?: string;
  }
): Response {
  const flash = opts?.flash
    ? `<div class="flash success">${opts.flash}</div>`
    : "";
  const error = opts?.error
    ? `<div class="flash error">${opts.error}</div>`
    : "";

  const m365State = status.microsoft365.configured
    ? status.microsoft365.legacy ? "Upgrade available" : "Connected"
    : status.currentStep === "microsoft365"
    ? "Next"
    : "Locked";
  const commuteState = status.commute.configured
    ? "Connected"
    : status.currentStep === "commute"
    ? "Next"
    : "Locked";

  const m365Disabled = false;
  const m365Notice = status.microsoft365.legacy
    ? "Running on legacy OneDrive config. Save to enable Teams and SharePoint."
    : "";
  const commuteDisabled = status.currentStep !== "commute" && status.currentStep !== "done";
  const commuteNotice = !status.microsoft365.configured
    ? "Complete the Microsoft 365 step to unlock commute briefings."
    : "";

  const apiKeys = opts?.apiKeys ?? [];
  const newKey = opts?.newKey;
  const newKeyBox = newKey
    ? `<div style="background:#EBF3E6;border:1px solid ${theme.primary};border-radius:8px;padding:.8rem;margin:.4rem 0 1rem">
        <p style="color:${theme.badgeAnsweredText};font-size:.82rem;margin:0 0 .5rem;font-weight:600">⚠️ Copy this now — you won't be able to see it again.</p>
        <code id="newkey" style="display:block;word-break:break-all;font-size:.78rem;background:${theme.paper};padding:.5rem;border-radius:6px;color:${theme.ink}">${esc(newKey)}</code>
        <button type="button" class="secondary" style="margin-top:.5rem;width:auto;padding:.4rem .9rem" onclick="copyKey()">Copy</button>
      </div>`
    : "";
  const keyRows = apiKeys
    .map(
      (k) => `<tr style="border-bottom:1px solid ${theme.line}">
        <td style="padding:.4rem .3rem">${esc(k.label ?? "—")}</td>
        <td style="padding:.4rem .3rem;font-family:monospace;font-size:.76rem;color:${theme.muted}">${esc(k.key_prefix)}…</td>
        <td style="padding:.4rem .3rem;font-size:.74rem;color:${theme.dim}">${k.created_at ? new Date(k.created_at + "Z").toLocaleDateString() : "—"}</td>
        <td style="padding:.4rem .3rem;font-size:.74rem;color:${theme.dim}">${k.last_used_at ? "used " + new Date(k.last_used_at + "Z").toLocaleDateString() : "unused"}</td>
        <td style="padding:.4rem .3rem;text-align:right"><form method="POST" action="/setup/keys/revoke" style="margin:0" onsubmit="return confirm('Revoke this key? Agents using it will stop working.')"><input type="hidden" name="key_hash" value="${esc(k.key_hash)}"><button type="submit" class="secondary" style="width:auto;padding:.25rem .6rem;font-size:.74rem;margin:0">Revoke</button></form></td>
      </tr>`
    )
    .join("");
  const keysList = apiKeys.length
    ? `<table style="width:100%;border-collapse:collapse;margin-bottom:.6rem">${keyRows}</table>`
    : `<p class="hint">No API keys yet.</p>`;
  const apiKeysCard = `<div class="card">
      <h2>API Keys</h2>
      <div class="badge optional">CLI &amp; agents</div>
      <p class="hint">Personal keys so your own Claude Code / Codex / CLI agents can send via PidginDocs. Each key is shown only once.</p>
      ${newKeyBox}
      ${keysList}
      <form method="POST" action="/setup/keys">
        <label for="key_label">New key label</label>
        <input id="key_label" name="label" placeholder="laptop" maxlength="60">
        <button type="submit">Generate API key</button>
      </form>
    </div>`;

  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PidginDocs Setup</title>
<style>
  body{font-family:Inter,-apple-system,sans-serif;background:${theme.sand};color:${theme.ink};margin:0;padding:2rem}
  h1{font-family:Georgia,serif;color:${theme.ink};margin-bottom:0.3rem}
  p{color:${theme.muted};max-width:640px}
  .flash{margin:1rem 0;padding:0.9rem 1rem;border-radius:6px;font-size:0.9rem}
  .flash.success{background:${theme.badgeAnsweredBg};color:${theme.badgeAnsweredText}}
  .flash.error{background:${theme.errorBg};color:${theme.error}}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:1.5rem;margin-top:2rem}
  .card{background:${theme.paper};border-radius:12px;padding:1.5rem;box-shadow:0 2px 18px rgba(43,31,24,.06)}
  .card h2{margin-top:0;font-size:1.1rem;color:${theme.ink}}
  label{display:block;font-size:0.78rem;letter-spacing:.04em;color:${theme.dim};margin-bottom:0.25rem;text-transform:uppercase}
  input,textarea,select{width:100%;padding:0.65rem 0.75rem;border:1px solid ${theme.line};border-radius:6px;font-size:0.9rem;margin-bottom:0.8rem;box-sizing:border-box;background:${theme.paper}}
  textarea{min-height:88px;resize:vertical}
  .badge{display:inline-block;padding:0.2rem 0.5rem;border-radius:999px;font-size:0.72rem;text-transform:uppercase;font-weight:600;letter-spacing:.05em;margin-bottom:0.75rem}
  .badge.connected{background:${theme.badgeAnsweredBg};color:${theme.badgeAnsweredText}}
  .badge.required{background:${theme.attentionBg};color:${theme.error}}
  .badge.next{background:${theme.badgeQuestionBg};color:${theme.idle}}
  .badge.locked{background:#ECE8F5;color:#736199}
  .badge.optional{background:${theme.badgeStatusBg};color:#476780}
  .badge.unavailable{background:${theme.line};color:#7E706B}
  button{width:100%;padding:0.75rem;border:none;border-radius:7px;background:${theme.ink};color:${theme.paper};font-weight:600;font-size:0.95rem;cursor:pointer}
  button:disabled{opacity:0.5;cursor:not-allowed}
  button.secondary{background:${theme.line};color:${theme.ink}}
  button.secondary:hover{background:#D4C0A4}
  .hint{font-size:0.8rem;color:${theme.dim};margin-top:-0.5rem;margin-bottom:0.8rem}
  .steps{display:flex;gap:1rem;margin-top:1.5rem;flex-wrap:wrap}
  .step-pill{display:flex;align-items:center;gap:0.4rem;padding:0.4rem 0.8rem;border-radius:999px;font-size:0.8rem;background:${theme.line};color:${theme.muted}}
  .step-pill.active{background:${theme.ink};color:${theme.sand}}
  .topbar{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap}
  .topbar a{color:${theme.primary};text-decoration:none;font-weight:600}
  .topbar a:hover{text-decoration:underline}
</style></head>
<body>
  <div class="topbar">
    <div>
      <h1>PidginDocs onboarding</h1>
      <p>Connect the destinations and commute audio settings PidginDocs should use. Once both steps are complete the inbox will unlock.</p>
    </div>
    <div><a href="/profile">Profile</a> &nbsp; <a href="/inbox">Back to inbox</a></div>
  </div>
  ${flash}${error}
  <div class="steps">
    <div class="step-pill ${status.currentStep === "microsoft365" || status.currentStep === "commute" || status.currentStep === "done" ? "active" : ""}">1. Microsoft 365</div>
    <div class="step-pill ${status.currentStep === "commute" || status.currentStep === "done" ? "active" : ""}">2. Commute</div>
    <div class="step-pill ${status.currentStep === "done" ? "active" : ""}">Ready</div>
  </div>
  <div class="grid">
    <div class="card">
      <h2>Microsoft 365</h2>
      <div class="badge ${status.microsoft365.configured ? status.microsoft365.legacy ? "next" : "connected" : m365Disabled ? "locked" : "next"}">${m365State}</div>
      ${m365Notice ? '<p class="hint">' + m365Notice + '</p>' : ""}
      <form method="POST" action="/setup">
        <input type="hidden" name="type" value="microsoft365">
        <label for="tenant_id">Tenant ID</label>
        <input id="tenant_id" name="tenant_id" placeholder="guid" ${m365Disabled ? "disabled" : ""} required>
        <label for="client_id">Client ID</label>
        <input id="client_id" name="client_id" placeholder="guid" ${m365Disabled ? "disabled" : ""} required>
        <label for="client_secret">Client secret</label>
        <input id="client_secret" name="client_secret" type="password" ${m365Disabled ? "disabled" : ""} required>
        <label for="refresh_token">Refresh token</label>
        <textarea id="refresh_token" name="refresh_token" ${m365Disabled ? "disabled" : ""} required></textarea>

        <h3 style="margin-top:1.2rem;font-size:0.95rem;color:${theme.ink}">Teams</h3>
        <label><input type="checkbox" name="teams_enabled" value="on" checked ${m365Disabled ? "disabled" : ""}> Enable Teams channel posting</label>
        <label for="teams_team_id">Team ID</label>
        <input id="teams_team_id" name="teams_team_id" placeholder="guid" ${m365Disabled ? "disabled" : ""}>
        <label for="teams_channel_id">Channel ID</label>
        <input id="teams_channel_id" name="teams_channel_id" placeholder="guid" ${m365Disabled ? "disabled" : ""}>
        <p class="hint">Get IDs: right-click channel in Teams > Get link > extract groupId and channel from URL.</p>

        <h3 style="margin-top:1.2rem;font-size:0.95rem;color:${theme.ink}">SharePoint</h3>
        <label><input type="checkbox" name="sharepoint_enabled" value="on" checked ${m365Disabled ? "disabled" : ""}> Enable SharePoint document uploads</label>
        <label for="sharepoint_site_id">Site ID</label>
        <input id="sharepoint_site_id" name="sharepoint_site_id" placeholder="guid" ${m365Disabled ? "disabled" : ""}>
        <label for="sharepoint_drive_id">Document library Drive ID</label>
        <input id="sharepoint_drive_id" name="sharepoint_drive_id" placeholder="guid" ${m365Disabled ? "disabled" : ""}>
        <label for="sharepoint_folder">Folder (optional)</label>
        <input id="sharepoint_folder" name="sharepoint_folder" placeholder="Claudia-PidginDocs/Docs" ${m365Disabled ? "disabled" : ""}>

        <h3 style="margin-top:1.2rem;font-size:0.95rem;color:${theme.ink}">OneDrive</h3>
        <label><input type="checkbox" name="onedrive_enabled" value="on" checked ${m365Disabled ? "disabled" : ""}> Enable OneDrive file uploads</label>
        <label for="onedrive_drive_id">Drive ID</label>
        <input id="onedrive_drive_id" name="onedrive_drive_id" placeholder="guid" ${m365Disabled ? "disabled" : ""}>
        <label for="onedrive_folder">Folder (optional)</label>
        <input id="onedrive_folder" name="onedrive_folder" placeholder="Claudia-PidginDocs/Docs" ${m365Disabled ? "disabled" : ""}>

        <button type="submit" ${m365Disabled ? "disabled" : ""} style="margin-top:1rem">Save Microsoft 365 settings</button>
      </form>
      ${status.microsoft365.updated_at ? '<p class="hint">Updated ' + new Date(status.microsoft365.updated_at + "Z").toLocaleString() + '</p>' : ""}
    </div>
    <div class="card">
      <h2>Commute briefings</h2>
      <div class="badge ${status.commute.configured ? "connected" : commuteDisabled ? "locked" : "next"}">${commuteState}</div>
      ${commuteNotice ? `<p class="hint">${commuteNotice}</p>` : ""}
      <form method="POST" action="/setup">
        <input type="hidden" name="type" value="commute">
        <label for="openai_api_key">OpenAI API key</label>
        <input id="openai_api_key" name="openai_api_key" type="password" placeholder="sk-..." ${commuteDisabled ? "disabled" : ""} required>
        <p class="hint">OpenAI is still used for the research pass and the final spoken script.</p>
        <label for="tts_provider">Narration provider</label>
        <select id="tts_provider" name="tts_provider" ${commuteDisabled ? "disabled" : ""} onchange="toggleTtsFields()">
          <option value="openai" selected>OpenAI</option>
          <option value="elevenlabs">ElevenLabs</option>
          <option value="gemini">Google Gemini</option>
        </select>
        <div id="openai-fields">
          <label for="voice">OpenAI voice</label>
          <input id="voice" name="voice" placeholder="sage" value="sage" ${commuteDisabled ? "disabled" : ""}>
          <label for="model">OpenAI speech model</label>
          <input id="model" name="model" placeholder="gpt-4o-mini-tts" value="gpt-4o-mini-tts" ${commuteDisabled ? "disabled" : ""}>
        </div>
        <div id="elevenlabs-fields" style="display:none">
          <label for="elevenlabs_api_key">ElevenLabs API key</label>
          <input id="elevenlabs_api_key" name="elevenlabs_api_key" type="password" placeholder="sk_..." ${commuteDisabled ? "disabled" : ""}>
          <label for="elevenlabs_voice_id">ElevenLabs voice ID</label>
          <input id="elevenlabs_voice_id" name="elevenlabs_voice_id" placeholder="voice id" ${commuteDisabled ? "disabled" : ""}>
          <label for="elevenlabs_model">ElevenLabs model</label>
          <input id="elevenlabs_model" name="elevenlabs_model" placeholder="eleven_multilingual_v2" value="eleven_multilingual_v2" ${commuteDisabled ? "disabled" : ""}>
        </div>
        <div id="gemini-fields" style="display:none">
          <label for="gemini_api_key">Gemini API key</label>
          <input id="gemini_api_key" name="gemini_api_key" type="password" placeholder="AIza..." ${commuteDisabled ? "disabled" : ""}>
          <label for="gemini_voice">Gemini voice</label>
          <input id="gemini_voice" name="gemini_voice" placeholder="Kore" value="Kore" ${commuteDisabled ? "disabled" : ""}>
          <label for="gemini_model">Gemini speech model</label>
          <input id="gemini_model" name="gemini_model" placeholder="gemini-2.5-flash-preview-tts" value="gemini-2.5-flash-preview-tts" ${commuteDisabled ? "disabled" : ""}>
          <label for="gemini_language_code">Gemini language code</label>
          <input id="gemini_language_code" name="gemini_language_code" placeholder="en-US" value="en-US" ${commuteDisabled ? "disabled" : ""}>
        </div>
        <label for="script_model">Script model</label>
        <input id="script_model" name="script_model" placeholder="gpt-4.1-mini" value="gpt-4.1-mini" ${commuteDisabled ? "disabled" : ""}>
        <label for="speech_instructions">Speech style</label>
        <textarea id="speech_instructions" name="speech_instructions" ${commuteDisabled ? "disabled" : ""}>Speak like a warm, thoughtful podcast host. Use natural pacing, small pauses, understated emphasis, and a calm reflective tone. Avoid sounding like a customer support agent, announcer, or screen reader.</textarea>
        <p class="hint">PidginDocs now writes a research memo, then a spoken script, then hands narration to OpenAI, ElevenLabs, or Gemini.</p>
        <label for="minutes">Minutes</label>
        <input id="minutes" name="minutes" type="number" min="1" max="10" value="3" ${commuteDisabled ? "disabled" : ""} required>
        <button type="submit" ${commuteDisabled ? "disabled" : ""}>Save commute settings</button>
      </form>
      ${status.commute.updated_at ? `<p class="hint">Updated ${new Date(status.commute.updated_at + "Z").toLocaleString()}</p>` : ""}
    </div>
    <div class="card">
      <h2>iOS Push</h2>
      <div class="badge ${status.push.apns_configured ? "connected" : "unavailable"}">${status.push.apns_configured ? "Configured" : "Not configured"}</div>
      <p class="hint">${status.push.apns_configured
        ? `APNs credentials are set. ${status.push.device_count} iOS device${status.push.device_count !== 1 ? "s" : ""} registered.`
        : "Add APNS_KEY_ID, APNS_TEAM_ID, and APNS_PRIVATE_KEY to the worker to enable iOS push notifications."}</p>
      ${status.push.device_count > 0 ? `<p class="hint">Devices register automatically when the iOS app launches.</p>` : ""}
    </div>
    ${apiKeysCard}
  </div>
  <h2 style="font-family:Georgia,serif;color:${theme.ink};margin:2.4rem 0 .3rem">Document styles</h2>
  <p class="hint" style="margin:0 0 1rem;max-width:640px">The builtin style stack for published documents. Agents pick one with <code>design_system</code> and write in its narrative voice — hover a card to read the voice.</p>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:1rem">
    ${styleGalleryCards()}
  </div>
<script>
function copyKey() {
  var el = document.getElementById('newkey');
  if (el && navigator.clipboard) { navigator.clipboard.writeText(el.textContent); }
}
function toggleTtsFields() {
  var sel = document.getElementById('tts_provider');
  if (!sel) return;
  var v = sel.value;
  document.getElementById('openai-fields').style.display = v === 'openai' ? '' : 'none';
  document.getElementById('elevenlabs-fields').style.display = v === 'elevenlabs' ? '' : 'none';
  document.getElementById('gemini-fields').style.display = v === 'gemini' ? '' : 'none';
}
</script>
</body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

export function commutePage(briefings: CommuteBriefingListItem[]): Response {
  const cards = briefings
    .map(
      (briefing) => `<div class="briefing-card">
        <div class="briefing-top">
          <div>
            <div class="briefing-title">${esc(briefing.title)}</div>
            <div class="briefing-meta">${esc(briefing.instance_project)} &middot; ${esc(briefing.instance_model)} &middot; ${new Date(briefing.created_at + "Z").toLocaleString()}</div>
          </div>
          <span class="badge ${briefing.audio_key ? "ready" : "partial"}">${briefing.audio_key ? "audio ready" : "transcript only"}</span>
        </div>
        <div class="briefing-actions">
          ${briefing.audio_key ? `<audio controls preload="none" src="/api/commute/${esc(briefing.source_message_id)}/audio"></audio>` : `<div class="hint">Audio generation fell back to transcript only.</div>`}
          <div class="links">
            <a href="/api/commute/${esc(briefing.source_message_id)}/transcript" target="_blank">Transcript</a>
            <a href="/api/docs/${esc(briefing.source_message_id)}" target="_blank">Source doc</a>
          </div>
          ${briefing.error ? `<div class="hint error">${esc(briefing.error)}</div>` : ""}
        </div>
      </div>`
    )
    .join("");

  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PidginDocs - Commute</title>
<style>
  body{font-family:Inter,-apple-system,sans-serif;background:${theme.sand};color:${theme.ink};margin:0;padding:2rem}
  .header{display:flex;justify-content:space-between;align-items:center;max-width:760px;margin:0 auto 2rem;gap:1rem;flex-wrap:wrap}
  h1{font-family:Georgia,serif;font-size:1.6rem;color:${theme.ink};margin:0}
  .header-links a{color:${theme.primary};text-decoration:none;margin-left:1rem;font-size:.88rem}
  .header-links a:hover{text-decoration:underline}
  .sub{max-width:760px;margin:0 auto 1rem;color:${theme.muted}}
  .sub a{color:${theme.primary};text-decoration:none;font-weight:600}
  .briefing-card{background:${theme.paper};border-radius:12px;padding:1.25rem 1.4rem;margin:0 auto 1rem;max-width:760px;box-shadow:0 2px 18px rgba(43,31,24,.05)}
  .briefing-top{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;flex-wrap:wrap}
  .briefing-title{font-size:1rem;font-weight:700;color:${theme.ink}}
  .briefing-meta{font-size:.8rem;color:${theme.dim};margin-top:.35rem}
  .badge{display:inline-block;padding:.2rem .55rem;border-radius:999px;font-size:.72rem;text-transform:uppercase;font-weight:700;letter-spacing:.05em}
  .badge.ready{background:${theme.badgeAnsweredBg};color:${theme.badgeAnsweredText}}
  .badge.partial{background:${theme.badgeQuestionBg};color:${theme.idle}}
  .briefing-actions{margin-top:1rem}
  audio{width:100%;max-width:520px}
  .links{display:flex;gap:1rem;flex-wrap:wrap;margin-top:.8rem}
  .links a{color:${theme.primary};text-decoration:none;font-weight:600}
  .links a:hover{text-decoration:underline}
  .hint{font-size:.82rem;color:${theme.dim};margin-top:.8rem}
  .hint.error{color:${theme.error}}
  .empty{text-align:center;color:${theme.dim};padding:3rem;font-size:.95rem;background:${theme.paper};border-radius:12px;max-width:760px;margin:0 auto;box-shadow:0 2px 18px rgba(43,31,24,.05)}
</style></head><body>
<div class="header">
  <div>
    <h1>Commute briefings</h1>
    <div class="sub">Private listen-back audio PidginDocs generated from your document messages. Quick-open the newest one at <a href="/commute/latest">/commute/latest</a>.</div>
  </div>
  <div class="header-links"><a href="/inbox">Inbox</a><a href="/workspace">Workspace</a><a href="/toc">Documents</a><a href="/setup">Setup</a><a href="/auth/logout">Logout</a></div>
</div>
${briefings.length === 0 ? '<div class="empty">No commute briefings yet. Post a document after setup to generate one.</div>' : cards}
</body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

export function latestCommutePage(
  briefing: CommuteBriefingListItem | null,
  transcript?: string
): Response {
  if (!briefing) {
    return new Response(
      `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PidginDocs - Latest Commute</title>
<style>
  body{font-family:Inter,-apple-system,sans-serif;background:${theme.sand};color:${theme.ink};margin:0;padding:2rem;display:flex;justify-content:center}
  .card{max-width:720px;width:100%;background:${theme.paper};border-radius:18px;padding:1.6rem;box-shadow:0 2px 20px rgba(43,31,24,.06)}
  h1{font-family:Georgia,serif;font-size:1.7rem;margin:0 0 .4rem;color:${theme.ink}}
  p{color:${theme.muted};line-height:1.5}
  a{color:${theme.primary};text-decoration:none;font-weight:600}
  a:hover{text-decoration:underline}
</style></head><body>
<div class="card">
  <h1>No commute briefings yet</h1>
  <p>Post a document after setup and PidginDocs will place the latest listen-back here.</p>
  <p><a href="/commute">Open the commute library</a></p>
</div>
</body></html>`,
      { headers: { "Content-Type": "text/html" } }
    );
  }

  const transcriptPreview = (transcript || "")
    .split("\n")
    .filter(Boolean)
    .slice(0, 10)
    .join("\n\n");

  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PidginDocs - Latest Commute</title>
<style>
  body{font-family:Inter,-apple-system,sans-serif;background:linear-gradient(180deg,#EDE0C8 0%,${theme.sand} 55%,#E0D4BC 100%);color:${theme.ink};margin:0;padding:1rem}
  .shell{max-width:760px;margin:0 auto}
  .top{display:flex;justify-content:space-between;align-items:center;gap:1rem;margin-bottom:1rem;flex-wrap:wrap}
  .top a{color:${theme.primary};text-decoration:none;font-weight:700}
  .top a:hover{text-decoration:underline}
  .hero{background:rgba(250,244,232,.92);backdrop-filter:blur(12px);border-radius:24px;padding:1.4rem;box-shadow:0 10px 40px rgba(43,31,24,.08)}
  h1{font-family:Georgia,serif;font-size:2rem;line-height:1.05;margin:0 0 .45rem;color:${theme.ink}}
  .meta{color:${theme.dim};font-size:.88rem}
  .badge{display:inline-block;margin-top:.9rem;padding:.28rem .65rem;border-radius:999px;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
  .badge.ready{background:${theme.badgeAnsweredBg};color:${theme.badgeAnsweredText}}
  .badge.partial{background:${theme.badgeQuestionBg};color:${theme.idle}}
  .player,.transcript{background:${theme.paper};border-radius:20px;padding:1.2rem;margin-top:1rem;box-shadow:0 8px 26px rgba(43,31,24,.06)}
  .section-title{font-size:.82rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:${theme.dim};margin-bottom:.7rem}
  audio{width:100%}
  .hint{color:${theme.muted};line-height:1.5}
  pre{white-space:pre-wrap;word-break:break-word;font-family:Georgia,serif;font-size:1rem;line-height:1.6;margin:0;color:${theme.ink}}
  .links{display:flex;gap:1rem;flex-wrap:wrap;margin-top:1rem}
  .links a{color:${theme.primary};text-decoration:none;font-weight:700}
  .links a:hover{text-decoration:underline}
  .error{margin-top:.8rem;color:${theme.error};font-size:.85rem}
</style></head><body>
<div class="shell">
  <div class="top">
    <a href="/commute">All commute briefings</a>
    <a href="/">Inbox</a>
  </div>
  <div class="hero">
    <div class="meta">Latest commute briefing</div>
    <h1>${esc(briefing.title)}</h1>
    <div class="meta">${esc(briefing.instance_project)} &middot; ${esc(briefing.instance_model)} &middot; ${new Date(briefing.created_at + "Z").toLocaleString()}</div>
    <div class="badge ${briefing.audio_key ? "ready" : "partial"}">${briefing.audio_key ? "audio ready" : "transcript only"}</div>
  </div>
  <div class="player">
    <div class="section-title">Listen</div>
    ${briefing.audio_key ? `<audio controls preload="metadata" src="/api/commute/${esc(briefing.source_message_id)}/audio"></audio>` : `<div class="hint">Audio was not available for this run, so PidginDocs kept the transcript instead.</div>`}
    <div class="links">
      <a href="/api/commute/${esc(briefing.source_message_id)}/transcript" target="_blank">Open full transcript</a>
      <a href="/api/docs/${esc(briefing.source_message_id)}" target="_blank">Open source document</a>
      ${briefing.audio_key ? `<a href="/api/commute/${esc(briefing.source_message_id)}/audio" target="_blank">Open raw audio</a>` : ""}
    </div>
    ${briefing.error ? `<div class="error">${esc(briefing.error)}</div>` : ""}
  </div>
  <div class="transcript">
    <div class="section-title">Preview</div>
    <pre>${esc(transcriptPreview || "Transcript not available.")}</pre>
  </div>
</div>
</body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

export function registryPage(instances: any[]): Response {
  const now = Date.now();
  const rows = instances.map((inst: any) => {
    const heartbeatMs = new Date(inst.last_heartbeat + "Z").getTime();
    const ageMs = now - heartbeatMs;
    const stale = ageMs > 5 * 60 * 1000;
    const ageLabel = ageMs < 60000
      ? `${Math.round(ageMs / 1000)}s ago`
      : ageMs < 3600000
        ? `${Math.round(ageMs / 60000)}m ago`
        : `${Math.round(ageMs / 3600000)}h ago`;
    const registeredMs = inst.registered_at ? new Date(inst.registered_at + "Z").getTime() : heartbeatMs;
    const uptimeSec = Math.round((now - registeredMs) / 1000);
    const uptimeLabel = uptimeSec < 60
      ? `${uptimeSec}s`
      : uptimeSec < 3600
        ? `${Math.floor(uptimeSec / 60)}m`
        : `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;
    return `<tr class="${stale ? "stale" : "active"}">
      <td><span class="dot ${stale ? "dot-stale" : "dot-live"}"></span></td>
      <td class="mono" title="${esc(inst.instance_id)}">${esc(inst.instance_id.slice(0, 12))}…</td>
      <td>${esc(inst.project)}</td>
      <td class="dim">${esc(inst.model)}</td>
      <td class="dim">${esc(inst.source)}</td>
      <td>${inst.working_on
        ? /^https?:\/\//.test(inst.working_on)
          ? `<a href="${esc(inst.working_on)}" target="_blank" rel="noopener" class="working" title="${esc(inst.working_on)}" style="color:${theme.badgeStatusText};text-overflow:ellipsis;overflow:hidden;display:inline-block;max-width:22ch">${esc(inst.working_on.replace(/^https?:\/\//, "").slice(0, 40))}</a>`
          : inst.working_on.length > 40
            ? `<span class="working" title="${esc(inst.working_on)}">${esc(inst.working_on.slice(0, 40))}…</span>`
            : `<span class="working" title="${esc(inst.working_on)}">${esc(inst.working_on)}</span>`
        : '<span class="dim">—</span>'}</td>
      <td class="dim ${stale ? "stale-time" : ""}" title="Heartbeat: ${ageLabel}">${ageLabel}</td>
      <td class="dim" title="Running for ${uptimeLabel}">${uptimeLabel}</td>
      <td><button class="dereg-btn" onclick="deregister('${esc(inst.instance_id)}', this)">✕</button></td>
    </tr>`;
  }).join("");

  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PidginDocs - Instances</title>
<style>
  body{font-family:Inter,-apple-system,sans-serif;background:#FBF7F0;color:#2C2321;margin:0;padding:2rem}
  .header{display:flex;justify-content:space-between;align-items:center;max-width:900px;margin:0 auto 2rem;gap:1rem;flex-wrap:wrap}
  h1{font-family:Georgia,serif;font-size:1.5rem;color:${theme.ink};margin:0}
  a{color:${theme.accent};text-decoration:none}a:hover{text-decoration:underline}
  table{width:100%;max-width:900px;margin:0 auto;border-collapse:collapse;font-size:.88rem}
  th{text-align:left;padding:.5rem .75rem;background:${theme.ink};color:#FBF7F0;font-size:.75rem;
    text-transform:uppercase;letter-spacing:.04em}
  th:first-child{border-radius:6px 0 0 0}th:last-child{border-radius:0 6px 0 0}
  td{padding:.55rem .75rem;border-bottom:1px solid ${theme.borderLight}}
  .dim{color:${theme.dim}}
  .mono{font-family:ui-monospace,monospace;font-size:.82rem}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%}
  .dot-live{background:#4f9c6f}
  .dot-stale{background:${theme.accent}}
  tr.stale td{opacity:.7}
  .stale-time{color:${theme.accent}}
  .working{font-size:.82rem;color:${theme.ink};max-width:22ch;display:inline-block;
    overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  .empty{text-align:center;color:${theme.dim};padding:3rem;font-size:.95rem}
  .count{font-size:.85rem;color:${theme.dim};margin-left:.6rem}
  .dereg-btn{background:none;border:none;color:${theme.dim};cursor:pointer;font-size:.9rem;
    padding:.1rem .35rem;border-radius:3px}
  .dereg-btn:hover{background:#F0DDD6;color:${theme.accent}}
</style></head><body>
<div class="header">
  <h1>Running instances<span class="count">${instances.length} total, ${instances.filter((i: any) => (now - new Date(i.last_heartbeat + "Z").getTime()) < 5 * 60 * 1000).length} live</span></h1>
  <div style="display:flex;gap:1rem;align-items:center"><span class="dim" id="refresh-msg" style="font-size:.78rem">Refreshes in 60s</span><a href="/inbox">Inbox</a><a href="/toc">Documents</a><a href="/setup">Setup</a></div>
</div>
${instances.length === 0
  ? '<div class="empty">No registered instances. Agent sessions register with the PidginDocs shell client.</div>'
  : `<table>
      <thead><tr><th></th><th>Instance ID</th><th>Project</th><th>Model</th><th>Source</th><th>Working on</th><th>Heartbeat</th><th>Uptime</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`}
<script>
async function deregister(instanceId, btn) {
  btn.disabled = true;
  try {
    var res = await fetch('/api/register/' + encodeURIComponent(instanceId), {
      method: 'DELETE',
      credentials: 'same-origin'
    });
    if (res.ok || res.status === 404) { btn.closest('tr').remove(); }
    else { btn.disabled = false; }
  } catch (e) { btn.disabled = false; }
}
(function autoRefresh() {
  var el = document.getElementById('refresh-msg');
  var secs = 60;
  setInterval(function() {
    secs--;
    if (el) el.textContent = 'Refreshes in ' + secs + 's';
    if (secs <= 0) location.reload();
  }, 1000);
})();
</script>
</body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

export function statsPage(stats: {
  messages_per_day: Array<{ day: string; count: number }>;
  top_projects: Array<{ project: string; count: number }>;
  top_models: Array<{ model: string; count: number }>;
}): Response {
  const maxDay = Math.max(...stats.messages_per_day.map((r) => r.count), 1);
  const dayBars = stats.messages_per_day.map((r) => {
    const pct = Math.round((r.count / maxDay) * 100);
    return `<div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.3rem">
      <span style="width:70px;font-size:.78rem;color:${theme.muted};text-align:right">${esc(r.day.slice(5))}</span>
      <div style="flex:1;background:#F0E8E0;border-radius:3px;height:18px;position:relative">
        <div style="background:${theme.accent};border-radius:3px;height:100%;width:${pct}%"></div>
      </div>
      <span style="width:30px;font-size:.78rem;font-weight:600;color:#4A3F35">${r.count}</span>
    </div>`;
  }).join("");

  const projectRows = stats.top_projects.map((r) =>
    `<tr><td style="padding:.25rem .5rem">${esc(r.project)}</td><td style="padding:.25rem .5rem;text-align:right;font-weight:600">${r.count}</td></tr>`
  ).join("");

  const modelRows = stats.top_models.map((r) =>
    `<tr><td style="padding:.25rem .5rem">${esc(r.model)}</td><td style="padding:.25rem .5rem;text-align:right;font-weight:600">${r.count}</td></tr>`
  ).join("");

  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PidginDocs — Stats</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#FAF6F0;color:#4A3F35;padding:1.5rem;max-width:700px;margin:0 auto}
  h1{margin-bottom:1rem;font-size:1.4rem}
  h2{font-size:1rem;color:${theme.muted};margin:1.5rem 0 .5rem}
  nav a{margin-right:1rem;color:${theme.accent};text-decoration:none;font-size:.85rem}
  table{border-collapse:collapse;width:100%}
  td{border-bottom:1px solid #F0E8E0}
  tr:last-child td{border:none}
</style></head><body>
<nav><a href="/inbox">← Inbox</a><a href="/registry">Instances</a></nav>
<h1>Activity Stats</h1>
<h2>Messages per day (past 7 days)</h2>
${dayBars || '<p style="color:${theme.muted};font-size:.85rem">No data yet</p>'}
<h2>Top projects</h2>
<table>${projectRows || '<tr><td style="color:${theme.muted};padding:.25rem .5rem">No data</td></tr>'}</table>
<h2>Top models</h2>
<table>${modelRows || '<tr><td style="color:${theme.muted};padding:.25rem .5rem">No data</td></tr>'}</table>
</body></html>`, { headers: { "Content-Type": "text/html" } });
}

function esc(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
