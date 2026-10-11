import type { Env } from "../types";
import { getDesignSystem } from "../design-systems";
import { UNFILED, effectiveProjectSql, hasTagSql, type LibraryPlacement } from "../library";
import {
  MAX_ARTIFACT_BYTES,
  extractHtmlTitle,
  renderArtifactMarkdown,
} from "./render";

// Artifact identity + version store (Claude Code artifact parity). Unlike
// documents — which are messages rows — artifacts have stable identity and N
// immutable versions, so they get dedicated tables (migration 0019). Page
// content lives in R2 at artifacts/{id}/v{n}.html (+ .md source for markdown
// publishes).

export const ARTIFACT_VERSION_RETENTION = 20;
export const MAX_LABEL_LENGTH = 60;

// Invalid publish/patch input — handlers translate to 400 / MCP tool error.
export class ArtifactInputError extends Error {}

// Optimistic-concurrency failure — handlers translate to 409. Carries the
// server's current version so the caller can reconcile and retry with force.
export class ArtifactConflictError extends Error {
  constructor(public currentVersion: number) {
    super(`version conflict: artifact is at v${currentVersion}; republish from the latest version or pass force`);
  }
}

export interface ArtifactRow {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  favicon: string;
  source_path: string | null;
  source_kind: "html" | "markdown";
  role: "page" | "widget";
  visibility: "private" | "public";
  shared_version: number | null;
  current_version: number;
  capabilities: string | null;
  design_system: string | null;
  instance_session_id: string | null;
  instance_project: string | null;
  team_id: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ArtifactVersionRow {
  version: number;
  label: string | null;
  r2_key: string;
  size: number;
  source_size: number;
  created_at: string;
  created_by_session: string | null;
}

export interface PublishArtifactInput {
  html?: string;
  markdown?: string;
  title?: string;
  description?: string;
  favicon?: string;
  label?: string;
  artifactId?: string;
  sourcePath?: string;
  baseVersion?: number;
  force?: boolean;
  visibility?: "private" | "public";
  role?: "page" | "widget";
  // undefined = carry forward (update) / none (create); null = clear
  capabilities?: Record<string, unknown> | null;
  // Style the page with a named design system (builtin or the user's own).
  // undefined = carry forward / house default; null or "" = back to house.
  designSystem?: string | null;
  sessionId?: string;
  project?: string;
  teamId?: string;
  projectId?: string;
  userId: string;
}

export interface PublishArtifactResult {
  artifact: ArtifactRow;
  version: number;
  created: boolean;
}

function toUnixSeconds(dateStr: unknown): number {
  const s = String(dateStr ?? "").replace(" ", "T");
  const normalized = /z$|[+-]\d{2}:\d{2}$/i.test(s) ? s : s + "Z";
  return Math.floor(new Date(normalized).getTime() / 1000);
}

export function artifactVersionKey(id: string, version: number): string {
  return `artifacts/${id}/v${version}.html`;
}

function sourceKeyFor(r2Key: string): string {
  return r2Key.replace(/\.html$/, ".md");
}

function graphemes(value: string): string[] {
  try {
    return [...new Intl.Segmenter().segment(value)].map((s) => s.segment);
  } catch {
    return [...value];
  }
}

// 1-2 emoji, per the Artifact tool contract ("favicon: one or two emoji, no
// markup"). We check grapheme count plus a pictographic first cluster —
// forgiving enough for flags/ZWJ sequences, strict enough to reject words.
export function validateFavicon(favicon: string): void {
  const clusters = graphemes(favicon.trim());
  if (clusters.length < 1 || clusters.length > 2) {
    throw new ArtifactInputError('"favicon" must be 1-2 emoji');
  }
  // Keycap sequences (1️⃣) and VS16-forced emoji aren't Extended_Pictographic,
  // so accept those explicitly alongside ordinary pictographs.
  if (!/\p{Extended_Pictographic}|\u{FE0F}|\u{20E3}/u.test(clusters[0])) {
    throw new ArtifactInputError('"favicon" must be emoji, not text');
  }
}

function basename(path: string): string {
  const base = path.split("/").pop() || path;
  return base.replace(/\.(html?|md|markdown)$/i, "");
}

function parseCapabilities(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function artifactUrl(env: Env, id: string): string {
  return `${env.WORKER_URL}/a/${id}`;
}

// The wire shape both the iOS client and MCP structured output consume.
export function serializeArtifact(env: Env, row: ArtifactRow, library?: LibraryPlacement) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    favicon: row.favicon,
    source_kind: row.source_kind,
    role: row.role ?? "page",
    visibility: row.visibility,
    design_system: row.design_system ?? null,
    shared_version: row.shared_version,
    current_version: row.current_version,
    capabilities: parseCapabilities(row.capabilities),
    created_at: toUnixSeconds(row.created_at),
    updated_at: toUnixSeconds(row.updated_at),
    url: artifactUrl(env, row.id),
    instance: {
      session_id: row.instance_session_id,
      project: row.instance_project,
    },
    team_id: row.team_id ?? null,
    project_id: row.project_id ?? null,
    ...(library ? { library } : {}),
  };
}

export function serializeArtifactVersion(row: ArtifactVersionRow) {
  return {
    version: row.version,
    label: row.label,
    size: row.size,
    created_at: toUnixSeconds(row.created_at),
  };
}

export async function getArtifactById(env: Env, id: string): Promise<ArtifactRow | null> {
  const row = await env.DB.prepare("SELECT * FROM artifacts WHERE id = ?")
    .bind(id)
    .first<ArtifactRow>();
  return row ?? null;
}

async function findArtifactBySourcePath(
  env: Env,
  userId: string,
  sourcePath: string,
  sessionId?: string
): Promise<ArtifactRow | null> {
  if (sessionId) {
    const row = await env.DB.prepare(
      `SELECT * FROM artifacts WHERE user_id = ? AND source_path = ? AND instance_session_id = ?
       ORDER BY updated_at DESC LIMIT 1`
    )
      .bind(userId, sourcePath, sessionId)
      .first<ArtifactRow>();
    if (row) return row;
  }
  const row = await env.DB.prepare(
    "SELECT * FROM artifacts WHERE user_id = ? AND source_path = ? ORDER BY updated_at DESC LIMIT 1"
  )
    .bind(userId, sourcePath)
    .first<ArtifactRow>();
  return row ?? null;
}

export async function listArtifactVersions(env: Env, id: string): Promise<ArtifactVersionRow[]> {
  const rows = await env.DB.prepare(
    "SELECT version, label, r2_key, size, source_size, created_at, created_by_session FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC"
  )
    .bind(id)
    .all<ArtifactVersionRow>();
  return rows.results ?? [];
}

async function pruneVersions(env: Env, id: string, retention: number): Promise<void> {
  const versions = await listArtifactVersions(env, id);
  const pinnedRows = await env.DB.prepare(
    "SELECT DISTINCT artifact_version FROM message_blocks WHERE artifact_id = ?"
  )
    .bind(id)
    .all<{ artifact_version: number }>();
  const pinned = new Set((pinnedRows.results ?? []).map((row) => row.artifact_version));
  const stale = versions.slice(retention);
  for (const v of stale) {
    if (pinned.has(v.version)) continue;
    await env.DOCS.delete(v.r2_key);
    await env.DOCS.delete(sourceKeyFor(v.r2_key));
    await env.DB.prepare("DELETE FROM artifact_versions WHERE artifact_id = ? AND version = ?")
      .bind(id, v.version)
      .run();
  }
}

// Shared by publish and patch: undefined carries the existing value forward,
// null/"" clears back to the house default, and a name must resolve for this
// user (builtin or stored design system) or the request fails.
async function resolveDesignSystemInput(
  env: Env,
  userId: string,
  requested: string | null | undefined,
  existing: string | null
): Promise<string | null> {
  if (requested === undefined) return existing;
  if (requested !== null && typeof requested !== "string") {
    throw new ArtifactInputError('"design_system" must be a style name or null');
  }
  const name = requested?.trim() || null;
  if (!name) return null;
  const def = await getDesignSystem(env, userId, name);
  if (!def) {
    throw new ArtifactInputError(
      `unknown design system "${name}" — list available styles with pidgin_list_design_systems`
    );
  }
  return name;
}

export async function publishArtifact(
  env: Env,
  input: PublishArtifactInput
): Promise<PublishArtifactResult> {
  if (!input.userId) throw new ArtifactInputError("authenticated user required");
  const hasHtml = typeof input.html === "string" && input.html.trim().length > 0;
  const hasMarkdown = typeof input.markdown === "string" && input.markdown.trim().length > 0;
  if (hasHtml === hasMarkdown) {
    throw new ArtifactInputError('provide exactly one of "html" or "markdown"');
  }
  if (input.label && input.label.length > MAX_LABEL_LENGTH) {
    throw new ArtifactInputError(`"label" must be at most ${MAX_LABEL_LENGTH} characters`);
  }
  if (input.visibility && input.visibility !== "private" && input.visibility !== "public") {
    throw new ArtifactInputError('"visibility" must be "private" or "public"');
  }
  if (input.role && input.role !== "page" && input.role !== "widget") {
    throw new ArtifactInputError('"role" must be "page" or "widget"');
  }

  // Resolve identity: explicit artifact_id > (user, source_path[, session]) > new.
  let existing: ArtifactRow | null = null;
  if (input.artifactId) {
    existing = await getArtifactById(env, input.artifactId);
    if (!existing || existing.user_id !== input.userId) {
      // Same 404-flavored message for missing and foreign — no existence leak.
      throw new ArtifactInputError("artifact not found");
    }
  } else if (input.sourcePath) {
    existing = await findArtifactBySourcePath(env, input.userId, input.sourcePath, input.sessionId);
  }

  // Optimistic concurrency: a publish that started from a stale version 409s
  // unless the caller reconciled and passed force.
  if (
    existing &&
    typeof input.baseVersion === "number" &&
    input.baseVersion !== existing.current_version &&
    !input.force
  ) {
    throw new ArtifactConflictError(existing.current_version);
  }

  const favicon = input.favicon?.trim() || existing?.favicon;
  if (!favicon) {
    throw new ArtifactInputError('"favicon" is required (1-2 emoji) when creating an artifact');
  }
  validateFavicon(favicon);

  const sourceKind: "html" | "markdown" = hasMarkdown ? "markdown" : "html";
  const content = hasMarkdown
    ? renderArtifactMarkdown(input.markdown as string)
    : (input.html as string);
  const size = new TextEncoder().encode(content).byteLength;
  const sourceSize = hasMarkdown
    ? new TextEncoder().encode(input.markdown as string).byteLength
    : 0;
  if (size > MAX_ARTIFACT_BYTES) {
    throw new ArtifactInputError(
      `rendered artifact is ${size} bytes — the maximum is ${MAX_ARTIFACT_BYTES} (16 MiB)`
    );
  }

  // Title resolution: html <title> tag > title param > existing > source_path
  // basename > "Untitled". Markdown pages keep their existing identity unless
  // the caller names one explicitly.
  const title =
    (hasHtml ? extractHtmlTitle(input.html as string) : null) ??
    input.title?.trim() ??
    existing?.title ??
    (input.sourcePath ? basename(input.sourcePath) : null) ??
    "Untitled";

  const visibility = input.visibility ?? existing?.visibility ?? "private";
  const role = input.role ?? existing?.role ?? "page";
  const capabilitiesJson =
    input.capabilities === undefined
      ? existing?.capabilities ?? null
      : input.capabilities === null
      ? null
      : JSON.stringify(input.capabilities);
  if (capabilitiesJson && visibility === "public") {
    throw new ArtifactInputError("artifacts that declare capabilities cannot be public");
  }

  const designSystem = await resolveDesignSystemInput(
    env,
    input.userId,
    input.designSystem,
    existing?.design_system ?? null
  );

  const id = existing?.id ?? crypto.randomUUID();
  const version = existing ? existing.current_version + 1 : 1;
  const r2Key = artifactVersionKey(id, version);

  const retention = ARTIFACT_VERSION_RETENTION;

  try {
    await env.DOCS.put(r2Key, content, {
      httpMetadata: { contentType: "text/html" },
      customMetadata: { title, version: String(version) },
    });
    if (hasMarkdown) {
      await env.DOCS.put(sourceKeyFor(r2Key), input.markdown as string, {
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
        customMetadata: { title },
      });
    }

    const statements: D1PreparedStatement[] = [];
    if (existing) {
      statements.push(env.DB.prepare(
      `UPDATE artifacts SET title = ?, description = COALESCE(?, description), favicon = ?,
        source_path = COALESCE(?, source_path), source_kind = ?, role = ?, visibility = ?, capabilities = ?,
        design_system = ?, current_version = ?, instance_session_id = COALESCE(?, instance_session_id),
        instance_project = COALESCE(?, instance_project), team_id = COALESCE(?, team_id),
        project_id = COALESCE(?, project_id), updated_at = datetime('now')
       WHERE id = ?`
      ).bind(
        title,
        input.description ?? null,
        favicon,
        input.sourcePath ?? null,
        sourceKind,
        role,
        visibility,
        capabilitiesJson,
        designSystem,
        version,
        input.sessionId ?? null,
        input.project ?? null,
        input.teamId ?? null,
        input.projectId ?? null,
        id
      ));
    } else {
      statements.push(
        env.DB.prepare(
          `INSERT INTO artifacts (id, user_id, title, description, favicon, source_path, source_kind,
            role, visibility, shared_version, current_version, capabilities, design_system, instance_session_id,
            instance_project, team_id, project_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          id,
          input.userId,
          title,
          input.description ?? null,
          favicon,
          input.sourcePath ?? null,
          sourceKind,
          role,
          visibility,
          version,
          capabilitiesJson,
          designSystem,
          input.sessionId ?? null,
          input.project ?? null,
          input.teamId ?? null,
          input.projectId ?? null
        )
      );
    }

    statements.push(env.DB.prepare(
      `INSERT INTO artifact_versions (
         artifact_id, version, label, r2_key, size, created_by_session, source_size
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      version,
      input.label?.trim() || null,
      r2Key,
      size,
      input.sessionId ?? null,
      sourceSize
    ));
    statements.push(env.DB.prepare(
      `INSERT INTO audit_log (action, instance_id, details, user_id) VALUES (?, ?, ?, ?)`
    ).bind(
      existing ? "update_artifact" : "publish_artifact",
      input.sessionId ?? "artifact",
      `${existing ? "Updated" : "Published"} artifact "${title}" v${version}`,
      input.userId
    ));
    await env.DB.batch(statements);
  } catch (error) {
    await env.DOCS.delete(r2Key).catch(() => {});
    await env.DOCS.delete(sourceKeyFor(r2Key)).catch(() => {});
    throw error;
  }

  await pruneVersions(env, id, retention);

  const artifact = await getArtifactById(env, id);
  if (!artifact) throw new Error("artifact publish succeeded but reload failed");
  return { artifact, version, created: !existing };
}

export interface ListArtifactsInput {
  userId: string;
  limit?: number;
  cursor?: string;
  q?: string;
  scope?: "mine" | "shared" | "all";
  role?: "page" | "widget" | "all";
  /** Personal library project id, or "unfiled". */
  libraryProject?: string;
  libraryTag?: string;
}

export interface ArtifactPage {
  artifacts: ArtifactRow[];
  nextCursor: string | null;
  hasMore: boolean;
}

function encodeCursor(updatedAt: string, id: string): string {
  return btoa(JSON.stringify({ updatedAt, id }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeCursor(cursor?: string): { updatedAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const normalized = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    const parsed = JSON.parse(atob(`${normalized}${padding}`)) as { updatedAt?: string; id?: string };
    if (!parsed.updatedAt || !parsed.id) return null;
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    return null;
  }
}

export async function listArtifacts(env: Env, input: ListArtifactsInput): Promise<ArtifactPage> {
  // scope 'shared' (artifacts other users shared with the caller) is dormant
  // until a cross-user share table exists — report "nothing listed", not an error.
  if (input.scope === "shared") {
    return { artifacts: [], nextCursor: null, hasMore: false };
  }

  const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 25)));
  const clauses = ["user_id = ?"];
  const binds: Array<string | number> = [input.userId];

  if (input.role !== "all") {
    clauses.push("role = ?");
    binds.push(input.role ?? "page");
  }

  if (input.q) {
    const like = `%${input.q.toLowerCase()}%`;
    clauses.push("(LOWER(title) LIKE ? OR LOWER(COALESCE(description, '')) LIKE ?)");
    binds.push(like, like);
  }

  if (input.libraryProject) {
    clauses.push(`${effectiveProjectSql("artifact", "artifacts")} = ?`);
    binds.push(input.libraryProject === UNFILED ? "" : input.libraryProject);
  }
  if (input.libraryTag) {
    clauses.push(hasTagSql("artifact", "artifacts"));
    binds.push(input.libraryTag);
  }

  const cursor = decodeCursor(input.cursor);
  if (cursor) {
    clauses.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
    binds.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
  }

  binds.push(limit + 1);
  const result = await env.DB.prepare(
    `SELECT * FROM artifacts WHERE ${clauses.join(" AND ")}
     ORDER BY updated_at DESC, id DESC LIMIT ?`
  )
    .bind(...binds)
    .all<ArtifactRow>();

  const rows = result.results ?? [];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    artifacts: page,
    nextCursor: hasMore && last ? encodeCursor(last.updated_at, last.id) : null,
    hasMore,
  };
}

export interface PatchArtifactInput {
  title?: string;
  description?: string | null;
  visibility?: "private" | "public";
  sharedVersion?: number | null;
  // Restyle without republishing content: a style name, or null for house.
  designSystem?: string | null;
}

export async function patchArtifact(
  env: Env,
  id: string,
  userId: string,
  patch: PatchArtifactInput
): Promise<ArtifactRow | null> {
  const row = await getArtifactById(env, id);
  if (!row || row.user_id !== userId) return null;

  const visibility = patch.visibility ?? row.visibility;
  if (visibility === "public" && row.capabilities) {
    throw new ArtifactInputError("artifacts that declare capabilities cannot be public");
  }
  const sharedVersion = patch.sharedVersion === undefined ? row.shared_version : patch.sharedVersion;
  if (sharedVersion !== null && (sharedVersion < 1 || sharedVersion > row.current_version)) {
    throw new ArtifactInputError(`"shared_version" must be between 1 and ${row.current_version}, or null for latest`);
  }
  const designSystem = await resolveDesignSystemInput(
    env,
    userId,
    patch.designSystem,
    row.design_system ?? null
  );

  await env.DB.prepare(
    `UPDATE artifacts SET title = ?, description = ?, visibility = ?, shared_version = ?,
      design_system = ?, updated_at = datetime('now') WHERE id = ?`
  )
    .bind(
      patch.title?.trim() || row.title,
      patch.description === undefined ? row.description : patch.description,
      visibility,
      sharedVersion,
      designSystem,
      id
    )
    .run();

  return getArtifactById(env, id);
}

export async function deleteArtifact(env: Env, id: string, userId: string): Promise<boolean> {
  const row = await getArtifactById(env, id);
  if (!row || row.user_id !== userId) return false;

  const versions = await listArtifactVersions(env, id);
  for (const v of versions) {
    await env.DOCS.delete(v.r2_key);
    await env.DOCS.delete(sourceKeyFor(v.r2_key));
  }
  await env.DB.prepare("DELETE FROM artifact_versions WHERE artifact_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM artifact_storage WHERE artifact_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM artifacts WHERE id = ?").bind(id).run();
  await env.DB.prepare(
    `INSERT INTO audit_log (action, instance_id, details, user_id) VALUES (?, ?, ?, ?)`
  )
    .bind("delete_artifact", "artifact", `Deleted artifact "${row.title}"`, userId)
    .run();
  return true;
}

export async function loadArtifactVersionContent(
  env: Env,
  id: string,
  version: number
): Promise<string | null> {
  const obj = await env.DOCS.get(artifactVersionKey(id, version));
  return obj ? obj.text() : null;
}

// --- Magic share tokens (stateless HMAC links, mirroring routes/docs.ts) ---
// The signed payload is prefixed with "artifact:" so a document share token
// can never authorize an artifact (and vice versa) even under the same secret.

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

export async function signArtifactToken(id: string, expiresAt: number, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const data = new TextEncoder().encode(`artifact:${id}:${expiresAt}`);
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyArtifactToken(
  id: string,
  expiresAt: number,
  token: string,
  secret: string
): Promise<boolean> {
  if (Date.now() > expiresAt) return false;
  const expected = await signArtifactToken(id, expiresAt, secret);
  if (token.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

// Short-lived browser-embed tokens are narrower than public share tokens:
// they are bound to the containing message and immutable artifact version.
// The distinct prefix prevents either token class from being replayed as the
// other even though both use the same deployment secret.
export async function signArtifactEmbedToken(
  id: string,
  version: number,
  messageId: string,
  expiresAt: number,
  secret: string
): Promise<string> {
  const key = await hmacKey(secret);
  const data = new TextEncoder().encode(
    `artifact-embed:${id}:${version}:${messageId}:${expiresAt}`
  );
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyArtifactEmbedToken(
  id: string,
  version: number,
  messageId: string,
  expiresAt: number,
  token: string,
  secret: string
): Promise<boolean> {
  if (Date.now() > expiresAt) return false;
  const expected = await signArtifactEmbedToken(id, version, messageId, expiresAt, secret);
  if (token.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}
