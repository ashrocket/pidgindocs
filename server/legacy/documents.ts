import type { EnhanceLevel, Env } from "./types";
import { htmlToText } from "./commute/script";
import { compileDesignSystem } from "./documents/design-system";
import { listDesignSystems, resolveDesignSystem } from "./design-systems";
import { typesetDocument } from "./documents/typeset";
import { isEnhancementProviderConfigured } from "./enhance/provider";
import { removeRawTextElements } from "./html-text";

const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 25;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;
const DEFAULT_MAX_CHARS = 2000;
const MAX_MAX_CHARS = 20000;
const VALID_DOCUMENT_KINDS = new Set(["doc", "decision_memo", "meeting_note", "spec", "runbook"]);

export type DocumentMode = "metadata" | "summary" | "excerpt" | "sections" | "full" | "markdown";

export interface DocumentRecord {
  id: string;
  title: string;
  body: string | null;
  doc_key: string | null;
  public: number;
  priority: string;
  created_at: string;
  instance_project: string;
  instance_model: string;
  instance_source: string;
  team_id: string | null;
  project_id: string | null;
  doc_kind: string;
  enhance_status?: string | null;
  doc_slug?: string | null;
  interactive?: number;
}

export interface DocumentSummary {
  id: string;
  title: string;
  created_at: string;
  project: string;
  public: boolean;
  priority: string;
  doc_kind: string;
  summary_1line: string;
  source_url: string | null;
  enhance_status: string | null;
  interactive: boolean;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ListDocumentsInput {
  limit?: number;
  cursor?: string;
  project?: string;
  teamId?: string;
  projectId?: string;
  docKind?: string;
  since?: string;
  public?: boolean;
  userId?: string;
}

export interface SearchDocumentsInput {
  query: string;
  limit?: number;
  cursor?: string;
  project?: string;
  teamId?: string;
  projectId?: string;
  docKind?: string;
  userId?: string;
}

export interface PublishDocumentInput {
  title: string;
  html?: string;
  markdown?: string;
  body?: string;
  docKind?: string;
  public?: boolean;
  priority?: "normal" | "urgent";
  project?: string;
  teamId?: string;
  projectId?: string;
  userId: string;
  designSystem?: string;
  enhance?: string;
  instructions?: string;
  // Serve via /idoc/:id with scripts executable (strict no-network CSP, no
  // protection wrapper). Requires html input.
  interactive?: boolean;
}

export interface DocumentContentResult {
  id: string;
  title: string;
  mode: DocumentMode;
  created_at: string;
  project: string;
  public: boolean;
  priority: string;
  doc_kind: string;
  section_hint?: string;
  summary?: string;
  excerpt?: string;
  sections?: string[];
  text?: string;
  markdown?: string;
  markdown_available?: boolean;
  content_truncated?: boolean;
  total_chars?: number;
  returned_chars?: number;
}

// Invalid publish input — handlers translate this to a 400 / MCP tool error.
export class PublishInputError extends Error {}

const ENHANCE_LEVELS: EnhanceLevel[] = ["polish", "enrich", "research"];

export function parseEnhanceLevel(value: unknown): EnhanceLevel | null {
  if (value === undefined || value === null || value === "" || value === "none") return null;
  if (typeof value === "string" && (ENHANCE_LEVELS as string[]).includes(value)) {
    return value as EnhanceLevel;
  }
  throw new PublishInputError(`"enhance" must be one of none, ${ENHANCE_LEVELS.join(", ")}`);
}

export function sourceMarkdownKey(docKey: string | null): string | null {
  return docKey ? docKey.replace(/\.html$/, ".md") : null;
}

export async function storeSourceMarkdown(env: Env, id: string, markdown: string, title: string): Promise<string> {
  const key = `docs/${id}.md`;
  await env.DOCS.put(key, markdown, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: { title },
  });
  return key;
}

export function summarizeDocumentHtml(html: string, title: string): string {
  return oneLineSummary(htmlToText(html), title);
}

export interface RenderMarkdownInput {
  title: string;
  markdown: string;
  project?: string | null;
  createdAt?: string | null;
  userId: string | null;
  designSystemName?: string;
}

// Resolve + compile the design system and typeset markdown into finished HTML.
// Shared by the MCP publish path, the HTTP publish path, and the enhancement
// consumer so all three render identically.
export async function renderMarkdownDocument(
  env: Env,
  input: RenderMarkdownInput
): Promise<{ html: string; designSystemName: string }> {
  const requested = input.designSystemName || "pidgin-editorial";
  const definition = await resolveDesignSystem(env, input.userId, requested);
  if (!definition) {
    const available = (await listDesignSystems(env, input.userId)).map((d) => d.name).join(", ");
    throw new PublishInputError(`unknown design system "${requested}" — available: ${available}`);
  }
  const compiled = compileDesignSystem(definition);
  const html = typesetDocument(
    {
      title: input.title,
      markdown: input.markdown,
      project: input.project ?? null,
      createdAt: input.createdAt ?? null,
    },
    compiled
  );
  return { html, designSystemName: definition.name };
}

export async function loadDocumentText(env: Env, key: string | null): Promise<string | null> {
  if (!key) return null;
  const object = await env.DOCS.get(key);
  if (!object) return null;
  return object.text();
}

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

export function normalizeMaxChars(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_MAX_CHARS;
  return Math.max(200, Math.min(MAX_MAX_CHARS, Math.floor(value)));
}

function encodeCursor(createdAt: string, id: string): string {
  return btoa(JSON.stringify({ createdAt, id }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeCursor(cursor?: string): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const normalized = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    const parsed = JSON.parse(atob(`${normalized}${padding}`)) as {
      createdAt?: string;
      id?: string;
    };
    if (!parsed.createdAt || !parsed.id) return null;
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function plainText(value: string): string {
  return normalizeWhitespace(decodeEntities(removeRawTextElements(value).replace(/<[^>]+>/g, " ")));
}

function oneLineSummary(body: string | null, title: string): string {
  const source = normalizeWhitespace(body || title);
  if (!source) return title;
  const sentence = source.split(/(?<=[.!?])\s+/).find(Boolean) || source;
  return sentence.length > 160 ? `${sentence.slice(0, 157).trim()}...` : sentence;
}

function rowToSummary(row: DocumentRecord): DocumentSummary {
  return {
    id: row.id,
    title: row.title,
    created_at: row.created_at,
    project: row.instance_project,
    public: row.public === 1,
    priority: row.priority,
    doc_kind: row.doc_kind || "doc",
    summary_1line: oneLineSummary(row.body, row.title),
    source_url: (row as any).source_url ?? null,
    enhance_status: (row as { enhance_status?: string | null }).enhance_status ?? null,
    interactive: row.interactive === 1,
  };
}

function trimText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  const slice = text.slice(0, maxChars);
  const lastBoundary = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
  const cutoff = lastBoundary > maxChars * 0.6 ? lastBoundary : maxChars;
  return { text: `${slice.slice(0, cutoff).trim()}...`, truncated: true };
}

function summarizeText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const paragraphs = normalizeWhitespace(text)
    .split(/\n\s*\n/)
    .map((entry) => entry.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const summary = paragraphs.slice(0, 3).join("\n\n") || text;
  return trimText(summary, maxChars);
}

function extractHeadings(html: string): string[] {
  const headings: string[] = [];
  const regex = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;

  for (let match = regex.exec(html); match; match = regex.exec(html)) {
    const heading = plainText(match[2]).replace(/\s+/g, " ").trim();
    if (heading) headings.push(heading);
  }

  return headings;
}

function extractSectionText(html: string, sectionHint?: string): string | null {
  if (!sectionHint) return null;

  const headingRegex = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  const matches = [...html.matchAll(headingRegex)];
  if (matches.length === 0) return null;

  const wanted = sectionHint.toLowerCase();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const heading = plainText(match[2]).toLowerCase();
    if (!heading.includes(wanted)) continue;

    const start = match.index ?? 0;
    const next = matches[index + 1];
    const end = next?.index ?? html.length;
    const sectionHtml = html.slice(start, end);
    const text = htmlToText(sectionHtml);
    return normalizeWhitespace(text) || null;
  }

  return null;
}

async function fetchDocumentRows(
  env: Env,
  options: {
    limit: number;
    cursor?: string;
    project?: string;
    teamId?: string;
    projectId?: string;
    docKind?: string;
    since?: string;
    public?: boolean;
    query?: string;
    userId?: string;
  }
): Promise<DocumentRecord[]> {
  if (!options.userId && !options.teamId && options.public !== true) {
    throw new Error("document scope required");
  }
  const clauses = ["type = 'document'", "doc_key IS NOT NULL", "COALESCE(is_latest, 1) = 1"];
  const binds: Array<string | number> = [];
  const cursor = decodeCursor(options.cursor);

  if (options.project) {
    clauses.push("instance_project = ?");
    binds.push(options.project);
  }
  if (options.teamId) {
    clauses.push("team_id = ?");
    binds.push(options.teamId);
  }
  if (options.projectId) {
    clauses.push("project_id = ?");
    binds.push(options.projectId);
  }
  if (options.docKind) {
    clauses.push("doc_kind = ?");
    binds.push(options.docKind);
  }

  if (typeof options.public === "boolean") {
    clauses.push("public = ?");
    binds.push(options.public ? 1 : 0);
  }

  if (options.since) {
    clauses.push("created_at >= ?");
    binds.push(options.since);
  }

  if (options.query) {
    const like = `%${options.query.toLowerCase()}%`;
    clauses.push(
      "(LOWER(title) LIKE ? OR LOWER(COALESCE(body, '')) LIKE ? OR LOWER(instance_project) LIKE ?)"
    );
    binds.push(like, like, like);
  }

  if (options.userId) {
    clauses.push("user_id = ?");
    binds.push(options.userId);
  }

  if (cursor) {
    clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
    binds.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }

  const sql = `
    SELECT id, title, body, doc_key, public, priority, created_at,
           instance_project, instance_model, instance_source, team_id, project_id,
           doc_kind, source_url, doc_slug, enhance_status, interactive
    FROM messages
    WHERE ${clauses.join(" AND ")}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `;

  binds.push(options.limit + 1);
  const result = await env.DB.prepare(sql).bind(...binds).all<DocumentRecord>();
  return (result.results || []) as DocumentRecord[];
}

export async function listDocuments(
  env: Env,
  input: ListDocumentsInput = {}
): Promise<CursorPage<DocumentSummary>> {
  const limit = normalizeLimit(input.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const rows = await fetchDocumentRows(env, {
    limit,
    cursor: input.cursor,
    project: input.project,
    teamId: input.teamId,
    projectId: input.projectId,
    docKind: input.docKind,
    since: input.since,
    public: input.public,
    userId: input.userId,
  });

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);

  return {
    items: page.map(rowToSummary),
    nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
    hasMore,
  };
}

export async function searchDocuments(
  env: Env,
  input: SearchDocumentsInput
): Promise<CursorPage<DocumentSummary>> {
  const limit = normalizeLimit(input.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  const rows = await fetchDocumentRows(env, {
    limit,
    cursor: input.cursor,
    project: input.project,
    teamId: input.teamId,
    projectId: input.projectId,
    docKind: input.docKind,
    query: input.query.trim(),
    userId: input.userId,
  });

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);

  return {
    items: page.map(rowToSummary),
    nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
    hasMore,
  };
}

export async function getDocumentRecord(env: Env, id: string, userId?: string): Promise<DocumentRecord | null> {
  if (!userId) return null;
  let sql = `
    SELECT id, title, body, doc_key, public, priority, created_at,
           instance_project, instance_model, instance_source, team_id, project_id,
           doc_kind, doc_slug, enhance_status, interactive
    FROM messages
    WHERE id = ? AND type = 'document' AND doc_key IS NOT NULL
  `;
  const binds: (string | number)[] = [id];

  if (userId) {
    sql += " AND user_id = ?";
    binds.push(userId);
  }

  const row = await env.DB.prepare(sql).bind(...binds).first<DocumentRecord>();
  return row || null;
}

export async function getLatestDocument(
  env: Env,
  input: { project?: string; teamId?: string; projectId?: string; docKind?: string; public?: boolean; userId?: string } = {}
): Promise<DocumentSummary | null> {
  const result = await listDocuments(env, {
    project: input.project,
    teamId: input.teamId,
    projectId: input.projectId,
    docKind: input.docKind,
    public: input.public,
    limit: 1,
    userId: input.userId,
  });
  return result.items[0] || null;
}

export async function loadDocumentHtml(env: Env, docKey: string | null): Promise<string | null> {
  return loadDocumentText(env, docKey);
}

export async function getDocumentContent(
  env: Env,
  id: string,
  mode: DocumentMode,
  maxChars: number,
  sectionHint?: string,
  userId?: string
): Promise<DocumentContentResult | null> {
  const record = await getDocumentRecord(env, id, userId);
  if (!record) return null;

  const base: DocumentContentResult = {
    id: record.id,
    title: record.title,
    mode,
    created_at: record.created_at,
    project: record.instance_project,
    public: record.public === 1,
    priority: record.priority,
    doc_kind: record.doc_kind || "doc",
    section_hint: sectionHint,
  };

  if (mode === "metadata") {
    return base;
  }

  if (mode === "markdown") {
    const source = await loadDocumentText(env, sourceMarkdownKey(record.doc_key));
    if (source === null) {
      // Raw-HTML documents and pre-feature documents have no stored source.
      return { ...base, markdown_available: false };
    }
    const trimmed = trimText(source, maxChars);
    return {
      ...base,
      markdown_available: true,
      markdown: trimmed.text,
      content_truncated: trimmed.truncated,
      total_chars: source.length,
      returned_chars: trimmed.text.length,
    };
  }

  const html = await loadDocumentHtml(env, record.doc_key);
  const text = normalizeWhitespace(html ? htmlToText(html) : record.body || "");
  const totalChars = text.length;

  if (mode === "sections") {
    return {
      ...base,
      sections: html ? extractHeadings(html) : [],
      total_chars: totalChars,
    };
  }

  if (mode === "summary") {
    const summary = summarizeText(text, maxChars);
    return {
      ...base,
      summary: summary.text,
      content_truncated: summary.truncated,
      total_chars: totalChars,
      returned_chars: summary.text.length,
    };
  }

  if (mode === "excerpt") {
    const preferred = html ? extractSectionText(html, sectionHint) : null;
    const excerpt = trimText(preferred || text, maxChars);
    return {
      ...base,
      excerpt: excerpt.text,
      content_truncated: excerpt.truncated,
      total_chars: totalChars,
      returned_chars: excerpt.text.length,
    };
  }

  const full = trimText(text, maxChars);
  return {
    ...base,
    text: full.text,
    content_truncated: full.truncated,
    total_chars: totalChars,
    returned_chars: full.text.length,
  };
}

export async function publishDocument(
  env: Env,
  input: PublishDocumentInput
): Promise<DocumentSummary> {
  if (!input.userId) throw new PublishInputError("authenticated user required");
  const hasHtml = typeof input.html === "string" && input.html.trim().length > 0;
  const hasMarkdown = typeof input.markdown === "string" && input.markdown.trim().length > 0;
  if (hasHtml === hasMarkdown) {
    throw new PublishInputError('provide exactly one of "html" or "markdown"');
  }
  const enhance = parseEnhanceLevel(input.enhance);
  if ((enhance || input.designSystem || input.instructions) && !hasMarkdown) {
    throw new PublishInputError('"design_system", "enhance", and "instructions" require markdown input');
  }
  // Interactive docs are finished HTML+JS apps; the typeset/enhancement
  // pipelines only produce static pages, so raw html is the only valid input.
  if (input.interactive && !hasHtml) {
    throw new PublishInputError('"interactive" requires html input');
  }
  if (enhance && !isEnhancementProviderConfigured(env, enhance)) {
    throw new PublishInputError(
      enhance === "research"
        ? "research enhancement requires ANTHROPIC_API_KEY to be configured on the server"
        : "enhancement requires a Workers AI binding or ANTHROPIC_API_KEY to be configured on the server"
    );
  }
  if (input.docKind && !VALID_DOCUMENT_KINDS.has(input.docKind)) {
    throw new PublishInputError(
      `"doc_kind" must be one of ${Array.from(VALID_DOCUMENT_KINDS).join(", ")}`
    );
  }

  const id = crypto.randomUUID();
  const docKey = `docs/${id}.html`;
  const project = input.project || "pidgin";
  const priority = input.priority || "normal";
  const docKind = input.docKind || "doc";
  const createdAt = new Date().toISOString();

  let html: string;
  let designSystemName: string | null = null;
  if (hasMarkdown) {
    const rendered = await renderMarkdownDocument(env, {
      title: input.title,
      markdown: input.markdown as string,
      project,
      createdAt,
      userId: input.userId ?? null,
      designSystemName: input.designSystem,
    });
    html = rendered.html;
    designSystemName = rendered.designSystemName;
  } else {
    html = input.html as string;
  }

  const body = input.body || summarizeDocumentHtml(html, input.title);
  const docSize = new TextEncoder().encode(html).byteLength;
  const sourceSize = hasMarkdown
    ? new TextEncoder().encode(input.markdown as string).byteLength
    : 0;
  try {
    await env.DOCS.put(docKey, html, {
      httpMetadata: { contentType: "text/html" },
      customMetadata: {
        title: input.title,
        project,
        source: "mcp",
      },
    });
    if (hasMarkdown) {
      await storeSourceMarkdown(env, id, input.markdown as string, input.title);
    }

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO messages (id, type, title, body, doc_key, priority, public,
          doc_slug, doc_version, is_latest, design_system, enhance_status, enhance_level,
          instance_model, instance_session_id, instance_project, instance_source, user_id,
          interactive, team_id, project_id, doc_kind, doc_size, source_size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        "document",
        input.title,
        body,
        docKey,
        priority,
        input.public ? 1 : 0,
        id,
        1,
        1,
        designSystemName,
        enhance ? "queued" : null,
        enhance,
        "pidgin-mcp",
        `mcp-${id}`,
        project,
        "mcp",
        input.userId || null,
        input.interactive ? 1 : 0,
        input.teamId ?? null,
        input.projectId ?? null,
        docKind,
        docSize,
        sourceSize
      ),
      env.DB.prepare(
        `INSERT INTO audit_log (action, instance_id, details, user_id) VALUES (?, ?, ?, ?)`
      ).bind(
        "post_document_mcp",
        `mcp-${id}`,
        `Published "${input.title}" via MCP`,
        input.userId || null
      ),
    ]);
  } catch (error) {
    await env.DOCS.delete(docKey).catch(() => {});
    const sourceKey = sourceMarkdownKey(docKey);
    if (sourceKey) await env.DOCS.delete(sourceKey).catch(() => {});
    throw error;
  }

  if (enhance) {
    try {
      await env.ENHANCE_QUEUE.send({
        kind: "enhance",
        docId: id,
        level: enhance,
        instructions: input.instructions,
        designSystemName: designSystemName as string,
        userId: input.userId ?? null,
      });
    } catch (err) {
      // The document is already durable and readable; record the enhancement
      // as failed instead of failing the publish (a retry would double-publish).
      const reason = err instanceof Error ? err.message : "queueing failed";
      await env.DB.prepare(
        "UPDATE messages SET enhance_status = 'failed', enhance_error = ? WHERE id = ?"
      )
        .bind(`enhancement queueing failed: ${reason}`.slice(0, 500), id)
        .run();
    }
  }

  const record = await getDocumentRecord(env, id, input.userId);
  if (!record) {
    throw new Error("document publish succeeded but document could not be reloaded");
  }
  return rowToSummary(record);
}
