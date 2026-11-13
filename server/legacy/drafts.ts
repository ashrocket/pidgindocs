// PidginCore: immutable draft blobs, a current revision pointer, and fenced commits.
import type { Env } from "./types";
import { PublishInputError, publishDocument } from "./documents";
import { ArtifactForbiddenError, ArtifactConflictError, ArtifactInputError, publishArtifact } from "./artifacts/store";
import { canWriteContentScope } from "./content-scope";
import { boundedText } from "./bounded-body";
import { meter, type Units } from "./meter";

export const DRAFT_MAX_BYTES = 2 * 1024 * 1024;
export const DRAFT_MAX_PER_USER = 50;
export const DRAFT_MAX_RETAINED_BYTES = DRAFT_MAX_BYTES * DRAFT_MAX_PER_USER;
export const DRAFT_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const DRAFT_IDLE_MS = 10 * 60_000;
export const DRAFT_KEEP_MS = 7 * 24 * 60 * 60_000;
type Json = Record<string, any>;
export interface DraftResult { status: number; body: Json; units?: string }
export interface DraftRevision { id: string; owner: string; draft_key: string; object_key: string; size_bytes: number; state: string; created_ms: number }
interface Receipt { revision: string; owner: string; draft_key: string; claim_id: string; status: string; http_status: number | null; body: string | null; units: string; settled: number; created_ms: number }
const failure = (status: number, error: string): DraftResult => ({ status, body: { ok: false, error } });
const storageKey = (id: string) => `draft-storage:${id}`;
const commitKey = (row: Pick<Receipt, "revision" | "claim_id">) => `draft-commit:${row.revision}:${row.claim_id}`;
const changed = async (stmt: D1PreparedStatement) => (await stmt.run()).meta.changes;

export async function currentDraft(env: Env, userId: string, key: string): Promise<DraftRevision | null> {
  return env.DB.prepare("SELECT * FROM draft_revisions WHERE owner = ? AND draft_key = ? AND state = 'active'").bind(userId, key).first<DraftRevision>();
}

async function settleCommit(env: Env, row: Receipt): Promise<void> {
  if (row.settled || row.status === "pending" || row.status === "held") return;
  await meter().settle(env, commitKey(row), JSON.parse(row.units) as Units);
  await env.DB.prepare("UPDATE draft_commits SET settled = 1 WHERE revision = ? AND claim_id = ? AND status = ?")
    .bind(row.revision, row.claim_id, row.status).run();
}

// Never remove a revision with an ambiguous publication. Its receipt and bytes
// remain visible to an operator; automatically retrying it could publish twice.
export async function flushDraftCleanup(env: Env, owner?: string): Promise<number> {
  const rows = await env.DB.prepare(`SELECT r.* FROM draft_revisions r WHERE r.state = 'retired'
    AND (? IS NULL OR r.owner = ?) AND NOT EXISTS
      (SELECT 1 FROM draft_commits c WHERE c.revision = r.id AND c.status IN ('pending','held'))
    ORDER BY r.created_ms LIMIT 100`).bind(owner ?? null, owner ?? null).all<DraftRevision>();
  let removed = 0;
  for (const row of rows.results) {
    try {
      await env.DOCS.delete(row.object_key);
      await meter().settle(env, storageKey(row.id), {});
      removed += await changed(env.DB.prepare("DELETE FROM draft_revisions WHERE id = ? AND state = 'retired'").bind(row.id));
    } catch { console.error("draft cleanup deferred"); }
  }
  const unsettled = await env.DB.prepare("SELECT * FROM draft_commits WHERE status IN ('done','rejected') AND settled = 0 LIMIT 100").all<Receipt>();
  for (const row of unsettled.results) {
    try { await settleCommit(env, row); } catch { console.error("draft settlement deferred"); }
  }
  return removed;
}

// D1 reserves retained bytes and the key slot before R2 can receive a blob.
// Uncertain reservations/deletions retain their row until idempotent release.
export async function putDraft(env: Env, userId: string, key: string, text: string): Promise<"ok" | "limit"> {
  const size = new TextEncoder().encode(text).byteLength;
  if (!DRAFT_KEY_PATTERN.test(key) || size > DRAFT_MAX_BYTES) return "limit";
  if (!await canWriteContentScope(env, userId)) return "limit";
  await flushDraftCleanup(env, userId);
  const id = crypto.randomUUID(), objectKey = `drafts/${encodeURIComponent(userId)}/${id}.json`;
  const inserted = await changed(env.DB.prepare(`INSERT INTO draft_revisions (id,owner,draft_key,object_key,size_bytes,state,created_ms)
    SELECT ?,?,?,?,?,'staging',? WHERE
      (SELECT COALESCE(SUM(size_bytes),0) FROM draft_revisions WHERE owner = ?) + ? <= ?
      AND (EXISTS(SELECT 1 FROM draft_revisions WHERE owner = ? AND draft_key = ? AND state IN ('active','staging'))
        OR (SELECT COUNT(DISTINCT draft_key) FROM draft_revisions WHERE owner = ? AND state IN ('active','staging')) < ?)`)
    .bind(id,userId,key,objectKey,size,Date.now(),userId,size,DRAFT_MAX_RETAINED_BYTES,userId,key,userId,DRAFT_MAX_PER_USER));
  if (!inserted) return "limit";
  try {
    const reserved = await meter().reserve(env, userId, { draft_bytes: size }, storageKey(id));
    if (!reserved.ok) {
      await env.DB.prepare("UPDATE draft_revisions SET state = 'retired' WHERE id = ? AND state = 'staging'").bind(id).run();
      await flushDraftCleanup(env, userId);
      return "limit";
    }
    await env.DOCS.put(objectKey, text, { httpMetadata: { contentType: "application/json" } });
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE draft_revisions SET state = 'retired' WHERE owner = ? AND draft_key = ? AND state = 'active'
        AND EXISTS(SELECT 1 FROM draft_revisions WHERE id = ? AND state = 'staging')`).bind(userId,key,id),
      env.DB.prepare("UPDATE draft_revisions SET state = 'active' WHERE id = ? AND state = 'staging'").bind(id),
    ]);
    if (!results[1].meta.changes) {
      // A stale upload was expired/deleted while its object was being written.
      await env.DOCS.delete(objectKey);
      throw new Error("draft upload expired");
    }
    await flushDraftCleanup(env, userId);
    return "ok";
  } catch (error) {
    // A lost reserve, R2 upload, or activation response is ambiguous. Retain
    // the staged row and its bytes for reconciliation; a late upload must not
    // arrive after its only durable accounting row has been deleted.
    throw error;
  }
}

export async function deleteDraft(env: Env, userId: string, key: string): Promise<boolean> {
  const n = await changed(env.DB.prepare("UPDATE draft_revisions SET state = 'retired' WHERE owner = ? AND draft_key = ? AND state = 'active'").bind(userId,key));
  await flushDraftCleanup(env, userId);
  return n > 0;
}
// Publish the stored fields. Throws only on a stored object that cannot be
// read or on an unexpected publish failure; known input errors return a result.
async function publishStored(env: Env, userId: string, stored: Json): Promise<DraftResult> {
  if (stored.kind === "document" && (typeof stored.title !== "string" || !stored.title.trim())) return failure(400,"title is required");
  if (stored.priority !== undefined && stored.priority !== "normal" && stored.priority !== "urgent") return failure(400,"invalid priority");
  if (stored.team_id !== undefined && stored.team_id !== null && typeof stored.team_id !== "string") {
    return failure(400, "team_id must be a string");
  }
  if (!await canWriteContentScope(env, userId, stored.team_id, stored.project_id)) {
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
    if (err instanceof ArtifactForbiddenError) return failure(403,"forbidden");
    if (err instanceof ArtifactConflictError) return failure(409, err.message);
    if (err instanceof ArtifactInputError) {
      return failure(err.message === "artifact not found" ? 404 : 400, err.message);
    }
    if (err instanceof PublishInputError) return failure(400, err.message);
    throw err;
  }
}

async function finish(env: Env, row: Receipt, result: DraftResult, status: "done" | "rejected", units: Units): Promise<void> {
  await env.DB.prepare(`UPDATE draft_commits SET status = ?, http_status = ?, body = ?, units = ?
    WHERE revision = ? AND claim_id = ? AND status = 'pending'`)
    .bind(status,result.status,JSON.stringify(result.body),JSON.stringify(units),row.revision,row.claim_id).run();
  await settleCommit(env, { ...row, status, units: JSON.stringify(units) }).catch(() => {});
}

// Idempotency keys are aliases for a revision, never a second publication claim.
// Manual and scheduled commits always contend for the same revision receipt.
export async function commitDraft(env: Env, userId: string, key: string, _ctx?: ExecutionContext, idem?: string, expectedRevision?: string): Promise<DraftResult> {
  if (!DRAFT_KEY_PATTERN.test(key) || (idem !== undefined && (idem.length < 1 || idem.length > 128))) return failure(400,"invalid draft or idempotency key");
  if (!await canWriteContentScope(env, userId)) return failure(403,"forbidden");
  let revision = (await currentDraft(env,userId,key))?.id;
  if (expectedRevision && expectedRevision !== revision) return failure(409,"draft changed");
  if (idem) {
    if (revision) await env.DB.prepare("INSERT INTO draft_commit_keys (owner,draft_key,key,revision) VALUES (?,?,?,?) ON CONFLICT DO NOTHING").bind(userId,key,idem,revision).run();
    const alias = await env.DB.prepare("SELECT revision FROM draft_commit_keys WHERE owner = ? AND draft_key = ? AND key = ?").bind(userId,key,idem).first<{revision:string}>();
    revision = alias?.revision;
  }
  if (!revision) return failure(404,"draft not found");
  const row: Receipt = { revision, owner:userId, draft_key:key, claim_id:crypto.randomUUID(), status:"pending", http_status:null, body:null, units:"{}", settled:0, created_ms:Date.now() };
  const won = await changed(env.DB.prepare(`INSERT INTO draft_commits (revision,owner,draft_key,claim_id,status,created_ms)
    SELECT ?,?,?,?,'pending',? WHERE EXISTS(SELECT 1 FROM draft_revisions WHERE id = ? AND owner = ? AND state = 'active')
    ON CONFLICT DO NOTHING`).bind(revision,userId,key,row.claim_id,row.created_ms,revision,userId));
  if (!won) {
    const receipt = await env.DB.prepare("SELECT * FROM draft_commits WHERE revision = ? AND owner = ?").bind(revision,userId).first<Receipt>();
    if (receipt?.status === "done" || receipt?.status === "rejected") {
      if (receipt.status === "done") await env.DB.prepare("UPDATE draft_revisions SET state = 'retired' WHERE id = ?").bind(revision).run();
      await flushDraftCleanup(env,userId);
      return { status:receipt.http_status ?? 200, body:JSON.parse(receipt.body ?? "{}"), units:"none" };
    }
    return failure(receipt ? 409 : 404, receipt ? "commit_outcome_pending" : "draft not found");
  }
  let publishing = false;
  try {
    const retained = await env.DB.prepare("SELECT * FROM draft_revisions WHERE id = ? AND owner = ?").bind(revision,userId).first<DraftRevision>();
    const object = retained ? await env.DOCS.get(retained.object_key) : null;
    if (!object) { const result=failure(404,"draft not found"); await finish(env,row,result,"rejected",{}); return result; }
    let stored: Json;
    try { stored = JSON.parse(await boundedText(new Response(object.body),DRAFT_MAX_BYTES)); }
    catch { const result=failure(400,"draft is not valid JSON"); await finish(env,row,result,"rejected",{}); return result; }
    if (!stored || Array.isArray(stored) || typeof stored !== "object") {
      const result=failure(400,"draft is not an object"); await finish(env,row,result,"rejected",{}); return result;
    }
    const reservation = await meter().reserve(env,userId,{draft_commit:1},commitKey(row));
    if (!reservation.ok) {
      await env.DB.prepare("DELETE FROM draft_commits WHERE revision = ? AND claim_id = ? AND status = 'pending'").bind(revision,row.claim_id).run();
      return failure(429,"limit");
    }
    publishing = true;
    const result = await publishStored(env,userId,stored);
    await finish(env,row,result,result.status === 200 ? "done" : "rejected",result.status === 200 ? {draft_commit:1} : {});
    if (result.status === 200) {
      await env.DB.prepare("UPDATE draft_revisions SET state = 'retired' WHERE id = ?").bind(revision).run();
      await flushDraftCleanup(env,userId);
    }
    return { ...result, units: result.status === 200 ? "draft_commit=1" : "none" };
  } catch {
    if (publishing) {
      await env.DB.prepare("UPDATE draft_commits SET status = 'held', units = ? WHERE revision = ? AND claim_id = ? AND status = 'pending'").bind(JSON.stringify({draft_commit:1}),revision,row.claim_id).run().catch(() => {});
      // No refund and no automatic re-execution after a possibly committed write.
      return failure(503,"commit_outcome_unknown");
    }
    await finish(env,row,failure(503,"draft unavailable"),"rejected",{}).catch(() => {});
    return failure(503,"draft unavailable");
  }
}

// Rejected/held revisions stay inspectable but never starve later idle drafts.
export async function commitStaleDrafts(env: Env, olderThanMs: number, now = Date.now()): Promise<{committed:number;failed:number;skipped:number}> {
  await flushDraftCleanup(env);
  const rows = await env.DB.prepare(`SELECT r.* FROM draft_revisions r WHERE r.state = 'active' AND r.created_ms <= ?
    AND NOT EXISTS(SELECT 1 FROM draft_commits c WHERE c.revision = r.id)
    ORDER BY r.last_attempt_ms, r.created_ms LIMIT 100`).bind(now-olderThanMs).all<DraftRevision>();
  const out = {committed:0,failed:0,skipped:0};
  for (const row of rows.results) {
    await env.DB.prepare("UPDATE draft_revisions SET last_attempt_ms = ? WHERE id = ?").bind(now,row.id).run();
    const result = await commitDraft(env,row.owner,row.draft_key,undefined,undefined,row.id);
    if (result.status === 200) out.committed++;
    else if (result.status === 429 || result.status === 409 || result.status === 404) out.skipped++;
    else out.failed++;
  }
  return out;
}

export async function deleteOldDrafts(env: Env, now = Date.now()): Promise<number> {
  const dropped = await changed(env.DB.prepare(`UPDATE draft_revisions SET state = 'retired' WHERE id IN
    (SELECT id FROM draft_revisions WHERE state = 'active' AND created_ms < ? LIMIT 100)`)
    .bind(now-DRAFT_KEEP_MS));
  await flushDraftCleanup(env);
  // Keep pending/held receipts indefinitely: they are evidence against replay.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM draft_commit_keys WHERE revision IN
      (SELECT revision FROM draft_commits WHERE status IN ('done','rejected') AND settled = 1 AND created_ms < ?
        AND NOT EXISTS(SELECT 1 FROM draft_revisions r WHERE r.id = draft_commits.revision) LIMIT 100)`).bind(now-DRAFT_KEEP_MS),
    env.DB.prepare(`DELETE FROM draft_commits WHERE revision IN
      (SELECT revision FROM draft_commits WHERE status IN ('done','rejected') AND settled = 1 AND created_ms < ?
        AND NOT EXISTS(SELECT 1 FROM draft_revisions r WHERE r.id = draft_commits.revision) LIMIT 100)`).bind(now-DRAFT_KEEP_MS),
  ]);
  return dropped;
}
