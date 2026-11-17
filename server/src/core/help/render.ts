/**
 * Safe HTML for help assistant answers.
 *
 * The model's text is untrusted. Everything is escaped first; only then is a
 * small Markdown subset turned into markup: paragraphs, "-"/"*" and "1."
 * lists, **bold**, *italic* or _italic_, `inline code`, fenced code blocks, and
 * [S#] source markers. A marker becomes a link only when its number is in the
 * validated citation list, and the link target comes from that list (a known
 * article slug and anchor), never from the model's text. Unknown markers are
 * dropped. Code is literal: nothing inside code, [S#] included, becomes markup.
 * No raw HTML passes through. Absolute citation links are allowed only on the
 * origin the caller names.
 */

export interface RenderCitation {
  n: number;
  url: string;
  title?: string;
  heading?: string;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;",
};

export function escapeHelpHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (char) => ESCAPES[char]);
}

/** Help links are same-site article paths, optionally absolute on the edition's origin. */
const HELP_LINK = /^(https?:\/\/[A-Za-z0-9.-]+(?::\d+)?)?\/help\/[a-z0-9]+(?:-[a-z0-9]+)*(?:#[\p{L}\p{N}-]+)?$/u;

/**
 * A same-site /help/<slug>#<anchor> path, or the same path made absolute on
 * `origin` (WORKER_URL: https in production, http in local dev). Absolute links
 * on any other origin, and any other scheme, are refused.
 */
export function isSafeHelpLink(url: string, origin?: string | null): boolean {
  const match = HELP_LINK.exec(url);
  if (!match) return false;
  if (!match[1]) return true;
  if (!origin) return false;
  try {
    const allowed = new URL(origin);
    return (allowed.protocol === "https:" || allowed.protocol === "http:") && new URL(match[1]).origin === allowed.origin;
  } catch {
    return false;
  }
}

const CITATION = /\[S(\d{1,2})\]/g;
const BOLD = /\*\*(?=\S)([^*\n]*?\S)\*\*/g;
// Single * or _ emphasis on one line, not inside a word (EXAMPLE_AGENT_KEY, 2*3*4 stay as written) and never
// across a tag, so it cannot overlap <strong>.
const EM_STAR = /(?<![\p{L}\p{N}*])\*(?![\s*])([^*<>\n]*?[^\s*<>])\*(?![\p{L}\p{N}*])/gu;
const EM_UNDERSCORE = /(?<![\p{L}\p{N}_])_(?![\s_])([^_<>\n]*?[^\s_<>])_(?![\p{L}\p{N}_])/gu;
const LIST_ITEM = /^\s{0,3}(?:([-*+•])|(\d{1,3})[.)])\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})([^\n]*)$/;

export type AnswerSegment =
  | { code: false; text: string }
  | { code: true; text: string; lines: string[] };

/**
 * Splits text into prose and fenced code blocks (``` or ~~~, any language tag).
 * A code segment's text is its fence lines and content as written; `lines` is
 * the content with the opening fence's indentation removed. An unclosed fence
 * runs to the end. Joining every segment's text with "\n" gives the input back.
 */
export function splitFencedCode(text: string): AnswerSegment[] {
  const segments: AnswerSegment[] = [];
  let prose: string[] = [];
  let fence: { marker: string; indent: number; raw: string[]; lines: string[] } | null = null;
  for (const line of text.split("\n")) {
    if (fence) {
      fence.raw.push(line);
      const close = /^[ \t]*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length) {
        segments.push({ code: true, text: fence.raw.join("\n"), lines: fence.lines });
        fence = null;
      } else {
        fence.lines.push(line.replace(new RegExp(`^[ \\t]{0,${fence.indent}}`), ""));
      }
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    // A backtick fence's language tag cannot contain backticks (that line is inline code).
    if (open && !(open[2][0] === "`" && open[3].includes("`"))) {
      if (prose.length) segments.push({ code: false, text: prose.join("\n") });
      prose = [];
      fence = { marker: open[2], indent: open[1].length, raw: [line], lines: [] };
      continue;
    }
    prose.push(line);
  }
  if (fence) segments.push({ code: true, text: fence.raw.join("\n"), lines: fence.lines });
  if (prose.length) segments.push({ code: false, text: prose.join("\n") });
  return segments;
}

// Inline code spans are set aside before escaping so their contents stay literal:
// a NUL-delimited placeholder (control characters are stripped from the input,
// so the model cannot forge one) holds each span's place while markup is added,
// and the code text is escaped on its own and never gets emphasis or link markup.
function renderInline(raw: string, links: Map<number, RenderCitation>): string {
  const spans: string[] = [];
  const text = raw.replace(/`+[^`\n]+`+/g, (span) => `\u0000${spans.push(span.replace(/^`+|`+$/g, "")) - 1}\u0000`);
  // Escaping leaves "[S1]", "*" and "_" untouched, so markup is added afterwards,
  // citations last so emphasis never reaches into a link's title.
  return escapeHelpHtml(text)
    .replace(BOLD, "<strong>$1</strong>")
    .replace(EM_STAR, "<em>$1</em>")
    .replace(EM_UNDERSCORE, "<em>$1</em>")
    .replace(CITATION, (_match, digits: string) => {
      const citation = links.get(Number(digits));
      if (!citation) return "";
      const label = [citation.title, citation.heading].filter(Boolean).join(" — ");
      return `<a class="help-cite" href="${escapeHelpHtml(citation.url)}"${label ? ` title="${escapeHelpHtml(label)}"` : ""}>[${citation.n}]</a>`;
    })
    .replace(/ {2,}/g, " ")
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => `<code>${escapeHelpHtml(spans[Number(index)] ?? "")}</code>`)
    .trim();
}

/** A code block, escaped and otherwise as written; blank lines around it are dropped. */
function renderCode(lines: readonly string[]): string {
  let first = 0;
  let last = lines.length;
  while (first < last && !lines[first].trim()) first += 1;
  while (last > first && !lines[last - 1].trim()) last -= 1;
  return first < last ? `<pre><code>${escapeHelpHtml(lines.slice(first, last).join("\n"))}</code></pre>` : "";
}

/** A list item's text lines and the code blocks that belong to it, in order. */
type ItemPart = { code: boolean; lines: string[] };

type Block =
  | { type: "p"; lines: string[] }
  | { type: "pre"; lines: string[] }
  | { type: "ul" | "ol"; start: number; items: ItemPart[][] };

/**
 * `origin` allows absolute citation links on that origin (see isSafeHelpLink); without it only site-relative links render.
 *
 * Lists stay open across blank lines, so "1. … \n\n2. …" is one list; a code
 * block after an item belongs to that item, and the next item continues the
 * list. An ordered list keeps the number its first item was written with
 * (<ol start="3">), so a list split by a paragraph still counts on.
 */
export function renderAnswerHtml(text: string, citations: readonly RenderCitation[], origin?: string | null): string {
  const links = new Map<number, RenderCitation>();
  for (const citation of citations) {
    if (Number.isSafeInteger(citation.n) && citation.n > 0 && isSafeHelpLink(citation.url, origin)) links.set(citation.n, citation);
  }
  const blocks: Block[] = [];
  let current: Exclude<Block, { type: "pre" }> | null = null;
  const close = () => { if (current) blocks.push(current); current = null; };

  const normalized = String(text ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  for (const segment of splitFencedCode(normalized)) {
    if (segment.code) {
      if (current && current.type !== "p" && current.items.length) {
        current.items[current.items.length - 1].push({ code: true, lines: segment.lines });
      } else {
        close();
        blocks.push({ type: "pre", lines: segment.lines });
      }
      continue;
    }
    for (const line of segment.text.split("\n")) {
      if (!line.trim()) {
        // A blank line ends a paragraph; a list waits to see what comes next.
        if (current?.type === "p") close();
        continue;
      }
      const item = LIST_ITEM.exec(line);
      if (item) {
        const type = item[1] ? "ul" : "ol";
        if (!current || current.type !== type) { close(); current = { type, start: item[2] ? Number(item[2]) : 1, items: [] }; }
        (current as { items: ItemPart[][] }).items.push([{ code: false, lines: [item[3]] }]);
        continue;
      }
      const heading = HEADING.exec(line);
      if (heading) {
        close();
        blocks.push({ type: "p", lines: [`**${heading[1].replace(/\*\*/g, "")}**`] });
        continue;
      }
      if (current && current.type !== "p") {
        // An indented line continues the previous list item.
        if (/^\s+/.test(line) && current.items.length) {
          const parts = current.items[current.items.length - 1];
          const tail = parts[parts.length - 1];
          if (tail.code) parts.push({ code: false, lines: [line.trim()] });
          else tail.lines.push(line.trim());
          continue;
        }
        close();
      }
      if (!current) current = { type: "p", lines: [] };
      (current as { lines: string[] }).lines.push(line.trim());
    }
  }
  close();

  return blocks.map((block) => {
    if (block.type === "p") {
      const body = block.lines.map((line) => renderInline(line, links)).filter(Boolean).join("<br>");
      return body ? `<p>${body}</p>` : "";
    }
    if (block.type === "pre") return renderCode(block.lines);
    const items = block.items.map((parts) => parts.map((part) => part.code
      ? renderCode(part.lines)
      : part.lines.map((line) => renderInline(line, links)).filter(Boolean).join(" ")).filter(Boolean).join("")).filter(Boolean);
    const start = block.type === "ol" && block.start !== 1 ? ` start="${block.start}"` : "";
    return items.length ? `<${block.type}${start}>${items.map((item) => `<li>${item}</li>`).join("")}</${block.type}>` : "";
  }).filter(Boolean).join("\n");
}
