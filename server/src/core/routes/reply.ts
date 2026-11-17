import { editionReplyStoreStatements } from "../edition-hooks";
import { assertWorkspacePublishScope, loadTeamMessageForState, messageReadSql } from "../workspace-access";
import { Env, ReplyPayload } from "../types";
import { json } from "../utils";
import { resolveCallerCredential, unauthorized } from "../middleware";
import { scheduleDispatch } from "../events/dispatch";
import { emitEvent, eventIdFor, userRef } from "../events/emit";

export async function handlePostReply(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<Response> {
  // Resolve once: the user to scope by, and which credential sent the reply
  // (stored as replied_via; see CallerCredential in middleware.ts). Same
  // credentials as resolveCallerUserId: a session or an API key. OAuth access
  // tokens still get 401 here.
  const caller = await resolveCallerCredential(request, env);
  if (!caller) return unauthorized();
  const userId = caller.userId;

  let payload: ReplyPayload;
  try {
    payload = (await request.json()) as ReplyPayload;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  if (!payload.message_id || !payload.reply) {
    return json({ ok: false, error: "missing message_id or reply" }, 400);
  }

  const teamMessage = await loadTeamMessageForState(env, userId, payload.message_id);
  if (teamMessage === false) return json({ ok: false, error: "message not found" }, 404);
  if (teamMessage) {
    try { await assertWorkspacePublishScope(env, userId, teamMessage.team_id); }
    catch { return json({ ok: false, error: "forbidden" }, 403); }
    const row = await env.DB.prepare("SELECT type, reply, user_id, project_id FROM messages WHERE id = ?").bind(payload.message_id)
      .first<{ type: string; reply: string | null; user_id: string; project_id: string | null }>();
    if (row?.type !== "question") return json({ ok: false, error: "only questions accept agent replies; use a comment for discussion" }, 400);
    const readable = `messages.id = ? AND messages.team_id = ? AND messages.type = 'question'
      AND ${messageReadSql("messages")}
      AND EXISTS (SELECT 1 FROM team_memberships membership WHERE membership.team_id=messages.team_id
        AND membership.user_id=? AND membership.role IN ('owner','admin','member'))`;
    const readableBinds = [payload.message_id, teamMessage.team_id, userId, userId, userId];
    // question.replied comes first in the batch, under the reply's own
    // condition (no reply yet), so only the reply that lands records it.
    const replied = emitEvent(env, {
      id: await eventIdFor("question.replied", payload.message_id),
      type: "question.replied", teamId: teamMessage.team_id, actorRef: userRef(userId), subjectRef: userRef(row.user_id),
      projectId: row.project_id,
      payload: { message_id: payload.message_id, asker_user_id: row.user_id, replied_by_user_id: userId, replied_via: caller.via },
    }, { sql: `EXISTS (SELECT 1 FROM messages WHERE ${readable} AND reply IS NULL)`, binds: readableBinds });
    // replied_via is set only with the first reply; a retry finds reply set and changes nothing.
    const delivery = editionReplyStoreStatements(env,{userId,messageId:payload.message_id,guard:{sql:`${readable} AND reply IS NULL`,binds:readableBinds}});
    const results = await env.DB.batch([
      ...delivery,
      replied.statement,
      env.DB.prepare(`UPDATE messages SET reply = ?, replied_at = datetime('now'), replied_by_user_id = ?, replied_via = ?
        WHERE ${readable} AND reply IS NULL`)
        .bind(payload.reply, userId, caller.via, ...readableBinds),
      env.DB.prepare(`INSERT INTO message_user_state (message_id,user_id,read,read_at)
        SELECT messages.id,?,1,datetime('now') FROM messages WHERE ${readable}
        ON CONFLICT(message_id,user_id) DO UPDATE SET read=1,read_at=excluded.read_at`)
        .bind(userId, ...readableBinds),
    ]);
    const result=results[delivery.length+1];
    if (result.meta.changes === 0) {
      const current = await env.DB.prepare(`SELECT id FROM messages WHERE ${readable} AND reply IS NOT NULL`)
        .bind(...readableBinds).first();
      if (!current) return json({ ok: false, error: "message not found" }, 404);
    }
    await scheduleDispatch(env, ctx, [replied.id]);
    if (result.meta.changes) await env.DB.prepare("INSERT INTO audit_log (action, details, user_id) VALUES ('reply', ?, ?)")
      .bind(`Replied to team question ${payload.message_id}`, userId).run();
    return json({ ok: true, data: { message_id: payload.message_id } });
  }

  // Check existence and current reply state for idempotency. Scoped to the
  // caller: a session replying to another user's message id finds no row and
  // gets 404, never a reply written onto someone else's message.
  const existing = await env.DB.prepare(
    `SELECT id, reply FROM messages WHERE id = ? AND user_id = ? AND team_id IS NULL AND ${messageReadSql("messages")}`
  ).bind(payload.message_id, userId, userId, userId).first<{ id: string; reply: string | null }>();

  if (!existing) return json({ ok: false, error: "message not found" }, 404);

  // Already replied — idempotent success (inline reply + in-app reply can race).
  // replied_via keeps the credential of the reply that landed first.
  if (existing.reply !== null) {
    return json({ ok: true, data: { message_id: payload.message_id } });
  }

  const readable = `messages.id = ? AND messages.user_id = ? AND messages.team_id IS NULL AND ${messageReadSql("messages")}`;
  const readableBinds = [payload.message_id, userId, userId, userId];
  // A question in the caller's own inbox: a personal event, theirs only,
  // recorded under the reply's own condition like the team branch. This
  // branch also takes replies to other messages; those are not answers, so
  // they record nothing.
  const replied = emitEvent(env, {
    id: await eventIdFor("question.replied", payload.message_id),
    type: "question.replied", ownerUserId: userId, actorRef: userRef(userId), subjectRef: userRef(userId),
    payload: { message_id: payload.message_id, asker_user_id: userId, replied_by_user_id: userId, replied_via: caller.via },
  }, { sql: `EXISTS (SELECT 1 FROM messages WHERE ${readable} AND reply IS NULL AND type = 'question')`, binds: readableBinds });
  const delivery = editionReplyStoreStatements(env,{userId,messageId:payload.message_id,guard:{sql:`${readable} AND reply IS NULL`,binds:readableBinds}});
  const results = await env.DB.batch([
    ...delivery,
    replied.statement,
    env.DB.prepare(
      `UPDATE messages SET reply = ?, replied_at = datetime('now'), replied_via = ?, read = 1, read_at = datetime('now')
       WHERE ${readable} AND reply IS NULL`
    ).bind(payload.reply, caller.via, ...readableBinds),
  ]);
  const result=results[delivery.length+1];
  // A concurrent reply is idempotent; revoked access is not a successful write.
  if (result.meta.changes === 0) {
    const current = await env.DB.prepare(`SELECT id FROM messages WHERE ${readable} AND reply IS NOT NULL`)
      .bind(...readableBinds).first();
    if (!current) return json({ ok: false, error: "message not found" }, 404);
    await scheduleDispatch(env, ctx, [replied.id]);
    return json({ ok: true, data: { message_id: payload.message_id } });
  }
  await scheduleDispatch(env, ctx, [replied.id]);

  await env.DB.prepare(
    `INSERT INTO audit_log (action, details, user_id)
     VALUES (?, ?, ?)`
  )
    .bind("reply", `Replied to message ${payload.message_id}`, userId)
    .run();

  return json({ ok: true, data: { message_id: payload.message_id } });
}
