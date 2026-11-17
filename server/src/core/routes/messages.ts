import { updateMessagePriority } from "../messages/priority";
import { runGovernedContentCleanup } from "../governed-content-cleanup";
import { assertWorkspacePublishScope, canReadResource, messageReadSql, messageEditSql, loadTeamMessageForState, setTeamMessageState, applyTeamMessageState, resolveSharingTeam } from "../workspace-access";
import { DocumentAudienceError, resolveDocumentDefaultTeam } from "../document-audience";
import { restrictedContentTeams } from "../content-policy";
import { Env, MessagePayload } from "../types";
import { deferOrAwait, json } from "../utils";
import { resolveApiKeyUser, verifySession, unauthorized, resolveCallerUserId } from "../middleware";
import { deliverToDestinations } from "../destinations";
import { typesetDocument, renderMarkdownContent } from "../documents/typeset";
import type { MessageEnvelope } from "../destinations/types";
import {
  DocumentSlugTakenError,
  DocumentVersionError,
  PublishInputError,
  parseEnhanceLevel,
  promoteLatestVersion,
  publishDocumentVersion,
  renderMarkdownDocument,
  sourceMarkdownKey,
  storeSourceMarkdown,
} from "../documents";
import { sendPushNotification } from "../push/apns";
import {
  createMessage,
  foldStatus,
  loadMessageBlocks,
  MessageBlockInputError,
  type FoldStatusInput,
  type SerializedMessageBlock,
} from "../messages/store";
import { editionLibraryQuery, editionLibraryPlacements, editionAccountLimits, UsageRefused, releaseEditionUsage, reserveEditionUsage, editionAccountActiveSql } from "../edition-hooks";

// Convert SQLite datetime string ("2026-05-11 12:34:56") to unix timestamp seconds
function toUnixSeconds(dateStr: unknown): number {
  const s = String(dateStr ?? "").replace(" ", "T");
  const normalized = /z$|[+-]\d{2}:\d{2}$/i.test(s) ? s : s + "Z";
  return Math.floor(new Date(normalized).getTime() / 1000);
}

// Window (seconds) within which a recent poll means the agent is still online
// and actively waiting. The agent polls every 5s for up to 5 min, so a poll
// inside the last 15s (3 intervals) reliably means "live".
const REPLY_LIVE_WINDOW_SECONDS = 15;
const VALID_DOCUMENT_KINDS = new Set(["doc", "decision_memo", "meeting_note", "spec", "runbook"]);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

function summarizeHtml(value: string): string | null {
  const text = stripHtml(value);
  if (!text) return null;
  return text.length > 240 ? `${text.slice(0, 237).trim()}...` : text;
}


// Derive the reply lifecycle for a question so the phone can show the right
// affordance. Non-questions are not replyable. A reply always *saves* (the
// endpoint is idempotent and a fresh session reads history) — this only drives
// the indicator, never gates the ability to reply.
//   answered → already replied
//   live     → agent polled within the live window; reply delivers instantly
//   idle     → agent polled before but its session has moved on; reply is saved
//   never    → question posted, no agent has polled yet; reply is saved
export function computeReplyStatus(
  type: unknown,
  reply: unknown,
  lastPollAt: unknown,
  nowSeconds: number
): { reply_status: "answered" | "live" | "idle" | "never" | null; seconds_since_poll: number | null } {
  if (type !== "question") return { reply_status: null, seconds_since_poll: null };
  if (reply !== null && reply !== undefined) {
    return { reply_status: "answered", seconds_since_poll: null };
  }
  if (lastPollAt === null || lastPollAt === undefined) {
    return { reply_status: "never", seconds_since_poll: null };
  }
  const delta = nowSeconds - toUnixSeconds(lastPollAt);
  return {
    reply_status: delta <= REPLY_LIVE_WINDOW_SECONDS ? "live" : "idle",
    seconds_since_poll: Math.max(0, delta),
  };
}

// Reshape a raw D1 message row into the iOS-compatible JSON format
function serializeMessage(
  row: Record<string, unknown>,
  nowSeconds?: number,
  blocks: SerializedMessageBlock[] = []
) {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const live = computeReplyStatus(row.type, row.reply ?? null, row.last_poll_at ?? null, now);
  return {
    id: row.id,
    ...(row.library ? { library: row.library } : {}),
    type: row.type,
    title: row.title,
    body: row.body ?? null,
    doc_key: row.doc_key ?? null,
    reply: row.reply ?? null,
    replied_at: row.replied_at ?? null,
    replied_by_user_id: row.replied_by_user_id ?? null,
    replied_via: row.replied_via ?? null,
    archived_at: row.archived_at ?? null,
    created_at: toUnixSeconds(row.created_at),
    priority: row.priority ?? "normal",
    doc_slug: row.doc_slug ?? null,
    doc_version: row.doc_version ?? null,
    source_url: row.source_url ?? null,
    doc_kind: row.doc_kind ?? "doc",
    public: row.public,
    interactive: row.interactive === 1 || row.interactive === true,
    read: row.read === 1 || row.read === true,
    read_at: row.read_at ? toUnixSeconds(row.read_at) : null,
    last_poll_at: row.last_poll_at ? toUnixSeconds(row.last_poll_at) : null,
    reply_status: live.reply_status,
    seconds_since_poll: live.seconds_since_poll,
    dismiss_action: row.dismiss_action ?? null,
    expires_at: row.expires_at ? toUnixSeconds(row.expires_at) : null,
    pinned: row.pinned === 1 || row.pinned === true,
    blocks,
    visual_count: blocks.filter((block) => block.type === "artifact").length,
    instance: {
      model: row.instance_model,
      session_id: row.instance_session_id,
      project: row.instance_project,
      source: row.instance_source,
    },
    team_id: row.team_id ?? null,
    project_id: row.project_id ?? null,
    sharing: row.type !== "document" || row.sharing === "shared" ? "shared" : "private",
  };
}

export async function handlePostMessage(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<Response> {
  const authedUser = await resolveApiKeyUser(request.headers, env);
  if (!authedUser) return unauthorized();

  let payload: MessagePayload;
  try {
    payload = (await request.json()) as MessagePayload;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  // Validate required fields
  if (
    !payload.type || !payload.title || !payload.instance ||
    !payload.instance.model || !payload.instance.session_id ||
    !payload.instance.project || !payload.instance.source
  ) {
    return json({ ok: false, error: "missing required fields: type, title, instance{model,session_id,project,source}" }, 400);
  }

  const validTypes = ["message", "question", "status", "document"] as const;
  if (!validTypes.includes(payload.type as any)) {
    return json({ ok: false, error: `invalid type "${payload.type}": must be one of ${validTypes.join(", ")}` }, 400);
  }

  if (payload.final !== undefined && typeof payload.final !== "boolean") {
    return json({ ok: false, error: '"final" must be a boolean' }, 400);
  }

  const html = typeof payload.html === "string" && payload.html.trim() ? payload.html : null;
  const markdown = typeof payload.markdown === "string" && payload.markdown.trim() ? payload.markdown : null;
  const body = typeof payload.body === "string" && payload.body.trim() ? payload.body : null;

  const designSystemName =
    typeof payload.design_system === "string" && payload.design_system.trim()
      ? payload.design_system.trim()
      : null;
  const docKind =
    typeof payload.doc_kind === "string" && payload.doc_kind.trim()
      ? payload.doc_kind.trim()
      : "doc";
  if (payload.type === "document" && !VALID_DOCUMENT_KINDS.has(docKind)) {
    return json(
      { ok: false, error: '"doc_kind" must be one of doc, decision_memo, meeting_note, spec, runbook' },
      400
    );
  }
  const instructions =
    typeof payload.instructions === "string" && payload.instructions.trim()
      ? payload.instructions.trim()
      : null;

  if (payload.doc_id !== undefined && payload.doc_id !== null) {
    if (typeof payload.doc_id !== "string" || !payload.doc_id.trim()) {
      return json({ ok: false, error: '"doc_id" must be the id of a document version' }, 400);
    }
    if (payload.type !== "document" && !html && !markdown) {
      return json({ ok: false, error: '"doc_id" publishes a new version of a document; send type "document"' }, 400);
    }
    if (payload.blocks) {
      return json({ ok: false, error: '"blocks" are supported for message, question, and status only' }, 400);
    }
    return publishVersionOverHttp(request, env, ctx, authedUser.userId, payload, {
      html, markdown, body, designSystemName, instructions,
    });
  }

  let enhance: ReturnType<typeof parseEnhanceLevel>;
  try {
    enhance = parseEnhanceLevel(payload.enhance);
  } catch (err) {
    if (err instanceof PublishInputError) return json({ ok: false, error: err.message }, 400);
    throw err;
  }

  if (html && markdown) {
    return json({ ok: false, error: 'provide exactly one of "html" or "markdown"' }, 400);
  }
  // Interactive docs are finished HTML+JS apps; the typeset/enhancement
  // pipelines only produce static pages, so raw html is the only valid input.
  const interactive = payload.interactive === true;
  if (interactive && !html) {
    return json({ ok: false, error: '"interactive" requires raw html input' }, 400);
  }
  if ((designSystemName || enhance || instructions) && !markdown) {
    return json(
      { ok: false, error: '"design_system", "enhance", and "instructions" require markdown input' },
      400
    );
  }
  if (enhance && !env.ANTHROPIC_API_KEY) {
    return json(
      { ok: false, error: "enhancement requires ANTHROPIC_API_KEY to be configured on the server" },
      400
    );
  }

  // HTML and markdown payloads are always documents. Older/loose clients
  // sometimes passed --type message with --html, which previously created a
  // push notification while silently dropping the document body.
  if ((html || markdown) && payload.type !== "document") {
    payload = { ...payload, type: "document" };
  }

  if (payload.blocks && payload.type === "document") {
    return json(
      { ok: false, error: '"blocks" are supported for message, question, and status only' },
      400
    );
  }

  if (payload.type === "document" && !html && !markdown && !body) {
    return json({ ok: false, error: "document messages require html, markdown, or body content" }, 400);
  }

  try {
    if(payload.type === "document") payload.team_id = await resolveDocumentDefaultTeam(env,{userId:authedUser.userId,teamId:payload.team_id,projectId:payload.project_id,sharing:payload.sharing,isPublic:payload.public}) ?? undefined;
    await assertWorkspacePublishScope(env,authedUser.userId,payload.team_id,payload.project_id);
  } catch(err) { return json({ok:false,error:err instanceof Error ? err.message : "invalid team scope"},err instanceof DocumentAudienceError ? err.status : 403); }
  if (payload.team_id && payload.public) return json({ ok: false, error: "team documents must remain private" }, 400);

  // Living status item: a status from one session updates its open row instead of adding a new one.
  // A status with blocks never folds. Scope was checked above, so a fold writes only where an insert could.
  const statusFold: FoldStatusInput | null = payload.type === "status" && payload.blocks === undefined
    ? {
        userId: authedUser.userId,
        teamId: payload.team_id ?? null,
        projectId: payload.project_id ?? null,
        sessionId: payload.instance.session_id,
        instanceProject: payload.instance.project,
        title: payload.title,
        body,
        final: payload.final === true,
      }
    : null;
  const foldedResponse = (foldedId: string) => json({ ok: true, data: { id: foldedId, type: "status", folded: true } }, 200);
  if (statusFold) {
    const folded = await foldStatus(env, statusFold);
    if (folded) return foldedResponse(folded.id);
  }

  if (payload.type === "document" && payload.sharing === "shared" && enhance) {
    try {
      const teamId = await resolveSharingTeam(env, authedUser.userId, payload.team_id);
      if (await restrictedContentTeams(env, teamId)) return json({ ok: false,
        error: 'Enhance a private draft before assigning team read access in Access controls.' }, 400);
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : 'invalid team scope' }, 400);
    }
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  let docKey: string | null = null;

  // Every document is stored as a finished, viewable HTML artifact in R2 so it
  // is retrievable, shareable, and visible in document-focused MCP/list flows.
  // Raw HTML passes through untouched; markdown and plain text get typeset
  // server-side into the dispatch design language.
  let docHtml: string | null = null;
  let resolvedDesignSystem: string | null = null;
  if (payload.type === "document") {
    if (markdown) {
      try {
        const rendered = await renderMarkdownDocument(env, {
          title: payload.title,
          markdown,
          project: payload.instance.project,
          createdAt,
          userId: authedUser.userId,
          designSystemName: designSystemName ?? undefined,
        });
        docHtml = rendered.html;
        resolvedDesignSystem = rendered.designSystemName;
      } catch (err) {
        if (err instanceof PublishInputError) return json({ ok: false, error: err.message }, 400);
        throw err;
      }
    } else {
      docHtml =
        html ??
        typesetDocument({
          title: payload.title,
          markdown: null,
          body,
          project: payload.instance.project,
          createdAt,
        });
    }
  }

  // Inbox/push preview text comes from the content itself, never the page
  // chrome: raw HTML is summarized directly; markdown is summarized from its
  // rendered content before the dispatch template wraps it.
  const storedBody =
    body ??
    (html
      ? summarizeHtml(html)
      : markdown
        ? summarizeHtml(renderMarkdownContent(markdown))
        : null);

  const docSize = docHtml ? new TextEncoder().encode(docHtml).byteLength : 0;
  const sourceSize = markdown ? new TextEncoder().encode(markdown).byteLength : 0;
  const storageSize = docSize + sourceSize;
  if (payload.type === "document" && docHtml) docKey = `docs/${id}.html`;

  let deliveryReserved = false;
  let storageReserved = false;
  let aiReserved = false;
  let created;
  const releaseReservations = async () => {
    const releases: Promise<unknown>[] = [];
    if (aiReserved) {
      releases.push(releaseEditionUsage(
        env, authedUser.userId, "ai_actions", 1, `message:${id}:ai:rollback`
      ));
    }
    if (storageReserved) {
      releases.push(releaseEditionUsage(
        env, authedUser.userId, "storage_bytes", storageSize, `message:${id}:storage:rollback`
      ));
    }
    if (deliveryReserved) {
      releases.push(releaseEditionUsage(
        env, authedUser.userId, "deliveries", 1, `message:${id}:delivery:rollback`
      ));
    }
    await Promise.allSettled(releases);
  };
  try {
    const hosted = await editionAccountLimits(env, authedUser.userId);
    if (hosted && storageSize > hosted.max_upload_bytes) {
      return json(
        {
          ok: false,
          error: `document is ${storageSize} bytes; the hosted per-upload limit is ${hosted.max_upload_bytes} bytes`,
        },
        413
      );
    }
    const delivery = await reserveEditionUsage(
      env,
      authedUser.userId,
      "deliveries",
      1,
      `message:${id}:delivery:add`
    );
    deliveryReserved = delivery.managed;
    if (storageSize > 0) {
      const storage = await reserveEditionUsage(
        env,
        authedUser.userId,
        "storage_bytes",
        storageSize,
        `message:${id}:storage:add`
      );
      storageReserved = storage.managed;
    }
    if (enhance) {
      const ai = await reserveEditionUsage(
        env,
        authedUser.userId,
        "ai_actions",
        1,
        `message:${id}:ai:add`
      );
      aiReserved = ai.managed;
    }

    if (docKey && docHtml) {
      await env.DOCS.put(docKey, docHtml, {
        httpMetadata: { contentType: "text/html" },
        customMetadata: {
          title: payload.title,
          instance: payload.instance.session_id,
        },
      });
    }
    if (payload.type === "document" && markdown && docKey) {
      await storeSourceMarkdown(env, id, markdown, payload.title);
    }

    const messageInput: Parameters<typeof createMessage>[1] = {
        id,
        type: payload.type,
        title: payload.title,
        body: storedBody,
        docKey,
        priority: payload.priority,
        isPublic: payload.public,
        docSlug: payload.slug || (payload.type === "document" ? id : null),
        exclusiveDocSlug: !!payload.slug,
        docVersion: payload.type === "document" ? 1 : null,
        designSystem: resolvedDesignSystem,
        enhanceStatus: enhance ? "queued" : null,
        enhanceLevel: enhance,
        sourceUrl: payload.source_url || null,
        interactive,
        teamId: payload.team_id ?? null,
        sharing: payload.sharing ?? undefined,
        projectId: payload.project_id ?? null,
        docKind,
        docSize,
        sourceSize,
        instance: payload.instance,
        userId: authedUser.userId,
        blocks: payload.blocks,
        ...(statusFold?.final ? { statusClosed: true } : {}),
    };
    // A status races other statuses of its session: the first insert is conditional, and one that
    // finds an open row folds into it instead. If that row closed in the gap, insert plainly.
    created = await createMessage(env, statusFold ? { ...messageInput, onlyIfNoOpenStatus: true } : messageInput, ctx);
    if (created.skipped) {
      const again = statusFold ? await foldStatus(env, statusFold) : null;
      if (again) {
        await releaseReservations();
        return foldedResponse(again.id);
      }
      created = await createMessage(env, messageInput, ctx);
    }
  } catch (err) {
    if (docKey) {
      await env.DOCS.delete(docKey).catch(() => {});
      const sourceKey = sourceMarkdownKey(docKey);
      if (sourceKey) await env.DOCS.delete(sourceKey).catch(() => {});
    }
    await releaseReservations();
    if (err instanceof MessageBlockInputError) {
      return json({ ok: false, error: err.message }, 400);
    }
    if (err instanceof DocumentSlugTakenError) {
      return json({ ok: false, error: err.message }, 409);
    }
    if (err instanceof UsageRefused) {
      return json({ ok: false, error: err.message }, err.status);
    }
    throw err;
  }

  if (enhance && payload.type === "document") {
    try {
      await env.ENHANCE_QUEUE.send({
        kind: "enhance",
        docId: id,
        level: enhance,
        instructions: instructions ?? undefined,
        designSystemName: resolvedDesignSystem as string,
        userId: authedUser.userId,
      });
    } catch (err) {
      // The message is already durable; record the enhancement as failed
      // instead of failing the publish (a retry would double-publish).
      const reason = err instanceof Error ? err.message : "queueing failed";
      await env.DB.prepare(
        "UPDATE messages SET enhance_status = 'failed', enhance_error = ? WHERE id = ?"
      )
        .bind(`enhancement queueing failed: ${reason}`.slice(0, 500), id)
        .run();
    }
  }

  const envelope: MessageEnvelope = {
    id,
    payload: { ...payload, body: created.body ?? undefined },
    docKey,
    createdAt,
  };

  const destinationPromise = deliverToDestinations(env, envelope).catch((err) =>
    console.error("destination delivery failed", err)
  );

  await deferOrAwait(ctx, destinationPromise);

  // A document's first publish is version 1 of its family; the version fields
  // let a shell-only agent pass base_version on its next edit.
  const documentFields = payload.type === "document" ? {
    doc_slug: payload.slug || id,
    doc_version: 1,
    url: `${env.WORKER_URL || new URL(request.url).origin}/${interactive ? "idoc" : "docs"}/${id}`,
  } : {};
  return json({ ok: true, data: { id, type: payload.type, ...documentFields,
    ...(created.readAccess ? { read_access: created.readAccess } : {}) } }, 201);
}

// POST /api/messages with doc_id: a new version of an existing document, via
// the same helper as MCP pidgin_publish_document. Like a new document it lands
// unread in the inbox, pushes, and reaches the configured destinations.
async function publishVersionOverHttp(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  userId: string,
  payload: MessagePayload,
  content: { html: string | null; markdown: string | null; body: string | null; designSystemName: string | null; instructions: string | null }
): Promise<Response> {
  const { html, markdown, body } = content;
  const storedBody =
    body ?? (html ? summarizeHtml(html) : markdown ? summarizeHtml(renderMarkdownContent(markdown)) : null);
  let version;
  try {
    version = await publishDocumentVersion(env, {
      docId: (payload.doc_id as string).trim(),
      userId,
      title: payload.title,
      html,
      markdown,
      body: html || markdown ? null : body,
      summary: storedBody,
      baseVersion: payload.base_version,
      force: payload.force === true,
      designSystem: content.designSystemName,
      enhance: payload.enhance,
      instructions: content.instructions,
      priority: payload.priority,
      sourceUrl: payload.source_url,
      instance: payload.instance,
      origin: new URL(request.url).origin,
      teamId: payload.team_id,
      projectId: payload.project_id,
      public: payload.public,
      sharing: payload.sharing ?? undefined,
      docKind: payload.doc_kind,
      interactive: payload.interactive,
      slug: payload.slug,
    });
  } catch (err) {
    if (err instanceof PublishInputError) return json({ ok: false, error: err.message }, 400);
    if (err instanceof DocumentVersionError) {
      return json({
        ok: false, error: err.message,
        ...(err.status === 409 ? { current_version: err.currentVersion, latest_id: err.latestId } : {}),
      }, err.status);
    }
    if (err instanceof UsageRefused) return json({ ok: false, error: err.message }, err.status);
    throw err;
  }

  const push = sendPushNotification(
    env, "Document updated", `${version.title} — version ${version.doc_version}`, version.id, "document", userId
  ).catch((err) => console.error("push delivery failed", err));
  await deferOrAwait(ctx, push);
  const envelope: MessageEnvelope = {
    id: version.id,
    // Destinations show what was stored: priority and source link are
    // inherited from the latest version when the caller left them out.
    payload: {
      ...payload, type: "document", body: version.body ?? undefined,
      priority: version.priority as MessagePayload["priority"], source_url: version.source_url ?? undefined,
    },
    docKey: `docs/${version.id}.html`,
    createdAt: version.created_at,
  };
  await deferOrAwait(ctx, deliverToDestinations(env, envelope).catch((err) =>
    console.error("destination delivery failed", err)
  ));

  return json({
    ok: true,
    data: {
      id: version.id,
      type: "document",
      doc_slug: version.doc_slug,
      doc_version: version.doc_version,
      previous_id: version.previous_id,
      url: version.url,
    },
  }, 201);
}

export async function handleGetMessages(
  request: Request,
  env: Env
): Promise<Response> {
  // Accept either session auth (human) or API key (bot checking replies)
  const sessionEmail = await verifySession(request.headers, env.SESSIONS, env);
  let userId: string | null = null;

  if (sessionEmail) {
    const u = await env.DB.prepare(
      `SELECT id, email FROM users WHERE email = ? AND status = 'active'
       AND ${editionAccountActiveSql()}`
    ).bind(sessionEmail.toLowerCase()).first<{ id: string; email: string }>();
    if (!u) return unauthorized();
    userId = u.id;
  } else {
    const authedUser = await resolveApiKeyUser(request.headers, env);
    if (!authedUser) return unauthorized();
    userId = authedUser.userId;
  }

  const url = new URL(request.url);
  if (url.searchParams.has("team_id") || ["shared", "all"].includes(url.searchParams.get("scope") || "")) {
    return getSharedMessages(request, env, userId);
  }
  const rawLimit = parseInt(url.searchParams.get("limit") || "50");
  const limit = Number.isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 100);
  const rawOffset = parseInt(url.searchParams.get("offset") || "0");
  const offset = Number.isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;
  const type = url.searchParams.get("type");
  const priority = url.searchParams.get("priority");
  const sort = url.searchParams.get("sort"); // "oldest" reverses default newest-first
  const q = url.searchParams.get("q"); // full-text search across title and body
  const since = url.searchParams.get("since");
  const before = url.searchParams.get("before");
  const unreadOnly = url.searchParams.get("unread") === "true";
  const repliedParam = url.searchParams.get("replied");
  const project = url.searchParams.get("project");
  const source = url.searchParams.get("source");
  const sessionId = url.searchParams.get("session_id");
  const model = url.searchParams.get("model");
  const dateFilter = url.searchParams.get("date");
  const archivedParam = url.searchParams.get("archived");
  const dismissActionParam = url.searchParams.get("dismiss_action"); // 'archive' | 'delete' | null
  const docsView = url.searchParams.get("docs_view") === "true"; // show non-dismissed + pinned
  const search = (q || "").trim();

  const conditions: string[] = [];
  const binds: (string | number)[] = [];

  // Personal ownership is not sufficient when a composed message contains a
  // snapshot of a team artifact whose audience has since changed.
  // Superseded document versions stay readable by id but leave every list.
  conditions.push("user_id = ?", "team_id IS NULL", "COALESCE(is_latest, 1) = 1", messageReadSql("messages"));
  binds.push(userId!, userId!, userId!);


  if (type) {
    conditions.push("type = ?");
    binds.push(type);
  }
  if (priority) {
    conditions.push("priority = ?");
    binds.push(priority);
  }
  if (since) {
    conditions.push("created_at > ?");
    binds.push(since);
  }
  if (before) {
    conditions.push("created_at < ?");
    binds.push(before);
  }
  if (unreadOnly) {
    conditions.push("read = 0");
  }
  if (repliedParam === "true") {
    conditions.push("reply IS NOT NULL");
  } else if (repliedParam === "false") {
    conditions.push("reply IS NULL");
  }
  if (project) {
    conditions.push("instance_project = ?");
    binds.push(project);
  }
  if (source) {
    conditions.push("instance_source = ?");
    binds.push(source);
  }
  if (sessionId) {
    conditions.push("instance_session_id = ?");
    binds.push(sessionId);
  }
  if (model) {
    conditions.push("instance_model = ?");
    binds.push(model);
  }
  if (dateFilter && /^\d{4}-\d{2}-\d{2}$/.test(dateFilter)) {
    conditions.push("date(created_at) = ?");
    binds.push(dateFilter);
  }
  if (dismissActionParam === "archive" || dismissActionParam === "delete") {
    // Cold storage views: items dismissed with a specific action
    conditions.push("archived_at IS NOT NULL AND dismiss_action = ?");
    binds.push(dismissActionParam);
  } else if (docsView) {
    // Docs tab: show active (non-dismissed) docs OR pinned docs
    conditions.push("(archived_at IS NULL OR pinned = 1)");
  } else if (archivedParam === "true") {
    conditions.push("archived_at IS NOT NULL");
  } else if (archivedParam === "false") {
    conditions.push("archived_at IS NULL");
  }
  if (search) {
    // Escape LIKE wildcards so user text is matched literally.
    const escaped = search.replace(/[\\%_]/g, (c) => "\\" + c);
    conditions.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
    binds.push(`%${escaped}%`, `%${escaped}%`);
  }

  if(type === "document") editionLibraryQuery(env,{userId,type:"document",alias:"messages",project:url.searchParams.get("library_project")||undefined,tag:url.searchParams.get("library_tag")||undefined},conditions,binds);
  let query = "SELECT * FROM messages";
  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }

  // Sort modes. Urgent-float is kept for the time-ordered modes (it's what
  // makes the inbox usable), but dropped for `relevance` and `project` where
  // it would fight the key the user explicitly chose. Unknown values fall back
  // to `recent` rather than erroring — a bad query param shouldn't 400 a list.
  const URGENT_FIRST = "CASE priority WHEN 'urgent' THEN 0 ELSE 1 END";
  let orderBy: string;
  switch (sort) {
    case "oldest":
      orderBy = `${URGENT_FIRST}, created_at ASC`;
      break;
    case "unread":
      orderBy = `read ASC, ${URGENT_FIRST}, created_at DESC`;
      break;
    case "project":
      // NULLs last so unattributed messages don't head the list.
      orderBy = "instance_project IS NULL, instance_project ASC, created_at DESC";
      break;
    case "relevance":
      if (search) {
        // Title hits outrank body-only hits; recency breaks ties. Bound as its
        // own bind so the ESCAPE clause matches the filter above exactly.
        const escaped = search.replace(/[\\%_]/g, (c) => "\\" + c);
        orderBy = `CASE WHEN title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, created_at DESC`;
        binds.push(`%${escaped}%`);
        break;
      }
      // Relevance without a query is meaningless — behave like `recent`.
      orderBy = `${URGENT_FIRST}, created_at DESC`;
      break;
    default: // "recent", "newest", anything unrecognized
      orderBy = `${URGENT_FIRST}, created_at DESC`;
  }

  // Fetch limit+1 to determine has_more without a separate COUNT query
  query += ` ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  binds.push(limit + 1, offset);

  const [result, unreadRow] = await Promise.all([
    env.DB.prepare(query).bind(...binds).all(),
    env.DB.prepare(`SELECT COUNT(*) as count FROM messages WHERE read = 0 AND user_id = ? AND team_id IS NULL AND COALESCE(is_latest, 1) = 1
      AND ${messageReadSql("messages")}`)
      .bind(userId!, userId!, userId!)
      .first<{ count: number }>(),
  ]);

  const has_more = result.results.length > limit;
  const messages = has_more ? result.results.slice(0, limit) : result.results;
  const library = await editionLibraryPlacements(env,userId,messages.filter(row=>row.type === "document").map(row=>({type:"document",id:String(row.id)})));
  for(const row of messages) if(library.has(`document:${row.id}`)) row.library=library.get(`document:${row.id}`);
  const blockMap = await loadMessageBlocks(
    env,
    messages.map((row) => String((row as Record<string, unknown>).id))
  );

  const now = Math.floor(Date.now() / 1000);
  const response = json({
    ok: true,
    data: messages.map((r) =>
      serializeMessage(r, now, blockMap.get(String((r as Record<string, unknown>).id)) ?? [])
    ),
  });
  response.headers.set("X-Unread-Count", String(unreadRow?.count ?? 0));
  response.headers.set("X-Has-More", String(has_more));
  response.headers.set("X-Offset", String(offset));
  return response;
}

export async function handleMarkAllRead(
  request: Request,
  env: Env
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  const result = await env.DB.prepare(
    "UPDATE messages SET read = 1, read_at = datetime('now') WHERE read = 0 AND user_id = ? AND team_id IS NULL"
  ).bind(userId).run();

  return json({ ok: true, data: { marked_read: result.meta.changes } });
}

export async function handleGetMessage(
  request: Request,
  env: Env,
  messageId: string
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  const row = await env.DB.prepare(`SELECT * FROM messages WHERE id = ? AND ${messageReadSql("messages")}`)
    .bind(messageId, userId, userId)
    .first<Record<string, unknown>>();

  if (!row || !await canReadResource(env, userId, row as { id: string; user_id: string; team_id: string | null; sharing: string; type: string })) return json({ ok: false, error: "message not found" }, 404);

  const blocks = (await loadMessageBlocks(env, [messageId])).get(messageId) ?? [];
  return json({ ok: true, data: serializeMessage(await applyTeamMessageState(env, userId, row), undefined, blocks) });
}

export async function handleArchiveMessage(
  request: Request,
  env: Env,
  messageId: string
): Promise<Response> {
  const email = await verifySession(request.headers, env.SESSIONS, env);
  if (!email) return unauthorized();

  const u = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email.toLowerCase()).first<{ id: string }>();
  if (!u) return unauthorized();

  const teamMessage = await loadTeamMessageForState(env, u.id, messageId);
  if (teamMessage === false) return json({ ok: false, error: "message not found" }, 404);
  if (teamMessage) {
    await setTeamMessageState(env, u.id, messageId, { archived: true });
    return json({ ok: true, data: { message_id: messageId, personal_state: true } });
  }

  const result = await env.DB.prepare(
    "UPDATE messages SET archived_at = datetime('now') WHERE id = ? AND archived_at IS NULL AND user_id = ?"
  ).bind(messageId, u.id).run();

  if (result.meta.changes === 0) {
    // Scope the disambiguation probe to the caller: changes=0 means either the
    // caller's own message was already archived (idempotent re-archive -> ok) OR
    // the id isn't theirs at all (-> 404). An UNSCOPED probe would see another
    // tenant's row and fall through to a false ok:true, leaking existence.
    const exists = await env.DB.prepare("SELECT id FROM messages WHERE id = ? AND user_id = ?")
      .bind(messageId, u.id).first();
    if (!exists) return json({ ok: false, error: "message not found" }, 404);
  }

  return json({ ok: true, data: { message_id: messageId } });
}

// A personal document's dismissal follows its latest version: dismissing or
// restoring the latest acts on every version (binds: id, user id), so expiry
// removes the document whole instead of resurfacing an older version.
const VERSIONS_OF_LATEST_SQL = `(type = 'document' AND team_id IS NULL AND doc_slug = (
  SELECT f.doc_slug FROM messages f WHERE f.id = ? AND f.user_id = ? AND f.type = 'document'
    AND f.team_id IS NULL AND COALESCE(f.is_latest, 1) = 1))`;

export async function handleUnarchiveMessage(
  request: Request,
  env: Env,
  messageId: string
): Promise<Response> {
  const email = await verifySession(request.headers, env.SESSIONS, env);
  if (!email) return unauthorized();

  const u = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email.toLowerCase()).first<{ id: string }>();
  if (!u) return unauthorized();

  const teamMessage = await loadTeamMessageForState(env, u.id, messageId);
  if (teamMessage === false) return json({ ok: false, error: "message not found" }, 404);
  if (teamMessage) {
    await setTeamMessageState(env, u.id, messageId, { archived: false });
    return json({ ok: true, data: { message_id: messageId, personal_state: true } });
  }

  const result = await env.DB.prepare(
    `UPDATE messages
     SET archived_at = NULL, dismiss_action = NULL, expires_at = NULL
     WHERE user_id = ? AND (id = ? OR ${VERSIONS_OF_LATEST_SQL})`
  ).bind(u.id, messageId, messageId, u.id).run();

  if (result.meta.changes === 0) return json({ ok: false, error: "message not found" }, 404);

  return json({ ok: true, data: { message_id: messageId } });
}

// Archive many messages at once: either an explicit list of ids (multi-select)
// or every message currently in the inbox (archive-all). Always idempotent and
// scoped to the caller's own messages.
export async function handleBulkArchive(
  request: Request,
  env: Env
): Promise<Response> {
  const email = await verifySession(request.headers, env.SESSIONS, env);
  if (!email) return unauthorized();

  const u = await env.DB.prepare("SELECT id, email FROM users WHERE email = ?")
    .bind(email.toLowerCase()).first<{ id: string; email: string }>();
  if (!u) return unauthorized();
  const ownerScope = "user_id = ? AND team_id IS NULL";

  let body: { ids?: unknown; all?: unknown };
  try {
    body = (await request.json()) as { ids?: unknown; all?: unknown };
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  if (body.all === true) {
    const result = await env.DB.prepare(
      `UPDATE messages SET archived_at = datetime('now')
       WHERE archived_at IS NULL AND ${ownerScope}`
    ).bind(u.id).run();
    return json({ ok: true, data: { archived: result.meta.changes } });
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === "string").slice(0, 500)
    : [];
  if (ids.length === 0) {
    return json({ ok: false, error: "provide ids[] or all:true" }, 400);
  }

  const placeholders = ids.map(() => "?").join(",");
  const result = await env.DB.prepare(
    `UPDATE messages SET archived_at = datetime('now')
     WHERE archived_at IS NULL AND ${ownerScope} AND id IN (${placeholders})`
  ).bind(u.id, ...ids).run();

  return json({ ok: true, data: { archived: result.meta.changes } });
}

export async function handleMarkMessageRead(
  request: Request,
  env: Env,
  messageId: string
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  let markRead = true;
  try {
    const body = await request.json() as { read?: boolean };
    if (body && body.read === false) markRead = false;
  } catch { /* no body = mark read */ }

  const teamMessage = await loadTeamMessageForState(env, userId, messageId);
  if (teamMessage === false) return json({ ok: false, error: "message not found" }, 404);
  if (teamMessage) {
    await setTeamMessageState(env, userId, messageId, { read: markRead });
    return json({ ok: true, data: { id: messageId, read: markRead } });
  }
  // Scope the existence check (the sole 404 source) to the caller: a member
  // hitting another user's id finds no row and gets 404, never a silent
  // mark-read of someone else's message.
  const exists = await env.DB.prepare("SELECT id FROM messages WHERE id = ? AND user_id = ?")
    .bind(messageId, userId)
    .first();
  if (!exists) return json({ ok: false, error: "message not found" }, 404);

  if (markRead) {
    await env.DB.prepare("UPDATE messages SET read = 1, read_at = datetime('now') WHERE id = ? AND user_id = ?")
      .bind(messageId, userId).run();
  } else {
    await env.DB.prepare("UPDATE messages SET read = 0, read_at = NULL WHERE id = ? AND user_id = ?")
      .bind(messageId, userId).run();
  }

  return json({ ok: true, data: { id: messageId, read: markRead } });
}

export async function handleGetMessageContext(
  request: Request,
  env: Env,
  messageId: string
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  const teamMessage = await loadTeamMessageForState(env, userId, messageId);
  if (teamMessage === false) return json({ ok: false, error: "message not found" }, 404);
  if (teamMessage) {
    const message = await env.DB.prepare(`SELECT * FROM messages WHERE id = ? AND ${messageReadSql("messages")}`)
      .bind(messageId, userId, userId).first<Record<string, unknown>>();
    if (!message) return json({ ok: false, error: "message not found" }, 404);
    return json({ ok: true, data: { message, instance: null } });
  }

  // Both the message read and the instance lookup are scoped to the caller.
  // For a foreign id the message SELECT returns null (-> 404 below). The
  // instance query scopes BOTH the inner subquery (which message_id resolves to
  // a session) AND the outer instances row by user_id: instance_id is globally
  // unique and re-registrable across tenants, so the outer clause prevents the
  // context from resolving another user's instance. Mirrors mcp.ts's
  // pidgin_get_message_context.
  const [message, instance] = await Promise.all([
    env.DB.prepare(`SELECT * FROM messages WHERE id = ? AND user_id = ? AND team_id IS NULL AND ${messageReadSql("messages")}`)
      .bind(messageId, userId, userId, userId)
      .first<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT instance_id, model, project, working_on, source, registered_at, last_heartbeat
       FROM instances WHERE instance_id = (SELECT instance_session_id FROM messages WHERE id = ? AND user_id = ?
         AND team_id IS NULL AND ${messageReadSql("messages")}) AND user_id = ?`
    ).bind(messageId, userId, userId, userId, userId).first<Record<string, unknown>>(),
  ]);

  if (!message) return json({ ok: false, error: "message not found" }, 404);

  const heartbeatAge = instance ? Date.now() - new Date(String(instance.last_heartbeat)).getTime() : null;
  return json({
    ok: true,
    data: {
      message,
      instance: instance ? { ...instance, status: heartbeatAge! < 5 * 60 * 1000 ? "live" : "stale" } : null,
    },
  });
}

export async function handleUpdatePriority(
  request: Request,
  env: Env,
  messageId: string
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  let priority: string;
  try {
    const body = (await request.json()) as { priority: string };
    priority = body.priority;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  if (priority !== "normal" && priority !== "urgent") {
    return json({ ok: false, error: "priority must be 'normal' or 'urgent'" }, 400);
  }

  const teamMessage = await loadTeamMessageForState(env, userId, messageId);
  if (teamMessage === false || (teamMessage && teamMessage.user_id !== userId)) return json({ ok: false, error: "message not found" }, 404);
  if (teamMessage) {
    try { await assertWorkspacePublishScope(env, userId, teamMessage.team_id); }
    catch { return json({ ok: false, error: "forbidden" }, 403); }
  }
  if (!await updateMessagePriority(env, userId, messageId, priority)) {
    return json({ ok: false, error: "message not found" }, 404);
  }
  return json({ ok: true, data: { id: messageId, priority } });
}

export async function handleDeleteMessage(
  request: Request,
  env: Env,
  messageId: string
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  const deleted = await deleteMessageForUser(env, userId, messageId);
  if (!deleted) return json({ ok: false, error: "message not found" }, 404);
  return json({ ok: true, data: { id: messageId, deleted: true } });
}

export async function deleteMessageForUser(
  env: Env,
  userId: string,
  messageId: string
): Promise<boolean> {
  const teamMessage = await loadTeamMessageForState(env, userId, messageId);
  if (teamMessage === false) return false;
  if (teamMessage) {
    if (teamMessage.user_id !== userId) return false;
    try { await assertWorkspacePublishScope(env, userId, teamMessage.team_id); } catch { return false; }
  }
  const [stored, commute] = await Promise.all([
    env.DB.prepare(
    "SELECT doc_key, doc_size, source_size, type, doc_slug, team_id, is_latest FROM messages WHERE id = ? AND user_id = ?"
    ).bind(messageId, userId).first<{
      doc_key: string | null;
      doc_size: number;
      source_size: number;
      type: string;
      doc_slug: string | null;
      team_id: string | null;
      is_latest: number | null;
    }>(),
    env.DB.prepare(
      `SELECT cb.transcript_key, cb.audio_key, cb.metadata_key,
              cb.transcript_size, cb.audio_size, cb.metadata_size
       FROM commute_briefings cb JOIN messages m ON m.id = cb.source_message_id
       WHERE cb.source_message_id = ? AND m.user_id = ?`
    ).bind(messageId, userId).first<{
      transcript_key: string;
      audio_key: string | null;
      metadata_key: string | null;
      transcript_size: number;
      audio_size: number;
      metadata_size: number;
    }>(),
  ]);

  if (stored?.type === "document" && stored.team_id) {
    const cleanupId = crypto.randomUUID();
    const keys = [stored.doc_key, sourceMarkdownKey(stored.doc_key), commute?.transcript_key, commute?.audio_key, commute?.metadata_key].filter((key): key is string => !!key);
    const bytes = Number(stored.doc_size || 0) + Number(stored.source_size || 0) + Number(commute?.transcript_size || 0) + Number(commute?.audio_size || 0) + Number(commute?.metadata_size || 0);
    const gate = "EXISTS (SELECT 1 FROM governed_content_cleanup WHERE id=?)";
    const writes = await env.DB.batch([
      env.DB.prepare(`INSERT INTO governed_content_cleanup(id,resource_type,resource_id,user_id,object_keys,storage_bytes)
        SELECT ?,'document',id,user_id,?,? FROM messages WHERE id=? AND user_id=? AND doc_key IS ? AND is_latest IS ?
          AND ${messageEditSql("messages")}`)
        .bind(cleanupId, JSON.stringify(keys), bytes, messageId, userId, stored.doc_key, stored.is_latest, userId, userId),
      env.DB.prepare(`INSERT INTO audit_log(action,instance_id,details,user_id)
        SELECT 'delete_team_document','governance',?,? WHERE ${gate}`).bind(JSON.stringify({resource_id:messageId,cleanup_id:cleanupId}),userId,cleanupId),
      env.DB.prepare(`DELETE FROM commute_briefings WHERE source_message_id=? AND ${gate}`).bind(messageId,cleanupId),
      env.DB.prepare(`DELETE FROM messages WHERE id=? AND ${gate}`).bind(messageId,cleanupId),
      promoteLatestVersion(env,{id:messageId,doc_slug:stored.doc_slug,team_id:stored.team_id,user_id:userId},true),
    ]);
    if (writes[0].meta.changes !== 1) return false;
    await runGovernedContentCleanup(env,cleanupId);
    return true;
  }

  // Remove R2 first. If D1 then fails, a retry can still remove the row; the
  // reverse order could permanently orphan an object with no lookup key.
  if (stored?.doc_key) {
    await env.DOCS.delete(stored.doc_key);
    const sourceKey = sourceMarkdownKey(stored.doc_key);
    if (sourceKey) await env.DOCS.delete(sourceKey);
  }
  if (commute) {
    await env.DOCS.delete(commute.transcript_key);
    if (commute.audio_key) await env.DOCS.delete(commute.audio_key);
    if (commute.metadata_key) await env.DOCS.delete(commute.metadata_key);
    await env.DB.prepare(
      "DELETE FROM commute_briefings WHERE source_message_id = ?"
    ).bind(messageId).run();
  }

  // Deleting a document's latest version makes the previous one the latest
  // again; otherwise the older versions would drop out of every list.
  const remove = env.DB.prepare("DELETE FROM messages WHERE id = ? AND user_id = ?").bind(messageId, userId);
  const result = stored?.type === "document" && stored.is_latest !== 0
    ? (await env.DB.batch([remove, promoteLatestVersion(env, { id: messageId, doc_slug: stored.doc_slug, team_id: stored.team_id, user_id: userId })]))[0]
    : await remove.run();

  if (result.meta.changes === 0) return false;
  const releasedBytes =
    Number(stored?.doc_size || 0) +
    Number(stored?.source_size || 0) +
    Number(commute?.transcript_size || 0) +
    Number(commute?.audio_size || 0) +
    Number(commute?.metadata_size || 0);
  if (releasedBytes > 0) {
    // Deletion remains successful if the external ledger is temporarily
    // unavailable. That conservatively over-counts usage instead of allowing
    // an overage; the idempotency key makes an operator retry safe.
    await releaseEditionUsage(
      env,
      userId,
      "storage_bytes",
      releasedBytes,
      `message:${messageId}:storage:delete`
    ).catch((error) => console.error("hosted storage release failed", error));
  }
  return true;
}

export async function handleGetReplies(
  request: Request,
  env: Env,
  messageId: string,
  ctx?: ExecutionContext
): Promise<Response> {
  const authedUser = await resolveApiKeyUser(request.headers, env);
  if (!authedUser) return unauthorized();

  const teamMessage = await loadTeamMessageForState(env, authedUser.userId, messageId);
  if (teamMessage === false) return json({ ok: false, error: "message not found" }, 404);

  const message = await env.DB.prepare(
    `SELECT id, reply, replied_at, replied_via FROM messages WHERE id = ? AND user_id = ? AND ${messageReadSql("messages")}`
  )
    .bind(messageId, authedUser.userId, authedUser.userId, authedUser.userId)
    .first();

  if (!message) {
    return json({ ok: false, error: "message not found" }, 404);
  }

  // Stamp liveness: this poll proves an agent session is online and waiting for
  // the reply. The phone uses last_poll_at to show "Claude is waiting" vs
  // "session moved on". Only meaningful while still unanswered. The stamp never
  // gates the response — agents poll every 5s, so it rides waitUntil.
  if (message.reply === null) {
    const stamp = env.DB.prepare(
      "UPDATE messages SET last_poll_at = datetime('now') WHERE id = ? AND user_id = ?"
    )
      .bind(messageId, authedUser.userId)
      .run()
      .catch((err) => console.error("liveness stamp failed", err));
    await deferOrAwait(ctx, stamp);
  }

  return json({
    ok: true,
    data: {
      replied: message.reply !== null,
      reply: message.reply,
      replied_at: message.replied_at,
      // Which credential sent the reply (see CallerCredential in middleware.ts):
      // "app_session" (the edition's apps, the only value that shows a signed-in
      // person replied), "web_cookie" (the request carried the web inbox
      // cookie, which page script on this origin can also cause) or "api_key"
      // (anything holding an API key). null = not replied yet, or replied
      // before this was recorded.
      replied_via: message.replied_via ?? null,
    },
  });
}

// Dismiss a message (or package) to cold storage with the given action.
// action='archive' → 90-day TTL; action='delete' → 7-day TTL.
// Idempotent: re-dismissing updates the action and resets the TTL.
export async function handleDismissMessage(
  request: Request,
  env: Env,
  messageId: string
): Promise<Response> {
  const email = await verifySession(request.headers, env.SESSIONS, env);
  if (!email) return unauthorized();

  const u = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email.toLowerCase()).first<{ id: string }>();
  if (!u) return unauthorized();

  let action: string;
  try {
    const body = (await request.json()) as { action: string };
    action = body.action;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  if (action !== "archive" && action !== "delete") {
    return json({ ok: false, error: "action must be 'archive' or 'delete'" }, 400);
  }

  const teamMessage = await loadTeamMessageForState(env, u.id, messageId);
  if (teamMessage === false) return json({ ok: false, error: "message not found" }, 404);
  if (teamMessage) {
    await setTeamMessageState(env, u.id, messageId, { archived: true, dismissAction: action });
    return json({ ok: true, data: { message_id: messageId, personal_state: true } });
  }

  const ttlDays = action === "archive" ? 90 : 7;

  const result = await env.DB.prepare(
    `UPDATE messages
     SET archived_at = COALESCE(archived_at, datetime('now')),
         dismiss_action = ?,
         expires_at = datetime('now', '+' || ? || ' days')
     WHERE user_id = ? AND (id = ? OR ${VERSIONS_OF_LATEST_SQL})`
  ).bind(action, ttlDays, u.id, messageId, messageId, u.id).run();

  if (result.meta.changes === 0) {
    const exists = await env.DB.prepare("SELECT id FROM messages WHERE id = ? AND user_id = ?")
      .bind(messageId, u.id).first();
    if (!exists) return json({ ok: false, error: "message not found" }, 404);
  }

  return json({ ok: true, data: { message_id: messageId, action, expires_in_days: ttlDays } });
}

// Toggle the pinned flag on a document message.
// Pinning clears expires_at (makes the message exempt from expiry cron).
// Unpinning does NOT restore expires_at — caller re-dismisses if needed.
export async function handlePinMessage(
  request: Request,
  env: Env,
  messageId: string
): Promise<Response> {
  const email = await verifySession(request.headers, env.SESSIONS, env);
  if (!email) return unauthorized();

  const u = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email.toLowerCase()).first<{ id: string }>();
  if (!u) return unauthorized();

  let pinned: boolean;
  try {
    const body = (await request.json()) as { pinned: boolean };
    if (typeof body.pinned !== "boolean") throw new Error();
    pinned = body.pinned;
  } catch {
    return json({ ok: false, error: "body must be { pinned: boolean }" }, 400);
  }

  const teamMessage = await loadTeamMessageForState(env, u.id, messageId);
  if (teamMessage === false) return json({ ok: false, error: "message not found" }, 404);
  if (teamMessage) {
    await setTeamMessageState(env, u.id, messageId, { pinned });
    return json({ ok: true, data: { message_id: messageId, personal_state: true } });
  }

  const result = await env.DB.prepare(
    `UPDATE messages
     SET pinned = ?,
         expires_at = CASE WHEN ? = 1 THEN NULL ELSE expires_at END
     WHERE id = ? AND user_id = ?`
  ).bind(pinned ? 1 : 0, pinned ? 1 : 0, messageId, u.id).run();

  if (result.meta.changes === 0) return json({ ok: false, error: "message not found" }, 404);

  return json({ ok: true, data: { message_id: messageId, pinned } });
}

async function getSharedMessages(request: Request, env: Env, userId: string): Promise<Response> {
  const url = new URL(request.url);
  const clauses = [messageReadSql("m"), "COALESCE(m.is_latest, 1) = 1"];
  const binds: (string | number)[] = [userId, userId, userId]; // state join precedes ACL binds
  if (url.searchParams.get("scope") !== "all") clauses.push("m.team_id IS NOT NULL");
  for (const field of ["team_id", "project_id", "type", "priority"] as const) {
    const value = url.searchParams.get(field);
    if (value) { clauses.push(`m.${field} = ?`); binds.push(value); }
  }
  if (url.searchParams.get("unread") === "true") clauses.push("CASE WHEN m.team_id IS NULL THEN m.read ELSE COALESCE(s.read, 0) END = 0");
  const archived = url.searchParams.get("archived");
  if (archived === "true" || archived === "false") clauses.push(`CASE WHEN m.team_id IS NULL THEN m.archived_at ELSE s.archived_at END IS ${archived === "true" ? "NOT " : ""}NULL`);
  const search = url.searchParams.get("q")?.trim();
  if (search) { clauses.push("(m.title LIKE ? OR m.body LIKE ?)"); binds.push(`%${search}%`, `%${search}%`); }
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  if(url.searchParams.get("type") === "document") editionLibraryQuery(env,{userId,type:"document",alias:"m",project:url.searchParams.get("library_project")||undefined,tag:url.searchParams.get("library_tag")||undefined},clauses,binds);
  const rows = await env.DB.prepare(`SELECT m.*, s.read AS personal_read, s.read_at AS personal_read_at,
    s.archived_at AS personal_archived_at, s.dismiss_action AS personal_dismiss_action, s.pinned AS personal_pinned
    FROM messages m LEFT JOIN message_user_state s ON s.message_id = m.id AND s.user_id = ?
    WHERE ${clauses.join(" AND ")} ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`)
    .bind(...binds, limit + 1, offset).all<Record<string, unknown>>();
  const page = rows.results.slice(0, limit);
  const library = await editionLibraryPlacements(env,userId,page.filter(row=>row.type === "document").map(row=>({type:"document",id:String(row.id)})));
  for(const row of page) if(library.has(`document:${row.id}`)) row.library=library.get(`document:${row.id}`);
  const blocks = await loadMessageBlocks(env, page.map(row => String(row.id)));
  const items = page.map(row => serializeMessage(row.team_id ? { ...row,
    read: row.personal_read || 0, read_at: row.personal_read_at, archived_at: row.personal_archived_at,
    dismiss_action: row.personal_dismiss_action, pinned: row.personal_pinned || 0, expires_at: null,
  } : row, undefined, blocks.get(String(row.id)) || []));
  const response = json({ ok: true, data: items });
  response.headers.set("X-Has-More", String(rows.results.length > limit));
  response.headers.set("X-Offset", String(offset));
  return response;
}
