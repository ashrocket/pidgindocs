// Drafts: immutable draft blobs, a current revision pointer, and fenced commits that publish a document or artifact.
// A commit publishes through the same functions as a direct publish, so scope, plan and content-policy checks apply alike.
import type { Env } from "./types";
import { PublishInputError, publishDocument } from "./documents";
import { ArtifactConflictError, ArtifactInputError, artifactUrl, publishArtifact } from "./artifacts/store";
import { assertWorkspacePublishScope, WorkspaceAccessError, type Sharing } from "./workspace-access";
import { assertTenantWritable, editionErrorResponse, releaseEditionUsage, reserveEditionUsage, tenantWritable, TenantWriteRefused, UsageRefused } from "./edition-hooks";
import { boundedText } from "./bounded-body";

export const DRAFT_MAX_BYTES = 2 * 1024 * 1024;
export const DRAFT_MAX_PER_USER = 50;
export const DRAFT_MAX_RETAINED_BYTES = DRAFT_MAX_BYTES * DRAFT_MAX_PER_USER;
export const DRAFT_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const DRAFT_IDLE_MS = 10 * 60_000;
/** A staged upload older than this belongs to a Worker that died mid-PUT. */
export const DRAFT_STAGING_MS = 60 * 60_000;
export const DRAFT_KEEP_MS = 7 * 24 * 60 * 60_000;
/** The five-minute trigger. It runs only the draft sweep. */
export const DRAFT_CRON = "*/5 * * * *";

type Json = Record<string, any>;
export interface DraftResult {
  status: number;
  body: Json;
  /** The refusal came before anything was written, so the same revision may be tried again. */
  retry?: boolean;
}
export interface DraftRevision {
  id: string; owner: string; draft_key: string; object_key: string; size_bytes: number;
  state: string; created_ms: number; last_attempt_ms: number; metered_bytes: number;
}
interface Receipt { revision: string; owner: string; draft_key: string; claim_id: string; status: string; http_status: number | null; body: string | null; created_ms: number }

const failure = (status: number, error: string, retry = false): DraftResult => ({ status, body: { ok: false, error }, ...(retry ? { retry } : {}) });
const addKey = (id: string) => `draft:${id}:storage:add`;
const releaseKey = (id: string) => `draft:${id}:storage:release`;
const changed = async (stmt: D1PreparedStatement) => (await stmt.run()).meta.changes;

/** The owner is an active user and the deployment accepts writes. A refused deployment throws its own refusal. */
export async function canDraft(env: Env, userId: string): Promise<boolean> {
  if (!await env.DB.prepare("SELECT 1 FROM users WHERE id = ? AND status = 'active'").bind(userId).first()) return false;
  await assertTenantWritable(env);
  return true;
}

/** The scope check that a direct publish makes: write access to the team, and a project that belongs to it. */
async function canPublishScope(env: Env, userId: string, teamId: unknown, projectId: unknown): Promise<boolean> {
  if ((teamId != null && typeof teamId !== "string") || (projectId != null && typeof projectId !== "string")) return false;
  try { await assertWorkspacePublishScope(env, userId, (teamId as string | null) || null, (projectId as string | null) || null); return true; }
  catch (error) { if (error instanceof WorkspaceAccessError) return false; throw error; }
}

export async function currentDraft(env: Env, userId: string, key: string): Promise<DraftRevision | null> {
  return env.DB.prepare("SELECT * FROM draft_revisions WHERE owner = ? AND draft_key = ? AND state = 'active'").bind(userId, key).first<DraftRevision>();
}

// A retired revision is removed once its object is deleted and its metered bytes are released. Both steps are
// idempotent, so a failure keeps the row for the next sweep. A revision with an ambiguous publication is never
// removed: its receipt and bytes stay visible to an operator, and retrying it automatically could publish twice.
export async function flushDraftCleanup(env: Env, owner?: string): Promise<number> {
  const rows = await env.DB.prepare(`SELECT r.* FROM draft_revisions r WHERE r.state = 'retired'
    AND (? IS NULL OR r.owner = ?) AND NOT EXISTS
      (SELECT 1 FROM draft_commits c WHERE c.revision = r.id AND c.status IN ('pending','held'))
    ORDER BY r.created_ms LIMIT 100`).bind(owner ?? null, owner ?? null).all<DraftRevision>();
  let removed = 0;
  for (const row of rows.results) {
    try {
      await env.DOCS.delete(row.object_key);
      if (row.metered_bytes > 0) await releaseEditionUsage(env, row.owner, "storage_bytes", row.metered_bytes, releaseKey(row.id));
      removed += await changed(env.DB.prepare("DELETE FROM draft_revisions WHERE id = ? AND state = 'retired'").bind(row.id));
    } catch { console.error("draft cleanup deferred"); }
  }
  return removed;
}

// D1 reserves the retained bytes and the key slot before object storage can receive a blob. An uncertain
// upload keeps its row until the next sweep retires it, so a late upload never outlives its accounting row.
export async function putDraft(env: Env, userId: string, key: string, text: string): Promise<"ok" | "limit"> {
  const size = new TextEncoder().encode(text).byteLength;
  if (!DRAFT_KEY_PATTERN.test(key) || size > DRAFT_MAX_BYTES) return "limit";
  if (!await canDraft(env, userId)) return "limit";
  await flushDraftCleanup(env, userId);
  const id = crypto.randomUUID(), objectKey = `drafts/${encodeURIComponent(userId)}/${id}.json`;
  const inserted = await changed(env.DB.prepare(`INSERT INTO draft_revisions (id,owner,draft_key,object_key,size_bytes,state,created_ms)
    SELECT ?,?,?,?,?,'staging',? WHERE
      (SELECT COALESCE(SUM(size_bytes),0) FROM draft_revisions WHERE owner = ?) + ? <= ?
      AND (EXISTS(SELECT 1 FROM draft_revisions WHERE owner = ? AND draft_key = ? AND state IN ('active','staging'))
        OR (SELECT COUNT(DISTINCT draft_key) FROM draft_revisions WHERE owner = ? AND state IN ('active','staging')) < ?)`)
    .bind(id,userId,key,objectKey,size,Date.now(),userId,size,DRAFT_MAX_RETAINED_BYTES,userId,key,userId,DRAFT_MAX_PER_USER));
  if (!inserted) return "limit";
  const retireStaged = () => env.DB.prepare("UPDATE draft_revisions SET state = 'retired' WHERE id = ? AND state = 'staging'").bind(id).run();
  try {
    const reserved = await reserveEditionUsage(env, userId, "storage_bytes", size, addKey(id));
    if (reserved.managed) await env.DB.prepare("UPDATE draft_revisions SET metered_bytes = ? WHERE id = ?").bind(size, id).run();
    await env.DOCS.put(objectKey, text, { httpMetadata: { contentType: "application/json" } });
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE draft_revisions SET state = 'retired' WHERE owner = ? AND draft_key = ? AND state = 'active'
        AND EXISTS(SELECT 1 FROM draft_revisions WHERE id = ? AND state = 'staging')`).bind(userId,key,id),
      env.DB.prepare("UPDATE draft_revisions SET state = 'active' WHERE id = ? AND state = 'staging'").bind(id),
    ]);
    if (!results[1].meta.changes) {
      // A stale upload was expired or deleted while its object was being written.
      await env.DOCS.delete(objectKey);
      throw new Error("draft upload expired");
    }
  } catch (error) {
    // The blob may or may not exist. Retire the staged row so the sweep deletes the object (if any) and releases the bytes.
    await retireStaged().catch(() => {});
    await flushDraftCleanup(env, userId).catch(() => {});
    throw error;
  }
  await flushDraftCleanup(env, userId);
  return "ok";
}

export async function deleteDraft(env: Env, userId: string, key: string): Promise<boolean> {
  const n = await changed(env.DB.prepare("UPDATE draft_revisions SET state = 'retired' WHERE owner = ? AND draft_key = ? AND state = 'active'").bind(userId,key));
  await flushDraftCleanup(env, userId);
  return n > 0;
}

// Publish the stored fields. Known input errors return a result; a refusal that comes before any write
// (a plan limit, a deployment that is not accepting writes) comes back with `retry` so the claim is released.
async function publishStored(env: Env, userId: string, stored: Json): Promise<DraftResult> {
  if (stored.kind !== "document" && stored.kind !== "artifact") return failure(400, '"kind" must be document or artifact');
  if (stored.kind === "document" && (typeof stored.title !== "string" || !stored.title.trim())) return failure(400, "title is required");
  if (stored.priority !== undefined && stored.priority !== "normal" && stored.priority !== "urgent") return failure(400, "invalid priority");
  if (stored.team_id !== undefined && stored.team_id !== null && typeof stored.team_id !== "string") return failure(400, "team_id must be a string");
  if (stored.sharing !== undefined && stored.sharing !== null && typeof stored.sharing !== "string") return failure(400, "sharing must be a string");
  if ((stored.team_id || stored.project_id) && !await canPublishScope(env, userId, stored.team_id, stored.project_id)) return failure(403, "forbidden");
  const sharing = (stored.sharing ?? undefined) as Sharing | undefined;
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
        teamId: stored.team_id ?? undefined, projectId: stored.project_id, sharing,
        userId,
      });
      return { status: 200, body: { ok: true, data: { id: result.artifact.id, kind: "artifact", version: result.version, created: result.created, url: artifactUrl(env, result.artifact.id) } } };
    }
    const doc = await publishDocument(env, {
      title: stored.title,
      html: stored.html, markdown: stored.markdown, body: stored.body,
      docKind: stored.doc_kind, public: stored.public,
      priority: stored.priority || "normal",
      project: stored.project ?? stored.instance?.project,
      teamId: stored.team_id ?? undefined, projectId: stored.project_id, sharing,
      designSystem: stored.design_system, enhance: stored.enhance, instructions: stored.instructions,
      interactive: stored.interactive,
      userId,
    });
    return { status: 200, body: { ok: true, data: { id: doc.id, kind: "document" } } };
  } catch (err) {
    // Only a definite refusal is retried. A plan-service failure (5xx) may have counted the usage already, so it
    // takes the held path below, as the artifact store treats it.
    if (err instanceof TenantWriteRefused || (err instanceof UsageRefused && err.status < 500)) return failure(err.status, err.message, true);
    // An edition's own refusal (for example an unpaid tenant) keeps its safe status and body.
    const edited = editionErrorResponse(err);
    if (edited) return { status: edited.status, body: (await edited.json().catch(() => ({ ok: false, error: "refused" }))) as Json, retry: true };
    if (err instanceof ArtifactConflictError) return failure(409, err.message);
    if (err instanceof ArtifactInputError) return failure(err.message === "artifact not found" ? 404 : 400, err.message);
    if (err instanceof PublishInputError) return failure(400, err.message);
    throw err;
  }
}

async function finish(env: Env, row: Receipt, result: DraftResult, status: "done" | "rejected"): Promise<void> {
  await env.DB.prepare(`UPDATE draft_commits SET status = ?, http_status = ?, body = ?
    WHERE revision = ? AND claim_id = ? AND status = 'pending'`)
    .bind(status,result.status,JSON.stringify(result.body),row.revision,row.claim_id).run();
}

// Idempotency keys are aliases for a revision, never a second publication claim.
// Manual and scheduled commits always contend for the same revision receipt.
export async function commitDraft(env: Env, userId: string, key: string, idem?: string, expectedRevision?: string): Promise<DraftResult> {
  if (!DRAFT_KEY_PATTERN.test(key) || (idem !== undefined && (idem.length < 1 || idem.length > 128))) return failure(400, "invalid draft or idempotency key");
  if (!await canDraft(env, userId)) return failure(403, "forbidden");
  let revision = (await currentDraft(env,userId,key))?.id;
  if (expectedRevision && expectedRevision !== revision) return failure(409, "draft changed");
  if (idem) {
    if (revision) await env.DB.prepare("INSERT INTO draft_commit_keys (owner,draft_key,key,revision) VALUES (?,?,?,?) ON CONFLICT DO NOTHING").bind(userId,key,idem,revision).run();
    const alias = await env.DB.prepare("SELECT revision FROM draft_commit_keys WHERE owner = ? AND draft_key = ? AND key = ?").bind(userId,key,idem).first<{revision:string}>();
    revision = alias?.revision;
  }
  if (!revision) return failure(404, "draft not found");
  const row: Receipt = { revision, owner:userId, draft_key:key, claim_id:crypto.randomUUID(), status:"pending", http_status:null, body:null, created_ms:Date.now() };
  const won = await changed(env.DB.prepare(`INSERT INTO draft_commits (revision,owner,draft_key,claim_id,status,created_ms)
    SELECT ?,?,?,?,'pending',? WHERE EXISTS(SELECT 1 FROM draft_revisions WHERE id = ? AND owner = ? AND state = 'active')
    ON CONFLICT DO NOTHING`).bind(revision,userId,key,row.claim_id,row.created_ms,revision,userId));
  if (!won) {
    const receipt = await env.DB.prepare("SELECT * FROM draft_commits WHERE revision = ? AND owner = ?").bind(revision,userId).first<Receipt>();
    if (receipt?.status === "done" || receipt?.status === "rejected") {
      if (receipt.status === "done") await env.DB.prepare("UPDATE draft_revisions SET state = 'retired' WHERE id = ?").bind(revision).run();
      await flushDraftCleanup(env,userId);
      return { status:receipt.http_status ?? 200, body:JSON.parse(receipt.body ?? "{}") };
    }
    return failure(receipt ? 409 : 404, receipt ? "commit_outcome_pending" : "draft not found");
  }
  const release = () => env.DB.prepare("DELETE FROM draft_commits WHERE revision = ? AND claim_id = ? AND status = 'pending'").bind(revision,row.claim_id).run();
  let publishing = false;
  try {
    // A storage or database read error here is transient: nothing has been published, so the claim is released
    // (below) and the draft stays committable. Only a validation or permission refusal records a permanent receipt.
    const retained = await env.DB.prepare("SELECT * FROM draft_revisions WHERE id = ? AND owner = ?").bind(revision,userId).first<DraftRevision>();
    const object = retained ? await env.DOCS.get(retained.object_key) : null;
    if (!object) { const result=failure(404, "draft not found"); await finish(env,row,result,"rejected"); return result; }
    let stored: Json;
    try { stored = JSON.parse(await boundedText(new Response(object.body),DRAFT_MAX_BYTES)); }
    catch { const result=failure(400, "draft is not valid JSON"); await finish(env,row,result,"rejected"); return result; }
    if (!stored || Array.isArray(stored) || typeof stored !== "object") {
      const result=failure(400, "draft is not an object"); await finish(env,row,result,"rejected"); return result;
    }
    // The commit's own publish reserves storage for the content, so the draft's reservation is given back first.
    // The release key is the draft's, so it happens once; metered_bytes is cleared only after it succeeded.
    if (retained!.metered_bytes > 0) {
      await releaseEditionUsage(env, userId, "storage_bytes", retained!.metered_bytes, releaseKey(revision));
      await env.DB.prepare("UPDATE draft_revisions SET metered_bytes = 0 WHERE id = ?").bind(revision).run();
    }
    publishing = true;
    const result = await publishStored(env,userId,stored);
    if (result.retry) { publishing = false; await release(); return result; }
    await finish(env,row,result,result.status === 200 ? "done" : "rejected");
    if (result.status === 200) {
      await env.DB.prepare("UPDATE draft_revisions SET state = 'retired' WHERE id = ?").bind(revision).run();
      await flushDraftCleanup(env,userId);
    }
    return result;
  } catch (error) {
    if (publishing) {
      await env.DB.prepare("UPDATE draft_commits SET status = 'held' WHERE revision = ? AND claim_id = ? AND status = 'pending'").bind(revision,row.claim_id).run().catch(() => {});
      // No automatic re-execution after a possibly committed write.
      return failure(503, "commit_outcome_unknown");
    }
    await release().catch(() => {});
    return failure(503, "draft unavailable", true);
  }
}

// Rejected and held revisions stay inspectable but never starve later idle drafts.
export async function commitStaleDrafts(env: Env, olderThanMs: number, now = Date.now()): Promise<{committed:number;failed:number;skipped:number}> {
  await flushDraftCleanup(env);
  const out = {committed:0,failed:0,skipped:0};
  if (!await tenantWritable(env)) return out;
  const rows = await env.DB.prepare(`SELECT r.* FROM draft_revisions r WHERE r.state = 'active' AND r.created_ms <= ?
    AND NOT EXISTS(SELECT 1 FROM draft_commits c WHERE c.revision = r.id)
    ORDER BY r.last_attempt_ms, r.created_ms LIMIT 100`).bind(now-olderThanMs).all<DraftRevision>();
  for (const row of rows.results) {
    await env.DB.prepare("UPDATE draft_revisions SET last_attempt_ms = ? WHERE id = ?").bind(now,row.id).run();
    const result = await commitDraft(env,row.owner,row.draft_key,undefined,row.id);
    if (result.status === 200) out.committed++;
    else if (result.retry || result.status === 429 || result.status === 409 || result.status === 404) out.skipped++;
    else out.failed++;
  }
  return out;
}

export async function deleteOldDrafts(env: Env, now = Date.now()): Promise<number> {
  const dropped = await changed(env.DB.prepare(`UPDATE draft_revisions SET state = 'retired' WHERE id IN
    (SELECT id FROM draft_revisions WHERE state = 'active' AND created_ms < ? LIMIT 100)`)
    .bind(now-DRAFT_KEEP_MS));
  // A Worker killed mid-PUT leaves a staged row. Retire it after a safe delay; the flush deletes any object
  // and releases the reserved bytes once, by the revision's own release key.
  await env.DB.prepare(`UPDATE draft_revisions SET state = 'retired' WHERE id IN
    (SELECT id FROM draft_revisions WHERE state = 'staging' AND created_ms < ? LIMIT 100)`).bind(now-DRAFT_STAGING_MS).run();
  await flushDraftCleanup(env);
  // Pending and held receipts stay indefinitely: they are the evidence against a replay.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM draft_commit_keys WHERE revision IN
      (SELECT revision FROM draft_commits WHERE status IN ('done','rejected') AND created_ms < ?
        AND NOT EXISTS(SELECT 1 FROM draft_revisions r WHERE r.id = draft_commits.revision) LIMIT 100)`).bind(now-DRAFT_KEEP_MS),
    env.DB.prepare(`DELETE FROM draft_commits WHERE revision IN
      (SELECT revision FROM draft_commits WHERE status IN ('done','rejected') AND created_ms < ?
        AND NOT EXISTS(SELECT 1 FROM draft_revisions r WHERE r.id = draft_commits.revision) LIMIT 100)`).bind(now-DRAFT_KEEP_MS),
  ]);
  return dropped;
}

/**
 * The five-minute sweep: commit drafts idle for ten minutes, and once an hour delete drafts older than seven days.
 * Both are bounded to 100 rows, so the trigger stays cheap.
 */
export async function runDraftSweep(env: Env, scheduledTime: number): Promise<string> {
  const committed = await commitStaleDrafts(env, DRAFT_IDLE_MS, scheduledTime);
  let line = `Draft sweep: committed ${committed.committed}, failed ${committed.failed}, skipped ${committed.skipped}`;
  if (new Date(scheduledTime).getUTCMinutes() < 5) {
    const dropped = await deleteOldDrafts(env, scheduledTime);
    if (dropped) line += `; deleted ${dropped} drafts over 7 days old`;
  }
  return line;
}
