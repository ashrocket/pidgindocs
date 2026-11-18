import { HELP_ARTICLE_SOURCES, HELP_CORPUS_VERSION } from "./corpus.generated";

/**
 * The edition's help articles, parsed once at module load from the bundled sources
 * (server/src/help/articles/*.md, bundled by scripts/build-help-corpus.mjs).
 *
 * Each article has YAML-ish front matter (slug, title, summary, audience,
 * tags) and a Markdown body. Every H2 section is a retrieval chunk with a
 * stable anchor: the slugified heading, made unique within the article with
 * -2, -3… Text before the first H2, if any, becomes a lead chunk with the
 * reserved anchor "top". Chunk ids are `${slug}#${anchor}`.
 *
 * No Node APIs: this runs in the Worker.
 */

export { HELP_CORPUS_VERSION };

export type HelpAudience = "people" | "admins" | "agents";

export const HELP_AUDIENCES: readonly HelpAudience[] = ["people", "admins", "agents"];

/** Anchor of the chunk made from text before an article's first H2. */
export const HELP_LEAD_ANCHOR = "top";

export interface HelpSection {
  /** Unique within the article; stable while the heading text is unchanged. */
  anchor: string;
  /** Heading text as written (Markdown inline syntax kept). */
  heading: string;
  /** The section's Markdown without its heading line. */
  markdown: string;
}

export interface HelpArticle {
  slug: string;
  title: string;
  summary: string;
  audience: readonly HelpAudience[];
  tags: readonly string[];
  /** Source file name, e.g. "handovers.md". */
  file: string;
  /** Markdown after the front matter. */
  markdown: string;
  /** Markdown before the first H2 ("" when there is none). */
  lead: string;
  /** H2 sections in order. */
  sections: readonly HelpSection[];
}

export interface HelpChunk {
  /** `${slug}#${anchor}` */
  id: string;
  slug: string;
  anchor: string;
  articleTitle: string;
  /** The H2 heading, or the article title for the lead chunk. */
  heading: string;
  /** The section's Markdown without its heading line. */
  text: string;
}

export class HelpCorpusError extends Error {}

const FRONT_MATTER_KEYS = new Set(["slug", "title", "summary", "audience", "tags"]);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function unquote(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[text.length - 1] === text[0]) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function list(value: string): string[] {
  const text = value.trim();
  const inner = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  return inner.split(",").map(unquote).filter(Boolean);
}

/** Lowercase letters and digits joined by "-"; any script, so a Russian heading keeps its words. */
export function slugifyHeading(heading: string): string {
  const slug = heading
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  return slug || "section";
}

/** Opening or closing code fence: up to three spaces, then ``` or ~~~ (3 or more). */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const H2 = /^##[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;

/** Splits a Markdown body on H2 headings outside code fences. */
export function splitHelpSections(markdown: string): { lead: string; sections: Array<{ heading: string; markdown: string }> } {
  const lines = markdown.split("\n");
  const lead: string[] = [];
  const sections: Array<{ heading: string; lines: string[] }> = [];
  let fence: string | null = null;
  for (const line of lines) {
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
    }
    const heading = !fence && !marker ? H2.exec(line) : null;
    if (heading) sections.push({ heading: heading[1].trim(), lines: [] });
    else (sections.length ? sections[sections.length - 1].lines : lead).push(line);
  }
  return {
    lead: lead.join("\n").trim(),
    sections: sections.map((section) => ({ heading: section.heading, markdown: section.lines.join("\n").trim() })),
  };
}

/** Parses one article. Throws HelpCorpusError naming the file on any problem. */
export function parseHelpArticle(file: string, raw: string): HelpArticle {
  const fail = (message: string): never => { throw new HelpCorpusError(`${file}: ${message}`); };
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") fail("must start with front matter (---)");
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) fail("front matter is not closed (---)");

  const fields = new Map<string, string>();
  for (const [offset, line] of lines.slice(1, end).entries()) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!match) fail(`front matter line ${offset + 2} is not "key: value"`);
    const [, key, value] = match as RegExpExecArray;
    if (!FRONT_MATTER_KEYS.has(key)) fail(`unknown front matter key "${key}"`);
    if (fields.has(key)) fail(`duplicate front matter key "${key}"`);
    fields.set(key, value);
  }

  const slug = unquote(fields.get("slug") ?? "");
  if (!SLUG.test(slug)) fail("slug must be lowercase words joined by hyphens");
  if (`${slug}.md` !== file) fail(`slug "${slug}" must match the file name`);
  const title = unquote(fields.get("title") ?? "");
  if (!title) fail("title is required");
  const summary = unquote(fields.get("summary") ?? "");
  if (!summary) fail("summary is required");
  const audience = [...new Set(list(fields.get("audience") ?? ""))];
  if (!audience.length) fail("audience is required");
  for (const value of audience) {
    if (!HELP_AUDIENCES.includes(value as HelpAudience)) fail(`unknown audience "${value}"`);
  }
  const rawTags = fields.get("tags")?.trim() ?? "";
  if (rawTags && !(rawTags.startsWith("[") && rawTags.endsWith("]"))) fail("tags must be a [list]");
  const tags = [...new Set(list(rawTags))];

  const markdown = lines.slice(end + 1).join("\n").trim();
  if (!markdown) fail("body is empty");
  const split = splitHelpSections(markdown);
  const used = new Set([HELP_LEAD_ANCHOR]);
  const sections = split.sections.map(({ heading, markdown: body }) => {
    if (!body) fail(`section "${heading}" is empty`);
    const base = slugifyHeading(heading);
    let anchor = base;
    for (let n = 2; used.has(anchor); n += 1) anchor = `${base}-${n}`;
    used.add(anchor);
    return Object.freeze({ anchor, heading, markdown: body });
  });
  if (!split.lead && !sections.length) fail("body has no text");

  return Object.freeze({
    slug, title, summary,
    audience: Object.freeze(audience as HelpAudience[]),
    tags: Object.freeze(tags),
    file, markdown,
    lead: split.lead,
    sections: Object.freeze(sections),
  });
}

/** Chunks for retrieval: the lead (if any), then one per H2 section. */
export function helpArticleChunks(article: HelpArticle): HelpChunk[] {
  const chunk = (anchor: string, heading: string, text: string): HelpChunk => Object.freeze({
    id: `${article.slug}#${anchor}`, slug: article.slug, anchor, articleTitle: article.title, heading, text,
  });
  return [
    ...(article.lead ? [chunk(HELP_LEAD_ANCHOR, article.title, article.lead)] : []),
    ...article.sections.map((section) => chunk(section.anchor, section.heading, section.markdown)),
  ];
}

function loadCorpus(sources: ReadonlyArray<{ file: string; raw: string }>) {
  const articles: HelpArticle[] = [];
  const errors: string[] = [];
  const slugs = new Set<string>();
  for (const source of sources) {
    try {
      const article = parseHelpArticle(source.file, source.raw);
      if (slugs.has(article.slug)) throw new HelpCorpusError(`${source.file}: duplicate slug "${article.slug}"`);
      slugs.add(article.slug);
      articles.push(article);
    } catch (error) {
      // A broken article is left out rather than taking the Worker down; tests require no errors.
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { articles, errors };
}

const corpus = loadCorpus(HELP_ARTICLE_SOURCES);

/** Every article, in file-name order. */
export const HELP_ARTICLES: readonly HelpArticle[] = Object.freeze(corpus.articles);

/** Problems found while parsing; empty for a healthy corpus. */
export const HELP_CORPUS_ERRORS: readonly string[] = Object.freeze(corpus.errors);

const BY_SLUG = new Map(HELP_ARTICLES.map((article) => [article.slug, article]));

export function getHelpArticle(slug: string): HelpArticle | undefined {
  return BY_SLUG.get(slug);
}

/** One chunk per H2 section (plus lead chunks), in article then section order. */
export const HELP_CHUNKS: readonly HelpChunk[] = Object.freeze(HELP_ARTICLES.flatMap(helpArticleChunks));
