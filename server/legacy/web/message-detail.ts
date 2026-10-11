import type { Env } from "../types";
import type { SerializedMessageBlock } from "../messages/store";
import { signArtifactEmbedToken } from "../artifacts/store";
import { theme } from "./theme";

export interface MessageDetailRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  reply: string | null;
  created_at: string;
  priority: string;
  instance_project: string | null;
  instance_model: string | null;
}

const EMBED_TTL_MS = 10 * 60 * 1000;

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineMarkdown(value: string): string {
  let html = esc(value);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  return html;
}

// Deliberately small, safe renderer matching the native message renderer.
// Raw HTML never crosses into the authenticated main-origin page.
function renderMarkdown(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const output: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let inCode = false;
  let code: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    output.push(`<ul>${list.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`);
    list = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      if (inCode) {
        output.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
        code = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(raw);
      continue;
    }
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length + 1;
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^[-*+]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1]);
      continue;
    }
    if (line.startsWith(">")) {
      flushParagraph();
      flushList();
      output.push(`<blockquote>${inlineMarkdown(line.slice(1).trim())}</blockquote>`);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  if (inCode && code.length) output.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
  flushParagraph();
  flushList();
  return output.join("\n");
}

async function renderArtifactBlock(
  env: Env,
  messageId: string,
  block: SerializedMessageBlock,
  position: number
): Promise<string> {
  const artifactId = block.artifact_id ?? "";
  const version = block.version ?? 0;
  const title = block.label || block.artifact_title || "Artifact";
  const provenance = [block.producer, block.producer_action].filter(Boolean).join(" · ");
  const header = `${esc(block.artifact_favicon || "◻️")} ${esc(title)}`;
  const id = `artifact-${position}`;

  if (!block.artifact_available) {
    return `<section class="artifact-block unavailable" aria-label="Deleted artifact: ${esc(title)}">
  <button class="artifact-head" type="button" aria-expanded="true" disabled>
    <span>${header}</span><span class="tombstone">Artifact deleted</span>
  </button>
  <p class="artifact-summary">${esc(block.summary)}</p>
</section>`;
  }

  const latest = block.latest_version ?? version;
  const update =
    latest > version
      ? `<a class="updated" href="/a/${encodeURIComponent(artifactId)}" onclick="recordOpen('${esc(artifactId)}')">v${latest} available</a>`
      : "";
  const fullUrl = `/a/${encodeURIComponent(artifactId)}?v=${version}`;
  const collapsed = block.collapsed === true;

  if (block.has_capabilities || !env.ARTIFACT_EMBED_ORIGIN) {
    return `<section class="artifact-block capability-card" data-artifact-id="${esc(artifactId)}">
  <button class="artifact-head" type="button" aria-expanded="false" disabled>
    <span>${header}</span>${provenance ? `<span class="provenance">from ${esc(provenance)}</span>` : ""}
  </button>
  <p class="artifact-summary">${esc(block.summary)}</p>
  <footer><span>Snapshot v${version}</span>${update}<a class="open-artifact" href="${fullUrl}">Open full screen</a></footer>
</section>`;
  }

  const expires = Date.now() + EMBED_TTL_MS;
  const nonce = crypto.randomUUID();
  const token = await signArtifactEmbedToken(
    artifactId,
    version,
    messageId,
    expires,
    env.DOC_SHARE_SECRET ?? env.API_KEY
  );
  const embedUrl = new URL(`/a/${artifactId}`, env.ARTIFACT_EMBED_ORIGIN);
  embedUrl.searchParams.set("v", String(version));
  embedUrl.searchParams.set("embed", "1");
  embedUrl.searchParams.set("message", messageId);
  embedUrl.searchParams.set("expires", String(expires));
  embedUrl.searchParams.set("token", token);
  embedUrl.searchParams.set("nonce", nonce);

  return `<section class="artifact-block${collapsed ? " collapsed" : ""}" data-artifact-id="${esc(artifactId)}" data-version="${version}" data-nonce="${nonce}" id="${id}">
  <button class="artifact-head" type="button" aria-expanded="${collapsed ? "false" : "true"}" onclick="toggleArtifact('${id}')">
    <span>${header}</span>
    <span class="head-meta">${provenance ? `<span class="provenance">from ${esc(provenance)}</span>` : ""}<span class="chevron">⌄</span></span>
  </button>
  <div class="artifact-content">
    <div class="artifact-loading">Loading visualization…</div>
    <iframe title="${esc(title)} — ${esc(block.summary)}" loading="lazy" sandbox="allow-scripts allow-same-origin" src="${esc(embedUrl.toString())}"></iframe>
  </div>
  <p class="artifact-summary fallback">${esc(block.summary)}</p>
  <footer><span>Snapshot v${version}</span>${update}<button class="retry-artifact" type="button" onclick="retryArtifact('${id}')">Try again</button><a class="open-artifact" href="${fullUrl}" onclick="recordOpen('${esc(artifactId)}')">Open full screen</a></footer>
</section>`;
}

export async function messageDetailPage(
  env: Env,
  message: MessageDetailRow,
  blocks: SerializedMessageBlock[]
): Promise<Response> {
  const effectiveBlocks =
    blocks.length > 0
      ? blocks
      : message.body
        ? ([{ type: "markdown", markdown: message.body }] as SerializedMessageBlock[])
        : [];
  const rendered: string[] = [];
  for (let i = 0; i < effectiveBlocks.length; i++) {
    const block = effectiveBlocks[i];
    rendered.push(
      block.type === "markdown"
        ? `<section class="markdown">${renderMarkdown(block.markdown ?? "")}</section>`
        : await renderArtifactBlock(env, message.id, block, i)
    );
  }

  const embedOrigin = env.ARTIFACT_EMBED_ORIGIN
    ? new URL(env.ARTIFACT_EMBED_ORIGIN).origin
    : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(message.title)} · PidginDocs</title>
<style>
  *{box-sizing:border-box} body{margin:0;background:${theme.sand};color:${theme.ink};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  main{max-width:820px;margin:0 auto;padding:28px 20px 70px}.top{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:28px}.top a{color:${theme.primary};text-decoration:none}
  .badge{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:${theme.accent};font-weight:750}.title{font:700 2rem/1.15 Georgia,serif;margin:8px 0}.meta{color:${theme.dim};font-size:.85rem}.response{display:flex;flex-direction:column;gap:20px}
  .markdown{font-size:1.04rem;line-height:1.68}.markdown p{margin:0 0 14px}.markdown h2,.markdown h3,.markdown h4{font-family:Georgia,serif;margin:24px 0 10px}.markdown a{color:${theme.primary}}.markdown code{background:rgba(43,31,24,.08);padding:2px 5px;border-radius:4px}.markdown pre{overflow:auto;background:${theme.ink};color:${theme.paper};padding:14px;border-radius:9px}.markdown blockquote{border-left:3px solid ${theme.line};margin:0;padding-left:14px;color:${theme.muted}}
  .artifact-block{background:${theme.paper};border:1px solid ${theme.line};border-radius:14px;overflow:hidden;box-shadow:0 6px 24px rgba(43,31,24,.05)}.artifact-head{width:100%;border:0;background:transparent;color:inherit;padding:13px 16px;display:flex;justify-content:space-between;align-items:center;gap:12px;text-align:left;font-size:.92rem;font-weight:650;cursor:pointer}.head-meta{display:flex;align-items:center;gap:10px;color:${theme.dim};font-weight:450}.provenance{font-size:.76rem}.chevron{font-size:1.1rem;transition:transform .15s}.collapsed .chevron{transform:rotate(-90deg)}.artifact-content{position:relative;border-top:1px solid ${theme.line};border-bottom:1px solid ${theme.line};min-height:180px;background:#fff}.artifact-content iframe{display:block;width:100%;height:240px;border:0}.artifact-loading{position:absolute;inset:0;display:grid;place-items:center;color:${theme.dim};font-size:.85rem}.artifact-block.loaded .artifact-loading,.artifact-block.failed .artifact-loading{display:none}.collapsed .artifact-content,.collapsed footer,.collapsed .fallback{display:none}.artifact-summary{color:${theme.muted};font-size:.88rem;line-height:1.5;margin:0;padding:14px 16px}.fallback{display:none}.failed .fallback,.unavailable .artifact-summary,.capability-card .artifact-summary{display:block}.tombstone{color:${theme.accent};font-size:.78rem}.updated{color:${theme.accent};font-weight:650}.artifact-block footer{display:flex;align-items:center;gap:12px;padding:10px 16px;color:${theme.dim};font-size:.76rem}.artifact-block footer a{color:${theme.primary};text-decoration:none;font-weight:650}.artifact-block footer .open-artifact{margin-left:auto}.retry-artifact{display:none;border:0;background:transparent;color:${theme.primary};font:inherit;font-weight:650;cursor:pointer}.failed .retry-artifact{display:inline}.reply{border-left:3px solid ${theme.primary};padding-left:14px;margin-top:28px}.preference{display:flex;gap:8px;align-items:center;color:${theme.dim};font-size:.8rem;margin:18px 0}
  @media(max-width:600px){main{padding:20px 12px 50px}.title{font-size:1.55rem}.provenance{display:none}.artifact-block footer{flex-wrap:wrap}}
  @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style></head><body><main>
  <div class="top"><a href="/inbox">← Inbox</a><a href="/artifacts">Artifacts</a></div>
  <header><div class="badge">${esc(message.type)}${message.priority === "urgent" ? " · urgent" : ""}</div><h1 class="title">${esc(message.title)}</h1><div class="meta">${esc(message.instance_project || "PidginDocs")} · ${esc(message.instance_model || "agent")} · ${esc(new Date(message.created_at).toLocaleString())}</div></header>
  <label class="preference"><input id="collapse-default" type="checkbox"> Collapse visualizations by default on this browser</label>
  <article class="response">${rendered.join("\n") || '<p class="meta">No message body was stored.</p>'}</article>
  ${message.reply ? `<section class="reply"><div class="badge">Your reply</div><p>${inlineMarkdown(message.reply)}</p></section>` : ""}
</main><script>
var embedOrigin=${JSON.stringify(embedOrigin)};
var started=performance.now();
var failureTimers=new WeakMap();
function telemetry(artifactId,event,duration){
  var body=JSON.stringify({message_id:${JSON.stringify(message.id)},artifact_id:artifactId,event:event,duration_ms:duration||null});
  if(navigator.sendBeacon){navigator.sendBeacon('/api/artifacts/telemetry',new Blob([body],{type:'application/json'}));}
  else fetch('/api/artifacts/telemetry',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:body}).catch(function(){});
}
function setArtifactCollapsed(el,collapsed){el.classList.toggle('collapsed',collapsed);var button=el.querySelector('.artifact-head');if(button&&!button.disabled)button.setAttribute('aria-expanded',String(!collapsed));}
function toggleArtifact(id){var el=document.getElementById(id);setArtifactCollapsed(el,!el.classList.contains('collapsed'));}
function recordOpen(id){telemetry(id,'opened_fullscreen',null);}
function markArtifactFailed(frame){var el=frame.closest('.artifact-block');if(!el||el.classList.contains('loaded'))return;el.classList.add('failed');if(el.dataset.failedRecorded!=='true'){el.dataset.failedRecorded='true';telemetry(el.dataset.artifactId,'failed',Math.round(performance.now()-started));}}
function armArtifactFrame(frame){var previous=failureTimers.get(frame);if(previous)clearTimeout(previous);failureTimers.set(frame,setTimeout(function(){markArtifactFailed(frame);},12000));}
function retryArtifact(id){var el=document.getElementById(id);var frame=el&&el.querySelector('iframe');if(!frame)return;el.classList.remove('failed','loaded');delete el.dataset.failedRecorded;delete el.dataset.loadedRecorded;frame.src=frame.src;armArtifactFrame(frame);}
addEventListener('message',function(event){
  var d=event.data||{};if(!embedOrigin||event.origin!==embedOrigin||d.type!=='pidgin:artifact-size')return;
  var el=document.querySelector('[data-artifact-id="'+CSS.escape(String(d.artifactId))+'"][data-version="'+Number(d.version)+'"]');if(!el||el.dataset.nonce!==d.nonce)return;
  var frame=el.querySelector('iframe');if(!frame||event.source!==frame.contentWindow)return;
  var timer=failureTimers.get(frame);if(timer)clearTimeout(timer);var height=Math.max(180,Math.min(560,Number(d.height)||240));frame.style.height=height+'px';el.classList.remove('failed');el.classList.add('loaded');if(el.dataset.loadedRecorded!=='true'){el.dataset.loadedRecorded='true';telemetry(String(d.artifactId),'loaded',Math.round(performance.now()-started));}
});
document.querySelectorAll('.artifact-content iframe').forEach(function(frame){frame.addEventListener('error',function(){markArtifactFailed(frame);});armArtifactFrame(frame);});
var pref=document.getElementById('collapse-default');pref.checked=localStorage.getItem('pidgin.widgets.collapsed')==='true';if(pref.checked)document.querySelectorAll('.artifact-block:not(.unavailable)').forEach(function(el){setArtifactCollapsed(el,true);});pref.addEventListener('change',function(){localStorage.setItem('pidgin.widgets.collapsed',String(pref.checked));document.querySelectorAll('.artifact-block:not(.unavailable)').forEach(function(el){setArtifactCollapsed(el,pref.checked);});});
</script></body></html>`;

  const frameSrc = embedOrigin || "'none'";
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; ` +
        `connect-src 'self'; frame-src ${frameSrc}; img-src data:; base-uri 'none'; frame-ancestors 'none'`,
      "Referrer-Policy": "no-referrer",
    },
  });
}
