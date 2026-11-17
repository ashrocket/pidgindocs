import { AgentBoardInputError, parsePersonBoardPost } from "../agent-board";
import type { Env, WorkspaceRole } from "../types";
import { canAdminWorkspace, canWriteWorkspace, getWorkspaceMembership } from "../workspace";
import type { DeferredAction, DeferredActionRow, TriggerMatch } from "./dispatch";

/**
 * "When X happens, do Y" (deferred_actions, migration 0063). A member sets one
 * up for a trigger (an event type plus a match) and an action; the dispatcher
 * fires it at most once, for the first matching event recorded after it was
 * created (armed_after_seq) and before expires_at. Every field is checked
 * strictly; unknown fields are refused.
 *
 * - notify_user: an inbox item (and push) for yourself, or, for owners and
 *   admins, another member of the team.
 * - post_board_entry: an addressed board post made as you, through the same
 *   path as your own web post, on a board where you can post. Your role and
 *   the board are checked again when it fires. Only a signed-in session can
 *   schedule one: API keys and OAuth tokens never post as a person.
 *
 * Either kind fails when it fires if its creator could no longer act
 * themselves (suspended, hosted access lapsed, or no longer a member).
 */

export class DeferredActionError extends Error {
  constructor(message: string, public status: number, public limit?: string) { super(message); }
}

export const DEFERRED_ACTION_LIMITS = {
  maxDays: 90,
  armedPerUser: 50,
  armedPerTeam: 500,
  title: 120,
  body: 500,
} as const;

/** Which event types can trigger an action, and which match keys each accepts. */
export const DEFERRED_TRIGGERS: Record<string, ReadonlyArray<keyof TriggerMatch>> = {
  "member.joined": ["email", "user_id"],
  "board.posted": ["project_id", "user_id"],
  "handoff.posted": ["project_id", "user_id"],
  "question.replied": ["user_id", "project_id"],
};

export type DeferredCredential = "session" | "api";

/** A person's session (the web cookie or the edition's apps) may schedule posts; anything holding an API key is "api". */
export function deferredCredential(via: string): DeferredCredential {
  return via === "api_key" ? "api" : "session";
}

export interface DeferredActionView {
  id: string;
  team_id: string;
  created_by_user_id: string;
  trigger_type: string;
  trigger_match: TriggerMatch;
  action: DeferredAction;
  status: string;
  expires_at: string;
  fired_at: string | null;
  fired_event_id: string | null;
  error: string | null;
  created_at: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DeferredActionError(`${field} must be an object`, 400);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new DeferredActionError(`unknown ${field} field: ${unknown}`, 400);
}

function id(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new DeferredActionError(`${field} must be an id`, 400);
  return value;
}

function cleanText(value: unknown, field: string, max: number, singleLine: boolean): string {
  if (typeof value !== "string") throw new DeferredActionError(`${field} must be text`, 400);
  const cleaned = value.replace(/\r\n?/g, "\n").trim();
  if (!cleaned) throw new DeferredActionError(`${field} is required`, 400);
  if (cleaned.length > max) throw new DeferredActionError(`${field} must be ${max} characters or fewer`, 400);
  if (CONTROL_CHARS.test(cleaned) || (singleLine && cleaned.includes("\n"))) {
    throw new DeferredActionError(`${field} contains characters that are not allowed`, 400);
  }
  return cleaned;
}

const SQLITE_OR_ISO = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?$/;

/** expires_at: ISO 8601 (or the server's "YYYY-MM-DD HH:MM:SS" UTC), in the future and at most 90 days away. Stored as SQLite UTC text. */
export function parseExpiresAt(value: unknown, now = Date.now()): string {
  const match = typeof value === "string" ? SQLITE_OR_ISO.exec(value.trim()) : null;
  const ms = match ? Date.parse(`${match[1]}T${match[2]}${match[3] ?? ""}${match[4] ?? "Z"}`) : NaN;
  if (!Number.isFinite(ms)) throw new DeferredActionError("expires_at must be an ISO 8601 date and time", 400);
  if (ms <= now + 60_000) throw new DeferredActionError("expires_at must be at least a minute in the future", 400);
  if (ms > now + DEFERRED_ACTION_LIMITS.maxDays * 86_400_000) {
    throw new DeferredActionError(`expires_at must be within ${DEFERRED_ACTION_LIMITS.maxDays} days`, 400);
  }
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function parseTriggerMatch(triggerType: string, value: unknown): TriggerMatch {
  const allowed = DEFERRED_TRIGGERS[triggerType];
  const input = object(value, "trigger_match");
  onlyKeys(input, allowed, "trigger_match");
  const match: TriggerMatch = {};
  if (input.email !== undefined) {
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    if (email.length > 254 || !EMAIL.test(email)) throw new DeferredActionError("trigger_match.email must be an email address", 400);
    match.email = email;
  }
  if (input.user_id !== undefined) match.user_id = id(input.user_id, "trigger_match.user_id");
  if (input.project_id !== undefined) match.project_id = id(input.project_id, "trigger_match.project_id");
  if (!Object.keys(match).length) throw new DeferredActionError(`trigger_match needs one of: ${allowed.join(", ")}`, 400);
  if (triggerType === "member.joined" && match.email && match.user_id) {
    throw new DeferredActionError("trigger_match for member.joined takes email or user_id, not both", 400);
  }
  return match;
}

async function activeMember(env: Env, teamId: string, userId: string): Promise<boolean> {
  return !!await env.DB.prepare(`SELECT 1 AS ok FROM team_memberships tm JOIN users u ON u.id = tm.user_id AND u.status = 'active'
    WHERE tm.team_id = ? AND tm.user_id = ?`).bind(teamId, userId).first();
}

/** A board of this team that takes posts now: not archived and, for a work board, not closed. */
async function assertOpenBoard(env: Env, teamId: string, projectId: string): Promise<void> {
  const board = await env.DB.prepare(`SELECT archived_at,
      (board_kind = 'work' AND (datetime(expires_at) <= datetime('now')
        OR EXISTS (SELECT 1 FROM projects parent WHERE parent.id = projects.parent_project_id AND parent.archived_at IS NOT NULL))) AS closed
    FROM projects WHERE id = ? AND team_id = ?`).bind(projectId, teamId).first<{ archived_at: string | null; closed: number }>();
  if (!board) throw new DeferredActionError("project_id must be a board of this team", 400);
  if (board.archived_at || board.closed) throw new DeferredActionError("that board is archived or closed", 400);
}

async function parseAction(env: Env, input: {
  value: unknown; teamId: string; triggerType: string; actorUserId: string; actorRole: WorkspaceRole; credential: DeferredCredential;
}): Promise<DeferredAction> {
  const action = object(input.value, "action");
  if (action.kind === "notify_user") {
    onlyKeys(action, ["kind", "user_id", "title", "body"], "action");
    const userId = action.user_id === undefined ? undefined : id(action.user_id, "action.user_id");
    if (userId && userId !== input.actorUserId) {
      if (!canAdminWorkspace(input.actorRole)) {
        throw new DeferredActionError("Only team owners and admins can set up a notification for someone else.", 403);
      }
      if (!await activeMember(env, input.teamId, userId)) throw new DeferredActionError("action.user_id must be a member of this team", 400);
    }
    return {
      kind: "notify_user",
      ...(userId ? { user_id: userId } : {}),
      title: cleanText(action.title, "action.title", DEFERRED_ACTION_LIMITS.title, true),
      ...(action.body !== undefined ? { body: cleanText(action.body, "action.body", DEFERRED_ACTION_LIMITS.body, false) } : {}),
    };
  }
  if (action.kind === "post_board_entry") {
    onlyKeys(action, ["kind", "project_id", "post_kind", "topic", "body", "reference", "to"], "action");
    if (input.credential !== "session") {
      throw new DeferredActionError("Only a signed-in person can schedule a board post; API keys and OAuth tokens never post as a person.", 403);
    }
    const projectId = id(action.project_id, "action.project_id");
    await assertOpenBoard(env, input.teamId, projectId);
    if (typeof action.to !== "string" || !action.to.trim()) {
      throw new DeferredActionError('action.to is required: "subject" (whom the event is about) or agent:<slug>, user:<email> or user:<id>', 400);
    }
    const to = action.to.trim();
    // Shape checks only: the recipient, the board and your role are checked when it fires.
    let post;
    try {
      post = parsePersonBoardPost({
        kind: action.post_kind, topic: action.topic, body: action.body, reference: action.reference,
        to: to === "subject" ? "user:subject" : to,
      });
    } catch (error) {
      if (error instanceof AgentBoardInputError) throw new DeferredActionError(error.message.replace(/^kind /, "post_kind "), 400);
      throw error;
    }
    if (to !== "subject" && !/^(user|agent):\S+$/i.test(to)) {
      throw new DeferredActionError('action.to must be "subject", agent:<slug>, user:<email> or user:<id>', 400);
    }
    return {
      kind: "post_board_entry", project_id: projectId, post_kind: post.kind as "h" | "n" | "b",
      topic: post.topic, body: post.body, ...(post.reference ? { reference: post.reference } : {}), to,
    };
  }
  throw new DeferredActionError("action.kind must be notify_user or post_board_entry", 400);
}

function view(row: DeferredActionRow & { fired_at: string | null; fired_event_id: string | null; error: string | null }): DeferredActionView {
  return {
    id: row.id, team_id: row.team_id, created_by_user_id: row.created_by_user_id, trigger_type: row.trigger_type,
    trigger_match: JSON.parse(row.trigger_match), action: JSON.parse(row.action), status: row.status,
    expires_at: row.expires_at, fired_at: row.fired_at, fired_event_id: row.fired_event_id, error: row.error, created_at: row.created_at,
  };
}

const COLUMNS = `id, team_id, created_by_user_id, trigger_type, trigger_match, action, status, expires_at, fired_at,
  fired_event_id, error, created_at`;

export async function createDeferredAction(env: Env, input: {
  actorUserId: string; credential: DeferredCredential; body: unknown; now?: number;
}): Promise<DeferredActionView> {
  const body = object(input.body, "request body");
  onlyKeys(body, ["team_id", "trigger_type", "trigger_match", "action", "expires_at"], "request");
  const teamId = id(body.team_id, "team_id");
  const role = (await getWorkspaceMembership(env, teamId, input.actorUserId))?.role ?? null;
  if (!role) throw new DeferredActionError("Team not found.", 404);
  if (!canWriteWorkspace(role)) throw new DeferredActionError("Viewers cannot set up actions.", 403);
  if (typeof body.trigger_type !== "string" || !Object.hasOwn(DEFERRED_TRIGGERS, body.trigger_type)) {
    throw new DeferredActionError(`trigger_type must be one of: ${Object.keys(DEFERRED_TRIGGERS).join(", ")}`, 400);
  }
  const triggerType = body.trigger_type;
  const match = parseTriggerMatch(triggerType, body.trigger_match);
  if (match.project_id) {
    const project = await env.DB.prepare("SELECT 1 AS ok FROM projects WHERE id = ? AND team_id = ?").bind(match.project_id, teamId).first();
    if (!project) throw new DeferredActionError("trigger_match.project_id must be a project of this team", 400);
  }
  const action = await parseAction(env, {
    value: body.action, teamId, triggerType, actorUserId: input.actorUserId, actorRole: role, credential: input.credential,
  });
  const expiresAt = parseExpiresAt(body.expires_at, input.now);
  const actionId = crypto.randomUUID().replace(/-/g, "");
  const limits = DEFERRED_ACTION_LIMITS;
  // The caps and the creator's role are checked in the statement that inserts, so concurrent creates cannot overshoot.
  // armed_after_seq is read in the same statement: only events recorded after it can fire the action.
  const [inserted] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO deferred_actions (id, team_id, created_by_user_id, trigger_type, trigger_match, action, expires_at,
        armed_after_seq)
      SELECT ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) FROM events)
      WHERE (SELECT COUNT(*) FROM deferred_actions WHERE created_by_user_id = ? AND status = 'armed') < ?
        AND (SELECT COUNT(*) FROM deferred_actions WHERE team_id = ? AND status = 'armed') < ?
        AND EXISTS (SELECT 1 FROM team_memberships WHERE team_id = ? AND user_id = ? AND role IN ('owner', 'admin', 'member'))`)
      .bind(actionId, teamId, input.actorUserId, triggerType, JSON.stringify(match), JSON.stringify(action), expiresAt,
        input.actorUserId, limits.armedPerUser, teamId, limits.armedPerTeam, teamId, input.actorUserId),
    env.DB.prepare(`INSERT INTO audit_log (action, instance_id, details, user_id)
      SELECT 'deferred_action.created', ?, ?, ? WHERE EXISTS (SELECT 1 FROM deferred_actions WHERE id = ?)`)
      .bind(actionId, JSON.stringify({ team_id: teamId, trigger_type: triggerType, action: action.kind }), input.actorUserId, actionId),
  ]);
  if (!inserted.meta?.changes) {
    const counts = await env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM deferred_actions WHERE created_by_user_id = ? AND status = 'armed') AS mine,
        (SELECT COUNT(*) FROM deferred_actions WHERE team_id = ? AND status = 'armed') AS team`)
      .bind(input.actorUserId, teamId).first<{ mine: number; team: number }>();
    if ((counts?.mine ?? 0) >= limits.armedPerUser) {
      throw new DeferredActionError(`You already have ${limits.armedPerUser} actions waiting. Cancel one first.`, 429, "deferred_actions_user");
    }
    if ((counts?.team ?? 0) >= limits.armedPerTeam) {
      throw new DeferredActionError(`This team already has ${limits.armedPerTeam} actions waiting. Cancel one first.`, 429, "deferred_actions_team");
    }
    throw new DeferredActionError("Viewers cannot set up actions.", 403);
  }
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM deferred_actions WHERE id = ?`).bind(actionId)
    .first<DeferredActionRow & { fired_at: string | null; fired_event_id: string | null; error: string | null }>();
  return view(row!);
}

/** Your own actions in a team (or every team); with `all`, an owner or admin sees the whole team's. */
export async function listDeferredActions(env: Env, input: {
  actorUserId: string; teamId?: string | null; status?: string | null; all?: boolean;
}): Promise<DeferredActionView[]> {
  const statuses = ["armed", "fired", "failed", "cancelled", "expired"];
  if (input.status && !statuses.includes(input.status)) throw new DeferredActionError(`status must be one of: ${statuses.join(", ")}`, 400);
  const conditions: string[] = ["EXISTS (SELECT 1 FROM team_memberships tm WHERE tm.team_id = d.team_id AND tm.user_id = ?)"];
  const binds: unknown[] = [input.actorUserId];
  if (input.teamId) { conditions.push("d.team_id = ?"); binds.push(id(input.teamId, "team_id")); }
  if (input.all) {
    if (!input.teamId) throw new DeferredActionError("all needs team_id", 400);
    const role = (await getWorkspaceMembership(env, input.teamId, input.actorUserId))?.role ?? null;
    if (!canAdminWorkspace(role)) throw new DeferredActionError("Only team owners and admins can list everyone's actions.", 403);
  } else {
    conditions.push("d.created_by_user_id = ?");
    binds.push(input.actorUserId);
  }
  if (input.status) { conditions.push("d.status = ?"); binds.push(input.status); }
  const { results } = await env.DB.prepare(`SELECT ${COLUMNS} FROM deferred_actions d WHERE ${conditions.join(" AND ")}
    ORDER BY d.created_at DESC, d.id DESC LIMIT 200`).bind(...binds)
    .all<DeferredActionRow & { fired_at: string | null; fired_event_id: string | null; error: string | null }>();
  return (results ?? []).map(view);
}

/** Cancels a waiting action: its creator, or an owner or admin of its team. Cancelling one that already fired changes nothing. */
export async function cancelDeferredAction(env: Env, input: { actorUserId: string; id: string }): Promise<DeferredActionView> {
  const actionId = id(input.id, "id");
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM deferred_actions WHERE id = ?`).bind(actionId)
    .first<DeferredActionRow & { fired_at: string | null; fired_event_id: string | null; error: string | null }>();
  const role = row ? (await getWorkspaceMembership(env, row.team_id, input.actorUserId))?.role ?? null : null;
  if (!row || !role || (row.created_by_user_id !== input.actorUserId && !canAdminWorkspace(role))) {
    throw new DeferredActionError("Action not found.", 404);
  }
  // The audit row first, under the same condition as the cancel, so only a cancel that happens is recorded.
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO audit_log (action, instance_id, details, user_id) SELECT 'deferred_action.cancelled', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM deferred_actions WHERE id = ? AND status = 'armed')`)
      .bind(actionId, JSON.stringify({ team_id: row.team_id }), input.actorUserId, actionId),
    env.DB.prepare("UPDATE deferred_actions SET status = 'cancelled' WHERE id = ? AND status = 'armed'").bind(actionId),
  ]);
  const updated = await env.DB.prepare(`SELECT ${COLUMNS} FROM deferred_actions WHERE id = ?`).bind(actionId)
    .first<DeferredActionRow & { fired_at: string | null; fired_event_id: string | null; error: string | null }>();
  return view(updated!);
}
