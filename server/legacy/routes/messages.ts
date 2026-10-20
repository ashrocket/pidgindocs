import { Env, MessagePayload } from "../types";
import { deferOrAwait, json } from "../utils";
import { resolveApiKeyUser, verifySession, unauthorized, resolveCallerUserId } from "../middleware";
import { deliverToDestinations } from "../destinations";
import { appendLibraryFilters, loadLibraryPlacements, type LibraryPlacement } from "../library";
import { typesetDocument, renderMarkdownContent } from "../documents/typeset";
import type { MessageEnvelope } from "../destinations/types";
import {
  PublishInputError,
  parseEnhanceLevel,
  renderMarkdownDocument,
  sourceMarkdownKey,
  storeSourceMarkdown,
} from "../documents";
import {
  createMessage,
  loadMessageBlocks,
  MessageBlockInputError,
  type SerializedMessageBlock,
} from "../messages/store";
import { isEnhancementProviderConfigured } from "../enhance/provider";
import { removeRawTextElements } from "../html-text";

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
  return removeRawTextElements(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#\d+;/g, " ")
    .replace(/&amp;/gi, "&")
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
  blocks: SerializedMessageBlock[] = [],
  library?: LibraryPlacement
) {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const live = computeReplyStatus(row.type, row.reply ?? null, row.last_poll_at ?? null, now);
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body ?? null,
    doc_key: row.doc_key ?? null,
    reply: row.reply ?? null,
    replied_at: row.replied_at ?? null,
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
    ...(library ? { library } : {}),
  };
}

// Personal-library placement for the document rows of a list or detail.
async function loadDocumentPlacements(
  env: Env,
  userId: string,
  rows: Array<Record<string, unknown>>
): Promise<Map<string, LibraryPlacement>> {
  const refs = rows
    .filter((row) => row.type === "document")
    .map((row) => ({ type: "document" as const, id: String(row.id) }));
  return refs.length ? loadLibraryPlacements(env, userId, refs) : new Map();
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
  if (enhance && !isEnhancementProviderConfigured(env, enhance)) {
    return json(
      {
        ok: false,
        error: enhance === "research"
          ? "research enhancement requires ANTHROPIC_API_KEY to be configured on the server"
          : "enhancement requires a Workers AI binding or ANTHROPIC_API_KEY to be configured on the server",
      },
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
  if (payload.type === "document" && docHtml) docKey = `docs/${id}.html`;

  let created;
  try {
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

    created = await createMessage(
      env,
      {
        id,
        type: payload.type,
        title: payload.title,
        body: storedBody,
        docKey,
        priority: payload.priority,
        isPublic: payload.public,
        docSlug: payload.slug || (payload.type === "document" ? id : null),
        docVersion: payload.type === "document" ? 1 : null,
        designSystem: resolvedDesignSystem,
        enhanceStatus: enhance ? "queued" : null,
        enhanceLevel: enhance,
        sourceUrl: payload.source_url || null,
        interactive,
        teamId: payload.team_id ?? null,
        projectId: payload.project_id ?? null,
        docKind,
        docSize,
        sourceSize,
        instance: payload.instance,
        userId: authedUser.userId,
        blocks: payload.blocks,
      },
      ctx
    );
  } catch (err) {
    if (docKey) {
      await env.DOCS.delete(docKey).catch(() => {});
      const sourceKey = sourceMarkdownKey(docKey);
      if (sourceKey) await env.DOCS.delete(sourceKey).catch(() => {});
    }
    if (err instanceof MessageBlockInputError) {
      return json({ ok: false, error: err.message }, 400);
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

  return json({ ok: true, data: { id, type: payload.type } }, 201);
}

export async function handleGetMessages(
  request: Request,
  env: Env
): Promise<Response> {
  // Accept either session auth (human) or API key (bot checking replies)
  const sessionEmail = await verifySession(request.headers, env.SESSIONS);
  let userId: string | null = null;

  if (sessionEmail) {
    const u = await env.DB.prepare(
      `SELECT id, email FROM users WHERE email = ? AND status = 'active'`
    ).bind(sessionEmail.toLowerCase()).first<{ id: string; email: string }>();
    if (!u) return unauthorized();
    userId = u.id;
  } else {
    const authedUser = await resolveApiKeyUser(request.headers, env);
    if (!authedUser) return unauthorized();
    userId = authedUser.userId;
  }

  const url = new URL(request.url);
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

  // User scope: every row carries an owner; reads are strictly scoped by user_id.
  conditions.push("user_id = ?");
  binds.push(userId!);


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
  // Personal library filters (Docs tab): only documents carry placements.
  appendLibraryFilters(url, "document", "m", conditions, binds);

  let query = "SELECT * FROM messages m";
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
    env.DB.prepare("SELECT COUNT(*) as count FROM messages WHERE read = 0 AND user_id = ?")
      .bind(userId!)
      .first<{ count: number }>(),
  ]);

  const has_more = result.results.length > limit;
  const messages = has_more ? result.results.slice(0, limit) : result.results;
  const blockMap = await loadMessageBlocks(
    env,
    messages.map((row) => String((row as Record<string, unknown>).id))
  );

  const placements = await loadDocumentPlacements(env, userId!, messages as Array<Record<string, unknown>>);

  const now = Math.floor(Date.now() / 1000);
  const response = json({
    ok: true,
    data: messages.map((r) => {
      const id = String((r as Record<string, unknown>).id);
      return serializeMessage(r, now, blockMap.get(id) ?? [], placements.get(`document:${id}`));
    }),
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
    "UPDATE messages SET read = 1, read_at = datetime('now') WHERE read = 0 AND user_id = ?"
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

  const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ? AND user_id = ?")
    .bind(messageId, userId)
    .first<Record<string, unknown>>();

  if (!row) return json({ ok: false, error: "message not found" }, 404);

  const blocks = (await loadMessageBlocks(env, [messageId])).get(messageId) ?? [];
  const placements = await loadDocumentPlacements(env, userId, [row]);
  return json({ ok: true, data: serializeMessage(row, undefined, blocks, placements.get(`document:${messageId}`)) });
}

export async function handleArchiveMessage(
  request: Request,
  env: Env,
  messageId: string
): Promise<Response> {
  const email = await verifySession(request.headers, env.SESSIONS);
  if (!email) return unauthorized();

  const u = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email.toLowerCase()).first<{ id: string }>();
  if (!u) return unauthorized();

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

export async function handleUnarchiveMessage(
  request: Request,
  env: Env,
  messageId: string
): Promise<Response> {
  const email = await verifySession(request.headers, env.SESSIONS);
  if (!email) return unauthorized();

  const u = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email.toLowerCase()).first<{ id: string }>();
  if (!u) return unauthorized();

  const result = await env.DB.prepare(
    `UPDATE messages
     SET archived_at = NULL, dismiss_action = NULL, expires_at = NULL
     WHERE id = ? AND user_id = ?`
  ).bind(messageId, u.id).run();

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
  const email = await verifySession(request.headers, env.SESSIONS);
  if (!email) return unauthorized();

  const u = await env.DB.prepare("SELECT id, email FROM users WHERE email = ?")
    .bind(email.toLowerCase()).first<{ id: string; email: string }>();
  if (!u) return unauthorized();
  const ownerScope = "user_id = ?";

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

  // Scope the existence check (the sole 404 source) to the caller: a member
  // hitting another user's id finds no row and gets 404, never a silent
  // mark-read of someone else's message.
  const exists = await env.DB.prepare("SELECT id FROM messages WHERE id = ? AND user_id = ?")
    .bind(messageId, userId)
    .first();
  if (!exists) return json({ ok: false, error: "message not found" }, 404);

  let markRead = true;
  try {
    const body = await request.json() as { read?: boolean };
    if (body && body.read === false) markRead = false;
  } catch { /* no body = mark read */ }

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

  // Both the message read and the instance lookup are scoped to the caller.
  // For a foreign id the message SELECT returns null (-> 404 below). The
  // instance query scopes BOTH the inner subquery (which message_id resolves to
  // a session) AND the outer instances row by user_id: instance_id is globally
  // unique and re-registrable across tenants, so the outer clause prevents the
  // context from resolving another user's instance. Mirrors mcp.ts's
  // pidgin_get_message_context.
  const [message, instance] = await Promise.all([
    env.DB.prepare("SELECT * FROM messages WHERE id = ? AND user_id = ?")
      .bind(messageId, userId)
      .first<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT instance_id, model, project, working_on, source, registered_at, last_heartbeat
       FROM instances WHERE instance_id = (SELECT instance_session_id FROM messages WHERE id = ? AND user_id = ?) AND user_id = ?`
    ).bind(messageId, userId, userId).first<Record<string, unknown>>(),
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

  const result = await env.DB.prepare("UPDATE messages SET priority = ? WHERE id = ? AND user_id = ?")
    .bind(priority, messageId, userId)
    .run();

  if (result.meta.changes === 0) return json({ ok: false, error: "message not found" }, 404);
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
  const [stored, commute] = await Promise.all([
    env.DB.prepare(
    "SELECT doc_key FROM messages WHERE id = ? AND user_id = ?"
    ).bind(messageId, userId).first<{
      doc_key: string | null;
    }>(),
    env.DB.prepare(
      `SELECT cb.transcript_key, cb.audio_key, cb.metadata_key
       FROM commute_briefings cb JOIN messages m ON m.id = cb.source_message_id
       WHERE cb.source_message_id = ? AND m.user_id = ?`
    ).bind(messageId, userId).first<{
      transcript_key: string;
      audio_key: string | null;
      metadata_key: string | null;
    }>(),
  ]);

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

  const result = await env.DB.prepare("DELETE FROM messages WHERE id = ? AND user_id = ?")
    .bind(messageId, userId)
    .run();

  if (result.meta.changes === 0) return false;
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

  const message = await env.DB.prepare(
    "SELECT id, reply, replied_at FROM messages WHERE id = ? AND user_id = ?"
  )
    .bind(messageId, authedUser.userId)
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
  const email = await verifySession(request.headers, env.SESSIONS);
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

  const ttlDays = action === "archive" ? 90 : 7;

  const result = await env.DB.prepare(
    `UPDATE messages
     SET archived_at = COALESCE(archived_at, datetime('now')),
         dismiss_action = ?,
         expires_at = datetime('now', '+' || ? || ' days')
     WHERE id = ? AND user_id = ?`
  ).bind(action, ttlDays, messageId, u.id).run();

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
  const email = await verifySession(request.headers, env.SESSIONS);
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

  const result = await env.DB.prepare(
    `UPDATE messages
     SET pinned = ?,
         expires_at = CASE WHEN ? = 1 THEN NULL ELSE expires_at END
     WHERE id = ? AND user_id = ?`
  ).bind(pinned ? 1 : 0, pinned ? 1 : 0, messageId, u.id).run();

  if (result.meta.changes === 0) return json({ ok: false, error: "message not found" }, 404);

  return json({ ok: true, data: { message_id: messageId, pinned } });
}
