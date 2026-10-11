/**
 * Remove raw-text elements while extracting visible text from HTML. This is
 * deliberately a text-extraction helper, not an HTML sanitizer or renderer.
 * The scanner recognizes HTML's end-tag form, including attributes and
 * whitespace before `>`, without relying on a tag-matching regular expression.
 */
export function removeRawTextElements(html: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < html.length) {
    const start = findRawTextStart(html, cursor);
    if (start === -1) {
      output += html.slice(cursor);
      break;
    }

    output += html.slice(cursor, start);
    const name = rawTextNameAt(html, start)!;
    const contentStart = findTagEnd(html, start + 1);
    if (contentStart === -1) {
      output += html.slice(start);
      break;
    }
    const end = findRawTextEnd(html, contentStart + 1, name);
    if (end === -1) break; // An unclosed raw-text element has no visible text.

    cursor = findTagEnd(html, end + 2 + name.length) + 1;
  }

  return output;
}

/** Convert HTML to email-safe plain text without decoding escaped angle brackets. */
export function htmlToPlainText(html: string): string {
  const source = removeRawTextElements(html);
  let output = "";

  for (let i = 0; i < source.length;) {
    if (source.startsWith("<!--", i)) {
      const commentEnd = source.indexOf("-->", i + 4);
      i = commentEnd === -1 ? source.length : commentEnd + 3;
      continue;
    }

    if (source[i] === "<" && (source[i + 1] === "!" || source[i + 1] === "?")) {
      const declarationEnd = findTagEnd(source, i + 1);
      i = declarationEnd === -1 ? source.length : declarationEnd + 1;
      continue;
    }

    if (source[i] === "<" && isTagStartAt(source, i)) {
      const tagEnd = findTagEnd(source, i + 1);
      if (tagEnd === -1) {
        output += "&lt;";
        i++;
        continue;
      }
      const tagName = readTagName(source, i);
      if (tagName === "br") {
        output += "\n";
      } else if (tagName === "p" && source[i + 1] === "/") {
        output += "\n\n";
      }
      i = tagEnd + 1;
      continue;
    }

    output += source[i] === "<" ? "&lt;" : source[i];
    i++;
  }

  return output
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function rawTextNameAt(html: string, start: number): "script" | "style" | null {
  const remainder = html.slice(start + 1).toLowerCase();
  for (const name of ["script", "style"] as const) {
    const boundary = remainder[name.length];
    if (remainder.startsWith(name) && isTagBoundary(boundary)) return name;
  }
  return null;
}

function findRawTextStart(html: string, from: number): number {
  for (let i = from; i < html.length; i++) {
    if (html[i] !== "<") continue;
    if (html.startsWith("<!--", i)) {
      const commentEnd = html.indexOf("-->", i + 4);
      if (commentEnd === -1) return -1;
      i = commentEnd + 2;
      continue;
    }
    if (rawTextNameAt(html, i)) return i;

    // Skip other start/end tags as a unit so a quoted attribute containing
    // literal `<script>` text cannot be mistaken for a raw-text element.
    if (isTagStartAt(html, i)) {
      const tagEnd = findTagEnd(html, i + 1);
      if (tagEnd === -1) return -1;
      i = tagEnd;
    }
  }
  return -1;
}

function isTagBoundary(character: string | undefined): boolean {
  return character === ">" || character === "/" || character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\f";
}

function isTagStartAt(html: string, start: number): boolean {
  let nameStart = start + 1;
  if (html[nameStart] === "/") nameStart++;
  const first = html[nameStart]?.toLowerCase();
  return first !== undefined && first >= "a" && first <= "z";
}

function readTagName(html: string, start: number): string {
  let nameStart = start + 1;
  if (html[nameStart] === "/") nameStart++;
  let end = nameStart;
  while (end < html.length) {
    const character = html[end].toLowerCase();
    if (!(character >= "a" && character <= "z") && !(character >= "0" && character <= "9") && character !== ":" && character !== "-") break;
    end++;
  }
  return html.slice(nameStart, end).toLowerCase();
}

function findRawTextEnd(html: string, from: number, name: "script" | "style"): number {
  const lower = html.toLowerCase();
  const needle = `</${name}`;
  let candidate = from;
  while ((candidate = lower.indexOf(needle, candidate)) !== -1) {
    const boundary = lower[candidate + needle.length];
    if (boundary === ">" || boundary === "/" || boundary === " " || boundary === "\t" || boundary === "\n" || boundary === "\r" || boundary === "\f") {
      const close = findTagEnd(html, candidate + needle.length);
      if (close !== -1) return candidate;
      return -1;
    }
    candidate += needle.length;
  }
  return -1;
}

function findTagEnd(html: string, from: number): number {
  let quote = "";
  for (let i = from; i < html.length; i++) {
    const character = html[i];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === ">") {
      return i;
    }
  }
  return -1;
}
