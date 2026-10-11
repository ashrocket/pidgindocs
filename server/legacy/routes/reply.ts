import { Env, ReplyPayload } from "../types";
import { json } from "../utils";
import { resolveCallerUserId, unauthorized } from "../middleware";

export async function handlePostReply(
  request: Request,
  env: Env
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  let payload: ReplyPayload;
  try {
    payload = (await request.json()) as ReplyPayload;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  if (!payload.message_id || !payload.reply) {
    return json({ ok: false, error: "missing message_id or reply" }, 400);
  }

  // Check existence and current reply state for idempotency. Scoped to the
  // caller: a session replying to another user's message id finds no row and
  // gets 404, never a reply written onto someone else's message.
  const existing = await env.DB.prepare(
    "SELECT id, reply FROM messages WHERE id = ? AND user_id = ?"
  ).bind(payload.message_id, userId).first<{ id: string; reply: string | null }>();

  if (!existing) return json({ ok: false, error: "message not found" }, 404);

  // Already replied — idempotent success (inline reply + in-app reply can race)
  if (existing.reply !== null) {
    return json({ ok: true, data: { message_id: payload.message_id } });
  }

  const result = await env.DB.prepare(
    `UPDATE messages SET reply = ?, replied_at = datetime('now'), read = 1, read_at = datetime('now')
     WHERE id = ? AND reply IS NULL AND user_id = ?`
  )
    .bind(payload.reply, payload.message_id, userId)
    .run();

  // Race: another reply landed between check and update — still success
  if (result.meta.changes === 0) {
    return json({ ok: true, data: { message_id: payload.message_id } });
  }

  await env.DB.prepare(
    `INSERT INTO audit_log (action, details, user_id)
     VALUES (?, ?, ?)`
  )
    .bind("reply", `Replied to message ${payload.message_id}`, userId)
    .run();

  return json({ ok: true, data: { message_id: payload.message_id } });
}
