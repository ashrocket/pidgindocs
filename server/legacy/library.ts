import type { Env } from "./types";

// Personal library: private Projects and Tags that organize one user's
// documents and artifacts (migration 0032). Filing never changes who can read
// a resource — unlike workspace projects, which share with a team.
//
// Effective project of a resource, in priority order:
//   1. an explicit library_items row (project_id NULL = explicitly unfiled)
//   2. an auto-filing rule matching the agent's instance project label
//   3. unfiled

export const LIBRARY_COLORS = [
  "blue", "teal", "green", "mint", "yellow", "orange",
  "red", "pink", "purple", "indigo", "brown", "gray",
] as const;
export type LibraryColor = (typeof LIBRARY_COLORS)[number];
export type LibraryResourceType = "document" | "artifact";

export const UNFILED = "unfiled";
const MAX_FILE_ITEMS = 500;
const MAX_TAGS_PER_ITEM = 12;
const MAX_NAME_LENGTH = 60;
const MAX_SOURCES_PER_PROJECT = 50;
const D1_BATCH_LIMIT = 90;

export class LibraryInputError extends Error {}

export interface LibraryTagRef {
  id: string;
  name: string;
  color: LibraryColor;
}

export interface LibraryProject {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  color: LibraryColor;
  symbol: string | null;
  pinned: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  sources: string[];
  counts: { documents: number; artifacts: number };
}

export interface LibraryTag extends LibraryTagRef {
  slug: string;
  count: number;
}

export interface LibrarySource {
  label: string;
  documents: number;
  artifacts: number;
  project_id: string | null;
}

export interface LibraryOverview {
  projects: LibraryProject[];
  tags: LibraryTag[];
  sources: LibrarySource[];
  unfiled: { documents: number; artifacts: number };
  colors: readonly LibraryColor[];
}

/** Library placement attached to each serialized document/artifact. */
export interface LibraryPlacement {
  project_id: string | null;
  filed: "explicit" | "rule" | null;
  tags: LibraryTagRef[];
}

export interface LibraryResourceRef {
  type: LibraryResourceType;
  id: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

function newId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function slugify(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .trim()
      .toLowerCase()
      .replace(/['"’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item"
  );
}

export function normalizeSourceLabel(value: string): string {
  return value.trim().toLowerCase();
}

function cleanName(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new LibraryInputError(`${field} is required`);
  }
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length > MAX_NAME_LENGTH) {
    throw new LibraryInputError(`${field} must be ${MAX_NAME_LENGTH} characters or fewer`);
  }
  return name;
}

function cleanColor(value: unknown, fallback: LibraryColor): LibraryColor {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && (LIBRARY_COLORS as readonly string[]).includes(value)) {
    return value as LibraryColor;
  }
  throw new LibraryInputError(`color must be one of ${LIBRARY_COLORS.join(", ")}`);
}

function cleanSymbol(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  // SF Symbol names: lowercase words separated by dots, e.g. "airplane.circle".
  if (typeof value === "string" && /^[a-z0-9]+(\.[a-z0-9]+)*$/.test(value) && value.length <= 64) {
    return value;
  }
  throw new LibraryInputError("symbol must be an SF Symbol name such as \"folder\" or \"airplane.circle\"");
}

// A stable default color so new tags/projects do not all look the same.
function defaultColor(seed: string): LibraryColor {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const palette = LIBRARY_COLORS.filter((c) => c !== "gray");
  return palette[hash % palette.length];
}

async function runBatched(env: Env, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += D1_BATCH_LIMIT) {
    await env.DB.batch(statements.slice(i, i + D1_BATCH_LIMIT));
  }
}

/** SQL resource key of a document row (its version family). */
export const DOCUMENT_KEY_SQL = (alias: string) => `COALESCE(${alias}.doc_slug, ${alias}.id)`;

/**
 * SQL for a row's effective library project id ('' when unfiled). `alias` is
 * a messages (documents) or artifacts row; `userColumn` is its owner column.
 */
export function effectiveProjectSql(type: LibraryResourceType, alias: string): string {
  const key = type === "document" ? DOCUMENT_KEY_SQL(alias) : `${alias}.id`;
  return `COALESCE(
    (SELECT COALESCE(li.project_id, '') FROM library_items li
       WHERE li.user_id = ${alias}.user_id AND li.resource_type = '${type}' AND li.resource_key = ${key}),
    (SELECT r.project_id FROM library_project_sources r
       WHERE r.user_id = ${alias}.user_id AND r.source_label = LOWER(TRIM(${alias}.instance_project))),
    ''
  )`;
}

/** SQL predicate: the row carries the given library tag. Binds one tag id. */
export function hasTagSql(type: LibraryResourceType, alias: string): string {
  const key = type === "document" ? DOCUMENT_KEY_SQL(alias) : `${alias}.id`;
  return `EXISTS (SELECT 1 FROM library_item_tags t
    WHERE t.user_id = ${alias}.user_id AND t.resource_type = '${type}'
      AND t.resource_key = ${key} AND t.tag_id = ?)`;
}

/**
 * Append library filters (`library_project`, `library_tag` query params) to a
 * list query. `library_project` is a project id or "unfiled".
 */
export function appendLibraryFilters(
  url: URL,
  type: LibraryResourceType,
  alias: string,
  conditions: string[],
  binds: Array<string | number>
): void {
  const project = url.searchParams.get("library_project");
  if (project) {
    conditions.push(`${effectiveProjectSql(type, alias)} = ?`);
    binds.push(project === UNFILED ? "" : project);
  }
  const tag = url.searchParams.get("library_tag");
  if (tag) {
    conditions.push(hasTagSql(type, alias));
    binds.push(tag);
  }
}

// ── Overview ────────────────────────────────────────────────────────

// Resources the PidginDocs app shows: active (or pinned) latest documents and
// page artifacts. Counts follow the same visibility as the Docs/Artifacts tabs.
export const VISIBLE_DOCUMENTS = `m.type = 'document' AND m.user_id = ?
  AND COALESCE(m.is_latest, 1) = 1 AND (m.archived_at IS NULL OR m.pinned = 1)`;
export const VISIBLE_ARTIFACTS = `a.user_id = ? AND a.role = 'page'`;

export async function getLibraryOverview(env: Env, userId: string): Promise<LibraryOverview> {
  const [projectRows, sourceRows, tagRows, docCounts, artifactCounts, labelRows] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, slug, description, color, symbol, pinned, archived_at, created_at, updated_at
       FROM library_projects WHERE user_id = ?
       ORDER BY archived_at IS NOT NULL, pinned DESC, name COLLATE NOCASE`
    ).bind(userId).all<Omit<LibraryProject, "pinned" | "sources" | "counts"> & { pinned: number }>(),
    env.DB.prepare(
      "SELECT source_label, project_id FROM library_project_sources WHERE user_id = ? ORDER BY source_label"
    ).bind(userId).all<{ source_label: string; project_id: string }>(),
    env.DB.prepare(
      `SELECT t.id, t.name, t.slug, t.color,
        (SELECT COUNT(*) FROM library_item_tags it WHERE it.tag_id = t.id) AS count
       FROM library_tags t WHERE t.user_id = ? ORDER BY t.name COLLATE NOCASE`
    ).bind(userId).all<LibraryTag>(),
    env.DB.prepare(
      `SELECT ${effectiveProjectSql("document", "m")} AS project_id, COUNT(*) AS n
       FROM messages m WHERE ${VISIBLE_DOCUMENTS} GROUP BY 1`
    ).bind(userId).all<{ project_id: string; n: number }>(),
    env.DB.prepare(
      `SELECT ${effectiveProjectSql("artifact", "a")} AS project_id, COUNT(*) AS n
       FROM artifacts a WHERE ${VISIBLE_ARTIFACTS} GROUP BY 1`
    ).bind(userId).all<{ project_id: string; n: number }>(),
    env.DB.prepare(
      `SELECT label, SUM(docs) AS documents, SUM(arts) AS artifacts FROM (
         SELECT LOWER(TRIM(m.instance_project)) AS label, 1 AS docs, 0 AS arts
           FROM messages m WHERE ${VISIBLE_DOCUMENTS} AND COALESCE(TRIM(m.instance_project), '') != ''
         UNION ALL
         SELECT LOWER(TRIM(a.instance_project)), 0, 1
           FROM artifacts a WHERE ${VISIBLE_ARTIFACTS} AND COALESCE(TRIM(a.instance_project), '') != ''
       ) GROUP BY label ORDER BY (SUM(docs) + SUM(arts)) DESC, label`
    ).bind(userId, userId).all<{ label: string; documents: number; artifacts: number }>(),
  ]);

  const sourcesByProject = new Map<string, string[]>();
  const projectBySource = new Map<string, string>();
  for (const row of sourceRows.results ?? []) {
    projectBySource.set(row.source_label, row.project_id);
    const list = sourcesByProject.get(row.project_id) ?? [];
    list.push(row.source_label);
    sourcesByProject.set(row.project_id, list);
  }
  const docsByProject = new Map((docCounts.results ?? []).map((r) => [r.project_id, r.n]));
  const artsByProject = new Map((artifactCounts.results ?? []).map((r) => [r.project_id, r.n]));

  const projects: LibraryProject[] = (projectRows.results ?? []).map((row) => ({
    ...row,
    pinned: row.pinned === 1,
    sources: sourcesByProject.get(row.id) ?? [],
    counts: { documents: docsByProject.get(row.id) ?? 0, artifacts: artsByProject.get(row.id) ?? 0 },
  }));

  const labels = new Map<string, LibrarySource>();
  for (const row of labelRows.results ?? []) {
    labels.set(row.label, {
      label: row.label,
      documents: row.documents,
      artifacts: row.artifacts,
      project_id: projectBySource.get(row.label) ?? null,
    });
  }
  // Rules for labels with no visible items still appear, so they can be edited.
  for (const [label, projectId] of projectBySource) {
    if (!labels.has(label)) labels.set(label, { label, documents: 0, artifacts: 0, project_id: projectId });
  }

  return {
    projects,
    tags: tagRows.results ?? [],
    sources: [...labels.values()],
    unfiled: { documents: docsByProject.get("") ?? 0, artifacts: artsByProject.get("") ?? 0 },
    colors: LIBRARY_COLORS,
  };
}

// ── Projects ────────────────────────────────────────────────────────

async function getProjectRow(env: Env, userId: string, projectId: string) {
  return env.DB.prepare(
    `SELECT id, name, slug, description, color, symbol, pinned, archived_at
     FROM library_projects WHERE id = ? AND user_id = ?`
  ).bind(projectId, userId).first<{
    id: string; name: string; slug: string; description: string | null;
    color: LibraryColor; symbol: string | null; pinned: number; archived_at: string | null;
  }>();
}

async function uniqueSlug(env: Env, table: "library_projects" | "library_tags", userId: string, name: string, exceptId?: string): Promise<string> {
  const base = slugify(name);
  for (let n = 1; n < 50; n += 1) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const row = await env.DB.prepare(`SELECT id FROM ${table} WHERE user_id = ? AND slug = ?`)
      .bind(userId, slug).first<{ id: string }>();
    if (!row || row.id === exceptId) return slug;
  }
  return `${base}-${newId().slice(0, 6)}`;
}

function sourceStatements(env: Env, userId: string, projectId: string, sources: unknown): D1PreparedStatement[] {
  if (sources === undefined) return [];
  if (!Array.isArray(sources) || sources.some((s) => typeof s !== "string")) {
    throw new LibraryInputError("sources must be an array of agent project labels");
  }
  const labels = [...new Set((sources as string[]).map(normalizeSourceLabel).filter(Boolean))];
  if (labels.length > MAX_SOURCES_PER_PROJECT) {
    throw new LibraryInputError(`a project can have at most ${MAX_SOURCES_PER_PROJECT} sources`);
  }
  // A label belongs to one project; assigning it here moves it from any other.
  return [
    env.DB.prepare("DELETE FROM library_project_sources WHERE user_id = ? AND project_id = ?").bind(userId, projectId),
    ...labels.map((label) =>
      env.DB.prepare(
        `INSERT INTO library_project_sources (user_id, source_label, project_id) VALUES (?, ?, ?)
         ON CONFLICT(user_id, source_label) DO UPDATE SET project_id = excluded.project_id`
      ).bind(userId, label, projectId)
    ),
  ];
}

export interface ProjectInput {
  name?: unknown;
  description?: unknown;
  color?: unknown;
  symbol?: unknown;
  pinned?: unknown;
  archived?: unknown;
  sources?: unknown;
}

export async function createLibraryProject(env: Env, userId: string, input: ProjectInput): Promise<string> {
  const name = cleanName(input.name, "name");
  const description = typeof input.description === "string" && input.description.trim()
    ? input.description.trim().slice(0, 500) : null;
  const color = cleanColor(input.color, defaultColor(name));
  const symbol = cleanSymbol(input.symbol);
  const id = newId();
  const slug = await uniqueSlug(env, "library_projects", userId, name);
  await runBatched(env, [
    env.DB.prepare(
      `INSERT INTO library_projects (id, user_id, slug, name, description, color, symbol, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, userId, slug, name, description, color, symbol, input.pinned === true ? 1 : 0),
    ...sourceStatements(env, userId, id, input.sources),
  ]);
  return id;
}

export async function updateLibraryProject(env: Env, userId: string, projectId: string, input: ProjectInput): Promise<boolean> {
  const row = await getProjectRow(env, userId, projectId);
  if (!row) return false;
  const name = input.name === undefined ? row.name : cleanName(input.name, "name");
  const slug = name === row.name ? row.slug : await uniqueSlug(env, "library_projects", userId, name, projectId);
  const description = input.description === undefined
    ? row.description
    : typeof input.description === "string" && input.description.trim() ? input.description.trim().slice(0, 500) : null;
  const color = input.color === undefined ? row.color : cleanColor(input.color, row.color);
  const symbol = input.symbol === undefined ? row.symbol : cleanSymbol(input.symbol);
  const pinned = input.pinned === undefined ? row.pinned : input.pinned === true ? 1 : 0;
  const archivedAt = input.archived === undefined
    ? row.archived_at
    : input.archived === true ? row.archived_at ?? new Date().toISOString() : null;
  await runBatched(env, [
    env.DB.prepare(
      `UPDATE library_projects SET name = ?, slug = ?, description = ?, color = ?, symbol = ?,
         pinned = ?, archived_at = ?, updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`
    ).bind(name, slug, description, color, symbol, pinned, archivedAt, projectId, userId),
    ...sourceStatements(env, userId, projectId, input.sources),
  ]);
  return true;
}

/** Deleting a project unfiles its items; it never deletes documents or artifacts. */
export async function deleteLibraryProject(env: Env, userId: string, projectId: string): Promise<boolean> {
  const result = await env.DB.prepare("DELETE FROM library_projects WHERE id = ? AND user_id = ?")
    .bind(projectId, userId).run();
  return (result.meta.changes ?? 0) > 0;
}

// ── Tags ────────────────────────────────────────────────────────────

export async function createLibraryTag(env: Env, userId: string, input: { name?: unknown; color?: unknown }): Promise<LibraryTagRef> {
  const name = cleanName(input.name, "name");
  const slug = slugify(name);
  const existing = await env.DB.prepare("SELECT id, name, color FROM library_tags WHERE user_id = ? AND slug = ?")
    .bind(userId, slug).first<LibraryTagRef>();
  if (existing) return existing;
  const tag: LibraryTagRef = { id: newId(), name, color: cleanColor(input.color, defaultColor(slug)) };
  await env.DB.prepare("INSERT INTO library_tags (id, user_id, slug, name, color) VALUES (?, ?, ?, ?, ?)")
    .bind(tag.id, userId, slug, tag.name, tag.color).run();
  return tag;
}

export async function updateLibraryTag(env: Env, userId: string, tagId: string, input: { name?: unknown; color?: unknown }): Promise<boolean> {
  const row = await env.DB.prepare("SELECT id, name, slug, color FROM library_tags WHERE id = ? AND user_id = ?")
    .bind(tagId, userId).first<{ id: string; name: string; slug: string; color: LibraryColor }>();
  if (!row) return false;
  const name = input.name === undefined ? row.name : cleanName(input.name, "name");
  const slug = slugify(name);
  if (slug !== row.slug) {
    const clash = await env.DB.prepare("SELECT id FROM library_tags WHERE user_id = ? AND slug = ? AND id != ?")
      .bind(userId, slug, tagId).first();
    if (clash) throw new LibraryInputError(`a tag named "${name}" already exists`);
  }
  const color = input.color === undefined ? row.color : cleanColor(input.color, row.color);
  await env.DB.prepare(
    "UPDATE library_tags SET name = ?, slug = ?, color = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
  ).bind(name, slug, color, tagId, userId).run();
  return true;
}

export async function deleteLibraryTag(env: Env, userId: string, tagId: string): Promise<boolean> {
  const result = await env.DB.prepare("DELETE FROM library_tags WHERE id = ? AND user_id = ?")
    .bind(tagId, userId).run();
  return (result.meta.changes ?? 0) > 0;
}

/** Resolve tag references (ids or names) to tag ids, creating named tags as needed. */
async function resolveTagRefs(env: Env, userId: string, refs: unknown, field: string): Promise<string[]> {
  if (refs === undefined) return [];
  if (!Array.isArray(refs) || refs.some((r) => typeof r !== "string" || !r.trim())) {
    throw new LibraryInputError(`${field} must be an array of tag ids or names`);
  }
  const ids: string[] = [];
  for (const ref of new Set((refs as string[]).map((r) => r.trim()))) {
    const byId = await env.DB.prepare("SELECT id FROM library_tags WHERE id = ? AND user_id = ?")
      .bind(ref, userId).first<{ id: string }>();
    ids.push(byId ? byId.id : (await createLibraryTag(env, userId, { name: ref })).id);
  }
  return ids;
}

// ── Filing ──────────────────────────────────────────────────────────

interface OwnedResource {
  type: LibraryResourceType;
  id: string;
  key: string;
}

/** Load the caller's own documents/artifacts; foreign or missing ids are dropped. */
async function loadOwnedResources(env: Env, userId: string, refs: LibraryResourceRef[]): Promise<OwnedResource[]> {
  const owned: OwnedResource[] = [];
  const docIds = refs.filter((r) => r.type === "document").map((r) => r.id);
  const artifactIds = refs.filter((r) => r.type === "artifact").map((r) => r.id);
  for (let i = 0; i < docIds.length; i += D1_BATCH_LIMIT) {
    const chunk = docIds.slice(i, i + D1_BATCH_LIMIT);
    const rows = await env.DB.prepare(
      `SELECT id, ${DOCUMENT_KEY_SQL("m")} AS resource_key FROM messages m
       WHERE m.user_id = ? AND m.type = 'document' AND m.id IN (${chunk.map(() => "?").join(",")})`
    ).bind(userId, ...chunk).all<{ id: string; resource_key: string }>();
    for (const row of rows.results ?? []) owned.push({ type: "document", id: row.id, key: row.resource_key });
  }
  for (let i = 0; i < artifactIds.length; i += D1_BATCH_LIMIT) {
    const chunk = artifactIds.slice(i, i + D1_BATCH_LIMIT);
    const rows = await env.DB.prepare(
      `SELECT id FROM artifacts WHERE user_id = ? AND id IN (${chunk.map(() => "?").join(",")})`
    ).bind(userId, ...chunk).all<{ id: string }>();
    for (const row of rows.results ?? []) owned.push({ type: "artifact", id: row.id, key: row.id });
  }
  return owned;
}

export interface FileInput {
  items?: unknown;
  /** Project id, "unfiled" (explicitly unfiled), or "auto" (clear explicit filing). */
  project_id?: unknown;
  add_tags?: unknown;
  remove_tags?: unknown;
  set_tags?: unknown;
}

export interface FileResult {
  updated: number;
  missing: string[];
  placements: Array<LibraryResourceRef & LibraryPlacement>;
}

export function parseResourceRefs(items: unknown): LibraryResourceRef[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new LibraryInputError("items must be a non-empty array of {type, id}");
  }
  if (items.length > MAX_FILE_ITEMS) {
    throw new LibraryInputError(`at most ${MAX_FILE_ITEMS} items can be filed at once`);
  }
  return items.map((item) => {
    const ref = item as { type?: unknown; id?: unknown };
    if ((ref.type !== "document" && ref.type !== "artifact") || typeof ref.id !== "string" || !ref.id) {
      throw new LibraryInputError('each item needs type "document" or "artifact" and an id');
    }
    return { type: ref.type, id: ref.id };
  });
}

export async function fileLibraryItems(env: Env, userId: string, input: FileInput): Promise<FileResult> {
  const refs = parseResourceRefs(input.items);
  if (input.set_tags !== undefined && (input.add_tags !== undefined || input.remove_tags !== undefined)) {
    throw new LibraryInputError("use set_tags alone, or add_tags/remove_tags");
  }

  let projectMode: { kind: "none" } | { kind: "auto" } | { kind: "set"; projectId: string | null } = { kind: "none" };
  if (input.project_id !== undefined) {
    if (input.project_id === "auto") {
      projectMode = { kind: "auto" };
    } else if (input.project_id === null || input.project_id === UNFILED) {
      projectMode = { kind: "set", projectId: null };
    } else if (typeof input.project_id === "string") {
      if (!(await getProjectRow(env, userId, input.project_id))) {
        throw new LibraryInputError("project not found");
      }
      projectMode = { kind: "set", projectId: input.project_id };
    } else {
      throw new LibraryInputError('project_id must be a project id, "unfiled", or "auto"');
    }
  }

  const addIds = await resolveTagRefs(env, userId, input.add_tags, "add_tags");
  const removeIds = input.remove_tags === undefined ? [] : await (async () => {
    if (!Array.isArray(input.remove_tags)) throw new LibraryInputError("remove_tags must be an array");
    const ids: string[] = [];
    for (const ref of input.remove_tags as unknown[]) {
      if (typeof ref !== "string") continue;
      const row = await env.DB.prepare("SELECT id FROM library_tags WHERE user_id = ? AND (id = ? OR slug = ?)")
        .bind(userId, ref, slugify(ref)).first<{ id: string }>();
      if (row) ids.push(row.id);
    }
    return ids;
  })();
  const setIds = input.set_tags === undefined ? null : await resolveTagRefs(env, userId, input.set_tags, "set_tags");
  if ((setIds?.length ?? 0) > MAX_TAGS_PER_ITEM || addIds.length > MAX_TAGS_PER_ITEM) {
    throw new LibraryInputError(`an item can have at most ${MAX_TAGS_PER_ITEM} tags`);
  }

  const owned = await loadOwnedResources(env, userId, refs);
  const ownedIds = new Set(owned.map((o) => `${o.type}:${o.id}`));
  const missing = refs.filter((r) => !ownedIds.has(`${r.type}:${r.id}`)).map((r) => r.id);

  const statements: D1PreparedStatement[] = [];
  const seenKeys = new Set<string>();
  for (const item of owned) {
    const dedupe = `${item.type}:${item.key}`;
    if (seenKeys.has(dedupe)) continue;
    seenKeys.add(dedupe);
    if (projectMode.kind === "auto") {
      statements.push(env.DB.prepare(
        "DELETE FROM library_items WHERE user_id = ? AND resource_type = ? AND resource_key = ?"
      ).bind(userId, item.type, item.key));
    } else if (projectMode.kind === "set") {
      statements.push(env.DB.prepare(
        `INSERT INTO library_items (user_id, resource_type, resource_key, project_id) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, resource_type, resource_key)
         DO UPDATE SET project_id = excluded.project_id, updated_at = datetime('now')`
      ).bind(userId, item.type, item.key, projectMode.projectId));
    }
    if (setIds) {
      statements.push(env.DB.prepare(
        "DELETE FROM library_item_tags WHERE user_id = ? AND resource_type = ? AND resource_key = ?"
      ).bind(userId, item.type, item.key));
    }
    for (const tagId of removeIds) {
      statements.push(env.DB.prepare(
        "DELETE FROM library_item_tags WHERE user_id = ? AND resource_type = ? AND resource_key = ? AND tag_id = ?"
      ).bind(userId, item.type, item.key, tagId));
    }
    for (const tagId of setIds ?? addIds) {
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO library_item_tags (user_id, resource_type, resource_key, tag_id) VALUES (?, ?, ?, ?)`
      ).bind(userId, item.type, item.key, tagId));
    }
  }
  await runBatched(env, statements);

  const placements = await loadLibraryPlacements(env, userId, owned.map(({ type, id }) => ({ type, id })));
  return {
    updated: owned.length,
    missing,
    placements: owned.map(({ type, id }) => ({
      type, id, ...(placements.get(`${type}:${id}`) ?? { project_id: null, filed: null, tags: [] }),
    })),
  };
}

// ── Placement lookup (for serializers) ──────────────────────────────

/**
 * Library placement for a page of resources, keyed `${type}:${id}`. One query
 * per resource type, so list endpoints stay at a fixed query count.
 */
export async function loadLibraryPlacements(
  env: Env,
  userId: string,
  refs: LibraryResourceRef[]
): Promise<Map<string, LibraryPlacement>> {
  const out = new Map<string, LibraryPlacement>();
  for (const type of ["document", "artifact"] as const) {
    const ids = [...new Set(refs.filter((r) => r.type === type).map((r) => r.id))];
    for (let i = 0; i < ids.length; i += D1_BATCH_LIMIT) {
      const chunk = ids.slice(i, i + D1_BATCH_LIMIT);
      const table = type === "document" ? "messages" : "artifacts";
      const key = type === "document" ? DOCUMENT_KEY_SQL("x") : "x.id";
      const rows = await env.DB.prepare(
        `SELECT x.id,
           (SELECT COALESCE(li.project_id, '') FROM library_items li
              WHERE li.user_id = x.user_id AND li.resource_type = '${type}' AND li.resource_key = ${key}) AS explicit_project,
           (SELECT r.project_id FROM library_project_sources r
              WHERE r.user_id = x.user_id AND r.source_label = LOWER(TRIM(x.instance_project))) AS rule_project,
           COALESCE((SELECT json_group_array(json_object('id', t.id, 'name', t.name, 'color', t.color))
              FROM library_item_tags it JOIN library_tags t ON t.id = it.tag_id
              WHERE it.user_id = x.user_id AND it.resource_type = '${type}' AND it.resource_key = ${key}), '[]') AS tags_json
         FROM ${table} x WHERE x.user_id = ? AND x.id IN (${chunk.map(() => "?").join(",")})`
      ).bind(userId, ...chunk).all<{ id: string; explicit_project: string | null; rule_project: string | null; tags_json: string }>();
      for (const row of rows.results ?? []) {
        let tags: LibraryTagRef[] = [];
        try {
          tags = (JSON.parse(row.tags_json) as LibraryTagRef[])
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
        } catch { /* malformed aggregate: show no tags rather than fail the list */ }
        const explicit = row.explicit_project;
        out.set(`${type}:${row.id}`, {
          project_id: explicit !== null ? explicit || null : row.rule_project,
          filed: explicit !== null ? "explicit" : row.rule_project ? "rule" : null,
          tags,
        });
      }
    }
  }
  return out;
}
