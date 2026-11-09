// PidginCore: server-side drafts. One R2 object per draft, no D1 row.
import type { Env } from "./types";
import { PublishInputError, publishDocument } from "./documents";
import { ArtifactConflictError, ArtifactInputError, publishArtifact } from "./artifacts/store";
import { getWorkspaceMembership } from "./workspace";
import { meter } from "./meter";

export const DRAFT_MAX_BYTES = 2 * 1024 * 1024;
export const DRAFT_MAX_PER_USER = 50;
export const DRAFT_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const DRAFT_IDLE_MS = 10 * 60_000;
export const DRAFT_KEEP_MS = 7 * 24 * 60 * 60_000;
const CRON_BATCH = 100;
const CURSOR_KEY = "meta/draft-cursor.json";

export const draftObjectKey = (userId: string, key: string) => `drafts/${userId}/${key}.json`;

type Json = Record<string, any>;
export interface DraftResult { status: number; body: Json }

// Overwrites one draft. Returns "limit" for a 51st new key.
export async function putDraft(env: Env, userId: string, key: string, text: string): Promise<"ok" | "limit"> {
  const objectKey = draftObjectKey(userId, key);
  if (!(await env.DOCS.head(objectKey))) {
    const listing = await env.DOCS.list({ prefix: `drafts/${userId}/`, limit: DRAFT_MAX_PER_USER + 1 });
    if (listing.objects.length >= DRAFT_MAX_PER_USER) return "limit";
  }
  await env.DOCS.put(objectKey, text, { httpMetadata: { contentType: "application/json" } });
  return "ok";
}

export async function deleteDraft(env: Env, userId: string, key: string): Promise<boolean> {
  const objectKey = draftObjectKey(userId, key);
  if (!(await env.DOCS.head(objectKey))) return false;
  await env.DOCS.delete(objectKey);
  return true;
}

const failure = (status: number, error: string): DraftResult => ({ status, body: { ok: false, error } });

// Publish the stored fields. Throws only on a stored object that cannot be
// read or on an unexpected publish failure; known input errors return a result.
async function publishStored(env: Env, userId: string, stored: Json): Promise<DraftResult> {
  if (stored.team_id !== undefined && stored.team_id !== null && typeof stored.team_id !== "string") {
    return failure(400, "team_id must be a string");
  }
  if (stored.team_id && !(await getWorkspaceMembership(env, stored.team_id, userId))) {
    return failure(403, "forbidden");
  }
  try {
    if (stored.kind === "artifact") {
      const target = stored.target ?? {};
      const result = await publishArtifact(env, {
        html: stored.html, markdown: stored.markdown, title: stored.title,
        description: stored.description, favicon: stored.favicon, label: stored.label,
        artifactId: target.artifact_id ?? stored.artifact_id,
        sourcePath: stored.source_path,
        baseVersion: typeof target.base_version === "number" ? target.base_version : undefined,
        force: stored.force === true,
        visibility: stored.visibility, role: stored.role, capabilities: stored.capabilities,
        designSystem: stored.design_system,
        sessionId: stored.instance?.session_id, project: stored.instance?.project,
        teamId: stored.team_id, projectId: stored.project_id,
        userId,
      });
      return { status: 200, body: { ok: true, data: { id: result.artifact.id, kind: "artifact", version: result.version, created: result.created } } };
    }
    if (stored.kind === "document") {
      const doc = await publishDocument(env, {
        title: stored.title,
        html: stored.html, markdown: stored.markdown, body: stored.body,
        docKind: stored.doc_kind, public: stored.public,
        priority: stored.priority || "normal",
        project: stored.project ?? stored.instance?.project,
        teamId: stored.team_id, projectId: stored.project_id,
        designSystem: stored.design_system, enhance: stored.enhance, instructions: stored.instructions,
        interactive: stored.interactive,
        userId,
      });
      return { status: 200, body: { ok: true, data: { id: doc.id, kind: "document" } } };
    }
    return failure(400, '"kind" must be document or artifact');
  } catch (err) {
    if (err instanceof ArtifactConflictError) return failure(409, err.message);
    if (err instanceof ArtifactInputError) {
      return failure(err.message === "artifact not found" ? 404 : 400, err.message);
    }
    if (err instanceof PublishInputError) return failure(400, err.message);
    throw err;
  }
}

async function readDraft(env: Env, objectKey: string): Promise<Json | null> {
  const object = await env.DOCS.get(objectKey);
  if (!object) return null;
  return JSON.parse(await object.text()) as Json;
}

// Publish the draft, then delete it. 404 when there is no draft. The draft
// stays when the publish does not succeed.
export async function commitDraft(
  env: Env, userId: string, key: string, _ctx?: ExecutionContext
): Promise<DraftResult> {
  const objectKey = draftObjectKey(userId, key);
  let stored: Json | null;
  try { stored = await readDraft(env, objectKey); }
  catch { return failure(400, "draft is not valid JSON"); }
  if (!stored) return failure(404, "draft not found");
  const result = await publishStored(env, userId, stored);
  if (result.status === 200) await env.DOCS.delete(objectKey);
  return result;
}

function parseObjectKey(objectKey: string): { userId: string; key: string } | null {
  const m = /^drafts\/([^/]+)\/([A-Za-z0-9_-]+)\.json$/.exec(objectKey);
  return m ? { userId: m[1], key: m[2] } : null;
}

async function loadCursor(env: Env): Promise<string | undefined> {
  try {
    const o = await env.DOCS.get(CURSOR_KEY);
    return o ? ((await o.json()) as { cursor?: string }).cursor : undefined;
  } catch { return undefined; }
}

async function saveCursor(env: Env, cursor: string | undefined): Promise<void> {
  if (cursor) await env.DOCS.put(CURSOR_KEY, JSON.stringify({ cursor }));
  else await env.DOCS.delete(CURSOR_KEY);
}

// Cron: commit drafts idle for olderThanMs as their owner. There is no
// request, so each commit is reserved with the meter, keyed by the draft and
// its upload time: refused leaves the draft, a good publish keeps the
// reservation, a failed one settles with nothing. 100 objects a run, resuming
// from a stored cursor so a stuck draft cannot starve the ones behind it.
export async function commitStaleDrafts(
  env: Env, olderThanMs: number, now: number = Date.now()
): Promise<{ committed: number; failed: number; skipped: number }> {
  const out = { committed: 0, failed: 0, skipped: 0 };
  const cursor = await loadCursor(env);
  let listing: R2Objects;
  try {
    listing = await env.DOCS.list({ prefix: "drafts/", limit: CRON_BATCH, cursor });
  } catch {
    await saveCursor(env, undefined);
    listing = await env.DOCS.list({ prefix: "drafts/", limit: CRON_BATCH });
  }
  for (const object of listing.objects) {
    try {
      const who = parseObjectKey(object.key);
      if (!who || now - object.uploaded.getTime() < olderThanMs) { out.skipped++; continue; }
      const rk = `draft:${who.userId}:${who.key}:${object.uploaded.getTime()}`;
      const reserved = await meter().reserve(env, who.userId, { draft_commit: 1 }, rk);
      if (!reserved.ok) { out.skipped++; continue; }
      let result: DraftResult | null = null;
      try {
        const stored = await readDraft(env, object.key);
        if (stored) {
          result = await publishStored(env, who.userId, stored);
          if (result.status === 200) await env.DOCS.delete(object.key);
        }
      } catch (err) {
        console.error("draft commit failed", err);
      }
      if (result?.status === 200) {
        out.committed++;
      } else {
        out.failed++;
        try { await meter().settle(env, rk, {}); }
        catch (err) { console.error("draft settle failed", err); }
      }
    } catch (err) {
      console.error("draft sweep item failed", err);
      out.failed++;
    }
  }
  await saveCursor(env, listing.truncated ? (listing as { cursor?: string }).cursor : undefined);
  return out;
}

// Daily: drop drafts nobody committed within a week.
export async function deleteOldDrafts(env: Env, now: number = Date.now()): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const listing = await env.DOCS.list({ prefix: "drafts/", limit: 500, cursor });
    for (const object of listing.objects) {
      if (now - object.uploaded.getTime() > DRAFT_KEEP_MS) {
        await env.DOCS.delete(object.key);
        deleted++;
      }
    }
    cursor = listing.truncated ? (listing as { cursor?: string }).cursor : undefined;
  } while (cursor);
  return deleted;
}
