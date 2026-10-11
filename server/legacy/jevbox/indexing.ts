// Section index for library search, ported from Jevbox
// (https://github.com/extend-hq/jevbox, server/indexing.ts,
// server/routing-preview.ts, server/search-candidates.ts; MIT).
//
// PidginDocs documents and artifacts are Markdown or HTML, so every item indexes
// locally: headings make a section tree, and prose becomes overlapping
// 2,400-character source passages. HTML tables split at row boundaries and
// repeat their headers. No model call and no generated summary is involved.

export interface IndexPassage {
  id: string;
  content: string;
}

export interface IndexNode {
  id: string;
  title: string;
  summary: string;
  content: string;
  children: IndexNode[];
  passages: IndexPassage[];
}

export interface ParsedItem {
  version: number;
  nodes: IndexNode[];
  /** Bounded heading outline used to describe the item when routing. */
  outline: string;
  characters: number;
}

export const INDEX_VERSION = 1;
const MAX_TEXT_CHARACTERS = 400_000;
const OUTLINE_CHARACTERS = 1200;

// ── Text extraction ─────────────────────────────────────────────────

const TABLE_TAGS = "table|thead|tbody|tfoot|tr|th|td|caption";
const BLOCK_TAGS =
  "p|div|section|article|header|footer|main|aside|nav|blockquote|pre|ul|ol|dl|dt|dd|figure|figcaption|hr|details|summary|form|fieldset|address";

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&hellip;/gi, "…")
    .replace(/&rsquo;/gi, "’")
    .replace(/&lsquo;/gi, "‘")
    .replace(/&rdquo;/gi, "”")
    .replace(/&ldquo;/gi, "“")
    .replace(/&#(\d+);/g, (_, code) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => safeCodePoint(parseInt(code, 16)))
    .replace(/&amp;/gi, "&");
}

function safeCodePoint(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
}

/**
 * Readable Markdown-like text from an HTML page: headings become `#` lines,
 * list items become `- ` lines, tables keep bare row/cell tags so passages
 * can split them by row. Scripts, styles, and embedded media are dropped.
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|object|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(img|video|audio|source|track|input|button|select|textarea|meta|link)\b[^>]*>/gi, " ");
  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level: string, inner: string) => {
    const heading = decodeEntities(inner.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    return heading ? `\n\n${"#".repeat(Number(level))} ${heading}\n\n` : "\n\n";
  });
  text = text
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n\n")
    .replace(new RegExp(`<(\\/?)(${TABLE_TAGS})\\b[^>]*>`, "gi"), (_, slash: string, tag: string) => `<${slash}${tag.toLowerCase()}>`)
    .replace(new RegExp(`<(?!\\/?(?:${TABLE_TAGS})>)[^>]*>`, "gi"), " ");
  text = decodeEntities(text);
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .join("\n")
    .replace(/<\/(td|th)>\s*\n+\s*/g, "</$1>")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Passages ────────────────────────────────────────────────────────

function splitText(content: string, size: number, overlap: number) {
  const passages: { content: string; start: number; end: number }[] = [];
  for (let start = 0; start < content.length; ) {
    let end = Math.min(start + size, content.length);
    if (end < content.length) {
      const boundary = content.lastIndexOf("\n\n", end);
      if (boundary > start + size / 2) end = boundary;
    }
    const text = content.slice(start, end);
    if (text.trim()) passages.push({ content: text, start, end });
    if (end === content.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return passages;
}

/** Overlapping source passages; HTML tables split at complete rows with their headers repeated. */
export function splitPassages(content: string, size = 2400, overlap = 200) {
  const tables = [...content.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)];
  if (!tables.length) return splitText(content, size, overlap);
  const passages: { content: string; start: number; end: number }[] = [];
  let offset = 0;
  const text = (end: number) => {
    for (const passage of splitText(content.slice(offset, end), size, overlap)) {
      passages.push({ ...passage, start: passage.start + offset, end: passage.end + offset });
    }
  };
  for (const match of tables) {
    text(match.index!);
    const table = match[0];
    const rows = [...table.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)];
    const caption = table.match(/<caption\b[^>]*>[\s\S]*?<\/caption>/i)?.[0] ?? "";
    const head = table.match(/<thead\b[^>]*>[\s\S]*?<\/thead>/i);
    const headers = head
      ? rows.filter((row) => row.index! >= head.index! && row.index! < head.index! + head[0].length)
      : rows.filter(
          (row, index) =>
            index === 0 || (/<th\b/i.test(row[0]) && rows.slice(0, index).every((prev) => /<th\b/i.test(prev[0])))
        );
    const body = rows.filter((row) => !headers.includes(row));
    const before = content.slice(offset, match.index).trim().split(/\n\s*\n/).at(-1)?.slice(-320) ?? "";
    const prefix = `${before ? `${before}\n` : ""}<table>${caption}${headers.map((row) => row[0]).join("")}`;
    let chunk: string[] = [];
    const flush = () => {
      if (!chunk.length && !headers.length) return;
      passages.push({
        content: `${prefix}${chunk.join("")}</table>`,
        start: match.index!,
        end: match.index! + table.length,
      });
      chunk = [];
    };
    for (const row of body) {
      if (chunk.length && prefix.length + chunk.join("").length + row[0].length > size) flush();
      chunk.push(row[0]);
    }
    if (chunk.length || !body.length) flush();
    offset = match.index! + table.length;
  }
  text(content.length);
  return passages;
}

// ── Section tree ────────────────────────────────────────────────────

/** Split at ATX headings outside fenced code blocks. */
function sectionParts(content: string): string[] {
  const offsets = [0];
  let offset = 0;
  let fence: string | undefined;
  for (const line of content.split(/(?<=\n)/)) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
    } else if (!fence && /^#{1,6}\s/.test(line) && offset > 0) {
      offsets.push(offset);
    }
    offset += line.length;
  }
  return offsets.map((start, index) => content.slice(start, offsets[index + 1]));
}

export function flatten(nodes: IndexNode[]): IndexNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function appendContent(node: IndexNode, content: string) {
  node.content += (node.content ? "\n\n" : "") + content;
  for (const passage of splitPassages(content)) {
    node.passages.push({ id: `${node.id}-p${node.passages.length + 1}`, content: passage.content });
  }
}

/** Index Markdown (or text extracted from HTML) into a section tree with passages. */
export function buildIndex(source: string, title: string): ParsedItem {
  const text = source.length > MAX_TEXT_CHARACTERS ? source.slice(0, MAX_TEXT_CHARACTERS) : source;
  let seq = 0;
  const nodes: IndexNode[] = [];
  const stack: { level: number; node: IndexNode }[] = [];
  for (const part of sectionParts(text).filter((p) => p.trim())) {
    const heading = part.match(/^\s{0,3}(#{1,6})\s+(.+)/);
    if (!heading && stack.length) {
      appendContent(stack.at(-1)!.node, part.trim());
      continue;
    }
    const level = heading?.[1].length ?? 0;
    const node: IndexNode = {
      id: `s${++seq}`,
      title: heading ? heading[2].replace(/\s+#+\s*$/, "").trim().slice(0, 200) : title.slice(0, 200) || "Opening",
      summary: "",
      content: "",
      children: [],
      passages: [],
    };
    appendContent(node, part.trim());
    // Text before the first heading is a root sibling, never a parent.
    while (stack.length && stack.at(-1)!.level >= level) stack.pop();
    if (stack.length && heading) stack.at(-1)!.node.children.push(node);
    else nodes.push(node);
    if (heading) stack.push({ level, node });
  }
  for (const node of flatten(nodes)) {
    node.summary = `Sections: ${[node.title, ...flatten(node.children).map((child) => child.title)].join("; ")}`.slice(0, 600);
  }
  const headings = flatten(nodes).map((node) => node.title);
  return {
    version: INDEX_VERSION,
    nodes,
    outline: (headings.length > 1 ? `Outline: ${headings.join("; ")}` : `Opening: ${normalizeIndexText(text).slice(0, 600)}`).slice(
      0,
      OUTLINE_CHARACTERS
    ),
    characters: text.length,
  };
}

// ── Routing previews ────────────────────────────────────────────────

export function normalizeIndexText(content: string): string {
  return content
    .replace(/<[^>]*>/g, " ")
    .replace(/­/g, "")
    .normalize("NFKC")
    .replace(/(\p{L})-\s*\n\s*(?=\p{Ll})/gu, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const PREVIEW_STOPWORDS = new Set(
  "a an and are as at be been being but by can could did do does each for from had has have how if in into is it its may more most no not of on or other our should so some than that the their them then there these they this those through to was we were what when where which who why will with would you your".split(
    " "
  )
);
const previewTerms = (text: string) =>
  (text.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((word) => !PREVIEW_STOPWORDS.has(word));
const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const PREVIEW_CHARACTERS = 1200;
const FRAGMENT_CHARACTERS = 280;
const SAMPLE_LIMIT = 3;

interface Sample {
  text: string;
  node: IndexNode;
  position: number;
  words: Map<string, number>;
  length: number;
  relevance: number;
  information: number;
}

function fragments(content: string): string[] {
  const output: string[] = [];
  for (const paragraph of content
    .replace(/^#{1,6}[\t ]+.*$/gm, "")
    .replace(/<\/t[dh]>/gi, "; ")
    .split(/\n\s*\n/)) {
    const text = normalizeIndexText(paragraph);
    let pending = "";
    for (const { segment } of segmenter.segment(text)) {
      if (pending && pending.length + segment.length > FRAGMENT_CHARACTERS) {
        output.push(pending.trim());
        pending = "";
      }
      if (segment.length <= FRAGMENT_CHARACTERS) pending += segment;
      else {
        for (let start = 0; start < segment.length; ) {
          let end = Math.min(start + FRAGMENT_CHARACTERS, segment.length);
          if (end < segment.length) {
            const space = segment.lastIndexOf(" ", end);
            if (space > start + FRAGMENT_CHARACTERS / 2) end = space;
          }
          output.push(segment.slice(start, end).trim());
          start = end;
        }
      }
    }
    if (pending.trim()) output.push(pending.trim());
  }
  return [...new Set(output)].filter((text) => text.length >= 25);
}

function similarity(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  let shared = 0;
  for (const word of a.keys()) if (b.has(word)) shared++;
  return shared / Math.max(1, a.size + b.size - shared);
}

function excerpt(text: string, budget: number, query: Set<string>): string {
  if (text.length <= budget) return text;
  const hit = [...text.matchAll(/[\p{L}\p{N}]{2,}/gu)].find((match) => query.has(match[0].toLocaleLowerCase()));
  let start = Math.max(0, (hit?.index ?? 0) - Math.floor(budget / 3));
  if (start) {
    const boundary = text.indexOf(" ", start);
    if (boundary !== -1 && boundary < start + 40) start = boundary + 1;
  }
  let end = Math.min(text.length, start + budget - 2);
  if (end < text.length) {
    const boundary = text.lastIndexOf(" ", end);
    if (boundary > start + budget / 2) end = boundary;
  }
  return `${start ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/**
 * Query-aware section descriptions for routing: the section's structure plus
 * up to three source excerpts chosen for query-term relevance, information,
 * and low redundancy, within 1,200 characters.
 */
export function buildSectionPreviews(nodes: IndexNode[], query: string): Map<string, string> {
  const own = new Map<IndexNode, Sample[]>();
  const all: Sample[] = [];
  const index = (node: IndexNode) => {
    const samples = fragments(node.content).map((text, position): Sample => {
      const tokens = previewTerms(text);
      const words = new Map<string, number>();
      for (const word of tokens) words.set(word, (words.get(word) ?? 0) + 1);
      return { text, node, position, words, length: tokens.length, relevance: 0, information: 0 };
    });
    own.set(node, samples);
    all.push(...samples);
    node.children.forEach(index);
  };
  nodes.forEach(index);
  const frequencies = new Map<string, number>();
  for (const samples of own.values()) {
    for (const word of new Set(samples.flatMap((sample) => [...sample.words.keys()]))) {
      frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    }
  }
  const count = Math.max(1, own.size);
  const weight = (word: string) => {
    const frequency = frequencies.get(word) ?? 0;
    return Math.log(1 + (count - frequency + 0.5) / (frequency + 0.5));
  };
  const queryTerms = new Set(previewTerms(query));
  const average = all.reduce((sum, sample) => sum + sample.length, 0) / Math.max(1, all.length);
  for (const sample of all) {
    for (const word of queryTerms) {
      const frequency = sample.words.get(word) ?? 0;
      if (frequency) {
        sample.relevance +=
          (weight(word) * frequency * 2.2) / (frequency + 1.2 * (0.25 + (0.75 * sample.length) / Math.max(1, average)));
      }
    }
    sample.information =
      [...sample.words.keys()]
        .map(weight)
        .sort((a, b) => b - a)
        .slice(0, 12)
        .reduce((sum, value) => sum + value, 0) / Math.max(1, Math.min(12, sample.words.size));
  }

  const previews = new Map<string, string>();
  const visit = (node: IndexNode): Sample[] => {
    const direct = own.get(node)!;
    const pool = [...direct, ...node.children.flatMap(visit)];
    const structure = `${node.title}\n${node.summary}`;
    if (!pool.length) {
      previews.set(node.id, structure.slice(0, PREVIEW_CHARACTERS));
      return pool;
    }
    const selected: Sample[] = [];
    const maxRelevance = pool.reduce((max, sample) => Math.max(max, sample.relevance), 1e-9);
    const maxInformation = pool.reduce((max, sample) => Math.max(max, sample.information), 1e-9);
    const choose = (focused: boolean) => {
      let best: Sample | undefined;
      let bestScore = -Infinity;
      for (const sample of pool) {
        const redundancy = Math.max(0, ...selected.map((previous) => similarity(previous.words, sample.words)));
        if (redundancy > 0.8 || selected.some((previous) => previous.text === sample.text)) continue;
        const score =
          (focused ? sample.relevance / maxRelevance : 0) +
          (0.2 * sample.information) / maxInformation +
          (selected.every((previous) => previous.node !== sample.node) ? 0.15 : 0) +
          (sample.position === 0 ? 0.05 : 0) -
          0.45 * redundancy;
        if (score > bestScore) {
          best = sample;
          bestScore = score;
        }
      }
      if (!best) return false;
      selected.push(best);
      return true;
    };
    if (pool.some((sample) => sample.relevance > 0)) choose(true);
    const opening = direct[0] ?? pool[0];
    if (!selected.some((sample) => sample.text === opening.text)) selected.push(opening);
    while (selected.length < SAMPLE_LIMIT) {
      if (!choose(maxRelevance > 1e-9)) break;
    }
    const prefix = `${structure.slice(0, 440)}\nSource excerpts (partial):`;
    const labels = selected.map((sample) => `\n[${sample.node.title.slice(0, 60)}] `);
    const budget = Math.floor(
      (PREVIEW_CHARACTERS - prefix.length - labels.reduce((sum, label) => sum + label.length, 0)) / selected.length
    );
    previews.set(node.id, prefix + selected.map((sample, i) => labels[i] + excerpt(sample.text, budget, queryTerms)).join(""));
    return pool;
  };
  nodes.forEach(visit);
  return previews;
}

// ── Direct candidates ───────────────────────────────────────────────

const CANDIDATE_STOPWORDS = new Set(
  "a an and are as at be by can could did do does document doc artifact for from have how in is it many mention mentions most of on or page report the there this times to was were what which who why with according about my our".split(
    " "
  )
);
const candidateTokens = (text: string) =>
  new Set(
    (normalizeIndexText(text).toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter(
      (word) => !CANDIDATE_STOPWORDS.has(word)
    )
  );

/**
 * Up to eight items whose titles or outlines match distinctive query terms
 * (corpus-frequency weighted). These only propose a routing branch; JEV still
 * routes into them and scores their passages.
 */
export function metadataCandidates<T extends { id: string; name: string; outline: string }>(
  items: T[],
  query: string
): (T & { score: number; hint: string })[] {
  const terms = candidateTokens(query);
  const indexed = items.map((item) => ({ item, words: candidateTokens(`${item.name}\n${item.outline}`) }));
  const frequencies = new Map(
    [...terms].map((term) => [term, indexed.filter((entry) => entry.words.has(term)).length])
  );
  return indexed
    .flatMap(({ item, words }) => {
      const matched = [...terms].filter((term) => words.has(term));
      const weights = matched.map((term) => Math.log(1 + items.length / (1 + frequencies.get(term)!)) * 2);
      if (!matched.length || (matched.length < 2 && weights[0] < 2)) return [];
      const headings = item.outline
        .replace(/^(Outline|Opening): /, "")
        .split(/;|\n/)
        .filter((heading) => [...candidateTokens(heading)].some((term) => terms.has(term)));
      return [
        {
          ...item,
          score: weights.reduce((sum, value) => sum + value, 0),
          hint: `${item.name}\n${headings.join("; ") || item.outline}`.slice(0, 1200),
        },
      ];
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 8);
}
