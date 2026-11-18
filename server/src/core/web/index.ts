import { resourceSharingControl, resourceSharingScript, resourceSharingStyles } from "./resource-sharing";
import { oauthConnectionsPanel, OAUTH_CONNECTIONS_JS } from "./oauth-connections";
import type { CommuteBriefingListItem } from "../commute/store";
import type { SetupStatus } from "../setup/status";
import type { Env } from "../types";
import { linkSegments } from "../short-links";
import { appPath, clientBase, routePath } from "../base-path";
import { editionProductName } from "../edition-hooks";
import { productText, contentAttribute, editionSlug } from "../wire-names";
import { compileDesignSystem } from "../documents/design-system";
import { BUILTIN_DESIGN_SYSTEMS } from "../documents/styles";
import { navButton, navStar } from "./nav-shell";
import { appShellCss, appShellHeader, LIBRARY_TABS_CSS, libraryTabsHtml } from "./app-shell";
import type { ShellConfig } from "./app-shell";
import { theme } from "./theme";
import { pageHeaders } from "../page-csp";
import { COMMUTE_SCRIPT_MODEL, COMMUTE_SPEECH_MODEL } from "../ai/tiers";

export interface TeamUpdateItem {
  id: string;
  kind: string;
  event_type: string | null;
  title: string;
  body: string | null;
  link: string | null;
  created_at: string;
  read: boolean;
}

// The badge for each kind of update; the title and body are names and text from the team.
const TEAM_UPDATE_BADGES: Record<string, string> = {
  "member.joined": "Joined",
  "question.replied": "Reply",
  "handoff.posted": "Handoff",
};

function teamUpdatesSection(items: TeamUpdateItem[], base: string): string {
  if (!items.length) return "";
  const unread = items.filter((item) => !item.read).length;
  const rows = items.map((item) => {
    const badge = item.kind === "system" ? "Reminder" : TEAM_UPDATE_BADGES[item.event_type ?? ""] ?? "Team";
    // Links are made by the server and always stay on this site.
    const link = item.link && item.link.startsWith("/") && !item.link.startsWith("//") && !item.link.startsWith("/\\") ? appPath(base, item.link) : null;
    const title = `<span ${contentAttribute()}>${esc(item.title)}</span>`;
    return `<li class="${item.read ? "" : "unread"}" data-update-id="${esc(item.id)}">
      <span class="badge status">${badge}</span>
      <div class="team-update-text">
        ${link ? `<a href="${esc(link)}" data-on-click="markUpdate" data-update-action="read">${title}</a>` : `<strong>${title}</strong>`}
        ${item.body ? `<div class="body-preview"><span ${contentAttribute()}>${esc(item.body.slice(0, 200))}</span></div>` : ""}
      </div>
      <span class="dim ts" data-ts="${esc(item.created_at)}">${esc(item.created_at)}</span>
      <span style="white-space:nowrap">
        ${item.read ? "" : `<button type="button" class="update-btn update-read" data-on-click="markUpdate" data-update-action="read">Mark read</button>`}
        <button type="button" class="update-btn" data-on-click="markUpdate" data-update-action="dismiss">Dismiss</button>
      </span>
    </li>`;
  }).join("");
  return `<section class="team-updates" aria-labelledby="team-updates-heading">
  <h2 id="team-updates-heading"><span>Team updates</span>${unread ? `<span class="unread-badge">${unread}</span>` : ""}</h2>
  <ul>${rows}</ul>
</section>`;
}

export function inboxPage(messages: any[], filters: { typeFilter?: string; unreadOnly?: boolean; offset?: number; hasMore?: boolean; instanceCount?: number; pendingCount?: number; projectFilter?: string; repliedFilter?: string; sourceFilter?: string; teamUpdates?: TeamUpdateItem[]; base?: string; shell?: ShellConfig } = {}): Response {
  const { typeFilter = "", unreadOnly = false, offset = 0, hasMore = false, instanceCount, pendingCount, projectFilter = "", repliedFilter = "", sourceFilter = "", teamUpdates = [], base = "", shell } = filters;
  const nonce = crypto.randomUUID();
  const unreadCount = messages.filter((m: any) => !m.read).length;
  // In the script below, the unread-count block stays after keyNav on purpose. scripts/extract-web-labels.mjs
  // numbers each ${...} in this template by position, and the stored label for keyNav's outline colour carries that number.
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
                <input type="text" class="reply-input" id="reply-input-${m.id}" placeholder="Type your reply..." data-on-keydown="replyOnEnter" data-id="${esc(m.id)}">
                <button class="reply-btn" data-on-click="reply" data-id="${esc(m.id)}">Reply</button>
              </div>`
          : "";
        return `<tr class="${[isUnread ? "unread" : "", isUrgent ? "urgent" : ""].filter(Boolean).join(" ")}" id="row-${m.id}">
          <td><span class="badge ${m.type}${m.type === "question" && m.reply ? " answered" : ""}">${m.type === "question" && m.reply ? "answered" : m.type}</span></td>
          <td>
            ${m.type === "document"
              ? `<a href="${appPath(base, `/${m.interactive ? "idoc" : "docs"}/${m.link_segment ?? m.id}`)}" data-dnav-title="${esc(m.title)}">${isUrgent ? '<span class="priority-dot"></span>' : ""}<span ${contentAttribute()}>${esc(m.title)}</span></a>`
              : `<strong><a href="${appPath(base, `/messages/${m.link_segment ?? m.id}`)}" data-dnav-title="${esc(m.title)}">${isUrgent ? '<span class="priority-dot"></span>' : ""}<span ${contentAttribute()}>${esc(m.title)}</span></a></strong>`}
            ${visualCount > 0 ? `<span class="visual-count">${visualCount} visual${visualCount === 1 ? "" : "s"}</span>` : ""}
            ${bodySnippet ? `<div class="body-preview" id="preview-${m.id}"><span ${contentAttribute()}>${bodySnippet}</span>${hasMore ? `<span class="more-link" data-on-click="expand" data-id="${esc(m.id)}">… <span style="color:${theme.accent};cursor:pointer">more</span></span>` : ""}</div>
            ${hasMore ? `<div class="body-full" id="full-${m.id}" style="display:none"><span ${contentAttribute()}>${esc(rawBody)}</span></div>` : ""}` : ""}
            ${m.source_url ? `<div class="source-link"><a href="${esc(m.source_url)}" target="_blank" rel="noopener">↗ ${esc(m.source_url.replace(/^https?:\/\//, "").slice(0, 60))}</a></div>` : ""}
            ${replySection}
          </td>
          <td class="dim">${esc(m.instance_project)}</td>
          <td class="dim" title="${esc(m.instance_source || "")} · ${esc(m.instance_session_id || "")}">${esc(m.instance_model)}</td>
          <td class="dim ts" data-ts="${m.created_at}" title="${new Date(m.created_at).toLocaleString()}">${new Date(m.created_at).toLocaleString()}</td>
          <td style="white-space:nowrap">
            ${!isUnread ? `<button class="unread-btn" data-on-click="unread" data-id="${esc(m.id)}" title="Mark unread">●</button>` : ""}
            <button class="pri-btn" data-on-click="priority" data-id="${esc(m.id)}" data-priority="${esc(m.priority)}" title="${isUrgent ? "Downgrade to normal" : "Upgrade to urgent"}">${isUrgent ? "↓" : "↑"}</button>
            <button class="del-btn" data-on-click="remove" data-id="${esc(m.id)}" title="Delete">✕</button>
          </td>
        </tr>`;
      }
    )
    .join("");

  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${editionProductName()} - Inbox</title>
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
  tr.key-active{outline:2px solid ${theme.accent}}
  .del-btn:hover{background:#F0DDD6;color:${theme.accent}}
  .unread-btn:hover{background:${theme.badgeStatusBg};color:${theme.badgeStatusText}}
  .pri-btn:hover{background:${theme.badgeQuestionBg};color:${theme.badgeQuestionText}}
  .new-banner{display:none;position:sticky;top:0;z-index:10;background:${theme.accent};color:#fff;
    text-align:center;padding:.5rem;font-size:.85rem;font-weight:600;cursor:pointer}
  .new-banner.show{display:block}
  .new-banner:hover{background:#a85540}
  .team-updates{max-width:900px;margin:0 auto 1.5rem}
  .team-updates h2{font-family:Georgia,serif;font-size:1.05rem;margin:0 0 .5rem}
  .team-updates ul{list-style:none;margin:0;padding:0;border-top:1px solid ${theme.line}}
  .team-updates li{display:flex;gap:.75rem;align-items:flex-start;padding:.55rem .75rem;border-bottom:1px solid ${theme.line};font-size:.88rem}
  .team-updates li.unread{background:#FFFCF9;border-left:3px solid ${theme.accent}}
  .team-update-text{flex:1;min-width:0}
  .update-btn{background:none;border:1px solid ${theme.borderLight};border-radius:5px;padding:.2rem .5rem;font-size:.75rem;cursor:pointer;color:${theme.ink}}
  .update-btn:hover{background:${theme.badgeStatusBg}}
${shell ? appShellCss(shell.brand) : ""}</style></head><body>
${shell ? appShellHeader({ ...shell, base, active: "inbox" }) : ""}<div class="new-banner" id="new-banner" data-on-click="reload">New messages — click to refresh</div>
<div class="filter-bar" style="margin-bottom:.25rem">
  <input type="search" id="inbox-search" placeholder="Search messages…" data-on-input="search" style="flex:1;min-width:180px">
</div>
<form class="filter-bar" method="GET" action="${appPath(base, "/inbox")}">
  <select name="type" data-on-change="submitForm">
    <option value="" ${!typeFilter ? "selected" : ""}>All types</option>
    <option value="message" ${typeFilter === "message" ? "selected" : ""}>Messages</option>
    <option value="question" ${typeFilter === "question" ? "selected" : ""}>Questions</option>
    <option value="status" ${typeFilter === "status" ? "selected" : ""}>Status</option>
    <option value="document" ${typeFilter === "document" ? "selected" : ""}>Documents</option>
  </select>
  <input type="text" name="project" placeholder="Project…" value="${esc(projectFilter)}" style="width:120px;padding:.35rem .6rem;border:1px solid ${theme.borderLight};border-radius:5px;font-size:.82rem" data-on-change="submitForm">
  <input type="text" name="source" placeholder="Source…" value="${esc(sourceFilter)}" style="width:100px;padding:.35rem .6rem;border:1px solid ${theme.borderLight};border-radius:5px;font-size:.82rem" data-on-change="submitForm">
  <label style="display:flex;align-items:center;gap:.3rem;font-size:.82rem;cursor:pointer">
    <input type="checkbox" name="unread" value="true" ${unreadOnly ? "checked" : ""} data-on-change="submitForm"> Unread only
  </label>
  <a href="${appPath(base, "/inbox?type=question&replied=false")}" style="font-size:.78rem;padding:.35rem .6rem;border-radius:5px;background:${theme.badgeQuestionBg};color:${theme.badgeQuestionText};font-weight:600;text-decoration:none">Pending questions${pendingCount != null && pendingCount > 0 ? ` <span style="background:${theme.badgeQuestionText};color:#fff;border-radius:9px;padding:.05rem .4rem;font-size:.7rem;font-weight:700">${pendingCount}</span>` : ""}</a>
  ${typeFilter || unreadOnly || projectFilter || repliedFilter || sourceFilter ? `<a href="${appPath(base, "/inbox")}" style="font-size:.78rem;color:${theme.accent}">Clear filters</a>` : ""}
</form>
  <div class="header">
  <h1>${shell ? "Inbox" : editionProductName()}${messages.length > 0 && unreadCount > 0 ? `<span class="unread-badge">${unreadCount}</span>` : ""}</h1>
  <div style="display:flex;gap:.75rem;align-items:center;flex-wrap:wrap">
    ${unreadCount > 0 ? `<button class="mark-read-btn" data-on-click="markAllRead">Mark all read</button>` : ""}
    ${shell ? "" : `<a href="${appPath(base, "/workspace")}">Workspace</a>
    <a href="${appPath(base, "/toc")}">Documents</a>
    <a href="${appPath(base, "/audio")}">Audio</a>
    <a href="${appPath(base, "/registry")}">Instances${instanceCount != null && instanceCount > 0 ? ` <span style="background:${theme.badgeAnsweredText};color:#fff;border-radius:9px;padding:.05rem .4rem;font-size:.72rem;font-weight:700">${instanceCount}</span>` : ""}</a>
    <a href="${appPath(base, "/stats")}">Stats</a>
    <a href="${appPath(base, "/profile")}">Profile</a>
    <a href="${appPath(base, "/setup")}">Setup</a>
    <a href="${appPath(base, "/auth/logout")}">Logout</a>
    ${navButton()}`}
  </div>
</div>
${offset === 0 ? teamUpdatesSection(teamUpdates, base) : ""}
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
  const pageUrl = appPath(base, "/inbox" + (params.toString() ? "?" + params.toString() : ""));
  const prevOffset = Math.max(0, offset - 50);
  const nextOffset = offset + 50;
  if (!hasMore && offset === 0) return "";
  return `<div style="display:flex;gap:.75rem;justify-content:center;padding:1rem;max-width:900px;margin:0 auto">
    ${offset > 0 ? `<a href="${pageUrl}${pageUrl.includes("?") ? "&" : "?"}offset=${prevOffset}" style="color:${theme.accent};text-decoration:none;font-size:.88rem">← Newer</a>` : ""}
    ${offset > 0 ? `<span style="font-size:.82rem;color:${theme.dim}">Page ${Math.floor(offset / 50) + 1}</span>` : ""}
    ${hasMore ? `<a href="${pageUrl}${pageUrl.includes("?") ? "&" : "?"}offset=${nextOffset}" style="color:${theme.accent};text-decoration:none;font-size:.88rem">Older →</a>` : ""}
  </div>`;
})()}
<script nonce="${nonce}">
${clientBase(base)}
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
    fetch(APP_BASE + '/api/messages/' + messageId, { method: 'PATCH', credentials: 'same-origin' }).catch(function(){});
  }
}
async function markUnread(messageId, btn) {
  btn.disabled = true;
  try {
    var res = await fetch(APP_BASE + '/api/messages/' + messageId, {
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
    var res = await fetch(APP_BASE + '/api/messages/' + messageId + '/priority', {
      method: 'PATCH', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: newPriority }),
    });
    if (res.ok) {
      var row = document.getElementById('row-' + messageId);
      if (row) {
        if (newPriority === 'urgent') { row.classList.add('urgent'); btn.textContent = '↓'; btn.title = 'Downgrade to normal'; }
        else { row.classList.remove('urgent'); btn.textContent = '↑'; btn.title = 'Upgrade to urgent'; }
        btn.dataset.priority = newPriority;
      }
    }
  } catch (e) {}
  btn.disabled = false;
}
async function deleteMessage(messageId, btn) {
  btn.disabled = true;
  try {
    var res = await fetch(APP_BASE + '/api/messages/' + messageId, { method: 'DELETE', credentials: 'same-origin' });
    if (res.ok) {
      var row = document.getElementById('row-' + messageId);
      if (row) row.remove();
    } else { btn.disabled = false; }
  } catch (e) { btn.disabled = false; }
}
async function markUpdate(control, action) {
  var row = control.closest('li');
  if (!row) return;
  var button = control.matches('button') ? control : null;
  if (button) button.disabled = true;
  try {
    // keepalive: following the update's link must not cancel marking it read.
    var res = await fetch(APP_BASE + '/api/inbox/' + encodeURIComponent(row.dataset.updateId) + '/' + action, { method: 'POST', credentials: 'same-origin', keepalive: true });
    if (!res.ok) { if (button) button.disabled = false; return; }
    if (action === 'dismiss') { row.remove(); return; }
    row.classList.remove('unread');
    var read = row.querySelector('.update-read');
    if (read) read.remove();
  } catch (e) { if (button) button.disabled = false; }
}
async function markAllRead() {
  var btn = document.querySelector('.mark-read-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Marking...'; }
  try {
    var res = await fetch(APP_BASE + '/api/messages/read-all', { method: 'PATCH', credentials: 'same-origin' });
    if (res.ok) { location.reload(); }
    else if (btn) { btn.disabled = false; btn.textContent = 'Mark all read'; }
  } catch (e) { if (btn) { btn.disabled = false; btn.textContent = 'Mark all read'; } }
}
async function sendReply(messageId) {
  var input = document.getElementById('reply-input-' + messageId);
  var btn = input.parentElement.querySelector('.reply-btn');
  if (!input.value.trim()) return;
  btn.disabled = true;
  btn.textContent = 'Sending...';
  try {
    var res = await fetch(APP_BASE + '/api/reply', {
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
    if (cur >= 0 && rows[cur]) rows[cur].classList.remove('key-active');
    cur = Math.max(0, Math.min(idx, rows.length - 1));
    if (rows[cur]) {
      rows[cur].classList.add('key-active');
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
(function startPolling() {
  var initialUnread = ${unreadCount};
  function poll() {
    fetch(APP_BASE + '/api/messages?limit=1', { credentials: 'same-origin' })
      .then(function(r) {
        var c = parseInt(r.headers.get('X-Unread-Count') || '0', 10);
        if (c > initialUnread) { document.getElementById('new-banner').classList.add('show'); }
      })
      .catch(function(){});
  }
  setInterval(poll, 30000);
})();
(function wireHandlers() {
  var clicks = {
    markUpdate: function(el) { markUpdate(el, el.dataset.updateAction); },
    reply: function(el) { sendReply(el.dataset.id); },
    expand: function(el) { expandBody(el.dataset.id); },
    unread: function(el) { markUnread(el.dataset.id, el); },
    priority: function(el) { togglePriority(el.dataset.id, el.dataset.priority, el); },
    remove: function(el) { deleteMessage(el.dataset.id, el); },
    reload: function() { location.reload(); },
    markAllRead: function() { markAllRead(); }
  };
  var keys = { replyOnEnter: function(el, e) { if (e.key === 'Enter') sendReply(el.dataset.id); } };
  var inputs = { search: function(el) { filterRows(el.value); } };
  var changes = { submitForm: function(el) { if (el.form) el.form.submit(); } };
  document.addEventListener('click', function(e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-on-click]') : null;
    if (el && clicks[el.dataset.onClick]) clicks[el.dataset.onClick](el, e);
  });
  document.addEventListener('keydown', function(e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-on-keydown]') : null;
    if (el && keys[el.dataset.onKeydown]) keys[el.dataset.onKeydown](el, e);
  });
  document.addEventListener('input', function(e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-on-input]') : null;
    if (el && inputs[el.dataset.onInput]) inputs[el.dataset.onInput](el, e);
  });
  document.addEventListener('change', function(e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-on-change]') : null;
    if (el && changes[el.dataset.onChange]) changes[el.dataset.onChange](el, e);
  });
})();
</script>
</body></html>`,
    { headers: pageHeaders(nonce) }
  );
}

export function tocPage(docs: any[], teams: Array<{ id: string; name: string }> = [], base = "", shell?: ShellConfig): Response {
  const nonce = crypto.randomUUID();
  const rows = docs
    .map(
      (d: any) =>
        `<div class="doc-card" data-id="${esc(d.id)}" data-dnav-host data-dnav-title="${esc(d.title)}">
          <div class="doc-header">
            <span class="badge ${d.public || d.sharing === "shared" ? "public" : "private"}">${d.public ? "Public" : d.sharing === "shared" ? "Shared" : "Private"}</span>
            <span class="doc-title" ${contentAttribute()}>${esc(d.title)}</span>
            ${navStar({ kind: "doc", id: String(d.id), title: String(d.title) }, true)}
          </div>
          <div class="doc-meta">
            ${esc(d.instance_project)} &middot; ${esc(d.instance_model)} &middot; <span class="ts" data-ts="${d.created_at + "Z"}" title="${new Date(d.created_at + "Z").toLocaleString()}">${new Date(d.created_at + "Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</span>
          </div>
          <div class="doc-actions">
            <a href="${appPath(base, `/${d.interactive ? "idoc" : "docs"}/${esc(d.id)}`)}" class="btn btn-view" data-dnav-title="${esc(d.title)}">View</a>
            <button class="share-link" data-doc-id="${esc(d.id)}" data-on-click="share">↗ share</button>
            ${resourceSharingControl("document", String(d.id), d.sharing, d.team_id, teams)}
          </div>
          <div class="link-output" id="link-${esc(d.id)}" style="display:none">
            <input type="text" readonly class="link-field">
            <button class="share-link" data-on-click="copy">copy</button>
            <span class="link-expiry"></span>
          </div>
        </div>`
    )
    .join("");

  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${editionProductName()} - Documents</title>
<style>
  ${resourceSharingStyles}
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
${shell ? appShellCss(shell.brand) + LIBRARY_TABS_CSS : ""}</style></head><body>
${shell ? appShellHeader({ ...shell, base, active: "library" }) + libraryTabsHtml(base, "documents") : ""}<div class="header">
  <h1>Documents</h1>
  ${shell ? "" : `<div class="header-links"><a href="${appPath(base, "/inbox")}">Inbox</a><a href="${appPath(base, "/workspace")}">Workspace</a><a href="${appPath(base, "/audio")}">Audio</a><a href="${appPath(base, "/profile")}">Profile</a><a href="${appPath(base, "/setup")}">Setup</a><a href="${appPath(base, "/auth/logout")}">Logout</a>${navButton()}</div>`}
</div>
${
  docs.length === 0
    ? '<div class="empty">No documents yet.</div>'
    : rows
}
<div class="toast" id="toast">Copied!</div>
${resourceSharingScript.replace("<script>", `<script nonce="${nonce}">`)}
<script nonce="${nonce}">
${clientBase(base)}
async function generateLink(btn) {
  var docId = btn.dataset.docId;
  if (!docId) return;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    var res = await fetch(APP_BASE + '/api/docs/' + encodeURIComponent(docId) + '/share', { method: 'POST', credentials: 'same-origin' });
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
(function wireHandlers() {
  var clicks = {
    share: function(el) { generateLink(el); },
    copy: function(el) { copyLink(el); }
  };
  document.addEventListener('click', function(e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-on-click]') : null;
    if (el && clicks[el.dataset.onClick]) clicks[el.dataset.onClick](el, e);
  });
})();
</script>
</body></html>`,
    { headers: pageHeaders(nonce) }
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
        <span style="font-family:${v["--ds-font-heading"]};color:${v["--ds-text"]};font-weight:700;font-size:1.02rem">${esc(productText(def.displayName))}</span>
        <code style="font-family:${v["--ds-font-mono"]};font-size:.67rem;color:${v["--ds-text-muted"]};background:${v["--ds-surface"]};padding:2px 7px;border-radius:4px">${esc(def.name)}</code>
      </div>
      <p style="font-family:${v["--ds-font-body"]};color:${v["--ds-text"]};font-size:.86rem;line-height:1.55;margin:.55rem 0 .6rem">The quick brown pidgin lifts off at dawn. <span style="color:${v["--ds-accent"]};text-decoration:underline;text-underline-offset:3px">A link</span>, <code style="font-family:${v["--ds-font-mono"]};font-size:.78em;background:${v["--ds-surface"]};padding:1px 4px;border-radius:3px">code</code>, and <strong style="color:${v["--ds-positive"]}">a win</strong>.</p>
      <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap">
        ${chip("--ds-bg")}${chip("--ds-surface")}${chip("--ds-text")}${chip("--ds-text-muted")}${chip("--ds-accent")}${chip("--ds-rule")}${chip("--ds-positive")}
        <span style="margin-left:auto;font-family:${v["--ds-font-mono"]};font-size:.64rem;color:${v["--ds-text-faint"]}">${esc(firstFamily(v["--ds-font-heading"]))} · ${esc(firstFamily(v["--ds-font-body"]))}</span>
      </div>
      <p style="font-family:${v["--ds-font-body"]};color:${v["--ds-text-muted"]};font-size:.74rem;line-height:1.45;margin:.6rem 0 0">${esc(productText(def.description))}</p>
    </div>`;
  }).join("\n");
}

const SETUP_CSS = `
  :root{color-scheme:light;--setup-ink:#173d3c;--setup-muted:#536d6b;--setup-line:#d7e4e0;--setup-accent:#246c62;--setup-paper:#fffdf9}
  *{box-sizing:border-box}
  body{margin:0;background:#edf4f1;color:var(--setup-ink);font:16px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  a{color:var(--setup-accent)}a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #dc9d63;outline-offset:3px}
  .setup-shell{width:min(100% - 40px,1220px);margin:0 auto;padding:28px 0 88px}
  .setup-top{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:20px}
  .setup-brand{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--setup-ink);text-decoration:none}
  .setup-brand-mark{display:block;width:30px;height:30px;border-radius:9px;object-fit:cover}
  .setup-top-links{display:flex;align-items:center;gap:20px}.setup-top-links a{text-decoration:none;font-size:14px;font-weight:650}.setup-top-links a:hover{text-decoration:underline}
  .setup-hero{position:relative;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr) minmax(290px,.78fr);align-items:center;gap:26px;min-height:278px;padding:clamp(30px,4vw,54px);border:1px solid #c9dcd5;border-radius:24px;background:radial-gradient(circle at 84% 13%,#fce9d1 0,transparent 29%),radial-gradient(circle at 71% 100%,#cce5db 0,transparent 38%),linear-gradient(110deg,#f9f6ec,#e1f0e8 86%);box-shadow:0 17px 40px #183e3520}
  .setup-hero:after{content:"";position:absolute;right:-75px;bottom:-200px;width:490px;height:490px;border:1px solid #3d766d2b;border-radius:50%;box-shadow:0 0 0 58px #eff8ef35,0 0 0 118px #eff8ef24;pointer-events:none}
  .setup-eyebrow{margin:0 0 12px;color:#376f64;font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}
  h1{margin:0;font:500 clamp(38px,4.6vw,63px)/1.04 Georgia,"Iowan Old Style",serif;letter-spacing:-.045em;color:var(--setup-ink);max-width:13ch}
  .setup-hero p:not(.setup-eyebrow){max-width:53ch;margin:16px 0 0;color:#3f625d;font-size:16px;line-height:1.55}
  .setup-actions{display:flex;align-items:center;gap:13px;flex-wrap:wrap;margin-top:24px}.setup-action{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:10px 17px;border:1px solid var(--setup-ink);border-radius:10px;background:var(--setup-ink);color:white;text-decoration:none;font-size:14px;font-weight:750;box-shadow:0 5px 13px #1a514139}.setup-action:hover{background:#27564f;color:white}.setup-action-secondary{background:#ffffffa8;color:var(--setup-ink);box-shadow:none}.setup-action-secondary:hover{background:white;color:var(--setup-ink)}
  .setup-diagram{position:relative;z-index:1;display:grid;grid-template-columns:1fr 1fr;align-items:center;gap:12px;max-width:390px;margin-left:auto;width:100%}.setup-diagram:before{content:"";position:absolute;left:23%;right:23%;top:50%;height:2px;background:#6caa9980;z-index:-1}.setup-diagram .node{display:flex;align-items:center;gap:10px;min-height:75px;padding:14px;background:#fffdfbe8;border:1px solid #c9dbd5;border-radius:16px;box-shadow:0 8px 20px #1e4d3d16}.setup-diagram .node:nth-child(1){grid-column:1}.setup-diagram .node:nth-child(2){grid-column:2;transform:translateY(36px)}.setup-diagram .node:nth-child(3){grid-column:1;transform:translateY(-8px)}.setup-diagram .symbol{display:grid;place-items:center;flex:none;width:36px;height:36px;border-radius:11px;background:#e5f2ea;color:#235f54;font-weight:800}.setup-diagram .node:nth-child(2) .symbol{background:#f9e8d7;color:#985b31}.setup-diagram .symbol img{display:block;width:36px;height:36px;border-radius:11px;object-fit:cover}.setup-diagram strong{display:block;font-size:14px}.setup-diagram small{display:block;color:var(--setup-muted);font-size:11px}
  .setup-overview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0;margin:20px 0 45px;padding:0 18px;background:#fffdf9;border:1px solid var(--setup-line);border-radius:17px;box-shadow:0 3px 14px #214c3e0a}.setup-overview>div{display:flex;align-items:center;gap:12px;min-width:0;padding:17px 20px}.setup-overview>div+div{border-left:1px solid var(--setup-line)}.setup-overview .number{display:grid;place-items:center;flex:none;width:30px;height:30px;border-radius:50%;background:#e2eee8;color:#24584f;font-size:12px;font-weight:800}.setup-overview strong,.setup-overview span{display:block}.setup-overview strong{font-size:13px}.setup-overview span{color:var(--setup-muted);font-size:12px}
  .setup-section{margin-top:39px}.setup-section-head{display:flex;justify-content:space-between;align-items:end;gap:16px;margin-bottom:17px}.setup-section-head h2{margin:0;font:500 clamp(27px,3vw,35px)/1.1 Georgia,serif;letter-spacing:-.035em}.setup-section-head p{margin:5px 0 0;color:var(--setup-muted);font-size:14px;max-width:68ch}
  .setup-connection-grid{display:grid;grid-template-columns:minmax(0,1.26fr) minmax(300px,.74fr);gap:18px}.setup-side{display:grid;gap:18px;align-content:start}
  .card{min-width:0;padding:25px;background:var(--setup-paper);border:1px solid var(--setup-line);border-radius:18px;box-shadow:0 5px 19px #183f3310}.card h3,.card h2{margin:0;color:var(--setup-ink)}.card h2{font-size:21px;line-height:1.25;letter-spacing:-.02em}.card h3{font-size:15px}.card p{color:var(--setup-muted)}.card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.card-kicker{display:block;margin-bottom:7px;color:#608278;font-size:11px;font-weight:800;letter-spacing:.13em;text-transform:uppercase}.card-intro{max-width:55ch;margin:11px 0 0;font-size:14px;line-height:1.55}.card-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:17px}.card-meta span{display:inline-flex;padding:5px 9px;border:1px solid #d7e7df;border-radius:99px;background:#f1f8f2;color:#386d5f;font-size:12px;font-weight:650}
  .card-feature{position:relative;overflow:hidden;min-height:300px}.card-feature:before{content:"";position:absolute;right:-49px;top:-71px;width:190px;height:190px;border-radius:50%;background:radial-gradient(circle,#ffeddb,#ffeddb00 69%);pointer-events:none}.card-feature>*{position:relative}
  .badge{display:inline-flex;align-items:center;padding:5px 9px;border-radius:99px;font-size:11px;text-transform:uppercase;font-weight:800;letter-spacing:.08em;white-space:nowrap}.badge.connected{background:#e2f3e7;color:#246648}.badge.next{background:#fbead8;color:#87572d}.badge.locked{background:#eeeaf4;color:#6d627f}.badge.optional{background:#e6f0f4;color:#375e70}.badge.unavailable{background:#eeeae5;color:#706962}
  .setup-drawer{margin-top:21px;border-top:1px solid var(--setup-line);padding-top:18px}.setup-drawer summary{display:flex;align-items:center;justify-content:space-between;gap:12px;list-style:none;cursor:pointer;color:var(--setup-accent);font-size:14px;font-weight:750;min-height:36px}.setup-drawer summary::-webkit-details-marker{display:none}.setup-drawer summary:after{content:"+";display:grid;place-items:center;flex:none;width:28px;height:28px;border:1px solid var(--setup-line);border-radius:8px;color:var(--setup-accent);font-size:19px;font-weight:400}.setup-drawer[open] summary:after{content:"−"}.setup-drawer form{margin-top:18px;padding:20px;background:#f5f8f5;border:1px solid var(--setup-line);border-radius:13px}.setup-drawer form h3{margin:23px 0 12px;border-top:1px solid var(--setup-line);padding-top:20px}.setup-drawer form h3:first-of-type{margin-top:16px}.setup-drawer .hint{margin:0 0 13px}
  label{display:block;margin:0 0 5px;color:#4a6864;font-size:11px;font-weight:750;letter-spacing:.06em;text-transform:uppercase}input,textarea,select{display:block;width:100%;min-height:42px;margin:0 0 15px;padding:9px 11px;border:1px solid #bdd2cc;border-radius:8px;background:white;color:var(--setup-ink);font:inherit;font-size:14px}textarea{min-height:80px;resize:vertical}input[type=checkbox]{display:inline-block;width:18px;height:18px;min-height:0;margin:0 8px 0 0;vertical-align:-4px;accent-color:var(--setup-accent)}label:has(input[type=checkbox]){display:flex;align-items:center;min-height:36px;margin:0 0 12px;font-size:13px;letter-spacing:0;text-transform:none}
  button{cursor:pointer;border:0;border-radius:9px;padding:10px 15px;background:var(--setup-ink);color:white;font:inherit;font-size:13px;font-weight:700}button:disabled{opacity:.52;cursor:not-allowed}button.secondary{background:#e5eeea;color:var(--setup-ink)}.setup-drawer button[type=submit]{min-height:43px;width:100%;margin-top:9px}
  .hint{font-size:13px;color:var(--setup-muted);line-height:1.5}.next-tip{display:flex;align-items:flex-start;gap:9px;margin:19px 0 0;padding:12px 13px;border:1px solid #e8d7c7;border-radius:10px;background:#fff8ef;color:#77543c;font-size:13px;line-height:1.45}.audio-card.is-locked .setup-drawer{display:none}.audio-card{min-height:195px}.push-card{min-height:140px}.push-card .card-intro{margin-bottom:0}
  .setup-utility-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:18px}.setup-utility-grid .card{height:100%}.setup-utility-grid .card h2{margin-bottom:10px}.setup-utility-grid .card .hint{margin:3px 0 15px}.setup-utility-grid table{font-size:13px}.setup-utility-grid td{vertical-align:top}.setup-utility-grid form button{min-height:40px}.setup-utility-grid form input{margin-top:6px}.setup-utility-grid .card:only-child{grid-column:1/-1}
  .delivery-options{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-top:28px}.delivery-options span{min-width:0;padding:12px 10px;border:1px solid #d8e7df;border-radius:10px;background:#f6faf5;color:#315d52;font-size:12px;font-weight:700}.delivery-options small{display:block;margin-top:3px;color:#71877e;font-size:10px;font-weight:500}.delivery-options .glyph{display:block;margin-bottom:6px;font-size:17px;line-height:1}
  .teams-inclusion-card{background:linear-gradient(145deg,#f5faf6,#fff8ef)}.teams-inclusion-card .card-intro{margin-bottom:17px}.teams-inclusion-card ul{margin:0 0 20px;padding:0;list-style:none}.teams-inclusion-card li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--setup-line);font-size:13px;font-weight:700}.teams-inclusion-card li span:last-child{color:var(--setup-muted);font-size:12px;font-weight:600}.teams-inclusion-card .setup-action{width:100%}
  [hidden]{display:none!important}.flash{margin:18px 0 0;padding:12px 15px;border-radius:10px;font-size:14px}.flash.success{background:#e3f2e7;color:#275f49}.flash.error{background:#fbeae8;color:#993f39}
  .setup-styles{margin-top:40px;border:1px solid var(--setup-line);border-radius:16px;background:#fffdf9}.setup-styles>summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:15px;padding:20px 24px;cursor:pointer;font-weight:750}.setup-styles>summary::-webkit-details-marker{display:none}.setup-styles>summary:after{content:"+";font-size:24px;font-weight:400}.setup-styles[open]>summary:after{content:"−"}.setup-styles-content{padding:0 24px 24px}.setup-styles-content p{margin:0 0 16px;color:var(--setup-muted);font-size:13px}
  @media(max-width:900px){.setup-hero{grid-template-columns:1fr}.setup-diagram{display:none}.setup-connection-grid{grid-template-columns:1fr}.setup-side{grid-template-columns:repeat(2,minmax(0,1fr))}.card-feature{min-height:0}}
  @media(max-width:650px){.setup-shell{width:min(100% - 28px,1220px);padding-top:17px}.setup-top-links{gap:11px}.setup-top-links a{font-size:12px}.setup-hero{min-height:0;padding:29px 24px;border-radius:18px}.setup-hero:after{display:none}.setup-hero p:not(.setup-eyebrow){font-size:14px}.setup-overview{grid-template-columns:1fr;padding:0 14px;margin-bottom:36px}.setup-overview>div{padding:12px 7px}.setup-overview>div+div{border-left:0;border-top:1px solid var(--setup-line)}.setup-side,.setup-utility-grid{grid-template-columns:1fr}.setup-section{margin-top:31px}.card{padding:21px}.setup-section-head{display:block}.setup-drawer form{padding:15px}.delivery-options{grid-template-columns:1fr}.delivery-options span{display:flex;align-items:center;gap:8px}.delivery-options .glyph{margin:0}.setup-styles>summary{display:grid;grid-template-columns:1fr auto;padding:18px 21px}.setup-styles>summary .hint{grid-row:2;grid-column:1}.setup-styles>summary:after{grid-row:1/3;grid-column:2;align-self:center}}
  @media(max-width:420px){.setup-top{display:grid;grid-template-columns:1fr;gap:10px}.setup-top-links{justify-content:flex-end}.setup-top-links button{margin-left:auto}}
  @media(prefers-reduced-motion:no-preference){.setup-action,.card,.setup-drawer summary:after{transition:background .16s ease,box-shadow .16s ease,transform .16s ease}.setup-action:hover{transform:translateY(-1px)}.card:hover{box-shadow:0 8px 23px #183f331a}}
`;

export function setupPage(
  status: SetupStatus,
  opts?: {
    flash?: string;
    error?: string;
    apiKeys?: Array<{ key_prefix: string; label: string | null; created_at: string; last_used_at: string | null; key_hash: string }>;
    newKey?: string;
    /** Extra cards for the account section (HTML), built by the edition. */
    accountSections?: string[];
    showOAuthConnections?: boolean;
    canEdit?: boolean;
    teamsChannels?: Array<{ name: string; connected: boolean }>;
    brand?: string;
    base?: string;
  }
): Response {
  const base = opts?.base ?? "";
  const nonce = crypto.randomUUID();
  const flash = opts?.flash
    ? `<div class="flash success" role="status">${esc(opts.flash)}</div>`
    : "";
  const error = opts?.error
    ? `<div class="flash error" role="alert">${esc(opts.error)}</div>`
    : "";

  const m365State = status.microsoft365.configured
    ? status.microsoft365.legacy ? "Upgrade available" : "Connected"
    : "Available";
  const commuteState = status.commute.configured
    ? "Connected"
    : "Available";

  const m365Disabled = false;
  const m365Notice = status.microsoft365.legacy
    ? "Running on legacy OneDrive config. Save to enable Teams and SharePoint."
    : "";
  const commuteDisabled = false;
  const commuteNotice = "";
  const canEdit = opts?.canEdit ?? true;
  const outputNames = (status.microsoft365.outputs ?? []).map((output) =>
    output === "teams" ? "Teams posting" : output === "sharepoint" ? "SharePoint" : "OneDrive");
  const enabledOutputs = new Set(status.microsoft365.outputs ?? []);

  const apiKeys = opts?.apiKeys ?? [];
  const newKey = opts?.newKey;
  const newKeyBox = newKey
    ? `<div style="background:#EBF3E6;border:1px solid ${theme.primary};border-radius:8px;padding:.8rem;margin:.4rem 0 1rem">
        <p style="color:${theme.badgeAnsweredText};font-size:.82rem;margin:0 0 .5rem;font-weight:600">⚠️ Copy this now — you won't be able to see it again.</p>
        <code id="newkey" style="display:block;word-break:break-all;font-size:.78rem;background:${theme.paper};padding:.5rem;border-radius:6px;color:${theme.ink}">${esc(newKey)}</code>
        <button type="button" class="secondary" style="margin-top:.5rem;width:auto;padding:.4rem .9rem" data-on-click="copyKey">Copy</button>
      </div>`
    : "";
  const keyRows = apiKeys
    .map(
      (k) => `<tr style="border-bottom:1px solid ${theme.line}">
        <td style="padding:.4rem .3rem">${esc(k.label ?? "—")}</td>
        <td style="padding:.4rem .3rem;font-family:monospace;font-size:.76rem;color:${theme.muted}">${esc(k.key_prefix)}…</td>
        <td style="padding:.4rem .3rem;font-size:.74rem;color:${theme.dim}">${k.created_at ? new Date(k.created_at + "Z").toLocaleDateString() : "—"}</td>
        <td style="padding:.4rem .3rem;font-size:.74rem;color:${theme.dim}">${k.last_used_at ? "used " + new Date(k.last_used_at + "Z").toLocaleDateString() : "unused"}</td>
        <td style="padding:.4rem .3rem;text-align:right"><form method="POST" action="${appPath(base, "/setup/keys/revoke")}" style="margin:0" data-confirm-submit="Revoke this key? Agents using it will stop working."><input type="hidden" name="key_hash" value="${esc(k.key_hash)}"><button type="submit" class="secondary" style="width:auto;padding:.25rem .6rem;font-size:.74rem;margin:0">Revoke</button></form></td>
      </tr>`
    )
    .join("");
  const keysList = apiKeys.length
    ? `<details class="setup-drawer"><summary>Manage ${apiKeys.length} saved key${apiKeys.length === 1 ? "" : "s"}</summary><table style="width:100%;border-collapse:collapse;margin:12px 0">${keyRows}</table></details>`
    : `<p class="hint">No API keys yet.</p>`;
  const apiKeysCard = `<div class="card">
      <h2>API Keys</h2>
      <div class="badge optional">CLI &amp; agents</div>
      <p class="hint">Personal keys so your own Claude Code / Codex / CLI agents can send via ${editionProductName()}. Each key is shown only once.</p>
      ${newKeyBox}
      ${keysList}
      <form method="POST" action="${appPath(base, "/setup/keys")}">
        <label for="key_label">New key label</label>
        <input id="key_label" name="label" placeholder="laptop" maxlength="60">
        <button type="submit">Generate API key</button>
      </form>
    </div>`;
  const teamsChannels = opts?.teamsChannels ?? [];
  const teamsChannelsCard = teamsChannels.length ? `<article class="card teams-inclusion-card">
      <span class="card-kicker">Personal Microsoft access</span><h2>Included Teams channels</h2>
      <p class="card-intro">Join with your own Microsoft account. Your ${editionProductName()} agents can read a channel only through your connection.</p>
      <ul>${teamsChannels.map(channel => `<li><span translate="no">${esc(channel.name)}</span><span>${channel.connected ? "Joined" : "Not joined"}</span></li>`).join("")}</ul>
      <a class="setup-action" href="${appPath(base, "/teams-inclusions")}">Review included channels <span aria-hidden="true">↗</span></a>
    </article>` : "";
  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${editionProductName()} Setup</title>
<style>${SETUP_CSS}</style></head>
<body><div class="setup-shell">
  <nav class="setup-top" aria-label="Setup navigation">
    <a class="setup-brand" href="${appPath(base, "/workspace")}"><img class="setup-brand-mark" src="${appPath(base, `/assets/space-icon/${opts?.brand ?? editionSlug()}`)}" alt=""> ${editionProductName()} <span aria-hidden="true">/</span> Setup</a>
    <div class="setup-top-links"><a href="${appPath(base, "/profile")}">Profile</a><a href="${appPath(base, "/inbox")}">Inbox</a>${navButton()}</div>
  </nav>
  <section class="setup-hero" aria-labelledby="setup-title">
    <div><p class="setup-eyebrow">Your workspace, your way</p>
      <h1 id="setup-title">Make space for good work.</h1>
      <p>Your team has a home in ${editionProductName()}. Connect agents, choose where work lands, and add the extras that fit your day.</p>
      <div class="setup-actions"><a class="setup-action" href="${opts?.showOAuthConnections ? appPath(base, "/welcome") : appPath(base, "/workspace")}">${opts?.showOAuthConnections ? "Set up your agents" : "Open workspace"} <span aria-hidden="true">↗</span></a><a class="setup-action setup-action-secondary" href="${opts?.showOAuthConnections ? appPath(base, "/workspace") : appPath(base, "/help")}">${opts?.showOAuthConnections ? "Go to workspace" : "Explore help"}</a></div>
    </div>
    <div class="setup-diagram" aria-hidden="true"><div class="node"><span class="symbol">◉</span><span><strong>Your team</strong><small>People and projects</small></span></div><div class="node"><span class="symbol"><img src="${appPath(base, `/assets/space-icon/${opts?.brand ?? editionSlug()}`)}" alt=""></span><span><strong>${editionProductName()}</strong><small>A shared home</small></span></div><div class="node"><span class="symbol">✦</span><span><strong>Your agents</strong><small>Work in the loop</small></span></div></div>
  </section>
  ${flash}${error}
  <div class="setup-overview" aria-label="Setup overview">
    <div><span class="number" aria-hidden="true">01</span><div><strong>Workspace</strong><span>Ready for your team</span></div></div>
    <div><span class="number" aria-hidden="true">02</span><div><strong>Delivery</strong><span>${status.microsoft365.configured ? "Microsoft 365 connected" : "Connect when you need it"}</span></div></div>
    <div><span class="number" aria-hidden="true">03</span><div><strong>Audio</strong><span>${status.commute.configured ? "Voices connected" : "Optional for briefings"}</span></div></div>
  </div>
  <section class="setup-section" aria-labelledby="connections-heading">
    <header class="setup-section-head"><div><p class="setup-eyebrow">01 / Connections</p><h2 id="connections-heading">Choose where work goes.</h2><p>Shared delivery settings belong to this server. Your personal agents and app connections stay tied to your own account.</p></div></header>
    <div class="setup-connection-grid"><article class="card card-feature">
      <div class="card-head"><div><span class="card-kicker">Shared delivery</span><h2>Microsoft 365</h2></div><span class="badge ${status.microsoft365.configured ? status.microsoft365.legacy ? "next" : "connected" : "next"}">${m365State}</span></div>
      <p class="card-intro">Send ${editionProductName()} work to Teams, SharePoint, or OneDrive. An owner sets this up once for the server.</p>
      ${outputNames.length ? `<div class="card-meta">${outputNames.map((name) => `<span>${name}</span>`).join("")}</div>` : ""}
      ${m365Notice ? `<p class="next-tip">${m365Notice}</p>` : ""}
      <div class="delivery-options" aria-label="Available destinations"><span><b class="glyph" aria-hidden="true">↗</b>Teams<small>Channel posts</small></span><span><b class="glyph" aria-hidden="true">▤</b>SharePoint<small>Shared documents</small></span><span><b class="glyph" aria-hidden="true">◇</b>OneDrive<small>Personal files</small></span></div>
      ${canEdit ? `<details class="setup-drawer"><summary>${status.microsoft365.configured ? "Edit delivery settings" : "Configure Microsoft 365"}</summary>` : '<p class="next-tip">Only a server owner or admin can change shared delivery settings.</p>'}
      ${canEdit ? `
      <form method="POST" action="${appPath(base, "/setup")}" autocomplete="off">
        <input type="hidden" name="type" value="microsoft365">
        <p class="hint">Shared credentials are write-only. Enter them again before saving changes to this connection.</p>
        <label for="tenant_id">Tenant ID</label>
        <input id="tenant_id" name="tenant_id" placeholder="guid" ${m365Disabled ? "disabled" : ""} required>
        <label for="client_id">Client ID</label>
        <input id="client_id" name="client_id" placeholder="guid" ${m365Disabled ? "disabled" : ""} required>
        <label for="client_secret">Client secret</label>
        <input id="client_secret" name="client_secret" type="password" ${m365Disabled ? "disabled" : ""} required>
        <label for="refresh_token">Refresh token</label>
        <textarea id="refresh_token" name="refresh_token" ${m365Disabled ? "disabled" : ""} required></textarea>

        <h3>Teams</h3>
        <label><input id="teams_enabled" type="checkbox" name="teams_enabled" value="on" ${enabledOutputs.has("teams") ? "checked" : ""}> Enable Teams channel posting</label>
        <div id="teams-fields" ${enabledOutputs.has("teams") ? "" : "hidden"}>
        <label for="teams_team_id">Team ID</label>
        <input id="teams_team_id" name="teams_team_id" placeholder="Microsoft team GUID" data-required="true" ${enabledOutputs.has("teams") ? "required" : "disabled"}>
        <label for="teams_channel_id">Channel ID</label>
        <input id="teams_channel_id" name="teams_channel_id" placeholder="19:…@thread.tacv2" data-required="true" ${enabledOutputs.has("teams") ? "required" : "disabled"}>
        <p class="hint">Get IDs: right-click channel in Teams > Get link > extract groupId and channel from URL.</p>
        </div>

        <h3>SharePoint</h3>
        <label><input id="sharepoint_enabled" type="checkbox" name="sharepoint_enabled" value="on" ${enabledOutputs.has("sharepoint") ? "checked" : ""}> Enable SharePoint document uploads</label>
        <div id="sharepoint-fields" ${enabledOutputs.has("sharepoint") ? "" : "hidden"}>
        <label for="sharepoint_site_id">Site ID</label>
        <input id="sharepoint_site_id" name="sharepoint_site_id" placeholder="SharePoint site ID" ${enabledOutputs.has("sharepoint") ? "" : "disabled"}>
        <label for="sharepoint_drive_id">Document library Drive ID</label>
        <input id="sharepoint_drive_id" name="sharepoint_drive_id" placeholder="Document library ID" data-required="true" ${enabledOutputs.has("sharepoint") ? "required" : "disabled"}>
        <label for="sharepoint_folder">Folder (optional)</label>
        <input id="sharepoint_folder" name="sharepoint_folder" placeholder="${editionProductName()}/Docs" ${enabledOutputs.has("sharepoint") ? "" : "disabled"}>
        </div>

        <h3>OneDrive</h3>
        <label><input id="onedrive_enabled" type="checkbox" name="onedrive_enabled" value="on" ${enabledOutputs.has("onedrive") ? "checked" : ""}> Enable OneDrive file uploads</label>
        <div id="onedrive-fields" ${enabledOutputs.has("onedrive") ? "" : "hidden"}>
        <label for="onedrive_drive_id">Drive ID</label>
        <input id="onedrive_drive_id" name="onedrive_drive_id" placeholder="OneDrive ID" data-required="true" ${enabledOutputs.has("onedrive") ? "required" : "disabled"}>
        <label for="onedrive_folder">Folder (optional)</label>
        <input id="onedrive_folder" name="onedrive_folder" placeholder="${editionProductName()}/Docs" ${enabledOutputs.has("onedrive") ? "" : "disabled"}>
        </div>

        <button type="submit" ${m365Disabled ? "disabled" : ""} style="margin-top:1rem">Save Microsoft 365 settings</button>
      </form></details>` : ""}
      ${status.microsoft365.updated_at ? '<p class="hint" style="margin:17px 0 0">Last saved ' + new Date(status.microsoft365.updated_at + "Z").toLocaleString() + '</p>' : ""}
    </article>
    <div class="setup-side"><article class="card audio-card ${commuteDisabled ? "is-locked" : ""}">
      <div class="card-head"><div><span class="card-kicker">Listen back</span><h2>Audio briefings</h2></div><span class="badge ${status.commute.configured ? "connected" : commuteDisabled ? "locked" : "next"}">${commuteState}</span></div>
      <p class="card-intro">Turn research and documents into spoken updates with a voice you choose.</p>
      ${commuteNotice ? `<p class="next-tip">${commuteNotice}</p>` : ""}
      ${canEdit && !commuteDisabled ? `<details class="setup-drawer"><summary>${status.commute.configured ? "Edit audio settings" : "Configure audio"}</summary>` : ""}
      ${canEdit && !commuteDisabled ? `
      <form method="POST" action="${appPath(base, "/setup")}">
        <input type="hidden" name="type" value="commute">
        <label for="openai_api_key">OpenAI API key</label>
        <input id="openai_api_key" name="openai_api_key" type="password" placeholder="sk-..." ${commuteDisabled ? "disabled" : ""} required>
        <p class="hint">OpenAI is still used for the research pass and the final spoken script.</p>
        <label for="tts_provider">Narration provider</label>
        <select id="tts_provider" name="tts_provider" ${commuteDisabled ? "disabled" : ""} data-on-change="toggleTts">
          <option value="openai" selected>OpenAI</option>
          <option value="elevenlabs">ElevenLabs</option>
          <option value="gemini">Google Gemini</option>
        </select>
        <div id="openai-fields">
          <label for="voice">OpenAI voice</label>
          <input id="voice" name="voice" placeholder="sage" value="sage" ${commuteDisabled ? "disabled" : ""}>
          <label for="model">OpenAI speech model</label>
          <input id="model" name="model" placeholder="${COMMUTE_SPEECH_MODEL}" value="${COMMUTE_SPEECH_MODEL}" ${commuteDisabled ? "disabled" : ""}>
        </div>
        <div id="elevenlabs-fields" style="display:none">
          <label for="elevenlabs_api_key">ElevenLabs API key</label>
          <input id="elevenlabs_api_key" name="elevenlabs_api_key" type="password" placeholder="sk_..." ${commuteDisabled ? "disabled" : ""}>
          <label for="elevenlabs_voice_id">ElevenLabs voice ID</label>
          <input id="elevenlabs_voice_id" name="elevenlabs_voice_id" placeholder="voice id" ${commuteDisabled ? "disabled" : ""}>
          <label for="elevenlabs_model">ElevenLabs model</label>
          <input id="elevenlabs_model" name="elevenlabs_model" placeholder="eleven_v4" value="eleven_v4" ${commuteDisabled ? "disabled" : ""}>
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
        <input id="script_model" name="script_model" placeholder="${COMMUTE_SCRIPT_MODEL}" value="${COMMUTE_SCRIPT_MODEL}" ${commuteDisabled ? "disabled" : ""}>
        <label for="speech_instructions">Speech style</label>
        <textarea id="speech_instructions" name="speech_instructions" ${commuteDisabled ? "disabled" : ""}>Speak like a warm, thoughtful podcast host. Use natural pacing, small pauses, understated emphasis, and a calm reflective tone. Avoid sounding like a customer support agent, announcer, or screen reader.</textarea>
        <p class="hint">${editionProductName()} now writes a research memo, then a spoken script, then hands narration to OpenAI, ElevenLabs, or Gemini.</p>
        <label for="minutes">Minutes</label>
        <input id="minutes" name="minutes" type="number" min="1" max="10" value="3" ${commuteDisabled ? "disabled" : ""} required>
        <button type="submit" ${commuteDisabled ? "disabled" : ""}>Save audio voice settings</button>
      </form></details>` : !canEdit ? '<p class="next-tip">Only a server owner or admin can change audio settings.</p>' : ""}
      ${status.commute.updated_at ? `<p class="hint" style="margin:15px 0 0">Last saved ${new Date(status.commute.updated_at + "Z").toLocaleString()}</p>` : ""}
    </article>
    <article class="card push-card">
      <div class="card-head"><div><span class="card-kicker">On your device</span><h2>iOS notifications</h2></div><span class="badge ${status.push.apns_configured ? "connected" : "unavailable"}">${status.push.apns_configured ? "Ready" : "Unavailable"}</span></div>
      <p class="card-intro">${status.push.apns_configured
        ? `APNs credentials are set. ${status.push.device_count} iOS device${status.push.device_count !== 1 ? "s" : ""} registered.`
        : "An administrator can enable device notifications for this server. Your app will register when it opens."}</p>
    </article></div></div>
  </section>
  <section class="setup-section" aria-labelledby="account-heading"><header class="setup-section-head"><div><p class="setup-eyebrow">02 / Your account</p><h2 id="account-heading">Keep your tools close.</h2><p>Manage agent access and connected apps without touching the shared delivery settings.</p></div></header><div class="setup-utility-grid">
    ${teamsChannelsCard}
    ${(opts?.accountSections ?? []).join("\n    ")}
    ${apiKeysCard}
    ${opts?.showOAuthConnections ? oauthConnectionsPanel() : ""}
  </div></section>
  <details class="setup-styles"><summary>Explore document styles <span class="hint">A voice and visual language for every publication</span></summary><div class="setup-styles-content"><p>Agents choose a style for published documents. Each preview shows the type, palette, and writing voice.</p><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:1rem">
    ${styleGalleryCards()}
  </div></div></details>
</div>
<script nonce="${nonce}">
${clientBase(base)}
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
function toggleOutputFields(name) {
  var checkbox = document.getElementById(name + '_enabled');
  var fields = document.getElementById(name + '-fields');
  if (!checkbox || !fields) return;
  fields.hidden = !checkbox.checked;
  fields.querySelectorAll('input').forEach(function(input) {
    input.disabled = !checkbox.checked;
    input.required = checkbox.checked && input.dataset.required === 'true';
  });
}
['teams', 'sharepoint', 'onedrive'].forEach(function(name) {
  var checkbox = document.getElementById(name + '_enabled');
  if (checkbox) {
    checkbox.addEventListener('change', function() { toggleOutputFields(name); });
    toggleOutputFields(name);
  }
});
(function wireHandlers() {
  var clicks = { copyKey: function() { copyKey(); } };
  var changes = { toggleTts: function() { toggleTtsFields(); } };
  document.addEventListener('click', function(e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-on-click]') : null;
    if (el && clicks[el.dataset.onClick]) clicks[el.dataset.onClick](el, e);
  });
  document.addEventListener('change', function(e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-on-change]') : null;
    if (el && changes[el.dataset.onChange]) changes[el.dataset.onChange](el, e);
  });
  // A form with data-confirm-submit asks first; Cancel keeps it from sending.
  document.addEventListener('submit', function(e) {
    var form = e.target && e.target.closest ? e.target.closest('form[data-confirm-submit]') : null;
    if (form && !confirm(form.dataset.confirmSubmit)) e.preventDefault();
  });
})();
</script>
${opts?.showOAuthConnections ? `<script nonce="${nonce}">${OAUTH_CONNECTIONS_JS}</script>` : ""}
</body></html>`,
    { headers: pageHeaders(nonce) }
  );
}

export function latestCommutePage(
  briefing: CommuteBriefingListItem | null,
  transcript?: string,
  base = "",
  /** The source document's link segment (its short code when it has one). */
  sourceSegment?: string
): Response {
  const nonce = crypto.randomUUID();
  if (!briefing) {
    return new Response(
      `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${editionProductName()} - Latest Commute</title>
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
  <p>Post a document after setup and ${editionProductName()} will place the latest listen-back here.</p>
  <p><a href="${appPath(base, "/audio")}">Open your audio library</a></p>
</div>
</body></html>`,
      { headers: pageHeaders(nonce) }
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
<title>${editionProductName()} - Latest Commute</title>
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
    <a href="${appPath(base, "/audio")}">All audio</a>
    <a href="${appPath(base, "/")}">Inbox</a>
  </div>
  <div class="hero">
    <div class="meta">Latest commute briefing</div>
    <h1>${esc(briefing.title)}</h1>
    <div class="meta">${esc(briefing.instance_project)} &middot; ${esc(briefing.instance_model)} &middot; ${new Date(briefing.created_at + "Z").toLocaleString()}</div>
    <div class="badge ${briefing.audio_key ? "ready" : "partial"}">${briefing.audio_key ? "audio ready" : "transcript only"}</div>
  </div>
  <div class="player">
    <div class="section-title">Listen</div>
    ${briefing.audio_key ? `<audio controls preload="metadata" src="${appPath(base, `/api/commute/${esc(briefing.source_message_id)}/audio`)}"></audio>` : `<div class="hint">Audio was not available for this run, so ${editionProductName()} kept the transcript instead.</div>`}
    <div class="links">
      <a href="${appPath(base, `/api/commute/${esc(briefing.source_message_id)}/transcript`)}">Open full transcript</a>
      <a href="${appPath(base, `/docs/${sourceSegment ?? esc(briefing.source_message_id)}`)}">Open source document</a>
      ${briefing.audio_key ? `<a href="${appPath(base, `/api/commute/${esc(briefing.source_message_id)}/audio`)}" target="_blank">Open raw audio</a>` : ""}
    </div>
    ${briefing.error ? `<div class="error">${esc(briefing.error)}</div>` : ""}
  </div>
  <div class="transcript">
    <div class="section-title">Preview</div>
    <pre>${esc(transcriptPreview || "Transcript not available.")}</pre>
  </div>
</div>
</body></html>`,
    { headers: pageHeaders(nonce) }
  );
}

export function registryPage(instances: any[], base = ""): Response {
  const nonce = crypto.randomUUID();
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
      <td><button class="dereg-btn" data-on-click="deregister" data-instance="${esc(inst.instance_id)}">✕</button></td>
    </tr>`;
  }).join("");

  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${editionProductName()} - Instances</title>
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
  <div style="display:flex;gap:1rem;align-items:center"><span class="dim" id="refresh-msg" style="font-size:.78rem">Refreshes in 60s</span><a href="${appPath(base, "/inbox")}">Inbox</a><a href="${appPath(base, "/toc")}">Documents</a><a href="${appPath(base, "/setup")}">Setup</a></div>
</div>
${instances.length === 0
  ? `<div class="empty">No registered instances. Claude sessions register via <code>${editionSlug()}.sh register</code>.</div>`
  : `<table>
      <thead><tr><th></th><th>Instance ID</th><th>Project</th><th>Model</th><th>Source</th><th>Working on</th><th>Heartbeat</th><th>Uptime</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`}
<script nonce="${nonce}">
${clientBase(base)}
async function deregister(instanceId, btn) {
  btn.disabled = true;
  try {
    var res = await fetch(APP_BASE + '/api/register/' + encodeURIComponent(instanceId), {
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
(function wireHandlers() {
  var clicks = { deregister: function(el) { deregister(el.dataset.instance, el); } };
  document.addEventListener('click', function(e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-on-click]') : null;
    if (el && clicks[el.dataset.onClick]) clicks[el.dataset.onClick](el, e);
  });
})();
</script>
</body></html>`,
    { headers: pageHeaders(nonce) }
  );
}

export function statsPage(stats: {
  messages_per_day: Array<{ day: string; count: number }>;
  top_projects: Array<{ project: string; count: number }>;
  top_models: Array<{ model: string; count: number }>;
}, base = ""): Response {
  const nonce = crypto.randomUUID();
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
<title>${editionProductName()} — Stats</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#FAF6F0;color:#4A3F35;padding:1.5rem;max-width:700px;margin:0 auto}
  h1{margin-bottom:1rem;font-size:1.4rem}
  h2{font-size:1rem;color:${theme.muted};margin:1.5rem 0 .5rem}
  nav a{margin-right:1rem;color:${theme.accent};text-decoration:none;font-size:.85rem}
  table{border-collapse:collapse;width:100%}
  td{border-bottom:1px solid #F0E8E0}
  tr:last-child td{border:none}
</style></head><body>
<nav><a href="${appPath(base, "/inbox")}">← Inbox</a><a href="${appPath(base, "/registry")}">Instances</a></nav>
<h1>Activity Stats</h1>
<h2>Messages per day (past 7 days)</h2>
${dayBars || '<p style="color:${theme.muted};font-size:.85rem">No data yet</p>'}
<h2>Top projects</h2>
<table>${projectRows || '<tr><td style="color:${theme.muted};padding:.25rem .5rem">No data</td></tr>'}</table>
<h2>Top models</h2>
<table>${modelRows || '<tr><td style="color:${theme.muted};padding:.25rem .5rem">No data</td></tr>'}</table>
</body></html>`, { headers: pageHeaders(nonce) });
}

export function esc(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
