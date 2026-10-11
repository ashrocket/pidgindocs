import type { Env } from "../types";
import type { ChatMessageRow, Conversation } from "./types";

const CONVERSATION_COLUMNS =
  "id, user_id, instance_session_id, instance_project, doc_id, title, status, last_poll_at, created_at, last_activity_at";

// The same columns qualified for JOIN queries aliasing conversations as `c`.
const PREFIXED_CONVERSATION_COLUMNS = CONVERSATION_COLUMNS.split(", ")
  .map((c) => `c.${c}`)
  .join(", ");

const MESSAGE_COLUMNS =
  "id, rowid AS seq, conversation_id, sender, channel, body, external_event_id, created_at";

export async function createConversation(
  env: Env,
  args: {
    userId: string;
    title: string;
    instanceSessionId?: string | null;
    instanceProject?: string | null;
    docId?: string | null;
  }
): Promise<Conversation> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO conversations (id, user_id, instance_session_id, instance_project, doc_id, title)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      args.userId,
      args.instanceSessionId ?? null,
      args.instanceProject ?? null,
      args.docId ?? null,
      args.title
    )
    .run();
  const row = await env.DB.prepare(
    `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = ?`
  )
    .bind(id)
    .first<Conversation>();
  if (!row) throw new Error("failed to create conversation");
  return row;
}

export async function getConversation(
  env: Env,
  id: string,
  userId?: string
): Promise<Conversation | null> {
  if (userId !== undefined) {
    return await env.DB.prepare(
      `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = ? AND user_id = ?`
    )
      .bind(id, userId)
      .first<Conversation>();
  }
  return await env.DB.prepare(
    `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = ?`
  )
    .bind(id)
    .first<Conversation>();
}

export async function listConversations(
  env: Env,
  userId: string,
  opts: { status?: "open" | "closed"; limit?: number } = {}
): Promise<Conversation[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const result = opts.status
    ? await env.DB.prepare(
        `SELECT ${CONVERSATION_COLUMNS} FROM conversations
         WHERE user_id = ? AND status = ?
         ORDER BY last_activity_at DESC LIMIT ?`
      )
        .bind(userId, opts.status, limit)
        .all<Conversation>()
    : await env.DB.prepare(
        `SELECT ${CONVERSATION_COLUMNS} FROM conversations
         WHERE user_id = ?
         ORDER BY last_activity_at DESC LIMIT ?`
      )
        .bind(userId, limit)
        .all<Conversation>();
  return result.results ?? [];
}

// "Discuss" is create-or-reuse: one open thread per (user, document), so
// reopening the pane continues the conversation instead of forking it.
export async function findOpenDocConversation(
  env: Env,
  userId: string,
  docId: string
): Promise<Conversation | null> {
  return await env.DB.prepare(
    `SELECT ${CONVERSATION_COLUMNS} FROM conversations
     WHERE user_id = ? AND doc_id = ? AND status = 'open'
     ORDER BY last_activity_at DESC LIMIT 1`
  )
    .bind(userId, docId)
    .first<Conversation>();
}

// Doc discussions awaiting a human-context answer in a given project: open,
// doc-linked, and whose newest message came from the user (nobody has answered
// yet). Drives the Stop-hook sweep — a session about to go idle answers the
// questions about documents it published, while it still has that context.
export async function listAwaitingDocQuestions(
  env: Env,
  userId: string,
  opts: { project?: string | null; limit?: number } = {}
): Promise<Array<Conversation & { question: string }>> {
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 20);
  const projectFilter = opts.project ? " AND c.instance_project = ?" : "";
  const binds: unknown[] = [userId];
  if (opts.project) binds.push(opts.project);
  binds.push(limit);

  const result = await env.DB.prepare(
    `SELECT ${PREFIXED_CONVERSATION_COLUMNS}, last.body AS question
     FROM conversations c
     JOIN chat_messages last ON last.rowid = (
       SELECT MAX(rowid) FROM chat_messages WHERE conversation_id = c.id
     )
     WHERE c.user_id = ? AND c.doc_id IS NOT NULL AND c.status = 'open'
       AND last.sender = 'user'${projectFilter}
     ORDER BY c.last_activity_at DESC
     LIMIT ?`
  )
    .bind(...binds)
    .all<Conversation & { question: string }>();
  return result.results ?? [];
}

export async function closeConversation(
  env: Env,
  id: string,
  userId: string
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE conversations SET status = 'closed', last_activity_at = datetime('now'),
       expires_at = datetime('now', '+30 days')
     WHERE id = ? AND user_id = ? AND status = 'open'`
  )
    .bind(id, userId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function touchConversation(env: Env, id: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE conversations SET last_activity_at = datetime('now') WHERE id = ?"
  )
    .bind(id)
    .run();
}

export async function stampConversationPoll(env: Env, id: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE conversations SET last_poll_at = datetime('now') WHERE id = ?"
  )
    .bind(id)
    .run();
}

// INSERT OR IGNORE + the partial unique index on (channel, external_event_id)
// make this race-safe against duplicate webhook deliveries: the second insert
// is a no-op and reports inserted: false.
export async function insertChatMessage(
  env: Env,
  args: {
    conversationId: string;
    sender: "agent" | "user" | "system";
    channel: string | null;
    body: string;
    externalEventId?: string | null;
  }
): Promise<{ inserted: boolean; message: ChatMessageRow | null }> {
  const id = crypto.randomUUID();
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO chat_messages (id, conversation_id, sender, channel, body, external_event_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      args.conversationId,
      args.sender,
      args.channel,
      args.body,
      args.externalEventId ?? null
    )
    .run();
  if ((result.meta?.changes ?? 0) === 0) {
    return { inserted: false, message: null };
  }
  const message = await env.DB.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE id = ?`
  )
    .bind(id)
    .first<ChatMessageRow>();
  return { inserted: true, message };
}

export async function listMessagesAfter(
  env: Env,
  conversationId: string,
  afterSeq: number,
  opts: { senders?: Array<"agent" | "user" | "system">; limit?: number } = {}
): Promise<ChatMessageRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const senders = opts.senders;
  const senderFilter =
    senders && senders.length > 0
      ? ` AND sender IN (${senders.map(() => "?").join(", ")})`
      : "";
  const binds: unknown[] = [conversationId, afterSeq];
  if (senders && senders.length > 0) binds.push(...senders);
  binds.push(limit);
  const result = await env.DB.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM chat_messages
     WHERE conversation_id = ? AND rowid > ?${senderFilter}
     ORDER BY rowid ASC LIMIT ?`
  )
    .bind(...binds)
    .all<ChatMessageRow>();
  return result.results ?? [];
}

export async function getChannelBinding(
  env: Env,
  conversationId: string,
  channel: string
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT external_id FROM conversation_channels WHERE conversation_id = ? AND channel = ?"
  )
    .bind(conversationId, channel)
    .first<{ external_id: string }>();
  return row?.external_id ?? null;
}

export async function saveChannelBinding(
  env: Env,
  conversationId: string,
  channel: string,
  externalId: string
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO conversation_channels (conversation_id, channel, external_id)
     VALUES (?, ?, ?)
     ON CONFLICT(conversation_id, channel) DO UPDATE SET external_id = excluded.external_id`
  )
    .bind(conversationId, channel, externalId)
    .run();
}

export async function findConversationByExternalId(
  env: Env,
  channel: string,
  externalId: string
): Promise<Conversation | null> {
  return await env.DB.prepare(
    `SELECT ${PREFIXED_CONVERSATION_COLUMNS}
     FROM conversations c
     JOIN conversation_channels cc ON cc.conversation_id = c.id
     WHERE cc.channel = ? AND cc.external_id = ?`
  )
    .bind(channel, externalId)
    .first<Conversation>();
}

// Fallback for flat (unthreaded) Google Chat DMs: an inbound message that
// carries no usable thread reference goes to the most recently active open
// conversation bound anywhere in that space. Both real thread names
// ("spaces/X/threads/Y") and synthetic flat-DM bindings ("spaces/X#<conv>")
// start with the space name.
export async function findLatestOpenConversationInSpace(
  env: Env,
  channel: string,
  spaceName: string
): Promise<Conversation | null> {
  return await env.DB.prepare(
    `SELECT ${PREFIXED_CONVERSATION_COLUMNS}
     FROM conversations c
     JOIN conversation_channels cc ON cc.conversation_id = c.id
     WHERE cc.channel = ? AND c.status = 'open'
       AND (cc.external_id = ? OR cc.external_id LIKE ? || '/%' OR cc.external_id LIKE ? || '#%')
     ORDER BY c.last_activity_at DESC LIMIT 1`
  )
    .bind(channel, spaceName, spaceName, spaceName)
    .first<Conversation>();
}
