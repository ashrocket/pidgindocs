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
export interface DraftResult { status: number; body: Json; units?: string }

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

const BUCKET_MS = 6 * 60 * 60_000;

// --- Claim-first commits (F's receipt table) -------------------------------
// One receipt per (draft, idempotency key or draft etag). Whoever inserts it
// publishes; everyone else reads the row. The etag key means two commits of
// the same draft content, from a request and the cron, run once.

interface Receipt { status: string; http_status: number | null; body: string | null }

async function claimReceipt(
  env: Env, userId: string, receiptKey: string, claimId: string
): Promise<{ won: true } | { won: false; row: Receipt | null }> {
  const res = await env.DB.prepare(
    `INSERT INTO batch_receipts (owner, key, claim_id, status, created_at)
     VALUES (?, ?, ?, 'pending', datetime('now')) ON CONFLICT DO NOTHING`
  ).bind(userId, receiptKey, claimId).run();
  if ((res.meta?.changes ?? 0) > 0) return { won: true };
  const row = await env.DB.prepare(
    "SELECT status, http_status, body FROM batch_receipts WHERE owner = ? AND key = ?"
  ).bind(userId, receiptKey).first<Receipt>();
  return { won: false, row };
}

async function releaseReceipt(env: Env, userId: string, receiptKey: string, claimId: string): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM batch_receipts WHERE owner = ? AND key = ? AND claim_id = ? AND status = 'pending'"
  ).bind(userId, receiptKey, claimId).run();
}

// Fenced finish. settled=1 because nothing here is refunded by the batch sweep;
// the cron settles its own reservation.
async function finishReceipt(
  env: Env, userId: string, receiptKey: string, claimId: string,
  status: "done" | "abandoned", httpStatus: number, body: string
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE batch_receipts SET status = ?, settled = 1, http_status = ?, body = ?
     WHERE owner = ? AND key = ? AND claim_id = ? AND status = 'pending'`
  ).bind(status, httpStatus, body, userId, receiptKey, claimId).run();
  return (res.meta?.changes ?? 0) > 0;
}

// R2 has no conditional delete, so check the etag right before deleting: a
// newer PUT that landed during the publish survives. A failure here is
// harmless because the done receipt stops a re-publish of the same content.
async function deleteIfEtag(env: Env, objectKey: string, etag: string): Promise<boolean> {
  try {
    const head = await env.DOCS.head(objectKey);
    if (!head || head.etag !== etag) return false;
    await env.DOCS.delete(objectKey);
    return true;
  } catch (err) {
    console.error("draft delete failed; the receipt prevents a re-publish", err);
    return false;
  }
}

// Publish the draft, then delete it (if unchanged). 404 when there is no
// draft. The draft stays when the publish does not succeed. The claim key is
// the Idempotency-Key when given, else the draft's etag.
export async function commitDraft(
  env: Env, userId: string, key: string, _ctx?: ExecutionContext, idem?: string
): Promise<DraftResult> {
  const objectKey = draftObjectKey(userId, key);
  const object = await env.DOCS.get(objectKey);
  if (!object && !idem) return failure(404, "draft not found");
  const etag = object?.etag;
  // etag is a content hash; the upload time makes a new upload of the same text a new draft.
  const receiptKey = `draft-commit:${key}:${idem ?? `${etag}:${object?.uploaded.getTime()}`}`;
  const claimId = crypto.randomUUID();
  const claim = await claimReceipt(env, userId, receiptKey, claimId);
  if (!claim.won) {
    const row = claim.row;
    if (row?.status === "done") {
      if (etag && !idem) await deleteIfEtag(env, objectKey, etag); // retry a delete that failed
      return { status: row.http_status ?? 200, body: JSON.parse(row.body ?? "{}"), units: "none" };
    }
    return failure(409, row?.status === "pending" ? "commit_in_progress" : "commit_abandoned");
  }
  try {
    if (!object || !etag) { await releaseReceipt(env, userId, receiptKey, claimId); return failure(404, "draft not found"); }
    let stored: Json;
    try { stored = JSON.parse(await object.text()) as Json; }
    catch { await releaseReceipt(env, userId, receiptKey, claimId); return failure(400, "draft is not valid JSON"); }
    const result = await publishStored(env, userId, stored);
    if (result.status !== 200) {
      await releaseReceipt(env, userId, receiptKey, claimId); // a retry may run again
      return result;
    }
    let done = false;
    try {
      done = await finishReceipt(env, userId, receiptKey, claimId, "done", 200, JSON.stringify(result.body));
    } catch (err) {
      // Published but the receipt write failed. Leave the claim pending: the
      // sweep abandons it, so the key never runs again. Remove the draft so
      // nothing re-publishes it; the items stay written.
      console.error("draft receipt write failed after a publish", err);
      await deleteIfEtag(env, objectKey, etag);
      return { ...result, units: "draft_commit=1" };
    }
    if (!done) return failure(409, "commit_abandoned");
    await deleteIfEtag(env, objectKey, etag);
    return { ...result, units: "draft_commit=1" };
  } catch (err) {
    await releaseReceipt(env, userId, receiptKey, claimId).catch(() => {});
    throw err;
  }
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

// One idle draft, as its owner. Claim first (the same receipt a request would
// take), then reserve with the meter. The reservation key carries a 6-hour
// bucket so a transient failure (settled, so its key is a tombstone) is
// retried in the next bucket. A permanent 4xx keeps an abandoned receipt, so
// the draft is not retried until the next PUT changes its etag.
async function commitIdleDraft(env: Env, objectKey: string, now: number): Promise<"committed" | "failed" | "skipped"> {
  const who = parseObjectKey(objectKey);
  if (!who) return "skipped";
  const object = await env.DOCS.get(objectKey);
  if (!object) return "skipped";
  const etag = object.etag;
  const receiptKey = `draft-commit:${who.key}:${etag}:${object.uploaded.getTime()}`;
  const claimId = crypto.randomUUID();
  const claim = await claimReceipt(env, who.userId, receiptKey, claimId);
  if (!claim.won) {
    // Already published (a delete failed): finish the delete, publish nothing.
    if (claim.row?.status === "done") await deleteIfEtag(env, objectKey, etag);
    return "skipped";
  }
  const rk = `draft:${who.userId}:${who.key}:${object.uploaded.getTime()}:${Math.floor(now / BUCKET_MS)}`;
  const settleNothing = async () => {
    try { await meter().settle(env, rk, {}); } catch (err) { console.error("draft settle failed", err); }
  };
  let reserved = false;
  try {
    const r = await meter().reserve(env, who.userId, { draft_commit: 1 }, rk);
    if (!r.ok) { await releaseReceipt(env, who.userId, receiptKey, claimId); return "skipped"; }
    reserved = true;
    let result: DraftResult | null = null;
    try {
      result = await publishStored(env, who.userId, JSON.parse(await object.text()) as Json);
    } catch (err) {
      console.error("draft commit failed", err);
    }
    if (result?.status === 200) {
      try {
        await finishReceipt(env, who.userId, receiptKey, claimId, "done", 200, JSON.stringify(result.body));
      } catch (err) {
        // Published, receipt write failed: leave the claim pending for the
        // sweep, keep the reservation, and remove the draft so it is not re-published.
        console.error("draft receipt write failed after a publish", err);
      }
      await deleteIfEtag(env, objectKey, etag);
      return "committed";
    }
    if (result && result.status >= 400 && result.status < 500) {
      await finishReceipt(env, who.userId, receiptKey, claimId, "abandoned", result.status, JSON.stringify(result.body));
    } else {
      await releaseReceipt(env, who.userId, receiptKey, claimId);
    }
    await settleNothing();
    return "failed";
  } catch (err) {
    await releaseReceipt(env, who.userId, receiptKey, claimId).catch(() => {});
    if (reserved) await settleNothing();
    throw err;
  }
}

// Cron: commit drafts idle for olderThanMs. 100 objects a run, resuming from a
// stored cursor so a stuck draft cannot starve the ones behind it.
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
      if (now - object.uploaded.getTime() < olderThanMs) { out.skipped++; continue; }
      out[await commitIdleDraft(env, object.key, now)]++;
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
