import type { Env } from "../types";
import type { EncryptedValue } from "../crypto";

export interface Conversation {
  id: string;
  user_id: string;
  instance_session_id: string | null;
  instance_project: string | null;
  // Document this conversation discusses (messages.id), or null for plain
  // agent-opened threads. Set by POST /api/chat; drives the server-side
  // answerer in chat/discuss.ts.
  doc_id: string | null;
  title: string;
  status: "open" | "closed";
  last_poll_at: string | null;
  created_at: string;
  last_activity_at: string;
}

export interface ChatMessageRow {
  id: string;
  // SQLite rowid, exposed as the monotonic poll cursor (created_at only has
  // second granularity, so it can't order messages within a burst).
  seq: number;
  conversation_id: string;
  sender: "agent" | "user" | "system";
  channel: string | null;
  body: string;
  external_event_id: string | null;
  created_at: string;
}

export type ChatOriginChannel = "ios" | "web" | "gchat" | "matrix";

// Deliberately parallel to MessageDestination in destinations/types.ts.
// Inbound is NOT part of the interface — each channel's inbound arrives
// structurally differently (webhook for gchat, sync loop for a future matrix)
// and lands in chat/ingest.ts's ingestUserMessage choke point instead.
//
// `binding` is the conversation's external id on this channel (Google Chat
// thread name, or a synthetic id for flat DMs) from conversation_channels —
// null on the first delivery. deliver() returns the binding to persist; for
// gchat the real thread name is only known from the first send's response.
export interface ChatChannel<T = unknown> {
  name: "gchat" | "matrix";
  loadConfig(env: Env): Promise<T | null>;
  deliver(
    env: Env,
    conversation: Conversation,
    message: ChatMessageRow,
    config: T,
    binding: string | null
  ): Promise<ChatDeliveryResult>;
}

export interface ChatDeliveryResult {
  eventId: string;
  binding: string;
}

// Google service-account JSON key file (the fields we use).
export interface GServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

// Stored in destination_configs under the name "gchat_chat".
export interface GChatConfig {
  // GCP project NUMBER — the webhook JWT audience in "Project Number" mode.
  project_number: string;
  // Full service-account JSON key file, AES-GCM encrypted (GCHAT_ENCRYPTION_KEY).
  service_account_key: EncryptedValue;
  // The only human allowed to speak into conversations.
  owner_email: string;
  // "users/{id}" — learned from the first verified owner event. Chat
  // interaction events don't reliably carry an email claim, so after binding
  // this resource name is the enforced identity.
  owner_user_name?: string | null;
  // "spaces/{id}" — the app<->owner DM, cached on ADDED_TO_SPACE. The app
  // cannot create this itself: the owner must message the app once.
  dm_space?: string | null;
}

export interface ResolvedGChatConfig extends Omit<GChatConfig, "service_account_key"> {
  service_account_key: GServiceAccountKey;
}

// Stored in destination_configs under the name "matrix_chat".
export interface MatrixChatConfig {
  // Client-Server API base, e.g. "https://matrix-client.matrix.org".
  homeserver_url: string;
  // Long-lived bot access token, AES-GCM encrypted (MATRIX_ENCRYPTION_KEY).
  // matrix.org is OIDC-native (MSC3861/MAS): this is an opaque token minted
  // manually at setup time — never assume password /login works.
  access_token: EncryptedValue;
  bot_mxid: string; // e.g. "@pidgindocs-bot:matrix.org"
  // The only human allowed to speak into conversations, and the only user
  // whose room invites the bot accepts.
  owner_mxid: string;
  // Set by MatrixSyncDO when the sync loop dies on a fatal error (dead
  // token); cleared on the next successful sync or config re-save.
  last_error?: string | null;
}

export interface ResolvedMatrixConfig extends Omit<MatrixChatConfig, "access_token"> {
  access_token: string;
}

export type IngestResult =
  | "stored"
  | "duplicate"
  | "unknown_conversation"
  | "conversation_closed"
  | "sender_rejected";
