import { Marked } from "marked";
import type { CompiledDesignSystem } from "../documents/design-system";

// Serve-time wrapping for artifacts (Claude Code artifact parity): authors
// write body content only; the host supplies the <!doctype html> skeleton, a
// minimal CSS reset, theme handling, the emoji favicon, and the mermaid
// renderer. Wrapping at serve time (instead of publish time) means this layer
// can be upgraded without republishing any artifact.

export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024; // 16 MiB rendered cap

// The reset is injected at the TOP of <head> so authored styles, which come
// later, always win. Theme contract: pages follow prefers-color-scheme by
// default, and a data-theme attribute stamped on <html> by the viewer's theme
// toggle wins in BOTH directions.
//
// The --ds-* variables carry the Swiss Airmail house palette from the native
// clients (clients/apple/Sources/Shared/DesignSystem.swift): cream/clay paper,
// ink navy text, sky links, serif display. They use the same names the
// document typesetter emits, so an artifact-declared design system restyles a
// page by re-pointing ONLY these variables (designSystemStyleBlock below).
// The app itself is light-only; the dark values are counterparts derived for
// the artifact viewer's dark mode.
const HOUSE_DARK_VARS = `--ds-bg: #0D1826; --ds-surface: #16263A; --ds-text: #EAE4D6;
      --ds-text-muted: #A9B6C7; --ds-text-faint: #7C8AA0; --ds-accent: #6FA3EC;
      --ds-rule: #263B52; --ds-positive: #7CAF8D;`;

const ARTIFACT_RESET = `<style>
  :root {
    color-scheme: light dark;
    --ds-bg: #FEFCF7;
    --ds-surface: #F3ECDF;
    --ds-text: #102335;
    --ds-text-muted: #405A77;
    --ds-text-faint: #6D6555;
    --ds-accent: #1C5FC4;
    --ds-rule: #C6BCA9;
    --ds-positive: #2F6B46;
    --ds-font-body: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --ds-font-heading: ui-serif, "New York", "Iowan Old Style", Georgia, serif;
    --ds-font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      ${HOUSE_DARK_VARS}
    }
  }
  :root[data-theme="dark"] {
    ${HOUSE_DARK_VARS}
  }
  html { -webkit-text-size-adjust: 100%; }
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; font-family: var(--ds-font-body); background: var(--ds-bg); color: var(--ds-text); }
  a { color: var(--ds-accent); }
  img, svg, video, canvas, iframe { max-width: 100%; }
</style>`;

// Typography for markdown artifacts only (html artifacts bring their own).
// Colors and fonts ride on the reset's --ds-* variables, so both the theme
// flip and a declared design system restyle these rules for free.
const MARKDOWN_STYLES = `<style>
  main.artifact { max-width: 720px; margin: 0 auto; padding: 40px 22px 80px; line-height: 1.6; font-size: 17px; }
  main.artifact h1, main.artifact h2, main.artifact h3,
  main.artifact h4, main.artifact h5, main.artifact h6 { font-family: var(--ds-font-heading); }
  main.artifact h1 { font-size: 30px; line-height: 1.2; margin: 0 0 20px; }
  main.artifact h2 { font-size: 22px; margin: 34px 0 12px; }
  main.artifact h3 { font-size: 18px; margin: 26px 0 10px; }
  main.artifact p, main.artifact ul, main.artifact ol { margin: 0 0 14px; }
  main.artifact li { margin-bottom: 5px; }
  main.artifact a { color: var(--ds-accent); text-decoration-thickness: 1px; text-underline-offset: 3px; }
  main.artifact blockquote { margin: 18px 0; padding: 2px 18px; border-left: 3px solid var(--ds-rule); color: var(--ds-text-muted); }
  main.artifact code { font-family: var(--ds-font-mono); font-size: .88em; background: var(--ds-surface); padding: 1px 5px; border-radius: 3px; }
  main.artifact pre { background: var(--ds-surface); padding: 14px 16px; border-radius: 6px; overflow-x: auto; margin: 0 0 16px; }
  main.artifact pre code { background: none; padding: 0; font-size: 13.5px; line-height: 1.55; }
  main.artifact table { border-collapse: collapse; margin: 0 0 18px; display: block; overflow-x: auto; }
  main.artifact th, main.artifact td { text-align: left; padding: 7px 12px; border-bottom: 1px solid var(--ds-rule); }
  main.artifact hr { border: none; border-top: 1px solid var(--ds-rule); margin: 30px 0; }
</style>`;

// Relative luminance of the last hex color in a CSS value, or null when no
// hex is present (url(), gradients, named colors). Used only to pick which
// scheme a single-look style pins — never to alter its palette.
function valueLuminance(value: string): number | null {
  const hexes = value.match(/#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b/gi);
  if (!hexes) return null;
  let hex = hexes[hexes.length - 1].slice(1);
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Opt-in design-system layer (artifacts.design_system): re-points the reset's
// --ds-* variables at a compiled style's palette + fonts, and applies the
// style's fonts/link color at element level. Injected immediately AFTER the
// reset so authored CSS still comes later and wins. Contract details:
//
// - Values are re-emitted from the compiler's structured pairs, never parsed
//   out of CSS text — token values may legally contain ';', newlines, or
//   url("data:...") strings.
// - The reset overrides color variables inside dark guards at specificity
//   (0,2,0), so this layer must restate the FULL variable set inside the same
//   guards — dark tokens overlaid on light — or house dark values would bleed
//   through for any variable the style's dark subtree doesn't override.
// - A style with no dark tokens pins its one palette in both modes and
//   declares the matching color-scheme (from the background's luminance, so a
//   single-look dark style gets dark UA chrome, not light).
export function designSystemStyleBlock(compiled: CompiledDesignSystem): string {
  const { rootVars, darkVars: darkOverrides } = compiled;
  if (!rootVars.length) return "";
  const merged = new Map(rootVars.map((v) => [v.name, v]));
  for (const v of darkOverrides) merged.set(v.name, v);
  const darkVars = [...merged.values()];

  let pinnedScheme: "light" | "dark" | null = null;
  if (darkOverrides.length === 0) {
    const bg = rootVars.find((v) => v.name === "--ds-bg");
    const luminance = bg ? valueLuminance(bg.value) : null;
    pinnedScheme = luminance !== null && luminance < 0.4 ? "dark" : "light";
  }

  const decl = (vars: Array<{ name: string; value: string }>, pad: string): string =>
    vars.map((v) => `${pad}${v.name}: ${v.value};`).join("\n");
  return `<style>
  :root {
${pinnedScheme ? `    color-scheme: ${pinnedScheme};\n` : ""}${decl(rootVars, "    ")}
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
${decl(darkVars, "      ")}
    }
  }
  :root[data-theme="dark"] {
${decl(darkVars, "    ")}
  }
  body { font-family: var(--ds-font-body); background: var(--ds-bg); color: var(--ds-text); }
  h1, h2, h3, h4, h5, h6 { font-family: var(--ds-font-heading); }
  code, pre, kbd, samp { font-family: var(--ds-font-mono); }
  a { color: var(--ds-accent); }
</style>`;
}

const MOBILE_VIEWPORT = `<meta name="viewport" content="width=device-width, initial-scale=1">`;

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

// Emoji favicon as an inline data: URI — no extra endpoint, works offline,
// and survives the strict CSP (data: images are allowed).
export function faviconDataUri(emoji: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="0.9em" font-size="88">${emoji}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// First <title> tag in an authored HTML document, or null.
export function extractHtmlTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  const title = decodeEntities(match[1]).replace(/\s+/g, " ").trim();
  return title || null;
}

export function contentNeedsMermaid(content: string): boolean {
  return /class="mermaid"|class='mermaid'/.test(content);
}

// Markdown → HTML fragment. Unlike document typesetting, headings are NOT
// demoted (the artifact owns its whole page) and ```mermaid fences become
// <pre class="mermaid"> blocks the client-side renderer picks up.
export function renderArtifactMarkdown(markdown: string): string {
  const marked = new Marked({ gfm: true });
  const html = marked.parse(markdown, { async: false }) as string;
  return html.replace(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    (_match, inner: string) => `<pre class="mermaid">${decodeEntities(inner)}</pre>`
  );
}

function mermaidBlock(force: "light" | "dark" | null): string {
  const darkExpr =
    force === "light"
      ? "false"
      : force === "dark"
        ? "true"
        : "t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)";
  return `<script src="/a/assets/mermaid.js" defer></script>
<script>
addEventListener('DOMContentLoaded', function () {
  if (!window.mermaid) return;
  var t = document.documentElement.getAttribute('data-theme');
  var dark = ${darkExpr};
  window.mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default' });
  window.mermaid.run({ querySelector: '.mermaid' });
});
</script>`;
}

function runtimeBlock(artifactId: string): string {
  return `<script src="/a/assets/runtime.js" defer data-artifact-id="${escapeHtml(artifactId)}"></script>`;
}

function embedResizeBlock(artifactId: string, version: number, nonce: string, parentOrigin: string): string {
  const payload = JSON.stringify({
    type: "pidgin:artifact-size",
    nonce,
    artifactId,
    version,
  });
  return `<script>
(function () {
  var base = ${payload};
  var target = ${JSON.stringify(parentOrigin)};
  var last = 0;
  function report() {
    var height = Math.max(
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0
    );
    if (!height || Math.abs(height - last) < 2) return;
    last = height;
    parent.postMessage(Object.assign({}, base, { height: height }), target);
  }
  addEventListener('load', report);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(report).observe(document.documentElement);
  }
  setTimeout(report, 0);
})();
</script>`;
}

export interface WrapArtifactInput {
  content: string; // stored html (fragment or complete document)
  title: string;
  favicon: string;
  artifactId: string;
  sourceKind: "html" | "markdown";
  hasCapabilities: boolean;
  // Prebuilt designSystemStyleBlock() output for the artifact's declared
  // style; injected right after the reset so authored CSS still wins.
  designSystemCss?: string;
  embed?: {
    version: number;
    nonce: string;
    parentOrigin: string;
  };
}

// The strict artifact CSP: zero external hosts. 'self' is allowed so this
// worker origin can supply the mermaid + runtime scripts — the same trust
// model as claudeusercontent.com hosting Claude's renderers. connect-src
// opens to 'self' ONLY for capability-declaring artifacts, whose runtime
// calls are answered exclusively by /api/artifacts/:id/rt/*.
export function artifactCsp(hasCapabilities: boolean, frameAncestor = "'none'"): string {
  return (
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; font-src data:; media-src data: blob:; " +
    `connect-src ${hasCapabilities ? "'self'" : "'none'"}; form-action 'none'; base-uri 'none'; ` +
    `frame-ancestors ${frameAncestor}`
  );
}

export function wrapArtifactHtml(input: WrapArtifactInput): string {
  const faviconLink = `<link rel="icon" href="${faviconDataUri(input.favicon)}">`;

  // Authored complete documents own their theme: their CSS out-cascades the
  // design-system layer, so a single-look style must NOT pin color-scheme or
  // the mermaid theme there — only the variables ride along. For fragments
  // and markdown the layer controls the page, so a pinned style also pins
  // mermaid (or dark-mode viewers would get mismatched diagrams).
  const isAuthoredDoc = /<html[\s>]/i.test(input.content);
  let dsCss = input.designSystemCss ?? "";
  let mermaidForce: "light" | "dark" | null = null;
  if (dsCss) {
    const pin = dsCss.match(/^\s*color-scheme:\s*(light|dark);\n/m);
    if (isAuthoredDoc) {
      if (pin) dsCss = dsCss.replace(pin[0], "");
    } else if (pin) {
      mermaidForce = pin[1] as "light" | "dark";
    }
  }
  const styleLayer = ARTIFACT_RESET + dsCss;
  const needsMermaid = contentNeedsMermaid(input.content);
  const tail =
    (needsMermaid ? mermaidBlock(mermaidForce) : "") +
    (input.hasCapabilities ? runtimeBlock(input.artifactId) : "") +
    (input.embed
      ? embedResizeBlock(
          input.artifactId,
          input.embed.version,
          input.embed.nonce,
          input.embed.parentOrigin
        )
      : "");

  // Authored complete documents keep their own structure; we inject the reset
  // at the head START (author styles win), plus viewport/title/favicon when
  // missing, and the script tail before </body>.
  if (isAuthoredDoc) {
    let html = input.content;
    const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(html);
    const hasTitle = /<title[^>]*>/i.test(html);
    const headInject =
      (hasViewport ? "" : MOBILE_VIEWPORT) +
      (hasTitle ? "" : `<title>${escapeHtml(input.title)}</title>`) +
      faviconLink +
      styleLayer;
    if (/<head[\s>]/i.test(html)) {
      html = html.replace(/(<head[^>]*>)/i, `$1${headInject}`);
    } else {
      html = html.replace(/(<html[^>]*>)/i, `$1<head><meta charset="utf-8">${headInject}</head>`);
    }
    if (tail) {
      html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${tail}</body>`) : html + tail;
    }
    return html;
  }

  const isMarkdown = input.sourceKind === "markdown";
  const body = isMarkdown ? `<main class="artifact">\n${input.content}\n</main>` : input.content;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${MOBILE_VIEWPORT}
<title>${escapeHtml(input.title)}</title>
${faviconLink}
${styleLayer}${isMarkdown ? `\n${MARKDOWN_STYLES}` : ""}
</head>
<body>
${body}
${tail}
</body>
</html>`;
}
