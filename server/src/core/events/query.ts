import { contentPolicy } from "../content-policy";
import { resolveAgentCredential } from "../agent-board";
import { resolveCallerCredential, type CallerCredential } from "../middleware";
import { resolveOAuthUser } from "../routes/oauth";
import { checkRateLimit } from "../ratelimit";
import type { Env } from "../types";
import { EVENT_NAME } from "./emit";

/**
 * Who is reading events, and what they may see (GET /api/events and
 * the list_events tool). Nobody sees another team's events.
 *
 * - A person (session, API key, or OAuth token without an agent): every event
 *   of the teams they belong to (people can read every board and team message
 *   of their team, so that covers the events addressed to them and those of
 *   the agents they sponsor), plus their own personal events.
 * - An agent (Agent key, or OAuth token bound to an agent): posts and
 *   handoffs on boards it holds a grant for (a work board through its parent
 *   grant, as for reading the board), plus events addressed to it or caused
 *   by it. Not a team question's events on those boards: an agent key cannot
 *   read messages, so it does not see their ids or how they were answered.
 */
export type EventPrincipal =
  | { kind: "user"; userId: string; credential?: CallerCredential | "oauth" }
  | { kind: "agent"; agentId: string };

/** The rate-limit key for a principal's event reads. */
export const eventReadKey = (principal: EventPrincipal) =>
  `events-read:${principal.kind === "agent" ? `agent:${principal.agentId}` : `user:${principal.userId}`}`;

/** Event reads one principal may make in a window: GET /api/events, POST /api/events/wait and the wait_for_events tool share it. */
export const EVENT_READ_BURST = { max: 240, windowSeconds: 60 };

/** Counts one event read against the principal's burst; false when they have used it up. */
export const eventReadAllowed = (env: Env, principal: EventPrincipal) =>
  checkRateLimit(env, eventReadKey(principal), EVENT_READ_BURST.max, EVENT_READ_BURST.windowSeconds);

/** GET /api/events query: after, limit, kinds. Throws EventQueryError. */
export function eventsQuery(params: URLSearchParams): { after: number; limit: number; kinds: string[] } {
  return {
    after: parseCursor(params.get("after"), "after", 0, Number.MAX_SAFE_INTEGER),
    limit: parseCursor(params.get("limit"), "limit", EVENT_PAGE.default, EVENT_PAGE.max) || EVENT_PAGE.default,
    kinds: parseKinds(params.get("kinds")),
  };
}

/** GET /api/inbox query: team_id, unread=1, include=dismissed, limit, before. Throws EventQueryError. */
export function inboxQuery(params: URLSearchParams) {
  const id = /^[A-Za-z0-9_-]{1,64}$/;
  const teamId = params.get("team_id"), before = params.get("before");
  if ((teamId && !id.test(teamId)) || (before && !id.test(before))) throw new EventQueryError("team_id and before must be ids");
  return {
    teamId, before,
    limit: parseCursor(params.get("limit"), "limit", 50, 100) || 50,
    unreadOnly: params.get("unread") === "1",
    includeDismissed: params.get("include") === "dismissed",
  };
}

export class EventQueryError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export const EVENT_PAGE = { default: 50, max: 200 } as const;
/** Error text for agents and scripts; the web never shows these. */
export const EVENT_ERRORS = { readBurst: "Too many event reads in a short time. Try again in a minute." } as const;
const KIND_FILTER = /^[a-z]+(\.[a-z_]+)*\.\*$/;

/** Agent credentials first (an OAuth token bound to an agent reads as that agent), as handleMcp resolves them. */
export async function resolveEventPrincipal(request: Request, env: Env): Promise<EventPrincipal | null> {
  const agentAttempt = request.headers.get("Authorization")?.startsWith("Agent ") ?? false;
  const agent = await resolveAgentCredential(request.headers, env);
  if (agent) return { kind: "agent", agentId: agent.agentId };
  if (agentAttempt) return null;
  const caller = await resolveCallerCredential(request, env);
  if (caller) return { kind: "user", userId: caller.userId, credential: caller.via };
  const oauth = await resolveOAuthUser(request.headers, env);
  return oauth ? { kind: "user", userId: oauth.userId, credential: "oauth" } : null;
}

export interface EventView {
  seq: number;
  id: string;
  type: string;
  team_id: string | null;
  owner_user_id?: string;
  project_id: string | null;
  actor_ref: string | null;
  subject_ref: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

/** kinds: exact event names or prefixes ending in `.*` (handoff.* , member.*). */
export function parseKinds(value: string | string[] | null | undefined): string[] {
  if (value === null || value === undefined || value === "") return [];
  const kinds = (Array.isArray(value) ? value : value.split(",")).map((kind) => (typeof kind === "string" ? kind.trim() : ""));
  if (kinds.length > 20) throw new EventQueryError("kinds takes at most 20 names");
  for (const kind of kinds) {
    if (!EVENT_NAME.test(kind) && !KIND_FILTER.test(kind)) throw new EventQueryError(`invalid kind: ${kind || "(empty)"}`);
  }
  return [...new Set(kinds)];
}

export function parseCursor(value: unknown, field: string, fallback: number, max: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new EventQueryError(`${field} must be a whole number of 0 or more`);
  return Math.min(number, max);
}

// The boards an agent may read: its grants, with a work board reached only through its parent grant.
// What its grant shows of a board's events: the board's own posts.
/** The event types an agent sees on a board it may read (the live stream applies the same rule). */
export const AGENT_BOARD_EVENT_TYPES: ReadonlySet<string> = new Set(["board.posted", "handoff.posted"]);
const AGENT_BOARD_EVENTS = [...AGENT_BOARD_EVENT_TYPES].map((type) => `'${type}'`).join(", ");
/** Derived question snapshots need an artifact-aware event contract. Suppress
 * their events while keeping ordinary questions on the small query path. */
export function questionEventSourceSql(alias: string): string {
  return contentPolicy().questionSourceSql(alias);
}
/** Document/artifact events need their own ACL contract before they can be
 * exposed. Existing question events must still refer to a readable question. */
export function eventResourceReadSql(alias: string): string {
  return `(json_valid(${alias}.payload)
    AND json_type(${alias}.payload, '$.document_id') IS NULL AND json_type(${alias}.payload, '$.artifact_id') IS NULL
    AND ((${alias}.type IN ('member.joined', 'board.posted', 'handoff.posted') AND json_type(${alias}.payload, '$.message_id') IS NULL)
      OR (${alias}.type IN ('question.asked', 'question.replied') AND EXISTS (
        SELECT 1 FROM messages event_source WHERE event_source.id = json_extract(${alias}.payload, '$.message_id')
          AND ${questionEventSourceSql("event_source")} AND event_source.team_id IS ${alias}.team_id
          AND ((event_source.team_id IS NULL AND event_source.user_id = ? AND event_source.user_id = ${alias}.owner_user_id)
            OR EXISTS (SELECT 1 FROM team_memberships event_member JOIN users event_user ON event_user.id = event_member.user_id
              WHERE event_member.team_id = event_source.team_id AND event_member.user_id = ? AND event_user.status = 'active'))))))`;
}
const AGENT_READABLE = `SELECT g.project_id FROM agent_project_grants g
  JOIN projects p ON p.id = g.project_id AND p.team_id = ?
  LEFT JOIN agent_project_grants pg ON p.board_kind = 'work' AND pg.agent_id = g.agent_id AND pg.project_id = p.parent_project_id
  WHERE g.agent_id = ? AND (p.board_kind IS NOT 'work' OR pg.agent_id IS NOT NULL)`;

/**
 * The boards each of these agents may read in a team, as AGENT_READABLE
 * decides for one agent: binds [teamId, JSON array of agent ids].
 */
export const AGENTS_READABLE = `SELECT g.agent_id, g.project_id FROM agent_project_grants g
  JOIN projects p ON p.id = g.project_id AND p.team_id = ?
  LEFT JOIN agent_project_grants pg ON p.board_kind = 'work' AND pg.agent_id = g.agent_id AND pg.project_id = p.parent_project_id
  WHERE g.agent_id IN (SELECT value FROM json_each(?)) AND (p.board_kind IS NOT 'work' OR pg.agent_id IS NOT NULL)`;

/** The visibility condition on `events e` for a principal, with its binds. */
export async function eventVisibility(env: Env, principal: EventPrincipal): Promise<{ sql: string; binds: unknown[] } | null> {
  if (principal.kind === "user") {
    return {
      sql: `((e.team_id IN (SELECT tm.team_id FROM team_memberships tm WHERE tm.user_id = ?) OR e.owner_user_id = ?) AND ${eventResourceReadSql("e")})`,
      binds: [principal.userId, principal.userId, principal.userId, principal.userId],
    };
  }
  const agent = await env.DB.prepare("SELECT team_id FROM agent_identities WHERE id = ? AND status = 'active' AND kind = 'agent'")
    .bind(principal.agentId).first<{ team_id: string }>();
  if (!agent) return null;
  const ref = `agent:${principal.agentId}`;
  return {
    sql: `(e.team_id = ? AND json_valid(e.payload)
      AND e.type IN ('member.joined', ${AGENT_BOARD_EVENTS})
      AND json_type(e.payload, '$.document_id') IS NULL AND json_type(e.payload, '$.artifact_id') IS NULL AND json_type(e.payload, '$.message_id') IS NULL
      AND ((e.type IN (${AGENT_BOARD_EVENTS}) AND e.project_id IN (${AGENT_READABLE})) OR e.subject_ref = ? OR e.actor_ref = ?))`,
    binds: [agent.team_id, agent.team_id, principal.agentId, ref, ref],
  };
}

/**
 * Events after the `after` cursor (a seq; 0 for the start of what is kept),
 * oldest first, at most `limit`. next_cursor is the last seq returned, or
 * `after` when nothing matched: pass it back as `after` to continue, and no
 * event is skipped or repeated.
 */
export async function listEvents(env: Env, principal: EventPrincipal, input: {
  after?: number; kinds?: string[]; limit?: number;
}): Promise<{ events: EventView[]; next_cursor: number }> {
  const after = Math.max(0, Math.floor(input.after ?? 0));
  const limit = Math.max(1, Math.min(EVENT_PAGE.max, Math.floor(input.limit ?? EVENT_PAGE.default)));
  const visibility = await eventVisibility(env, principal);
  if (!visibility) return { events: [], next_cursor: after };
  const conditions = ["e.seq > ?", visibility.sql];
  const binds: unknown[] = [after, ...visibility.binds];
  addKindsCondition(conditions, binds, input.kinds ?? []);
  const { results } = await env.DB.prepare(`SELECT ${EVENT_COLUMNS}
    FROM events e WHERE ${conditions.join(" AND ")} ORDER BY e.seq LIMIT ?`)
    .bind(...binds, limit)
    .all<EventRowText>();
  const events = (results ?? []).map(eventView);
  return { events, next_cursor: events.at(-1)?.seq ?? after };
}

/** The columns of an event as the API returns it (payload still JSON text). */
export const EVENT_COLUMNS = `e.seq, e.id, e.type, e.team_id, e.owner_user_id, e.project_id,
      e.actor_ref, e.subject_ref, e.payload, e.created_at`;
export type EventRowText = Omit<EventView, "payload" | "owner_user_id"> & { payload: string; owner_user_id: string | null };

/** An events row as the API returns it: payload parsed, owner_user_id only on a personal event. */
export function eventView({ payload, owner_user_id: owner, ...row }: EventRowText): EventView {
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(payload); } catch { /* written by emitEvent as JSON */ }
  return { ...row, ...(owner ? { owner_user_id: owner } : {}), payload: parsed };
}

/** kinds: exact names, or prefixes ending in `.*`. Nothing is added for no kinds. */
function addKindsCondition(conditions: string[], binds: unknown[], kinds: string[]): void {
  if (!kinds.length) return;
  const exact = kinds.filter((kind) => !kind.endsWith(".*"));
  const prefixes = kinds.filter((kind) => kind.endsWith(".*")).map((kind) => kind.slice(0, -1));
  const parts: string[] = [];
  if (exact.length) { parts.push("e.type IN (SELECT value FROM json_each(?))"); binds.push(JSON.stringify(exact)); }
  for (const prefix of prefixes) { parts.push("substr(e.type, 1, ?) = ?"); binds.push(prefix.length, prefix); }
  conditions.push(`(${parts.join(" OR ")})`);
}

/**
 * One stream of events: a team's (team_id) or a person's own inbox's
 * (owner_user_id, events that belong to no team). The live stream and
 * waiting requests follow one stream at a time.
 */
export type EventStream = { teamId: string; ownerUserId?: undefined } | { teamId?: undefined; ownerUserId: string };

/** What a live socket or a waiting request asks for, on top of what its principal may see. */
export interface EventFilter {
  kinds: string[];
  project_id: string | null;
  /** Only events about this message (payload.message_id): waiting for one question's answer. */
  message_id: string | null;
}

/**
 * Events of one stream after `after` that the principal may see and the
 * filter matches (the same visibility as listEvents), plus head: the newest
 * seq in the stream when it was read, in the same transaction. Every visible
 * matching event up to head is either returned or, with newest, before the
 * returned ones (truncated). oldest first either way.
 *   newest: false  the oldest `limit` after the cursor (a page)
 *   newest: true   the newest `limit` after the cursor, and truncated when more matched (a socket's catch-up)
 */
export async function readStreamEvents(env: Env, principal: EventPrincipal, input: {
  stream: EventStream; after: number; filter: EventFilter; limit: number; newest?: boolean;
}): Promise<{ events: EventView[]; truncated: boolean; head: number }> {
  const streamSql = input.stream.teamId !== undefined ? "e.team_id = ?" : "e.owner_user_id = ?";
  const streamBind = input.stream.teamId ?? input.stream.ownerUserId;
  const head = env.DB.prepare(`SELECT COALESCE(MAX(e.seq), 0) AS head FROM events e WHERE ${streamSql}`).bind(streamBind);
  const visibility = await eventVisibility(env, principal);
  if (!visibility) {
    const row = await head.first<{ head: number }>();
    return { events: [], truncated: false, head: row?.head ?? 0 };
  }
  const conditions = ["e.seq > ?", streamSql, visibility.sql];
  const binds: unknown[] = [Math.max(0, Math.floor(input.after)), streamBind, ...visibility.binds];
  addKindsCondition(conditions, binds, input.filter.kinds);
  if (input.filter.project_id) { conditions.push("e.project_id = ?"); binds.push(input.filter.project_id); }
  if (input.filter.message_id) { conditions.push("json_extract(e.payload, '$.message_id') = ?"); binds.push(input.filter.message_id); }
  const limit = Math.max(1, Math.floor(input.limit));
  const [page, top] = await env.DB.batch([
    env.DB.prepare(`SELECT ${EVENT_COLUMNS} FROM events e WHERE ${conditions.join(" AND ")}
      ORDER BY e.seq ${input.newest ? "DESC" : "ASC"} LIMIT ?`).bind(...binds, input.newest ? limit + 1 : limit),
    head,
  ]);
  let rows = (page.results ?? []) as EventRowText[];
  const truncated = !!input.newest && rows.length > limit;
  if (input.newest) rows = rows.slice(0, limit).reverse();
  return { events: rows.map(eventView), truncated, head: (top.results?.[0] as { head: number } | undefined)?.head ?? 0 };
}

// ── Inbox items (migration 0064) ────────────────────────────────────────────

export interface InboxItemView {
  id: string;
  team_id: string;
  kind: string;
  event_id: string | null;
  event_type: string | null;
  title: string;
  body: string | null;
  link: string | null;
  created_at: string;
  read: boolean;
  read_at: string | null;
  dismissed_at: string | null;
}

// An event item's body can quote a post's topic (describeEvent); once an admin
// takes the post down (agent_board_moderation), the item no longer shows it.
const MODERATED_ENTRY = `EXISTS (SELECT 1 FROM agent_board_moderation m WHERE m.entry_id = json_extract(e.payload, '$.entry_id'))`;
const ITEM_BODY = `CASE WHEN i.kind = 'event' AND ${MODERATED_ENTRY} THEN NULL ELSE i.body END`;

/** Your inbox items in teams you still belong to, newest first. Dismissed ones only with includeDismissed. */
export async function listInboxItems(env: Env, userId: string, input: {
  teamId?: string | null; unreadOnly?: boolean; includeDismissed?: boolean; limit?: number; before?: string | null;
} = {}): Promise<{ items: InboxItemView[]; unread: number }> {
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)));
  const conditions = ["i.user_id = ?", "i.tombstoned_at IS NULL",
    "EXISTS (SELECT 1 FROM team_memberships tm WHERE tm.team_id = i.team_id AND tm.user_id = i.user_id)",
    `(i.event_id IS NULL OR EXISTS (SELECT 1 FROM events safe_event WHERE safe_event.id = i.event_id AND ${eventResourceReadSql("safe_event")}))`];
  const binds: unknown[] = [userId, userId, userId];
  if (input.teamId) { conditions.push("i.team_id = ?"); binds.push(input.teamId); }
  const unreadConditions = [...conditions, "i.dismissed_at IS NULL", "i.read_at IS NULL"];
  const unreadBinds = [...binds];
  if (!input.includeDismissed) conditions.push("i.dismissed_at IS NULL");
  if (input.unreadOnly) conditions.push("i.read_at IS NULL");
  if (input.before) {
    conditions.push("(i.created_at < (SELECT created_at FROM inbox_items WHERE id = ?) OR (i.created_at = (SELECT created_at FROM inbox_items WHERE id = ?) AND i.id < ?))");
    binds.push(input.before, input.before, input.before);
  }
  const [page, unread] = await env.DB.batch([
    env.DB.prepare(`SELECT i.id, i.team_id, i.kind, i.event_id, e.type AS event_type, i.title, ${ITEM_BODY} AS body, i.link, i.created_at,
        i.read_at, i.dismissed_at
      FROM inbox_items i LEFT JOIN events e ON e.id = i.event_id
      WHERE ${conditions.join(" AND ")} ORDER BY i.created_at DESC, i.id DESC LIMIT ?`).bind(...binds, limit),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM inbox_items i WHERE ${unreadConditions.join(" AND ")}`).bind(...unreadBinds),
  ]);
  const items = ((page.results ?? []) as Array<Omit<InboxItemView, "read">>).map((row) => ({ ...row, read: row.read_at !== null }));
  return { items, unread: (unread.results?.[0] as { n: number } | undefined)?.n ?? 0 };
}

/** read: marks it read (false: unread again); dismiss: hides it from the inbox and marks it read. Returns null when it is not yours. */
export async function updateInboxItem(env: Env, userId: string, itemId: string, change: { read?: boolean; dismiss?: boolean }):
  Promise<InboxItemView | null> {
  const sets: string[] = [];
  if (change.read === true || change.dismiss) sets.push("read_at = COALESCE(read_at, datetime('now'))");
  if (change.read === false) sets.push("read_at = NULL");
  if (change.dismiss) sets.push("dismissed_at = COALESCE(dismissed_at, datetime('now'))");
  if (!sets.length) return null;
  const row = await env.DB.prepare(`UPDATE inbox_items SET ${sets.join(", ")}
    WHERE id = ? AND user_id = ? AND tombstoned_at IS NULL
      AND EXISTS (SELECT 1 FROM team_memberships tm WHERE tm.team_id = inbox_items.team_id AND tm.user_id = inbox_items.user_id)
      AND (event_id IS NULL OR EXISTS (SELECT 1 FROM events safe_event WHERE safe_event.id = inbox_items.event_id AND ${eventResourceReadSql("safe_event")}))
    RETURNING id, team_id, kind, event_id, title, body, link, created_at, read_at, dismissed_at`)
    .bind(itemId, userId, userId, userId).first<Omit<InboxItemView, "read" | "event_type">>();
  if (!row) return null;
  const event = row.event_id
    ? await env.DB.prepare(`SELECT e.type, ${MODERATED_ENTRY} AS moderated FROM events e WHERE e.id = ?`).bind(row.event_id)
      .first<{ type: string; moderated: number }>()
    : null;
  const body = row.kind === "event" && event?.moderated ? null : row.body;
  return { ...row, body, event_type: event?.type ?? null, read: row.read_at !== null };
}
