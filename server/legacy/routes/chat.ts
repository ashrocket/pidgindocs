import type { Env } from "../types";
import { deferOrAwait, json } from "../utils";
import {
  resolveCallerUserId,
  resolveSessionUserId,
  unauthorized,
} from "../middleware";
import { encryptValue } from "../crypto";
import {
  deleteDestinationConfig,
  getDestinationConfigValue,
  saveDestinationConfig,
} from "../destinations/store";
import {
  GCHAT_CONFIG_NAME,
  gchatSyncReply,
  loadGChatConfig,
  normalizeGChatEvent,
  patchGChatConfig,
  verifyGChatBearer,
} from "../chat/gchat";
import { MATRIX_CONFIG_NAME, pingMatrixSyncDO } from "../chat/matrix";
import { ingestUserMessage } from "../chat/ingest";
import {
  closeConversation,
  createConversation,
  findConversationByExternalId,
  findLatestOpenConversationInSpace,
  findOpenDocConversation,
  getConversation,
  listAwaitingDocQuestions,
  insertChatMessage,
  listConversations,
  listMessagesAfter,
  touchConversation,
} from "../chat/store";
import { fanOutChatMessage } from "../chat/fanout";
import { answerDocQuestion } from "../chat/discuss";
import { getDocumentRecord } from "../documents";
import { findActiveUserByEmail } from "../auth-utils";
import type { Conversation, GChatConfig, MatrixChatConfig } from "../chat/types";

function ack(body: Record<string, unknown> = {}): Response {
  return Response.json(body, { status: 200 });
}

async function audit(env: Env, action: string, details: string, userId?: string | null) {
  await env.DB.prepare(
    "INSERT INTO audit_log (action, details, user_id) VALUES (?, ?, ?)"
  )
    .bind(action, details, userId ?? null)
    .run()
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// POST /api/chat/gchat/events — Google Chat interaction-event webhook.
// Every request is cryptographically verified against Google's keys before
// the payload is trusted; unverified requests get a 401 per Google's docs.
export async function handleGChatEvents(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<Response> {
  const config = await loadGChatConfig(env);
  // Unconfigured answers 401 like a failed bearer check — a distinct 404
  // would let unauthenticated callers probe whether the channel exists.
  if (!config) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  if (!(await verifyGChatBearer(request.headers, env, config))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const event = normalizeGChatEvent(body);

  if (event.kind === "ADDED_TO_SPACE") {
    if (event.space?.spaceType === "DIRECT_MESSAGE") {
      // dm_space is the outbound delivery target for every conversation, so a
      // non-owner must never re-point an established binding: without this
      // gate, any Workspace user the app is visible to could add it to their
      // own DM and hijack all relayed traffic. First-time binding stays open
      // (events don't always carry an email and no dm_space exists yet).
      const isOwner =
        event.user?.email?.toLowerCase() === config.owner_email.toLowerCase() ||
        (config.owner_user_name != null && event.user?.name === config.owner_user_name);
      if (!isOwner && config.dm_space && config.dm_space !== event.space.name) {
        await audit(
          env,
          "chat_gchat_rejected",
          `ignored ADDED_TO_SPACE from ${event.user?.name ?? "unknown"} in ${event.space.name}`
        );
        return ack(gchatSyncReply(event, "PidginDocs is already connected to its owner."));
      }
      const patch: Parameters<typeof patchGChatConfig>[1] = { dm_space: event.space.name };
      if (
        !config.owner_user_name &&
        event.user?.name &&
        event.user.email?.toLowerCase() === config.owner_email.toLowerCase()
      ) {
        patch.owner_user_name = event.user.name;
      }
      await patchGChatConfig(env, patch);
      await audit(env, "chat_gchat_added", `PidginDocs added to DM ${event.space.name}`);
      return ack(gchatSyncReply(
          event,
          "PidginDocs connected. Claude conversations will appear here; just reply in the thread."
        )
      );
    }
    // Group spaces are out of scope by design — this is a personal relay.
    return ack(gchatSyncReply(event, "PidginDocs only works in a direct message."));
  }

  if (event.kind === "REMOVED_FROM_SPACE") {
    if (event.space?.name && event.space.name === config.dm_space) {
      await patchGChatConfig(env, { dm_space: null });
      await audit(env, "chat_gchat_removed", `PidginDocs removed from ${event.space.name}`);
    }
    return ack();
  }

  if (event.kind !== "MESSAGE" || !event.message || !event.space) {
    return ack();
  }

  // Loop prevention: never ingest app/bot-authored messages.
  if (event.user?.type === "BOT") return ack();

  // Single-sender allowlist. Chat events don't reliably carry an email, so
  // the durable identity is the "users/{id}" resource name, bound on the
  // first event we can attribute to the owner (email match, or first contact
  // in the DM — the app's Workspace visibility is restricted to the owner).
  const senderName = event.user?.name ?? "";
  const senderEmail = event.user?.email?.toLowerCase() ?? null;
  let authorized = false;
  let bindOwner = false;
  if (config.owner_user_name) {
    authorized = senderName !== "" && senderName === config.owner_user_name;
  } else if (senderEmail) {
    authorized = senderEmail === config.owner_email.toLowerCase();
    bindOwner = authorized;
  } else if (config.dm_space && event.space.name === config.dm_space) {
    authorized = senderName !== "";
    bindOwner = authorized;
  }
  if (!authorized) {
    await audit(
      env,
      "chat_gchat_rejected",
      `dropped message from ${senderName || "unknown"} (${senderEmail ?? "no email"}) in ${event.space.name}`
    );
    // 200, not 4xx: don't invite retries, don't leak allowlist behavior.
    return ack();
  }

  const patch: Parameters<typeof patchGChatConfig>[1] = {};
  if (bindOwner && senderName) patch.owner_user_name = senderName;
  if (!config.dm_space && event.space.spaceType === "DIRECT_MESSAGE") {
    patch.dm_space = event.space.name;
  }
  if (Object.keys(patch).length > 0) await patchGChatConfig(env, patch);

  if (!event.message.text) return ack();

  // The Google Chat channel belongs to the deployment owner (its config is
  // global, not per-user) — inbound replies may only land in the owner's
  // conversations, never another tenant's (e.g. via a threadKey that happens
  // to name someone else's conversation id).
  const ownerUser = await findActiveUserByEmail(env, env.OWNER_EMAIL);
  if (!ownerUser) return ack();

  // Locate the conversation: our own threadKey (= conversation id) when Chat
  // echoes it back, else the bound thread name, else the newest open
  // conversation in this space (flat DMs have no usable thread reference).
  let conversation: Conversation | null = null;
  if (event.message.threadKey) {
    conversation = await getConversation(env, event.message.threadKey, ownerUser.id);
  }
  if (!conversation && event.message.threadName) {
    conversation = await findConversationByExternalId(env, "gchat", event.message.threadName);
  }
  if (!conversation) {
    conversation = await findLatestOpenConversationInSpace(env, "gchat", event.space.name);
  }
  if (conversation && conversation.user_id !== ownerUser.id) {
    conversation = null;
  }
  if (!conversation) {
    return ack(
      gchatSyncReply(event, "No Claude conversation is open right now — this message wasn't relayed.")
    );
  }

  const outcome = await ingestUserMessage(
    env,
    {
      channel: "gchat",
      conversationId: conversation.id,
      externalEventId: event.message.name,
      senderIdentity: senderEmail ?? senderName,
      body: event.message.text,
    },
    ctx
  );

  if (outcome.result === "conversation_closed") {
    return ack(
      gchatSyncReply(event, `"${conversation.title}" is closed — this message wasn't relayed.`)
    );
  }
  return ack();
}

// ---------------------------------------------------------------------------
// /api/chat/gchat/config — session-only (a leaked agent API key must not be
// able to read or rewire the owner's Google Chat wiring).

export async function handleGChatConfig(request: Request, env: Env): Promise<Response> {
  const userId = await resolveSessionUserId(request, env);
  if (!userId) return unauthorized();
  // Owner-only: the gchat config is a single global row and the DM it points
  // at receives every relayed conversation — an invited (non-owner) tenant
  // must not be able to read, rewire, or delete it.
  const owner = await findActiveUserByEmail(env, env.OWNER_EMAIL);
  if (!owner || owner.id !== userId) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  if (request.method === "GET") {
    const config = await getDestinationConfigValue<GChatConfig>(env, GCHAT_CONFIG_NAME);
    return json({
      ok: true,
      data: {
        configured: Boolean(config),
        project_number: config?.project_number,
        owner_email: config?.owner_email,
        dm_space_bound: Boolean(config?.dm_space),
        owner_bound: Boolean(config?.owner_user_name),
        webhook_url: `${env.WORKER_URL.replace(/\/$/, "")}/api/chat/gchat/events`,
      },
    });
  }

  if (request.method === "DELETE") {
    await deleteDestinationConfig(env, GCHAT_CONFIG_NAME);
    await audit(env, "chat_gchat_config", "gchat config deleted", userId);
    return json({ ok: true, data: { configured: false } });
  }

  interface ConfigPayload {
    project_number?: string;
    service_account_key?: string;
    owner_email?: string;
  }
  let payload: ConfigPayload;
  try {
    payload = (await request.json()) as ConfigPayload;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const projectNumber = payload.project_number?.trim();
  const serviceAccountKey = payload.service_account_key?.trim();
  const ownerEmail = payload.owner_email?.trim().toLowerCase();
  if (!projectNumber || !serviceAccountKey || !ownerEmail) {
    return json(
      { ok: false, error: "project_number, service_account_key, and owner_email are required" },
      400
    );
  }
  if (!env.GCHAT_ENCRYPTION_KEY) {
    return json({ ok: false, error: "GCHAT_ENCRYPTION_KEY is not configured" }, 400);
  }
  let parsedKey: { client_email?: string; private_key?: string };
  try {
    parsedKey = JSON.parse(serviceAccountKey) as typeof parsedKey;
  } catch {
    return json({ ok: false, error: "service_account_key must be the JSON key file contents" }, 400);
  }
  if (!parsedKey.client_email || !parsedKey.private_key) {
    return json(
      { ok: false, error: "service_account_key is missing client_email/private_key" },
      400
    );
  }

  const existing = await getDestinationConfigValue<GChatConfig>(env, GCHAT_CONFIG_NAME);
  const config: GChatConfig = {
    project_number: projectNumber,
    service_account_key: await encryptValue(
      serviceAccountKey,
      env.GCHAT_ENCRYPTION_KEY,
      "GCHAT_ENCRYPTION_KEY"
    ),
    owner_email: ownerEmail,
    // The DM space belongs to the app, so it survives re-configuration; the
    // owner binding only survives if the owner hasn't changed.
    dm_space: existing?.dm_space ?? null,
    owner_user_name:
      existing && existing.owner_email.toLowerCase() === ownerEmail
        ? existing.owner_user_name ?? null
        : null,
  };
  await saveDestinationConfig(env, GCHAT_CONFIG_NAME, config);
  await audit(env, "chat_gchat_config", `gchat config saved (project ${projectNumber})`, userId);
  return json({
    ok: true,
    data: {
      configured: true,
      dm_space_bound: Boolean(config.dm_space),
      webhook_url: `${env.WORKER_URL.replace(/\/$/, "")}/api/chat/gchat/events`,
    },
  });
}

// ---------------------------------------------------------------------------
// /api/chat/matrix/config — session-only + owner-only, same posture as gchat:
// the matrix config is a single global row and the bot token it holds can
// read every relayed conversation.

export async function handleMatrixConfig(request: Request, env: Env): Promise<Response> {
  const userId = await resolveSessionUserId(request, env);
  if (!userId) return unauthorized();
  const owner = await findActiveUserByEmail(env, env.OWNER_EMAIL);
  if (!owner || owner.id !== userId) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  if (request.method === "GET") {
    const config = await getDestinationConfigValue<MatrixChatConfig>(env, MATRIX_CONFIG_NAME);
    return json({
      ok: true,
      data: {
        configured: Boolean(config),
        homeserver_url: config?.homeserver_url,
        bot_mxid: config?.bot_mxid,
        owner_mxid: config?.owner_mxid,
        last_error: config?.last_error ?? null,
      },
    });
  }

  if (request.method === "DELETE") {
    await deleteDestinationConfig(env, MATRIX_CONFIG_NAME);
    await audit(env, "chat_matrix_config", "matrix config deleted", userId);
    // The sync DO goes idle on its next alarm: config loads null, no re-alarm.
    return json({ ok: true, data: { configured: false } });
  }

  interface ConfigPayload {
    homeserver_url?: string;
    access_token?: string;
    bot_mxid?: string;
    owner_mxid?: string;
  }
  let payload: ConfigPayload;
  try {
    payload = (await request.json()) as ConfigPayload;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const homeserverUrl = payload.homeserver_url?.trim().replace(/\/$/, "");
  const accessToken = payload.access_token?.trim();
  const botMxid = payload.bot_mxid?.trim();
  const ownerMxid = payload.owner_mxid?.trim();
  if (!homeserverUrl || !accessToken || !botMxid || !ownerMxid) {
    return json(
      {
        ok: false,
        error: "homeserver_url, access_token, bot_mxid, and owner_mxid are required",
      },
      400
    );
  }
  let homeserver: URL;
  try {
    homeserver = new URL(homeserverUrl);
  } catch {
    return json({ ok: false, error: "homeserver_url must be a valid URL" }, 400);
  }
  if (homeserver.protocol !== "https:") {
    return json({ ok: false, error: "homeserver_url must be https" }, 400);
  }
  const mxidPattern = /^@[^:@\s]+:\S+$/;
  if (!mxidPattern.test(botMxid) || !mxidPattern.test(ownerMxid)) {
    return json({ ok: false, error: "bot_mxid and owner_mxid must look like @user:server" }, 400);
  }
  if (botMxid === ownerMxid) {
    // The loop-prevention rule (ignore own MXID) would silently eat every
    // owner message if the bot logged in as the owner.
    return json({ ok: false, error: "bot_mxid must be a dedicated bot account, not owner_mxid" }, 400);
  }
  if (!env.MATRIX_ENCRYPTION_KEY) {
    return json({ ok: false, error: "MATRIX_ENCRYPTION_KEY is not configured" }, 400);
  }

  const config: MatrixChatConfig = {
    homeserver_url: homeserverUrl,
    access_token: await encryptValue(accessToken, env.MATRIX_ENCRYPTION_KEY, "MATRIX_ENCRYPTION_KEY"),
    bot_mxid: botMxid,
    owner_mxid: ownerMxid,
    last_error: null,
  };
  await saveDestinationConfig(env, MATRIX_CONFIG_NAME, config);
  await audit(env, "chat_matrix_config", `matrix config saved (${botMxid} on ${homeserver.host})`, userId);
  // Start (or restart) the inbound sync loop with the fresh token.
  await pingMatrixSyncDO(env);
  return json({
    ok: true,
    data: { configured: true, bot_mxid: botMxid, owner_mxid: ownerMxid },
  });
}

// ---------------------------------------------------------------------------
// Conversation surface for iOS/web (and agents over plain HTTP).

// POST /api/chat — the user opens (or continues) a discussion about a
// document from the app. Session-only: this speaks as the human, and the
// server-side answerer spends ANTHROPIC_API_KEY budget.
export async function handleCreateConversation(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<Response> {
  const userId = await resolveSessionUserId(request, env);
  if (!userId) return unauthorized();

  let payload: { doc_id?: string; body?: string };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const docId = payload.doc_id?.trim();
  const body = payload.body?.trim();
  if (!docId) return json({ ok: false, error: "doc_id is required" }, 400);
  if (!body) return json({ ok: false, error: "body is required" }, 400);

  const doc = await getDocumentRecord(env, docId, userId);
  if (!doc) return json({ ok: false, error: "document not found" }, 404);

  let conversation = await findOpenDocConversation(env, userId, doc.id);
  const created = !conversation;
  if (!conversation) {
    conversation = await createConversation(env, {
      userId,
      title: `Discuss: ${doc.title}`,
      instanceProject: doc.instance_project,
      docId: doc.id,
    });
    await audit(env, "chat_discuss_open", `opened discussion on "${doc.title}"`, userId);
  }

  const outcome = await ingestUserMessage(
    env,
    { channel: "ios", conversationId: conversation.id, senderIdentity: userId, body },
    ctx
  );
  if (outcome.result !== "stored" || !outcome.message) {
    return json({ ok: false, error: outcome.result }, 500);
  }

  const answer = answerDocQuestion(env, conversation, ctx);
  await deferOrAwait(ctx, answer);

  return json(
    { ok: true, data: { conversation, message: outcome.message } },
    created ? 201 : 200
  );
}

export async function handleListConversations(request: Request, env: Env): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  const status = statusParam === "open" || statusParam === "closed" ? statusParam : undefined;
  // ?awaiting=1 — open doc discussions whose last word was the user's, i.e.
  // questions no one has answered. The Stop hook uses this (with &project=)
  // so a session answers its own documents' questions before going idle.
  if (url.searchParams.get("awaiting") === "1") {
    const conversations = await listAwaitingDocQuestions(env, userId, {
      project: url.searchParams.get("project"),
    });
    return json({ ok: true, data: { conversations } });
  }

  const docId = url.searchParams.get("doc_id");
  let conversations = await listConversations(env, userId, { status });
  // The Discuss pane restores its thread with ?doc_id= — filtered here rather
  // than in SQL because a user has at most ~50 recent conversations anyway.
  if (docId) {
    conversations = conversations.filter((c) => c.doc_id === docId);
  }
  return json({ ok: true, data: { conversations } });
}

export async function handleGetConversationMessages(
  request: Request,
  env: Env,
  conversationId: string
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  const conversation = await getConversation(env, conversationId, userId);
  if (!conversation) return json({ ok: false, error: "conversation not found" }, 404);
  const url = new URL(request.url);
  const afterParam = Number(url.searchParams.get("after") ?? "0");
  const after = Number.isFinite(afterParam) ? afterParam : 0;
  const messages = await listMessagesAfter(env, conversation.id, after);
  const cursor = messages.length > 0 ? messages[messages.length - 1].seq : after;
  return json({ ok: true, data: { conversation, messages, cursor } });
}

// Human reply path — session-only so agent API keys can't speak as the user.
export async function handlePostConversationMessage(
  request: Request,
  env: Env,
  conversationId: string,
  ctx?: ExecutionContext
): Promise<Response> {
  const userId = await resolveSessionUserId(request, env);
  if (!userId) return unauthorized();
  const conversation = await getConversation(env, conversationId, userId);
  if (!conversation) return json({ ok: false, error: "conversation not found" }, 404);

  let payload: { body?: string; channel?: string };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const body = payload.body?.trim();
  if (!body) return json({ ok: false, error: "body is required" }, 400);
  const channel = payload.channel === "web" ? "web" : "ios";

  const outcome = await ingestUserMessage(
    env,
    { channel, conversationId: conversation.id, senderIdentity: userId, body },
    ctx
  );
  if (outcome.result === "conversation_closed") {
    return json({ ok: false, error: "conversation is closed" }, 409);
  }
  if (outcome.result !== "stored" || !outcome.message) {
    return json({ ok: false, error: outcome.result }, 500);
  }

  // Doc-linked threads get a server-side answer; plain agent threads are
  // answered by the agent over pidgin_chat_poll as before.
  if (conversation.doc_id) {
    const answer = answerDocQuestion(env, conversation, ctx);
    await deferOrAwait(ctx, answer);
  }

  return json({ ok: true, data: { message: outcome.message } }, 201);
}

export async function handleCloseConversation(
  request: Request,
  env: Env,
  conversationId: string,
  ctx?: ExecutionContext
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  const conversation = await getConversation(env, conversationId, userId);
  if (!conversation) return json({ ok: false, error: "conversation not found" }, 404);
  const closed = await closeConversation(env, conversation.id, userId);
  if (closed) {
    const { message } = await insertChatMessage(env, {
      conversationId: conversation.id,
      sender: "system",
      channel: null,
      body: "Conversation closed.",
    });
    await touchConversation(env, conversation.id);
    if (message) {
      const fanout = fanOutChatMessage(env, conversation, message, { push: false }).catch(
        (err) => console.error("chat close fan-out failed", err)
      );
      await deferOrAwait(ctx, fanout);
    }
    await audit(env, "chat_close", `closed "${conversation.title}"`, userId);
  }
  return json({ ok: true, data: { id: conversation.id, status: "closed" } });
}
