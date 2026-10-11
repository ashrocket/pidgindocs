import { Marked } from "marked";
import {
  CompiledDesignSystem,
  PIDGIN_EDITORIAL,
  compileDesignSystem,
} from "./design-system";

// Server-side typesetting for agent documents. Agents send markdown (or plain
// text) and every client — iOS, macOS, web, share links — receives the same
// finished, self-contained page. Design language: warm paper & ink, editorial
// typography, system fonts only, zero external requests.

export interface TypesetInput {
  title: string;
  markdown?: string | null;
  body?: string | null;
  project?: string | null;
  createdAt?: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// The document chrome owns <h1> (the title), so markdown headings shift down
// one level: # → h2, ## → h3, … capped at h6.
function demoteHeadings() {
  return (token: { type: string; depth?: number }) => {
    if (token.type === "heading" && typeof token.depth === "number") {
      token.depth = Math.min(token.depth + 1, 6);
    }
  };
}

export function renderMarkdownContent(markdown: string): string {
  const marked = new Marked({ gfm: true, walkTokens: demoteHeadings() });
  const html = marked.parse(markdown, { async: false }) as string;
  // ```mermaid fences become <pre class="mermaid"> blocks; typesetDocument
  // injects the same-origin renderer (the artifacts pipeline's R2-cached
  // /a/assets/mermaid.js) whenever one is present.
  return html.replace(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    (_match, inner: string) => `<pre class="mermaid">${decodeEntities(inner)}</pre>`
  );
}

// Mermaid follows the PAGE, not the OS: a light-only style (empty darkCss)
// always renders neutral diagrams; only styles that ship a dark palette let
// the media query flip the diagram theme with the page.
function mermaidBlock(supportsDark: boolean): string {
  const theme = supportsDark
    ? "matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'neutral'"
    : "'neutral'";
  return `<script src="/a/assets/mermaid.js" defer></script>
<script>
addEventListener('DOMContentLoaded', function () {
  if (!window.mermaid) return;
  window.mermaid.initialize({ startOnLoad: false, theme: ${theme} });
  window.mermaid.run({ querySelector: '.mermaid' });
});
</script>`;
}

function renderPlainBody(body: string): string {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`);
  return paragraphs.join("\n");
}

function formatDate(iso: string | null | undefined): string {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

// Base document stylesheet. Consumes ONLY --ds-* variables; the concrete
// values come from the compiled design system prepended in typesetDocument.
const BASE_STYLES = `
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    background: var(--ds-bg);
    color: var(--ds-text);
    font-family: var(--ds-font-body);
    font-size: 17px;
    line-height: 1.62;
    font-feature-settings: "onum" 1, "pnum" 1;
  }
  .sheet { max-width: 680px; margin: 0 auto; padding: 34px 24px 80px; }

  header.doc {
    display: flex; align-items: baseline; gap: 12px;
    font-family: var(--ds-font-heading);
    font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase;
    color: var(--ds-text-muted);
    margin-bottom: 30px;
  }
  header.doc .mark { color: var(--ds-accent); font-weight: 700; }
  header.doc .rule { flex: 1; border-top: 1px solid var(--ds-text); transform: translateY(-3px); }

  h1.title {
    font-size: 34px; line-height: 1.16; font-weight: 650;
    letter-spacing: -0.01em;
    margin: 0 0 28px;
  }

  article p { margin: 0 0 14px; }
  article a { color: var(--ds-accent); text-decoration-color: var(--ds-rule); text-underline-offset: 3px; }
  article strong { font-weight: 650; }

  article h2 {
    font-family: var(--ds-font-heading);
    font-size: 12px; font-weight: 700;
    letter-spacing: 0.2em; text-transform: uppercase;
    color: var(--ds-accent);
    margin: 40px 0 16px;
    display: flex; align-items: baseline; gap: 12px;
  }
  article h2::after { content: ""; flex: 1; border-top: 1px solid var(--ds-rule); transform: translateY(-3px); }
  article h3 { font-size: 20px; font-weight: 650; margin: 28px 0 10px; }
  article h4 {
    font-family: var(--ds-font-heading); font-size: 12px; font-weight: 700;
    letter-spacing: 0.14em; text-transform: uppercase; color: var(--ds-text-muted);
    margin: 22px 0 8px;
  }

  article ul, article ol { margin: 0 0 14px; padding-left: 26px; }
  article li { margin-bottom: 6px; }
  article li::marker { color: var(--ds-accent); }

  article blockquote {
    margin: 22px 0; padding: 14px 20px;
    border-left: 3px solid var(--ds-accent);
    background: var(--ds-surface);
    font-size: 16px;
  }
  article blockquote p:last-child { margin-bottom: 0; }

  article code {
    font-family: var(--ds-font-mono); font-size: 0.86em;
    background: var(--ds-surface);
    padding: 1px 5px; border-radius: 2px;
  }
  article pre {
    background: var(--ds-surface);
    border: 1px solid var(--ds-rule);
    padding: 14px 16px; overflow-x: auto;
    margin: 0 0 16px;
  }
  article pre code { background: none; padding: 0; font-size: 13px; line-height: 1.55; }
  article pre.mermaid { text-align: center; }
  article pre.mermaid svg { max-width: 100%; }

  article table {
    width: 100%; border-collapse: collapse;
    font-family: var(--ds-font-heading); font-size: 14px;
    margin: 0 0 18px;
  }
  article th {
    text-align: left; font-size: 10.5px; letter-spacing: 0.16em;
    text-transform: uppercase; color: var(--ds-text-faint); font-weight: 600;
    padding: 0 12px 8px 0;
    border-bottom: 1px solid var(--ds-text);
  }
  article td {
    padding: 10px 12px 10px 0;
    border-bottom: 1px solid var(--ds-rule);
    vertical-align: baseline;
  }
  article hr {
    border: none; border-top: 1px solid var(--ds-rule);
    margin: 30px auto; width: 38%;
  }
  article img { max-width: 100%; }

  footer.doc {
    margin-top: 56px; padding-top: 14px;
    border-top: 1px solid var(--ds-text);
    display: flex; justify-content: space-between;
    font-family: var(--ds-font-heading); font-size: 10.5px;
    letter-spacing: 0.14em; text-transform: uppercase; color: var(--ds-text-faint);
  }
`;

let defaultCompiled: CompiledDesignSystem | null = null;
function defaultDesignSystem(): CompiledDesignSystem {
  if (!defaultCompiled) defaultCompiled = compileDesignSystem(PIDGIN_EDITORIAL);
  return defaultCompiled;
}

export function typesetDocument(
  input: TypesetInput,
  designSystem?: CompiledDesignSystem
): string {
  const ds = designSystem ?? defaultDesignSystem();
  const title = escapeHtml(input.title ?? "");
  const project = input.project ? escapeHtml(input.project) : null;
  const date = formatDate(input.createdAt);
  // Agents often open their markdown with "# <title>" matching --title; the
  // chrome already typesets the title, so drop the duplicate heading.
  let markdown = input.markdown ?? null;
  if (markdown) {
    const lines = markdown.trimStart();
    const firstLineEnd = lines.indexOf("\n");
    const firstLine = (firstLineEnd === -1 ? lines : lines.slice(0, firstLineEnd)).trim();
    const headingText = firstLine.replace(/^#\s+/, "").trim();
    if (
      firstLine.startsWith("# ") &&
      headingText.toLowerCase() === (input.title ?? "").trim().toLowerCase()
    ) {
      markdown = firstLineEnd === -1 ? "" : lines.slice(firstLineEnd + 1);
    }
  }

  const content = markdown
    ? renderMarkdownContent(markdown)
    : renderPlainBody(input.body ?? "");

  const dateline = [project, date].filter(Boolean).join(" · ");

  const tail =
    (content.includes('class="mermaid"') ? `\n${mermaidBlock(Boolean(ds.darkCss))}` : "") +
    (ds.effectsJs ? `\n<script>${ds.effectsJs}</script>` : "");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="${ds.darkCss ? "light dark" : "light"}">
<title>${title}</title>
<style>${ds.rootCss}
${ds.darkCss}
${BASE_STYLES}
${ds.partialCss}</style>
</head>
<body>
<div class="sheet">
  <header class="doc">
    <span class="mark">PidginDocs</span>
    <span class="rule"></span>
    <span>${dateline}</span>
  </header>
  <h1 class="title">${title}</h1>
  <article>
${content}
  </article>
  <footer class="doc">
    <span>PidginDocs · self-hosted by you</span>
  </footer>
</div>${tail}
</body>
</html>`;
}
