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
  const idem = request.headers.get("Idempotency-Key")?.trim() || undefined;
  const r = await commitDraft(env, userId, key, ctx, idem);
  return reply(r.body, r.status, r.units);
}
