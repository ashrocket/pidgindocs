import { boundedText, BodyTooLargeError, allowsCredentialWrite } from "../bounded-body";
import { canWriteContentScope } from "../content-scope";
// PidginCore: POST /api/batch, up to 25 items, each through its single-route function.
import type { Env, MessagePayload } from "../types";
import { corsHeaders, deferOrAwait } from "../utils";
import { resolveCallerUserId, unauthorized } from "../middleware";
import { deliverToDestinations } from "../destinations";
import type { MessageEnvelope } from "../destinations/types";
import { PublishInputError, publishDocument } from "../documents";
import {
  ArtifactConflictError,
  ArtifactInputError,
  deleteArtifact,
  publishArtifact,
} from "../artifacts/store";
import { createMessage, createOrFoldStatus, MessageBlockInputError, type CreateMessageInput } from "../messages/store";
import { canWriteWorkspace, createComment, getWorkspaceMembership } from "../workspace";
import { validateMessagePayload } from "./messages";
import { formatUnits, meter, UNITS_HEADER, type UnitKind, type Units } from "../meter";

export const BATCH_MAX_ITEMS = 25;
export const BATCH_MAX_BYTES = 2 * 1024 * 1024;
const ABANDON_AFTER = "-5 minutes";
const RETRY_AFTER = "-1 minutes";
const KEEP_RECEIPTS = "-7 days";

const KINDS = new Set<string>(["message", "status", "document", "artifact", "comment", "delete"]);
const COMMENT_RESOURCES = new Set(["message", "artifact", "document", "decision_memo"]);

type Item = Record<string, any>;
interface ItemResult {
  ref: string;
  ok: boolean;
  id?: string;
  version?: number;
  folded?: boolean;
  error?: { code: string; message: string };
}

function reply(body: unknown, status = 200, units?: string): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...corsHeaders() };
  if (units) headers[UNITS_HEADER] = units;
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

const reservationKey = (owner: string, key: string, claimId: string) => `${owner}:${key}:${claimId}`;

async function changed(stmt: D1PreparedStatement): Promise<number> {
  const res = await stmt.run();
  return res.meta?.changes ?? 0;
}

// Marks a receipt settled after the hook ran. A hook that throws leaves
// settled=0 so the cron sweep retries it (settle is idempotent per rk).
async function settleAndMark(
  env: Env, owner: string, key: string, claimId: string, actual: Units
): Promise<void> {
  try {
    await meter().settle(env, reservationKey(owner, key, claimId), actual);
    await env.DB.prepare("UPDATE batch_receipts SET settled = 1 WHERE owner = ? AND key = ? AND claim_id = ?")
      .bind(owner, key, claimId).run();
  } catch (err) {
    console.error("batch settle failed; the sweep will retry", err);
  }
}

// Stale work may already have committed. Hold it without refund or replay.
async function abandonIfStale(env: Env, owner: string, key: string, claimId: string): Promise<boolean> {
  const won = await changed(env.DB.prepare(
    `UPDATE batch_receipts SET status = 'held'
     WHERE owner = ? AND key = ? AND status = 'pending' AND claim_id = ? AND created_at < datetime('now', '${ABANDON_AFTER}')`
  ).bind(owner, key, claimId));
  if (!won) return false;
  return true;
}

// Abandon this request's own claim after a throw. Fenced on claim_id.
async function abandonOwn(env: Env, owner: string, key: string, claimId: string): Promise<void> {
  const won = await changed(env.DB.prepare(
    "UPDATE batch_receipts SET status = 'held' WHERE owner = ? AND key = ? AND claim_id = ? AND status = 'pending'"
  ).bind(owner, key, claimId));
  void won; // A lost response may follow committed items; retain the reservation.
}

function countUnits(items: Item[]): Units {
  const units: Units = {};
  for (const item of items) {
    const kind = item?.kind;
    if (typeof kind === "string" && KINDS.has(kind)) {
      units[kind as UnitKind] = (units[kind as UnitKind] ?? 0) + 1;
    }
  }
  return units;
}

const fail = (ref: string, code: string, message: string): ItemResult =>
  ({ ref, ok: false, error: { code, message } });

async function runItem(
  env: Env, ctx: ExecutionContext | undefined, userId: string, item: Item, index: number
): Promise<ItemResult> {
  const ref = typeof item?.ref === "string" && item.ref ? item.ref : String(index);
  if (!item || typeof item !== "object" || !KINDS.has(item.kind)) {
    return fail(ref, "invalid", `"kind" must be one of ${[...KINDS].join(", ")}`);
  }
  if (item.team_id !== undefined && item.team_id !== null && typeof item.team_id !== "string") {
    return fail(ref, "invalid", "team_id must be a string");
  }
  const teamId = typeof item.team_id === "string" && item.team_id ? item.team_id : null;
  if (!await canWriteContentScope(env, userId, teamId, item.project_id)) {
    return fail(ref, "forbidden", "not a member of that team");
  }
  try {
    switch (item.kind) {
      case "message":
      case "status": {
        const v = validateMessagePayload(env, { ...item, type: item.kind } as MessagePayload);
        if ("error" in v) return fail(ref, "invalid", v.error);
        const payload = v.value.payload;
        if (payload.type !== item.kind) return fail(ref, "invalid", `a ${item.kind} item takes no html or markdown`);
        const id = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        const input: CreateMessageInput = {
          id,
          type: payload.type,
          title: payload.title,
          body: v.value.body,
          docKey: null,
          priority: payload.priority,
          isPublic: payload.public,
          docSlug: payload.slug || null,
          docVersion: null,
          designSystem: null,
          enhanceStatus: null,
          enhanceLevel: null,
          sourceUrl: payload.source_url || null,
          interactive: false,
          teamId: payload.team_id ?? null,
          projectId: payload.project_id ?? null,
          docKind: v.value.docKind,
          docSize: 0,
          sourceSize: 0,
          instance: payload.instance,
          userId,
          blocks: payload.blocks,
        };
        const created = payload.type === "status" && !payload.blocks?.length
          ? await createOrFoldStatus(env, input, {
              userId,
              teamId: payload.team_id ?? null,
              projectId: payload.project_id ?? null,
              sessionId: payload.instance.session_id,
              instanceProject: payload.instance.project,
              title: payload.title,
              body: v.value.body,
              final: payload.final === true,
            }, ctx)
          : await createMessage(env, input, ctx);
        if ("folded" in created && created.folded) return { ref, ok: true, id: created.id, folded: true };
        const envelope: MessageEnvelope = {
          id, payload: { ...payload, body: created.body ?? undefined }, docKey: null, createdAt,
        };
        await deferOrAwait(ctx, deliverToDestinations(env, envelope).catch((err) =>
          console.error("destination delivery failed", err)));
        return { ref, ok: true, id };
      }
      case "document": {
        if (typeof item.title !== "string" || !item.title.trim()) return fail(ref, "invalid", '"title" must be a non-empty string');
        const doc = await publishDocument(env, {
          title: item.title,
          html: item.html, markdown: item.markdown, body: item.body,
          docKind: item.doc_kind,
          public: item.public,
          priority: item.priority || "normal",
          project: item.project ?? item.instance?.project,
          teamId: item.team_id, projectId: item.project_id,
          designSystem: item.design_system, enhance: item.enhance, instructions: item.instructions,
          interactive: item.interactive,
          userId,
        });
        return { ref, ok: true, id: doc.id };
      }
      case "artifact": {
        const result = await publishArtifact(env, {
          html: item.html, markdown: item.markdown, title: item.title,
          description: item.description, favicon: item.favicon, label: item.label,
          artifactId: item.artifact_id, sourcePath: item.source_path,
          baseVersion: typeof item.base_version === "number" ? item.base_version : undefined,
          force: item.force === true,
          visibility: item.visibility, role: item.role, capabilities: item.capabilities,
          designSystem: item.design_system,
          sessionId: item.instance?.session_id, project: item.instance?.project,
          teamId: item.team_id, projectId: item.project_id,
          userId,
        });
        return { ref, ok: true, id: result.artifact.id, version: result.version };
      }
      case "comment": {
        const text = typeof item.body === "string" ? item.body.trim() : "";
        if (!teamId) return fail(ref, "invalid", '"team_id" is required');
        if (!COMMENT_RESOURCES.has(item.resource_type)) return fail(ref, "invalid", '"resource_type" must be one of message, artifact, document, decision_memo');
        if (typeof item.resource_id !== "string" || !item.resource_id) return fail(ref, "invalid", '"resource_id" is required');
        if (!text) return fail(ref, "invalid", '"body" is required');
        const membership = await getWorkspaceMembership(env, teamId, userId);
        if (!canWriteWorkspace(membership?.role ?? null)) return fail(ref, "forbidden", "forbidden");
        const comment = await createComment(env, {
          userId, teamId,
          projectId: item.project_id || null,
          resourceType: item.resource_type,
          resourceId: item.resource_id,
          body: text,
          parentId: item.parent_id || null,
        });
        if (!comment) return fail(ref, "forbidden", "forbidden");
        return { ref, ok: true, id: comment.id };
      }
      default: { // delete
        if (typeof item.id !== "string" || !item.id) return fail(ref, "invalid", '"id" is required');
        const deleted = await deleteArtifact(env, item.id, userId);
        return deleted ? { ref, ok: true, id: item.id } : fail(ref, "not_found", "artifact not found");
      }
    }
  } catch (err) {
    if (err instanceof ArtifactConflictError) return fail(ref, "conflict", err.message);
    if (err instanceof ArtifactInputError) {
      return fail(ref, err.message === "artifact not found" ? "not_found" : "invalid", err.message);
    }
    if (err instanceof PublishInputError || err instanceof MessageBlockInputError) {
      return fail(ref, "invalid", err.message);
    }
    console.error("batch item failed", err);
    return fail(ref, "internal", "item failed");
  }
}

export async function handleBatch(
  request: Request, env: Env, ctx?: ExecutionContext
): Promise<Response> {
  const owner = await resolveCallerUserId(request, env);
  if (!owner) return unauthorized();
  if (!allowsCredentialWrite(request) || !await canWriteContentScope(env,owner)) return reply({ok:false,error:"forbidden"},403);

  const key = request.headers.get("Idempotency-Key")?.trim();
  if (!key || key.length > 128 || /[\x00-\x1f\x7f]/.test(key)) return reply({ ok: false, error: "Idempotency-Key header is required" }, 400);

  const limits = { max_items: BATCH_MAX_ITEMS, max_bytes: BATCH_MAX_BYTES };
  let text: string;
  try { text = await boundedText(request,BATCH_MAX_BYTES); }
  catch (error) { return reply({ok:false,error:error instanceof BodyTooLargeError ? "batch too large" : "invalid body",limits},error instanceof BodyTooLargeError ? 413 : 400); }
  let parsed: { items?: unknown };
  try { parsed = JSON.parse(text); } catch { return reply({ ok: false, error: "invalid JSON body" }, 400); }
  const items = parsed?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return reply({ ok: false, error: '"items" must be a non-empty array' }, 400);
  }
  if (items.length > BATCH_MAX_ITEMS) {
    return reply({ ok: false, error: "too many items", limits }, 413);
  }

  // Rule 6: claim before any work.
  const claimId = crypto.randomUUID();
  const claimed = await changed(env.DB.prepare(
    `INSERT INTO batch_receipts (owner, key, claim_id, status, units, created_at)
     VALUES (?, ?, ?, 'pending', ?, datetime('now')) ON CONFLICT DO NOTHING`
  ).bind(owner, key, claimId, JSON.stringify(countUnits(items as Item[]))));
  if (!claimed) {
    const row = await env.DB.prepare(
      "SELECT claim_id, status, http_status, body FROM batch_receipts WHERE owner = ? AND key = ?"
    ).bind(owner, key).first<{ claim_id: string; status: string; http_status: number | null; body: string | null }>();
    if (!row) return reply({ ok: false, error: "batch_in_progress" }, 409); // swept between insert and read
    if (row.status === "done") return reply(row.body ?? "{}", row.http_status ?? 200, "none");
    if (row.status === "pending") {
      if (await abandonIfStale(env, owner, key, row.claim_id)) {
        return reply({ ok: false, error: "batch_abandoned" }, 409);
      }
      const now = await env.DB.prepare("SELECT status FROM batch_receipts WHERE owner = ? AND key = ?")
        .bind(owner, key).first<{ status: string }>();
      if (now?.status === "pending") return reply({ ok: false, error: "batch_in_progress" }, 409);
    }
    return reply({ ok: false, error: "batch_abandoned" }, 409);
  }

  const rk = reservationKey(owner, key, claimId);
  try {
    // Rule 5: reserve, then mark reserved.
    const reserved = await meter().reserve(env, owner, countUnits(items as Item[]), rk);
    if (!reserved.ok) {
      const gone = await changed(env.DB.prepare(
        "DELETE FROM batch_receipts WHERE owner = ? AND key = ? AND claim_id = ? AND status = 'pending'"
      ).bind(owner, key, claimId));
      return gone
        ? reply({ ok: false, error: "limit", remaining: reserved.remaining }, 429)
        : reply({ ok: false, error: "batch_abandoned" }, 409);
    }
    const marked = await changed(env.DB.prepare(
      "UPDATE batch_receipts SET reserved = 1 WHERE owner = ? AND key = ? AND claim_id = ? AND status = 'pending'"
    ).bind(owner, key, claimId));
    if (!marked) {
      await settleAndMark(env, owner, key, claimId, {});
      return reply({ ok: false, error: "batch_abandoned" }, 409);
    }

    const results: ItemResult[] = [];
    const succeeded: Units = {};
    for (let i = 0; i < items.length; i++) {
      const result = await runItem(env, ctx, owner, items[i] as Item, i);
      results.push(result);
      if (result.ok || result.error?.code === "internal") {
        const kind = (result.folded ? "fold" : (items[i] as Item).kind) as UnitKind;
        succeeded[kind] = (succeeded[kind] ?? 0) + 1;
      }
    }

    const body = JSON.stringify({ ok: true, results });
    const done = await changed(env.DB.prepare(
      `UPDATE batch_receipts SET status = 'done', units = ?, http_status = 200, body = ?
       WHERE owner = ? AND key = ? AND claim_id = ? AND status = 'pending'`
    ).bind(JSON.stringify(succeeded), body, owner, key, claimId));
    if (!done) return reply({ ok: false, error: "batch_abandoned" }, 409);
    await settleAndMark(env, owner, key, claimId, succeeded);
    return reply(body, 200, formatUnits(succeeded));
  } catch (err) {
    console.error("batch failed", err);
    await abandonOwn(env, owner, key, claimId).catch((e) => console.error("batch abandon failed", e));
    return reply({ ok: false, error: "internal" }, 500);
  }
}

// Cron sweep: abandon stale claims, retry unsettled receipts, drop old receipts.
export async function sweepBatchReceipts(env: Env): Promise<{ abandoned: number; settled: number; deleted: number }> {
  let abandoned = 0;
  let settled = 0;
  const stale = await env.DB.prepare(
    `SELECT owner, key, claim_id FROM batch_receipts
     WHERE status = 'pending' AND created_at < datetime('now', '${ABANDON_AFTER}') LIMIT 100`
  ).all<{ owner: string; key: string; claim_id: string }>();
  for (const r of stale.results ?? []) {
    try { if (await abandonIfStale(env, r.owner, r.key, r.claim_id)) abandoned++; }
    catch (err) { console.error("batch sweep abandon failed", err); }
  }
  const open = await env.DB.prepare(
    `SELECT owner, key, claim_id, status, units FROM batch_receipts
     WHERE status = 'done' AND settled = 0 AND created_at < datetime('now', '${RETRY_AFTER}') LIMIT 100`
  ).all<{ owner: string; key: string; claim_id: string; status: string; units: string | null }>();
  for (const r of open.results ?? []) {
    let actual: Units = {};
    if (r.status === "done" && r.units) {
      try { actual = JSON.parse(r.units) as Units; } catch { actual = {}; }
    }
    await settleAndMark(env, r.owner, r.key, r.claim_id, actual);
    settled++;
  }
  // Only settled receipts are dropped, so a refund that keeps failing is not lost.
  const deleted = await changed(env.DB.prepare(
    `DELETE FROM batch_receipts WHERE (owner,key) IN (SELECT owner,key FROM batch_receipts WHERE status = 'done' AND settled = 1 AND created_at < datetime('now', '${KEEP_RECEIPTS}') LIMIT 100)`
  ));
  return { abandoned, settled, deleted };
}
