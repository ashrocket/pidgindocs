// PidginCore: PUT|DELETE /api/drafts/:key and POST /api/drafts/:key/commit.
import type { Env } from "../types";
import { corsHeaders } from "../utils";
import { resolveCallerUserId, unauthorized } from "../middleware";
import { commitDraft, deleteDraft, DRAFT_MAX_BYTES, putDraft } from "../drafts";
import { UNITS_HEADER } from "../meter";

function reply(body: unknown, status = 200, units?: string): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...corsHeaders() };
  if (units) headers[UNITS_HEADER] = units;
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

export async function handlePutDraft(request: Request, env: Env, key: string): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > DRAFT_MAX_BYTES) {
    return reply({ ok: false, error: "draft too large", limits: { max_bytes: DRAFT_MAX_BYTES } }, 413);
  }
  let body: any;
  try { body = JSON.parse(text); } catch { return reply({ ok: false, error: "invalid JSON body" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body) || (body.kind !== "document" && body.kind !== "artifact")) {
    return reply({ ok: false, error: '"kind" must be document or artifact' }, 400);
  }
  if ((await putDraft(env, userId, key, text)) === "limit") {
    return reply({ ok: false, error: "too many drafts" }, 409);
  }
  return reply({ ok: true, data: { key } }, 200, "draft_put=1");
}

export async function handleDeleteDraft(request: Request, env: Env, key: string): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  return (await deleteDraft(env, userId, key))
    ? reply({ ok: true, data: { deleted: true } })
    : reply({ ok: false, error: "draft not found" }, 404);
}

export async function handleCommitDraft(
  request: Request, env: Env, key: string, ctx?: ExecutionContext
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  const idem = request.headers.get("Idempotency-Key")?.trim();
  if (!idem) {
    const r = await commitDraft(env, userId, key, ctx);
    return reply(r.body, r.status, r.status === 200 ? "draft_commit=1" : undefined);
  }

  // Claim first, in F's receipt table, so two commits with one key run once.
  const receiptKey = `draft-commit:${key}:${idem}`;
  const claimId = crypto.randomUUID();
  const claim = await env.DB.prepare(
    `INSERT INTO batch_receipts (owner, key, claim_id, status, created_at)
     VALUES (?, ?, ?, 'pending', datetime('now')) ON CONFLICT DO NOTHING`
  ).bind(userId, receiptKey, claimId).run();
  if ((claim.meta?.changes ?? 0) === 0) {
    const row = await env.DB.prepare(
      "SELECT status, http_status, body FROM batch_receipts WHERE owner = ? AND key = ?"
    ).bind(userId, receiptKey).first<{ status: string; http_status: number | null; body: string | null }>();
    if (row?.status === "done") return reply(row.body ?? "{}", row.http_status ?? 200, "none");
    return reply({ ok: false, error: row?.status === "abandoned" ? "commit_abandoned" : "commit_in_progress" }, 409);
  }
  const release = () => env.DB.prepare(
    "DELETE FROM batch_receipts WHERE owner = ? AND key = ? AND claim_id = ? AND status = 'pending'"
  ).bind(userId, receiptKey, claimId).run();
  try {
    const r = await commitDraft(env, userId, key, ctx);
    if (r.status !== 200) {
      await release(); // a retry with the same key may run again
      return reply(r.body, r.status);
    }
    const body = JSON.stringify(r.body);
    const done = await env.DB.prepare(
      `UPDATE batch_receipts SET status = 'done', settled = 1, http_status = 200, body = ?
       WHERE owner = ? AND key = ? AND claim_id = ? AND status = 'pending'`
    ).bind(body, userId, receiptKey, claimId).run();
    if ((done.meta?.changes ?? 0) === 0) return reply({ ok: false, error: "commit_abandoned" }, 409);
    return reply(body, 200, "draft_commit=1");
  } catch (err) {
    await release().catch(() => {});
    throw err;
  }
}
