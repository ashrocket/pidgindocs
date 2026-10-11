import { boubaKikiSeedForId, boubaKikiSvg } from "../artifacts/identicon";
import { theme } from "./theme";

// Artifacts gallery — the web twin of the iOS Artifacts tab. Cards show the
// bouba/kiki identicon backdrop, emoji favicon, title, description subtitle,
// and updated time, newest first (claude.ai/code/artifacts parity).

interface GalleryArtifact {
  id: string;
  title: string;
  description: string | null;
  favicon: string;
  visibility: string;
  role?: string;
  current_version: number;
  updated_at: number; // unix seconds
  url: string;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function relativeTime(unixSeconds: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

export function artifactsPage(
  artifacts: GalleryArtifact[],
  activeRole: "page" | "widget" | "all" = "page"
): Response {
  const cards = artifacts
    .map((a) => {
      const seed = boubaKikiSeedForId(a.id);
      return `<a class="card" href="/a/${esc(a.id)}">
  <div class="glyph">${boubaKikiSvg(seed, 72)}<span class="favicon">${esc(a.favicon)}</span></div>
  <div class="meta">
    <div class="title">${esc(a.title)}</div>
    ${a.description ? `<div class="desc">${esc(a.description)}</div>` : ""}
    <div class="sub">v${a.current_version} · ${relativeTime(a.updated_at)}${a.visibility === "public" ? " · public" : ""}</div>
  </div>
</a>`;
    })
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Artifacts — PidginDocs</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: ${theme.paper}; color: ${theme.ink}; margin: 0; }
  .wrap { max-width: 920px; margin: 0 auto; padding: 28px 20px 60px; }
  header { display: flex; align-items: baseline; gap: 14px; margin-bottom: 24px; }
  header h1 { font-family: Georgia, serif; font-size: 1.5rem; margin: 0; }
  header nav a { color: ${theme.primary}; text-decoration: none; font-size: .9rem; margin-right: 12px; }
  .filters { display: flex; gap: 6px; margin: 0 0 20px; }
  .filters a { padding: 6px 10px; border-radius: 999px; color: ${theme.muted}; text-decoration: none; font-size: .82rem; border: 1px solid ${theme.sand}; }
  .filters a.active { background: ${theme.primary}; color: #fff; border-color: ${theme.primary}; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
  .card { display: flex; gap: 14px; align-items: center; background: #fff; border: 1px solid ${theme.sand}; border-radius: 12px; padding: 14px; text-decoration: none; color: inherit; }
  .card:hover { border-color: ${theme.primary}; }
  .glyph { position: relative; width: 72px; height: 72px; flex-shrink: 0; opacity: .92; }
  .glyph svg { position: absolute; inset: 0; opacity: .35; }
  .glyph .favicon { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 34px; }
  .meta { min-width: 0; }
  .title { font-weight: 650; margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .desc { font-size: .85rem; color: ${theme.muted}; margin-bottom: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .sub { font-size: .75rem; color: ${theme.dim}; letter-spacing: .04em; }
  .empty { color: ${theme.muted}; padding: 40px 0; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Artifacts</h1>
    <nav><a href="/inbox">Inbox</a><a href="/workspace">Workspace</a><a href="/toc">Documents</a></nav>
  </header>
  <nav class="filters" aria-label="Artifact type">
    <a href="/artifacts" class="${activeRole === "page" ? "active" : ""}">Pages</a>
    <a href="/artifacts?role=widget" class="${activeRole === "widget" ? "active" : ""}">Widgets</a>
    <a href="/artifacts?role=all" class="${activeRole === "all" ? "active" : ""}">All</a>
  </nav>
  ${artifacts.length ? `<div class="grid">${cards}</div>` : `<div class="empty">No artifacts yet. Agents publish them with pidgin_publish_artifact.</div>`}
</div>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
