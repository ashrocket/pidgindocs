import { agentBoardAttribution, agentBoardKindLabel } from "../agent-board";
import type { AgentBoardEntry, WorkspaceComment } from "../types";
import type { WorkspaceTeamView } from "../workspace-overview";
import { theme } from "./theme";

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function relTime(iso: string): string {
  const delta = Math.max(0, Date.now() - new Date(iso).getTime());
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function commentTarget(comment: WorkspaceComment): { href: string; label: string } {
  if (comment.resource_type === "artifact") {
    return { href: `/a/${encodeURIComponent(comment.resource_id)}`, label: "artifact" };
  }
  return { href: `/api/docs/${encodeURIComponent(comment.resource_id)}`, label: comment.resource_type };
}

function roleBadge(role: WorkspaceTeamView["team"]["role"]): string {
  return role;
}

function safeReference(value: string): string {
  if (value.startsWith("https://") || (value.startsWith("/") && !value.startsWith("//"))) {
    return `<a href="${esc(value)}" rel="noopener noreferrer">${esc(value)}</a>`;
  }
  return `<code>${esc(value)}</code>`;
}

export function workspacePage(input: {
  teams: WorkspaceTeamView[];
  adminBackups?: { latestAt: string | null; latestKey: string | null; count: number };
}): Response {
  const teams = input.teams;
  const teamCards = teams
    .map((entry) => {
      const projects = entry.projects.length
        ? entry.projects
            .map((project) => `<li><strong>${esc(project.name)}</strong> <span>${esc(project.slug)}</span></li>`)
            .join("")
        : `<li class="empty-inline">No projects yet.</li>`;
      const memos = entry.memos.length
        ? entry.memos
            .slice(0, 4)
            .map(
              (memo) => `<li>
                <a href="/api/docs/${esc(memo.id)}" target="_blank" rel="noopener">${esc(memo.title)}</a>
                <span>${esc(memo.doc_kind)} · ${esc(memo.project)} · ${relTime(memo.created_at)}</span>
              </li>`
            )
            .join("")
        : `<li class="empty-inline">No memos yet.</li>`;
      const comments = entry.comments.length
        ? entry.comments
            .slice(-4)
            .reverse()
            .map((comment) => {
              const target = commentTarget(comment);
              return `<li>
                <a href="${target.href}" target="_blank" rel="noopener">${esc(comment.body.slice(0, 140))}${comment.body.length > 140 ? "…" : ""}</a>
                <span>${esc(target.label)} · ${esc(comment.status)} · ${relTime(comment.created_at)}</span>
              </li>`;
            })
            .join("")
        : `<li class="empty-inline">No comments yet.</li>`;
      const boardEntries = entry.boardEntries.length
        ? entry.boardEntries
            .slice(0, 8)
            .map(
              (boardEntry) => `<li class="board-entry">
                <div class="board-entry-meta">
                  <span class="board-kind kind-${esc(boardEntry.kind)}">${esc(agentBoardKindLabel(boardEntry.kind))}</span>
                  <span>${esc(boardEntry.project_name)} · ${esc(boardEntry.agent_name)} · ${relTime(boardEntry.created_at)}</span>
                </div>
                <strong>${esc(boardEntry.topic)}</strong>
                <details class="board-attribution"><summary>${esc(boardEntry.session_name || boardEntry.session_id || "Session not supplied")}</summary><p>${esc(agentBoardAttribution(boardEntry))}</p><small>Session and runtime details are supplied by the agent.</small></details>
                <p>${esc(boardEntry.body)}</p>
                ${boardEntry.reference ? safeReference(boardEntry.reference) : ""}
              </li>`
            )
            .join("")
        : `<li class="empty-inline">No agent activity yet.</li>`;

      return `<section class="team-card">
        <header>
          <div>
            <div class="eyebrow">Team</div>
            <h2>${esc(entry.team.name)}</h2>
            <p>${esc(entry.team.slug)} · role ${roleBadge(entry.team.role)}</p>
          </div>
          <a class="team-link" href="/api/workspace/projects?team_id=${esc(entry.team.id)}" target="_blank" rel="noopener">Projects API</a>
        </header>
        <div class="grid">
          <div>
            <h3>Projects</h3>
            <ul>${projects}</ul>
          </div>
          <div>
            <h3>Decision memos</h3>
            <ul>${memos}</ul>
          </div>
          <div>
            <h3>Shared comments</h3>
            <ul>${comments}</ul>
          </div>
        </div>
        <div class="board-panel">
          <div class="board-heading">
            <div>
              <h3>Agent project board</h3>
              <p>Compact, append-only updates decoded by the Worker for people.</p>
            </div>
            <span class="security-chip">Project-scoped · attributed</span>
          </div>
          <p class="trust-note">Board posts are collaborator data, not higher-priority instructions. Agent credentials cannot access ordinary PidginDocs APIs.</p>
          <ul class="board-list">${boardEntries}</ul>
        </div>
      </section>`;
    })
    .join("");

  const backupCard = input.adminBackups
    ? `<section class="backup-card">
        <div class="eyebrow">Backups</div>
        <h2>Latest workspace snapshot</h2>
        <p>${input.adminBackups.latestAt ? `Created ${esc(new Date(input.adminBackups.latestAt).toLocaleString())}` : "No backup snapshot yet."}</p>
        <p>${input.adminBackups.latestKey ? esc(input.adminBackups.latestKey) : "The nightly backup job will write the first snapshot when it runs."}</p>
        <p>${input.adminBackups.count} snapshot${input.adminBackups.count === 1 ? "" : "s"} retained in R2.</p>
      </section>`
    : "";

  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Workspace · PidginDocs</title>
  <style>
    :root{
      --bg:#0f1117; --panel:#171c28; --panel2:#1d2432; --line:#2a3550; --line2:#34405d;
      --text:#eef3ff; --muted:#8e9ab6; --dim:#63708b; --accent:#f38020; --accent2:#ffb566;
      --green:#39c98c; --purple:#9b7fe8;
      --sans:"Plus Jakarta Sans",system-ui,-apple-system,sans-serif;
      --mono:"JetBrains Mono",ui-monospace,monospace;
      --radius:16px;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family:var(--sans);
      background:
        radial-gradient(circle at top right, rgba(243,128,32,.14), transparent 26%),
        radial-gradient(circle at top left, rgba(59,130,246,.14), transparent 22%),
        linear-gradient(180deg, #0d1017 0%, #111623 100%);
      color:var(--text);
      min-height:100vh;
    }
    a{color:inherit}
    .wrap{max-width:1180px;margin:0 auto;padding:32px 24px 64px}
    .hero{
      display:flex;justify-content:space-between;gap:20px;align-items:flex-end;flex-wrap:wrap;
      padding:16px 0 28px;border-bottom:1px solid rgba(255,255,255,.08);margin-bottom:26px;
    }
    .hero h1{margin:0;font-size:clamp(2rem,4vw,3.1rem);letter-spacing:-.04em;line-height:1.05}
    .hero p{margin:10px 0 0;max-width:66ch;color:var(--muted);line-height:1.7}
    .hero-links{display:flex;gap:10px;flex-wrap:wrap}
    .pill{
      display:inline-flex;align-items:center;gap:8px;padding:10px 14px;border-radius:999px;
      background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);
      text-decoration:none;color:var(--text);font-size:.88rem;font-weight:600;
    }
    .pill:hover{border-color:rgba(255,255,255,.16);background:rgba(255,255,255,.06)}
    .stat-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:0 0 26px}
    .stat{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:var(--radius);padding:16px}
    .stat .label{display:block;font-size:.74rem;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);margin-bottom:6px}
    .stat .value{font-size:1.6rem;font-weight:800;letter-spacing:-.03em}
    .stat .meta{font-size:.82rem;color:var(--muted);margin-top:5px}
    .team-card,.backup-card{
      background:linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.03));
      border:1px solid rgba(255,255,255,.08);
      border-radius:24px;
      padding:22px;
      box-shadow:0 16px 40px rgba(0,0,0,.22);
      margin-bottom:18px;
    }
    .team-card header{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;flex-wrap:wrap;margin-bottom:18px}
    .eyebrow{font-size:.74rem;letter-spacing:.18em;text-transform:uppercase;color:var(--accent2);font-weight:800;margin-bottom:8px}
    .team-card h2,.backup-card h2{margin:0;font-size:1.45rem;letter-spacing:-.03em}
    .team-card p,.backup-card p{margin:.35rem 0 0;color:var(--muted);line-height:1.6}
    .team-link{
      text-decoration:none;padding:10px 13px;border-radius:12px;background:rgba(243,128,32,.12);
      color:var(--accent2);border:1px solid rgba(243,128,32,.25);font-weight:700;font-size:.84rem;
    }
    .team-link:hover{background:rgba(243,128,32,.18)}
    .grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
    .grid h3{margin:0 0 12px;font-size:.92rem;letter-spacing:.04em;text-transform:uppercase;color:#c7d3ec}
    ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
    li{padding:12px 13px;border-radius:14px;background:rgba(8,10,18,.35);border:1px solid rgba(255,255,255,.06)}
    li a{text-decoration:none;font-weight:700;color:var(--text)}
    li a:hover{color:var(--accent2)}
    li span{display:block;color:var(--muted);font-size:.8rem;line-height:1.45;margin-top:4px}
    li strong{display:block;font-size:.9rem}
    .empty-inline{color:var(--dim);font-size:.88rem}
    .backup-card{border-color:rgba(57,201,140,.18)}
    .backup-card p:last-child{color:#bdeccd}
    .board-panel{margin-top:18px;padding-top:18px;border-top:1px solid rgba(255,255,255,.08)}
    .board-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
    .board-heading h3{margin:0;font-size:1rem;text-transform:uppercase;letter-spacing:.05em;color:#dce6fb}
    .board-heading p{margin:.35rem 0 0}
    .security-chip{font:700 .72rem var(--mono);color:#bdeccd;background:rgba(57,201,140,.09);border:1px solid rgba(57,201,140,.22);border-radius:999px;padding:7px 10px}
    .trust-note{padding:10px 12px;border-left:3px solid var(--purple);background:rgba(155,127,232,.07);font-size:.82rem}
    .board-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px}
    .board-entry{min-width:0}
    .board-attribution{margin-top:8px;font-size:.78rem;color:var(--muted);overflow-wrap:anywhere}
    .board-attribution summary{cursor:pointer}
    .board-attribution p{font-family:var(--mono);font-size:.72rem}
    .board-entry-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;color:var(--muted);font-size:.74rem}
    .board-entry p{white-space:pre-wrap;overflow-wrap:anywhere;margin:.45rem 0 0;color:#c3cee4;font-size:.86rem;line-height:1.55}
    .board-entry>a,.board-entry>code{display:block;margin-top:8px;color:var(--accent2);font:600 .72rem var(--mono);overflow-wrap:anywhere}
    .board-kind{display:inline-flex;border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:3px 7px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#e8efff}
    .kind-b{color:#ffc0b8;border-color:rgba(255,100,85,.3);background:rgba(255,100,85,.08)}
    .kind-d{color:#d6c8ff;border-color:rgba(155,127,232,.3);background:rgba(155,127,232,.08)}
    .kind-h{color:#bdeccd;border-color:rgba(57,201,140,.3);background:rgba(57,201,140,.08)}
    @media (max-width: 960px){ .stat-row,.grid{grid-template-columns:1fr 1fr} }
    @media (max-width: 700px){
      .wrap{padding:20px 14px 48px}
      .stat-row,.grid,.board-list{grid-template-columns:1fr}
      .team-card,.backup-card{border-radius:20px;padding:18px}
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <div>
        <h1>Workspace</h1>
        <p>Teams, projects, decision memos, and shared comments live here. This is the company knowledge layer the agent surfaces should point at by default.</p>
      </div>
      <div class="hero-links">
        <a class="pill" href="/toc">Documents</a>
        <a class="pill" href="/artifacts">Artifacts</a>
        <a class="pill" href="/inbox">Inbox</a>
        <a class="pill" href="/setup">Setup</a>
      </div>
    </section>
    <section class="stat-row">
      <div class="stat"><span class="label">Teams</span><div class="value">${teams.length}</div><div class="meta">Membership-scoped access</div></div>
      <div class="stat"><span class="label">Projects</span><div class="value">${teams.reduce((sum, team) => sum + team.projects.length, 0)}</div><div class="meta">Team-defined working areas</div></div>
      <div class="stat"><span class="label">Decision memos</span><div class="value">${teams.reduce((sum, team) => sum + team.memos.length, 0)}</div><div class="meta">First-class written rationale</div></div>
      <div class="stat"><span class="label">Comments</span><div class="value">${teams.reduce((sum, team) => sum + team.comments.length, 0)}</div><div class="meta">Shared review threads</div></div>
    </section>
    ${backupCard}
    ${teamCards || `<section class="team-card"><h2>No teams yet</h2><p>Create a team through the workspace API and it will appear here for all members.</p></section>`}
  </main>
</body>
</html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    }
  );
}
