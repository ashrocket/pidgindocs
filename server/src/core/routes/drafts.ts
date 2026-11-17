// PUT|DELETE /api/drafts/:key and POST /api/drafts/:key/commit.
import type { Env } from "../types";
import { corsHeaders } from "../utils";
import { resolveCallerUserId, unauthorized } from "../middleware";
import { allowsCredentialWrite, boundedText, BodyTooLargeError } from "../bounded-body";
import { UsageRefused } from "../edition-hooks";
import { canDraft, commitDraft, deleteDraft, DRAFT_MAX_BYTES, putDraft } from "../drafts";

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

/** The caller's id, or the response that refuses the request. */
async function writer(request: Request, env: Env): Promise<string | Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  if (!allowsCredentialWrite(request) || !await canDraft(env, userId)) return reply({ ok: false, error: "forbidden" }, 403);
  return userId;
}

export async function handlePutDraft(request: Request, env: Env, key: string): Promise<Response> {
  const userId = await writer(request, env);
  if (userId instanceof Response) return userId;
  let text: string;
  try { text = await boundedText(request, DRAFT_MAX_BYTES); }
  catch (error) {
    const tooLarge = error instanceof BodyTooLargeError;
    return reply({ ok: false, error: tooLarge ? "draft too large" : "invalid body" }, tooLarge ? 413 : 400);
  }
  let body: any;
  try { body = JSON.parse(text); } catch { return reply({ ok: false, error: "invalid JSON body" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body) || (body.kind !== "document" && body.kind !== "artifact")) {
    return reply({ ok: false, error: '"kind" must be document or artifact' }, 400);
  }
  try {
    if ((await putDraft(env, userId, key, text)) === "limit") return reply({ ok: false, error: "too many drafts" }, 409);
  } catch (error) {
    if (error instanceof UsageRefused) return reply({ ok: false, error: error.message }, error.status);
    throw error;
  }
  return reply({ ok: true, data: { key } });
}

export async function handleDeleteDraft(request: Request, env: Env, key: string): Promise<Response> {
  const userId = await writer(request, env);
  if (userId instanceof Response) return userId;
  return (await deleteDraft(env, userId, key))
    ? reply({ ok: true, data: { deleted: true } })
    : reply({ ok: false, error: "draft not found" }, 404);
}

export async function handleCommitDraft(request: Request, env: Env, key: string): Promise<Response> {
  const userId = await writer(request, env);
  if (userId instanceof Response) return userId;
  const idem = request.headers.get("Idempotency-Key")?.trim() || undefined;
  const result = await commitDraft(env, userId, key, idem);
  return reply(result.body, result.status);
}
