import type { Env } from "../types";
import { sendPushNotification } from "../push/apns";
import { findActiveUserByEmail } from "../auth-utils";
import { gchatChannel } from "./gchat";
import { matrixChannel, pingMatrixSyncDO } from "./matrix";
import { getChannelBinding, saveChannelBinding } from "./store";
import type { ChatChannel, ChatMessageRow, Conversation } from "./types";

const channels: ChatChannel[] = [gchatChannel, matrixChannel];

// Deliver a chat message to APNs and every configured external channel.
// Mirrors the messages.ts fan-out contract: per-channel failures are logged
// and never propagate — the message row is already durable in D1.
export async function fanOutChatMessage(
  env: Env,
  conversation: Conversation,
  message: ChatMessageRow,
  opts: { excludeChannel?: string; push?: boolean } = {}
): Promise<void> {
  const tasks: Promise<unknown>[] = [];

  if (opts.push !== false) {
    tasks.push(
      sendPushNotification(
        env,
        conversation.title,
        message.body.slice(0, 100),
        conversation.id,
        "chat",
        conversation.user_id
      ).catch((err) => console.error("chat push delivery failed", err))
    );
  }

  for (const channel of channels) {
    if (channel.name === opts.excludeChannel) continue;
    tasks.push(
      deliverToChannel(env, channel, conversation, message).catch((err) =>
        console.error(`[chat:${channel.name}] ${err instanceof Error ? err.message : String(err)}`)
      )
    );
  }

  await Promise.allSettled(tasks);
}

async function deliverToChannel(
  env: Env,
  channel: ChatChannel,
  conversation: Conversation,
  message: ChatMessageRow
): Promise<void> {
  // External chat channels are the deployment owner's personal transports
  // (their configs are global, not per-user). Other tenants' conversations
  // stay app/web-only rather than mirroring into the owner's Google Chat DM.
  const owner = await findActiveUserByEmail(env, env.OWNER_EMAIL);
  if (!owner || owner.id !== conversation.user_id) return;
  const config = await channel.loadConfig(env);
  if (!config) return; // not configured — skip silently, like destinations do
  const binding = await getChannelBinding(env, conversation.id, channel.name);
  const result = await channel.deliver(env, conversation, message, config, binding);
  if (result.binding && result.binding !== binding) {
    await saveChannelBinding(env, conversation.id, channel.name, result.binding);
  }
  if (channel.name === "matrix") {
    // Wake the inbound sync loop — a reply is most likely right after a send.
    await pingMatrixSyncDO(env);
  }
}
