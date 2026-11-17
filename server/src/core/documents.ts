import { DocumentAudienceError, documentDefaultStatements, resolveDocumentDefaultTeam } from "./document-audience";
import { contentPolicy, restrictedContentTeams, type DocumentPublishPolicy } from "./content-policy";
import { assertWorkspacePublishScope, assertGovernedDraft, canReadResource, canEditResource, messageReadSql, messageEditSql, resolveSharingTeam, WorkspaceAccessError, type Sharing } from "./workspace-access";
import type { EnhanceLevel, Env, InstanceIdentity } from "./types";
import { htmlToText } from "./commute/script";
import { compileDesignSystem } from "./documents/design-system";
import { listDesignSystems, resolveDesignSystem } from "./design-systems";
import { renderMarkdownContent, typesetDocument } from "./documents/typeset";
import { editionAccountLimits, UsageRefused, releaseEditionUsage, reserveEditionUsage } from "./edition-hooks";
import { applyLibraryQuery, loadEnabledLibraryPlacements } from "./library/query";
import { canAdminWorkspace, getWorkspaceMembership } from "./workspace";
import { DOCUMENT_FAMILY_SQL, documentFamilyBinds } from "./documents/family";

const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 25;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;
const DEFAULT_MAX_CHARS = 2000;
const MAX_MAX_CHARS = 20000;
const VALID_DOCUMENT_KINDS = new Set(["doc", "decision_memo", "meeting_note", "spec", "runbook"]);

export type DocumentMode = "metadata" | "summary" | "excerpt" | "sections" | "full" | "markdown";

export interface DocumentRecord {
  sharing_explicit?: number;
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
  doc_version?: number | null;
  is_latest?: number | null;
  interactive?: number;
  user_id?: string | null;
  sharing?: Sharing;
}

export interface DocumentSummary {
  // Explicit publish receipt; the stored sharing flag remains private for role-governed content.
  read_access?: DocumentPublishPolicy["readAccess"];
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
  sharing?: Sharing;
  team_id?: string | null;
  project_id?: string | null;
  is_owner?: boolean;
  // Version family: pass doc_version as base_version to publish the next one.
  // Always set by rowToSummary; optional only for hand-built fixtures.
  doc_slug?: string;
  doc_version?: number;
  is_latest?: boolean;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ListDocumentsInput {
  libraryProject?: string;
  libraryTag?: string;
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
  libraryProject?: string;
  libraryTag?: string;
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
  userId?: string;
  // undefined = private; "shared" publishes it to the team at once.
  sharing?: Sharing;
  designSystem?: string;
  enhance?: string;
  instructions?: string;
  // Serve via /idoc/:id with scripts executable (strict no-network CSP, no
  // protection wrapper). Requires html input.
  interactive?: boolean;
  /** Server-owned flag for external imports, never a way to enable raw HTML. */
  untrusted?: boolean;
}

export interface DocumentContentResult {
  sharing?: Sharing;
  id: string;
  title: string;
  mode: DocumentMode;
  created_at: string;
  project: string;
  public: boolean;
  priority: string;
  doc_kind: string;
  doc_slug?: string;
  doc_version?: number;
  is_latest?: boolean;
  // Set on a superseded version: the id to read and publish the next version from.
  latest_id?: string;
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
  /** Server-owned flag for external imports, never a way to enable raw HTML. */
  untrusted?: boolean;
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
      untrusted: input.untrusted,
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
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function plainText(value: string): string {
  return normalizeWhitespace(decodeEntities(value.replace(/<[^>]+>/g, " ")));
}

function oneLineSummary(body: string | null, title: string): string {
  const source = normalizeWhitespace(body || title);
  if (!source) return title;
  const sentence = source.split(/(?<=[.!?])\s+/).find(Boolean) || source;
  return sentence.length > 160 ? `${sentence.slice(0, 157).trim()}...` : sentence;
}

export function documentSharing(row: { team_id?: string | null; sharing?: string | null }): Sharing {
  return row.team_id && row.sharing === "shared" ? "shared" : "private";
}

function rowToSummary(row: DocumentRecord, viewerId?: string): DocumentSummary {
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
    team_id: row.team_id, project_id: row.project_id, sharing: documentSharing(row),
    ...(viewerId ? { is_owner: row.user_id === viewerId } : {}),
    ...versionFields(row),
  };
}

function versionFields(row: DocumentRecord): { doc_slug: string; doc_version: number; is_latest: boolean } {
  return { doc_slug: row.doc_slug || row.id, doc_version: row.doc_version ?? 1, is_latest: row.is_latest !== 0 };
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
    libraryProject?: string;
    libraryTag?: string;
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
    clauses.push(messageReadSql("messages"));
    binds.push(options.userId, options.userId);
  }

  if (cursor) {
    clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
    binds.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }

  if (!options.userId) return [];
  applyLibraryQuery(env,{userId:options.userId,type:"document",alias:"messages",project:options.libraryProject,tag:options.libraryTag},clauses,binds);
  const sql = `
    SELECT id, title, body, doc_key, public, priority, created_at,
           instance_project, instance_model, instance_source, team_id, project_id,
           doc_kind, source_url, doc_slug, doc_version, is_latest, enhance_status, interactive, user_id, sharing
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
    libraryProject: input.libraryProject,
    libraryTag: input.libraryTag,
  });

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const library = input.userId ? await loadEnabledLibraryPlacements(env,input.userId,page.map(row=>({type:"document",id:row.id}))) : new Map();

  return {
    items: page.map(row => {
      const summary = rowToSummary(row,input.userId);
      const placement = library.get(`document:${row.id}`);
      return placement ? {...summary,library:placement} : summary;
    }),
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
    libraryProject: input.libraryProject,
    libraryTag: input.libraryTag,
  });

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const library = input.userId ? await loadEnabledLibraryPlacements(env,input.userId,page.map(row=>({type:"document",id:row.id}))) : new Map();

  return {
    items: page.map(row => {
      const summary = rowToSummary(row,input.userId);
      const placement = library.get(`document:${row.id}`);
      return placement ? {...summary,library:placement} : summary;
    }),
    nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
    hasMore,
  };
}

export async function getDocumentRecord(env: Env, id: string, userId?: string): Promise<DocumentRecord | null> {
  if (!userId) return null;
  let sql = `
    SELECT id, title, body, doc_key, public, priority, created_at,
           instance_project, instance_model, instance_source, team_id, project_id,
           doc_kind, doc_slug, doc_version, is_latest, enhance_status, interactive, user_id, sharing
    FROM messages
    WHERE id = ? AND type = 'document' AND doc_key IS NOT NULL
  `;
  const binds: (string | number)[] = [id];

  if (userId) {
    sql += ` AND ${messageReadSql("messages")}`;
    binds.push(userId, userId);
  }

  const row = await env.DB.prepare(sql).bind(...binds).first<DocumentRecord>();
  return row || null;
}

export async function getLatestDocument(
  env: Env,
  input: { project?: string; teamId?: string; projectId?: string; docKind?: string; public?: boolean; userId?: string; libraryProject?: string; libraryTag?: string } = {}
): Promise<DocumentSummary | null> {
  const result = await listDocuments(env, {
    project: input.project,
    teamId: input.teamId,
    projectId: input.projectId,
    docKind: input.docKind,
    public: input.public,
    limit: 1,
    userId: input.userId,
    libraryProject: input.libraryProject,
    libraryTag: input.libraryTag,
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
    sharing: documentSharing(record),
    id: record.id,
    title: record.title,
    mode,
    created_at: record.created_at,
    project: record.instance_project,
    public: record.public === 1,
    priority: record.priority,
    doc_kind: record.doc_kind || "doc",
    ...versionFields(record),
    ...(record.is_latest === 0 ? { latest_id: await latestVersionId(env, record) } : {}),
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
  let teamId = input.teamId ?? null;
  let sharing: Sharing = input.sharing ?? "private";
  const id = crypto.randomUUID();
  let publishPolicy: DocumentPublishPolicy | undefined;
  try {
    teamId = await resolveDocumentDefaultTeam(env,{userId:input.userId,teamId,projectId:input.projectId,sharing:input.sharing,isPublic:input.public});
    if (sharing !== "private" && sharing !== "shared") throw new WorkspaceAccessError('"sharing" must be "private" or "shared"');
    if (sharing === "shared" && !teamId) {
      if (!input.userId) throw new WorkspaceAccessError("Sharing needs a signed-in owner.");
      teamId = await resolveSharingTeam(env, input.userId);
    }
    await assertWorkspacePublishScope(env, input.userId, teamId, input.projectId);
    publishPolicy = await contentPolicy().documentPublish?.(env, {
      id, resourceKey: id, userId: input.userId, teamId, projectId: input.projectId, sharing,
    });
    if (publishPolicy) sharing = publishPolicy.sharing;
    else await assertGovernedDraft(env, teamId, sharing);
  }
  catch (err) { if (err instanceof WorkspaceAccessError || err instanceof DocumentAudienceError) throw new PublishInputError(err.message); throw err; }
  if (teamId && input.public) throw new PublishInputError("team documents must remain private");
  const hasHtml = typeof input.html === "string" && input.html.trim().length > 0;
  const hasMarkdown = typeof input.markdown === "string" && input.markdown.trim().length > 0;
  if (hasHtml === hasMarkdown) {
    throw new PublishInputError('provide exactly one of "html" or "markdown"');
  }
  const enhance = parseEnhanceLevel(input.enhance);
  if (publishPolicy && enhance) throw new PublishInputError("Enhance a private draft before assigning team read access in Access controls.");
  if (input.untrusted && (hasHtml || input.interactive || enhance)) throw new PublishInputError("External imports require static markdown without enhancement");
  if ((enhance || input.designSystem || input.instructions) && !hasMarkdown) {
    throw new PublishInputError('"design_system", "enhance", and "instructions" require markdown input');
  }
  // Interactive docs are finished HTML+JS apps; the typeset/enhancement
  // pipelines only produce static pages, so raw html is the only valid input.
  if (input.interactive && !hasHtml) {
    throw new PublishInputError('"interactive" requires html input');
  }
  if (enhance && !env.ANTHROPIC_API_KEY) {
    throw new PublishInputError("enhancement requires ANTHROPIC_API_KEY to be configured on the server");
  }
  if (input.docKind && !VALID_DOCUMENT_KINDS.has(input.docKind)) {
    throw new PublishInputError(
      `"doc_kind" must be one of ${Array.from(VALID_DOCUMENT_KINDS).join(", ")}`
    );
  }

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
      untrusted: input.untrusted,
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
  const storedSize = docSize + sourceSize;
  let deliveryReserved = false;
  let storageReserved = false;
  let aiReserved = false;

  try {
    if (input.userId) {
      const hosted = await editionAccountLimits(env, input.userId);
      if (hosted && storedSize > hosted.max_upload_bytes) {
        throw new PublishInputError(
          `document is ${storedSize} bytes; the hosted per-upload limit is ${hosted.max_upload_bytes} bytes`
        );
      }
      const delivery = await reserveEditionUsage(
        env, input.userId, "deliveries", 1, `document:${id}:delivery:add`
      );
      deliveryReserved = delivery.managed;
      const storage = await reserveEditionUsage(
        env, input.userId, "storage_bytes", storedSize, `document:${id}:storage:add`
      );
      storageReserved = storage.managed;
      if (enhance) {
        const ai = await reserveEditionUsage(
          env, input.userId, "ai_actions", 1, `document:${id}:ai:add`
        );
        aiReserved = ai.managed;
      }
    }

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
          interactive, team_id, project_id, doc_kind, doc_size, source_size, sharing, sharing_explicit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        teamId,
        input.projectId ?? null,
        docKind,
        docSize,
        sourceSize,
        teamId ? sharing : "private",
        input.sharing !== undefined ? 1 : 0
      ),
      ...(publishPolicy?.statements ?? []),
      env.DB.prepare(
        `INSERT INTO audit_log (action, instance_id, details, user_id) VALUES (?, ?, ?, ?)`
      ).bind(
        "post_document_mcp",
        `mcp-${id}`,
        `Published "${input.title}" via MCP`,
        input.userId || null
      ),
      ...(teamId && input.userId && input.sharing === undefined ? await documentDefaultStatements(env, { documentId: id, teamId, userId: input.userId }) : []),
    ]);
  } catch (error) {
    await env.DOCS.delete(docKey).catch(() => {});
    const sourceKey = sourceMarkdownKey(docKey);
    if (sourceKey) await env.DOCS.delete(sourceKey).catch(() => {});
    if (input.userId) {
      const releases: Promise<unknown>[] = [];
      if (aiReserved) releases.push(releaseEditionUsage(
        env, input.userId, "ai_actions", 1, `document:${id}:ai:rollback`
      ));
      if (storageReserved) releases.push(releaseEditionUsage(
        env, input.userId, "storage_bytes", storedSize, `document:${id}:storage:rollback`
      ));
      if (deliveryReserved) releases.push(releaseEditionUsage(
        env, input.userId, "deliveries", 1, `document:${id}:delivery:rollback`
      ));
      await Promise.allSettled(releases);
    }
    const publishFailure = publishPolicy && contentPolicy().documentPublishFailure?.(error);
    if (publishFailure) throw new PublishInputError(publishFailure);
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
  return { ...rowToSummary(record, input.userId),
    ...(publishPolicy ? { read_access: publishPolicy.readAccess } : {}) };
}

// --- New versions ------------------------------------------------------------
// Editing a document publishes a new version: a new row (new id) in the same
// doc_slug family with doc_version = latest + 1. Content per id never changes.

// 403/404/409 outcomes of a version publish; 400s stay PublishInputError.
export class DocumentVersionError extends Error {
  constructor(
    message: string,
    public readonly status: 403 | 404 | 409,
    public readonly currentVersion?: number,
    // The latest version's id, so a caller can read it and publish from it.
    public readonly latestId?: string
  ) {
    super(message);
  }
}

// Optimistic-concurrency failure, same vocabulary as ArtifactConflictError.
// `enhancing`: the next version is still being produced by enhancement.
export class DocumentConflictError extends DocumentVersionError {
  constructor(currentVersion: number, latestId?: string, public readonly enhancing = false) {
    super(enhancing
      ? `an enhancement of this document is still running; publish a new version after it finishes (document is at v${currentVersion})`
      : `version conflict: document is at v${currentVersion}; publish from the latest version or pass force`,
    409, currentVersion, latestId);
  }
}

// A new document asked for a slug its audience already uses. Reusing it would
// fold the new row into someone's version family, so editing goes by doc_id.
export class DocumentSlugTakenError extends DocumentVersionError {
  constructor(slug: string) {
    super(`slug "${slug}" is already used by a document here; pass doc_id to publish a new version of it`, 409);
  }
}

export { DOCUMENT_FAMILY_SQL, documentFamilyBinds };

/** When a family has lost its latest row (a deleted or expired version), make
 * the highest remaining version the latest again so the document stays listed.
 * A no-op while some row is still latest. */
export function promoteLatestVersion(
  env: Env, row: { id: string; doc_slug?: string | null; team_id?: string | null; user_id?: string | null }, afterDelete = false
): D1PreparedStatement {
  const family = documentFamilyBinds(row);
  return env.DB.prepare(
    `UPDATE messages SET is_latest = 1
     WHERE id = (SELECT id FROM messages WHERE ${DOCUMENT_FAMILY_SQL}
                 ORDER BY COALESCE(doc_version, 1) DESC, created_at DESC, id DESC LIMIT 1)
       AND NOT EXISTS (SELECT 1 FROM messages WHERE ${DOCUMENT_FAMILY_SQL} AND COALESCE(is_latest, 1) = 1)
       ${afterDelete ? 'AND changes()>0' : ''}`
  ).bind(...family, ...family);
}

/** Id of the highest version in a document's family (the one to edit from). */
export async function latestVersionId(
  env: Env, row: { id: string; doc_slug?: string | null; team_id?: string | null; user_id?: string | null }
): Promise<string | undefined> {
  return (await loadLatestVersion(env, documentFamilyBinds(row)))?.id;
}

export interface PublishDocumentVersionInput {
  sharing?: Sharing;
  docId: string;
  userId: string;
  title: string;
  html?: string | null;
  markdown?: string | null;
  // Plain-text content, typeset like a body-only HTTP document (no html/markdown).
  body?: string | null;
  // Inbox preview text (the caller's "body" beside html/markdown); derived
  // from the content when absent.
  summary?: string | null;
  baseVersion?: unknown;
  force?: boolean;
  designSystem?: string | null;
  enhance?: unknown;
  instructions?: string | null;
  priority?: "normal" | "urgent";
  sourceUrl?: string | null;
  // Agent label (instance_project) for MCP publishes; HTTP passes instance.
  project?: string | null;
  instance?: InstanceIdentity;
  origin?: string;
  // Requested audience/kind: each must match the document when present
  // (null counts as not specified, like a missing field).
  teamId?: string | null;
  projectId?: string | null;
  public?: boolean | null;
  docKind?: string | null;
  interactive?: boolean | null;
  slug?: string | null;
  /** Server-owned flag for external imports, never a way to enable raw HTML. */
  untrusted?: boolean;
}

export interface DocumentVersionResult {
  id: string;
  title: string;
  doc_slug: string;
  doc_version: number;
  previous_id: string;
  url: string;
  interactive: boolean;
  team_id: string | null;
  project_id: string | null;
  body: string | null;
  created_at: string;
  // As stored (inherited from the latest version when not given).
  priority: string;
  source_url: string | null;
}

interface LatestVersionRow {
  sharing_explicit: number;
  sharing: Sharing;
  id: string;
  user_id: string | null;
  team_id: string | null;
  project_id: string | null;
  doc_slug: string | null;
  doc_version: number | null;
  public: number;
  doc_kind: string | null;
  interactive: number;
  design_system: string | null;
  priority: string | null;
  instance_project: string | null;
  source_url: string | null;
  pinned: number;
}

async function loadLatestVersion(env: Env, family: (string | null)[]): Promise<LatestVersionRow | null> {
  // Highest version wins (not is_latest): the insert guard is "no row at or
  // above the next version", so the next number must come from the maximum.
  return env.DB.prepare(
    `SELECT id, user_id, team_id, project_id, doc_slug, doc_version, public, doc_kind, interactive,
            design_system, priority, instance_project, source_url, pinned, sharing, sharing_explicit
     FROM messages WHERE ${DOCUMENT_FAMILY_SQL}
     ORDER BY COALESCE(doc_version, 1) DESC, created_at DESC, id DESC LIMIT 1`
  ).bind(...family).first<LatestVersionRow>();
}

/** Publish a new version of an existing document (shared by HTTP and MCP).
 * Only the latest version's author, or an owner/admin of the document's team,
 * may publish one; it keeps the document's team, channel, visibility and kind. */
export async function publishDocumentVersion(
  env: Env,
  input: PublishDocumentVersionInput
): Promise<DocumentVersionResult> {
  const html = typeof input.html === "string" && input.html.trim() ? input.html : null;
  const markdown = typeof input.markdown === "string" && input.markdown.trim() ? input.markdown : null;
  const plainBody = typeof input.body === "string" && input.body.trim() ? input.body : null;
  if (parseEnhanceLevel(input.enhance)) {
    throw new PublishInputError('"enhance" is not available when publishing a new version (doc_id); omit it or pass "none"');
  }
  if (input.instructions) {
    throw new PublishInputError('"instructions" only apply to enhancement, which is not available for a new version');
  }
  if (input.untrusted && (html || !markdown)) throw new PublishInputError("External imports require static markdown");
  if (html && markdown) throw new PublishInputError('provide exactly one of "html" or "markdown"');
  if (!html && !markdown && !plainBody) throw new PublishInputError("a new version needs html, markdown, or body content");
  if (input.designSystem && !markdown) throw new PublishInputError('"design_system" requires markdown input');
  const baseVersion = input.baseVersion ?? undefined;
  if (baseVersion !== undefined && (!Number.isInteger(baseVersion) || (baseVersion as number) < 1)) {
    throw new PublishInputError('"base_version" must be a positive integer');
  }

  // Missing, foreign and unreadable documents look the same: no existence leak.
  const target = await env.DB.prepare(
    "SELECT id, user_id, team_id, doc_slug, sharing FROM messages WHERE id = ? AND type = 'document'"
  ).bind(input.docId).first<{ id: string; user_id: string | null; team_id: string | null; doc_slug: string | null; sharing: Sharing }>();
  if (!target || !await canReadResource(env, input.userId, target)) {
    throw new DocumentVersionError("document not found", 404);
  }
  const family = documentFamilyBinds(target);
  const slug = family[0] as string;
  const latest = await loadLatestVersion(env, family);
  if (!latest || !await canReadResource(env, input.userId, latest)) throw new DocumentVersionError("document not found", 404);

  // A family with several version-1 rows by different people is several
  // documents that shared a slug before new slugs were checked: its "latest"
  // may be another member's squat, so only a team owner/admin may continue it.
  const isAuthor = latest.user_id === input.userId;
  const roots = isAuthor ? await env.DB.prepare(
    `SELECT COUNT(*) AS total, SUM(user_id IS NOT ?) AS foreign_roots
     FROM messages WHERE ${DOCUMENT_FAMILY_SQL} AND COALESCE(doc_version, 1) = 1`
  ).bind(input.userId, ...family).first<{ total: number; foreign_roots: number | null }>() : null;
  const collided = !!roots && roots.total > 1 && (roots.foreign_roots ?? 0) > 0;
  const governed = latest.team_id && await restrictedContentTeams(env, latest.team_id);
  if (governed) {
    if (collided || !await canEditResource(env, input.userId, latest, "document")) {
      throw new DocumentVersionError("document edit permission required", 403);
    }
  } else if (!isAuthor || collided) {
    const role = latest.team_id ? (await getWorkspaceMembership(env, latest.team_id, input.userId))?.role : null;
    if (!canAdminWorkspace(role)) {
      throw new DocumentVersionError("only the document's author or a team owner/admin can publish a new version", 403);
    }
  }
  try { await assertWorkspacePublishScope(env, input.userId, latest.team_id, latest.project_id); }
  catch (err) { if (err instanceof WorkspaceAccessError) throw new DocumentVersionError(err.message, 403); throw err; }

  // A version inherits its audience and kind; asking to change them is an error,
  // not a silent move (use workspace sharing to change who can read it).
  if (input.sharing !== undefined && input.sharing !== latest.sharing) throw new PublishInputError("use workspace sharing to change who can read it");
  if (input.teamId != null && (input.teamId || null) !== latest.team_id) {
    throw new PublishInputError("a new version stays in the document's team; it cannot change team_id");
  }
  if (input.projectId != null && (input.projectId || null) !== latest.project_id) {
    throw new PublishInputError("a new version stays in the document's channel; it cannot change project_id");
  }
  if (input.public != null && (input.public ? 1 : 0) !== (latest.public === 1 ? 1 : 0)) {
    throw new PublishInputError("a new version keeps the document's visibility; it cannot change public");
  }
  const docKind = latest.doc_kind || "doc";
  if (input.docKind && input.docKind !== docKind) {
    throw new PublishInputError(`a new version keeps the document's kind (${docKind}); it cannot change doc_kind`);
  }
  if (input.slug && input.slug !== slug) throw new PublishInputError("a new version keeps the document's slug");
  const interactive = latest.interactive === 1;
  if (input.interactive != null && input.interactive !== interactive) {
    throw new PublishInputError(interactive
      ? "this document is interactive; a new version must be interactive html too"
      : "this document is not interactive; a new version cannot become interactive");
  }
  if (interactive && !html) throw new PublishInputError("a new version of an interactive document requires raw html input");

  const currentVersion = latest.doc_version ?? 1;
  if (baseVersion !== undefined && baseVersion !== currentVersion && !input.force) {
    throw new DocumentConflictError(currentVersion, latest.id);
  }
  // The enhancement consumer publishes its own v2; letting an edit race it
  // would leave two rows claiming the same version. Checked here to fail
  // before any storage work, and again inside the guarded INSERT.
  const enhancingSql = `SELECT 1 FROM messages WHERE ${DOCUMENT_FAMILY_SQL} AND enhance_status IN ('queued', 'running')`;
  if (await env.DB.prepare(`${enhancingSql} LIMIT 1`).bind(...family).first()) {
    throw new DocumentConflictError(currentVersion, latest.id, true);
  }

  const id = crypto.randomUUID();
  const docKey = `docs/${id}.html`;
  const createdAt = new Date().toISOString();
  const nextVersion = currentVersion + 1;
  const priority = input.priority || latest.priority || "normal";
  const sourceUrl = input.sourceUrl === undefined ? latest.source_url : input.sourceUrl || null;
  const instance: InstanceIdentity = input.instance ?? {
    model: "pidgin-mcp",
    session_id: `mcp-${id}`,
    project: input.project || latest.instance_project || "pidgin",
    source: "mcp",
  };

  let docHtml: string;
  let designSystemName: string | null = null;
  if (markdown) {
    const render = (name?: string) => renderMarkdownDocument(env, {
      title: input.title, markdown, project: instance.project, createdAt, userId: input.userId, designSystemName: name, untrusted: input.untrusted,
    });
    let rendered;
    try { rendered = await render(input.designSystem || latest.design_system || undefined); }
    catch (err) {
      // A carried-forward style may belong to another author or be deleted.
      if (!(err instanceof PublishInputError) || input.designSystem) throw err;
      rendered = await render(undefined);
    }
    docHtml = rendered.html;
    designSystemName = rendered.designSystemName;
  } else {
    docHtml = html ?? typesetDocument({ title: input.title, markdown: null, body: plainBody, project: instance.project, createdAt });
  }
  // Preview text comes from the content, never the page chrome.
  const summary = input.summary || (markdown
    ? summarizeDocumentHtml(renderMarkdownContent(markdown, { untrusted: input.untrusted }), input.title)
    : html ? summarizeDocumentHtml(html, input.title) : plainBody);

  const docSize = new TextEncoder().encode(docHtml).byteLength;
  const sourceSize = markdown ? new TextEncoder().encode(markdown).byteLength : 0;
  const storedSize = docSize + sourceSize;
  let deliveryReserved = false;
  let storageReserved = false;
  const rollback = async () => {
    await env.DOCS.delete(docKey).catch(() => {});
    await env.DOCS.delete(`docs/${id}.md`).catch(() => {});
    const releases: Promise<unknown>[] = [];
    if (storageReserved) releases.push(releaseEditionUsage(env, input.userId, "storage_bytes", storedSize, `document:${id}:storage:rollback`));
    if (deliveryReserved) releases.push(releaseEditionUsage(env, input.userId, "deliveries", 1, `document:${id}:delivery:rollback`));
    await Promise.allSettled(releases);
  };

  let results: D1Result[];
  try {
    const hosted = await editionAccountLimits(env, input.userId);
    if (hosted && storedSize > hosted.max_upload_bytes) {
      throw new UsageRefused(
        `document is ${storedSize} bytes; the hosted per-upload limit is ${hosted.max_upload_bytes} bytes`, 413, "storage_bytes");
    }
    deliveryReserved = (await reserveEditionUsage(env, input.userId, "deliveries", 1, `document:${id}:delivery:add`)).managed;
    storageReserved = (await reserveEditionUsage(env, input.userId, "storage_bytes", storedSize, `document:${id}:storage:add`)).managed;

    await env.DOCS.put(docKey, docHtml, {
      httpMetadata: { contentType: "text/html" },
      customMetadata: { title: input.title, project: instance.project, source: instance.source },
    });
    if (markdown) await storeSourceMarkdown(env, id, markdown, input.title);

    // Every statement is conditional on the new row: when a concurrent publish
    // already took this version number, the INSERT matches nothing and the
    // rest of the batch must not touch the winner's rows.
    const inserted = "EXISTS (SELECT 1 FROM messages fresh WHERE fresh.id = ?)";
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO messages (id, type, title, body, doc_key, priority, public,
          doc_slug, doc_version, is_latest, design_system,
          instance_model, instance_session_id, instance_project, instance_source, source_url, user_id,
          interactive, team_id, project_id, doc_kind, doc_size, source_size, pinned, sharing, sharing_explicit)
         SELECT ?, 'document', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM messages WHERE ${DOCUMENT_FAMILY_SQL} AND COALESCE(doc_version, 1) >= ?)
           AND NOT EXISTS (${enhancingSql})
           AND EXISTS (SELECT 1 FROM messages prior WHERE prior.id=? AND prior.sharing IS ? AND prior.team_id IS ?
             AND ${messageEditSql("prior")})`
      ).bind(
        id, input.title, summary, docKey, priority, latest.public === 1 ? 1 : 0,
        slug, nextVersion, designSystemName,
        instance.model, instance.session_id, instance.project, instance.source,
        sourceUrl, input.userId,
        interactive ? 1 : 0, latest.team_id, latest.project_id, docKind, docSize, sourceSize,
        latest.team_id ? 0 : latest.pinned === 1 ? 1 : 0,
        latest.sharing,
        input.sharing !== undefined ? 1 : latest.sharing_explicit,
        ...family, nextVersion, ...family, latest.id, latest.sharing, latest.team_id, input.userId, input.userId
      ),
      ...(input.sharing !== undefined ? [env.DB.prepare(
        `UPDATE messages SET sharing_explicit=1 WHERE ${DOCUMENT_FAMILY_SQL} AND ${inserted}`
      ).bind(...family,id)] : []),
      // Superseded rows leave every list; marking them read keeps unread
      // counts from including rows nobody can see any more.
      env.DB.prepare(
        `UPDATE messages SET is_latest = 0, doc_slug = COALESCE(doc_slug, ?), doc_version = COALESCE(doc_version, 1),
           read = 1, read_at = COALESCE(read_at, datetime('now'))
         WHERE ${DOCUMENT_FAMILY_SQL} AND id <> ? AND ${inserted}`
      ).bind(slug, ...family, id, id),
      // Team pins are per member; carry them so a pinned document stays pinned.
      env.DB.prepare(
        `INSERT OR IGNORE INTO message_user_state (message_id, user_id, pinned)
         SELECT ?, user_id, 1 FROM message_user_state WHERE message_id = ? AND pinned = 1 AND ${inserted}`
      ).bind(id, latest.id, id),
      env.DB.prepare(
        `INSERT INTO audit_log (action, instance_id, details, user_id) SELECT 'document_version', ?, ?, ? WHERE ${inserted}`
      ).bind(instance.session_id, `Published "${input.title}" as v${nextVersion} of ${slug}`, input.userId, id),
    ]);
  } catch (error) {
    await rollback();
    throw error;
  }

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    await rollback();
    const [now, enhancing] = await Promise.all([
      loadLatestVersion(env, family), env.DB.prepare(`${enhancingSql} LIMIT 1`).bind(...family).first(),
    ]);
    if (!now || !await canReadResource(env, input.userId, now)) throw new DocumentVersionError("document not found", 404);
    throw new DocumentConflictError(now?.doc_version ?? nextVersion, now?.id, !!enhancing);
  }

  const origin = env.WORKER_URL || input.origin || "";
  return {
    id,
    title: input.title,
    doc_slug: slug,
    doc_version: nextVersion,
    previous_id: latest.id,
    url: `${origin}/${interactive ? "idoc" : "docs"}/${id}`,
    interactive,
    team_id: latest.team_id,
    project_id: latest.project_id,
    body: summary,
    created_at: createdAt,
    priority,
    source_url: sourceUrl,
  };
}
