import { TenantWriteRefused, assertTenantWritable } from "../edition-hooks";
import type { Env } from "../types";
import { deferOrAwait } from "../utils";
import type { ChatMessageRow, ChatOriginChannel, Conversation, IngestResult } from "./types";
import {
  findConversationByExternalId,
  getChatMessageByExternalEvent,
  getConversation,
  insertChatMessage,
  touchConversation,
} from "./store";
import { fanOutChatMessage } from "./fanout";

export interface IngestArgs {
  channel: ChatOriginChannel;
  // Exactly one of these locates the conversation: the app/web path knows the
  // conversation id; external channels only know their transport-level id.
  conversationId?: string;
  externalConversationId?: string;
  // Dedupe key for webhook redelivery (Google Chat message name, etc.).
  externalEventId?: string | null;
  // Transport-verified sender identity (session email, "users/{id}", MXID).
  // Authenticity and allowlisting are the CALLER's job — by the time a
  // message reaches ingest it is trusted; this is recorded for audit only.
  senderIdentity: string;
  body: string;
}

export interface IngestOutcome {
  result: IngestResult;
  conversation?: Conversation;
  message?: ChatMessageRow;
}

// Single choke point for ALL inbound user messages, whatever the channel:
// conversation lookup, race-safe dedupe, audit, and echo to the other
// channels so the conversation reads the same everywhere.
export async function ingestUserMessage(
  env: Env,
  args: IngestArgs,
  ctx?: ExecutionContext
): Promise<IngestOutcome> {
  let conversation: Conversation | null = null;
  if (args.conversationId) {
    conversation = await getConversation(env, args.conversationId);
  } else if (args.externalConversationId) {
    conversation = await findConversationByExternalId(
      env,
      args.channel,
      args.externalConversationId
    );
  }
  if (!conversation) return { result: "unknown_conversation" };
  if (conversation.status !== "open") return { result: "conversation_closed", conversation };

  await assertTenantWritable(env);
  const { inserted, message } = await insertChatMessage(env, {
    conversationId: conversation.id,
    sender: "user",
    channel: args.channel,
    body: args.body,
    externalEventId: args.externalEventId ?? null,
  });
  const echoMessage = async (stored: ChatMessageRow) => {
    const echo = fanOutChatMessage(env, conversation!, stored, {
      excludeChannel: args.channel,
      push: false,
    }).catch((err) => {
      // Keep the stored message, but let a synchronous relay preserve its cursor
      // instead of treating an entitlement-blocked echo as completed work.
      if (err instanceof TenantWriteRefused) throw err;
      console.error("chat echo fan-out failed", err);
    });
    await deferOrAwait(ctx, echo);
  };
  if (!inserted || !message) {
    // Matrix replays an event when a post-insert entitlement check denied its
    // echo. A deduped replay must try that echo again before advancing sync.
    // Echo delivery is at least once if a prior attempt reached another channel.
    if (args.channel === "matrix" && args.externalEventId) {
      const previous = await getChatMessageByExternalEvent(env, args.channel, args.externalEventId);
      if (previous?.conversation_id === conversation.id) await echoMessage(previous);
    }
    return { result: "duplicate", conversation };
  }

  await touchConversation(env, conversation.id);
  await env.DB.prepare(
    "INSERT INTO audit_log (action, instance_id, details, user_id) VALUES (?, ?, ?, ?)"
  )
    .bind(
      "chat_ingest",
      conversation.instance_session_id,
      `${args.senderIdentity} replied via ${args.channel} in "${conversation.title}"`,
      conversation.user_id
    )
    .run();

  // Echo to the other channels (never back to the origin, never as a push —
  // it's the user's own message). Best-effort: the reply is already durable.
  await echoMessage(message);

  return { result: "stored", conversation, message };
}
