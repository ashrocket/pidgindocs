import { auditStatement, BoardCapError, boardCapFromError, slugify } from "./agent-board";
import { AGENT_GRANT_LIMIT, countedGrantsSql } from "./member-access";
import { assertTenantWritable } from "./edition-hooks";
import { canAdminWorkspace, canWriteWorkspace, getWorkspaceMembership } from "./workspace";
import type { AgentProjectPermission, Env, WorkspaceRole } from "./types";

// Work boards are short-lived boards that agents open under a project (or the
// Bulletin board) for one piece of work. Caps are enforced by triggers in
// migration 0047 and tuned in agent_work_board_caps; this module checks
// permissions first so callers get a precise error.

/** 400 invalid input, 403 forbidden, 404 missing, 409 closed. */
export class WorkBoardError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export interface WorkBoardCaps {
  per_team: number;
  per_agent: number;
  per_parent: number;
  default_ttl_days: number;
  max_ttl_days: number;
  idle_days: number;
  delete_after_days: number;
}

export interface WorkBoard {
  id: string;
  team_id: string;
  slug: string;
  name: string;
  purpose: string | null;
  board_kind: "work";
  parent_project_id: string;
  created_by_agent_id: string | null;
  created_by_user_id: string;
  created_at: string;
  expires_at: string;
  last_post_at: string | null;
  archived_at: string | null;
}

export interface AgentBoardSummary {
  project_id: string;
  name: string;
  slug: string;
  board_kind: "project" | "commons" | "work";
  permission: AgentProjectPermission;
  parent_project_id: string | null;
  expires_at: string | null;
  archived: boolean;
  /** The board's whole day, people included. */
  posts_today: number;
  posts_cap: number | null;
  bytes_today: number;
  bytes_cap: number | null;
  /** Agents stop here; the rest of the day is kept for people. */
  agents_posts_cap: number | null;
  agents_bytes_cap: number | null;
  /** This agent's own share of the board today. */
  own_posts_today: number;
  own_posts_cap: number | null;
  own_bytes_today: number;
  own_bytes_cap: number | null;
}

export interface JoinableWorkBoard extends Omit<AgentBoardSummary, "permission" | "archived" | `own_${string}`> {
  purpose: string | null;
}

export interface AgentBoardsListing {
  boards: AgentBoardSummary[];
  joinable_work_boards: JoinableWorkBoard[];
  quotas: {
    work_boards_team: { used: number; limit: number };
    work_boards_agent: { used: number; limit: number };
  };
}

const DEFAULT_CAPS: WorkBoardCaps = {
  per_team: 10, per_agent: 3, per_parent: 5, default_ttl_days: 7, max_ttl_days: 14, idle_days: 7, delete_after_days: 30,
};
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const WORK_BOARD_COLUMNS = `id, team_id, slug, name, description AS purpose, board_kind, parent_project_id,
  created_by_agent_id, created_by_user_id, created_at, expires_at, last_post_at, archived_at`;
const EXPIRED = (alias: string) => `datetime(${alias}.expires_at) <= datetime('now')`;
const USAGE_COLUMNS = `COALESCE(us.posts, 0) AS posts_today, c.posts_per_day AS posts_cap,
  COALESCE(us.bytes, 0) AS bytes_today, c.bytes_per_day AS bytes_cap,
  c.posts_per_day - c.people_reserve_posts AS agents_posts_cap, c.bytes_per_day - c.people_reserve_bytes AS agents_bytes_cap`;
const USAGE_JOINS = (alias: string) => `LEFT JOIN agent_board_usage us ON us.project_id = ${alias}.id AND us.day = date('now')
  LEFT JOIN agent_board_caps c ON c.board_kind = ${alias}.board_kind`;
const OWN_USAGE_COLUMNS = `COALESCE(au.posts, 0) AS own_posts_today, c.author_posts_per_day AS own_posts_cap,
  COALESCE(au.bytes, 0) AS own_bytes_today, c.author_bytes_per_day AS own_bytes_cap`;
const OWN_USAGE_JOIN = (alias: string, agent: string) =>
  `LEFT JOIN agent_board_author_usage au ON au.project_id = ${alias}.id AND au.agent_id = ${agent} AND au.day = date('now')`;
/** A work board under an archived parent is closed too. */
const PARENT_ARCHIVED = (alias: string) =>
  `EXISTS (SELECT 1 FROM projects parent WHERE parent.id = ${alias}.parent_project_id AND parent.archived_at IS NOT NULL)`;

export async function getWorkBoardCaps(env: Env): Promise<WorkBoardCaps> {
  return await env.DB.prepare(`SELECT per_team, per_agent, per_parent, default_ttl_days, max_ttl_days, idle_days,
      delete_after_days FROM agent_work_board_caps WHERE id = 1`).first<WorkBoardCaps>() ?? DEFAULT_CAPS;
}

interface AgentContext {
  id: string;
  team_id: string;
  created_by_user_id: string;
  role: WorkspaceRole | null;
}

async function requireAgent(env: Env, agentId: string): Promise<AgentContext> {
  const agent = await env.DB.prepare(`SELECT a.id, a.team_id, a.created_by_user_id, m.role
    FROM agent_identities a
    LEFT JOIN team_memberships m ON m.team_id = a.team_id AND m.user_id = a.created_by_user_id
    WHERE a.id = ? AND a.kind = 'agent' AND a.status = 'active'`).bind(agentId).first<AgentContext>();
  if (!agent || !agent.role) throw new WorkBoardError("Agent not found.", 404);
  return agent;
}

// The sponsor's current role caps the grant, as posting does.
async function agentPermission(env: Env, agent: AgentContext, projectId: string): Promise<AgentProjectPermission | null> {
  const grant = await env.DB.prepare("SELECT permission FROM agent_project_grants WHERE agent_id = ? AND project_id = ?")
    .bind(agent.id, projectId).first<{ permission: AgentProjectPermission }>();
  if (!grant) return null;
  return canWriteWorkspace(agent.role) ? grant.permission : "read";
}

function cleanText(value: unknown, name: string, max: number, required: boolean, multiline = false): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new WorkBoardError(`${name} is required`, 400);
    return null;
  }
  if (typeof value !== "string") throw new WorkBoardError(`${name} must be a string`, 400);
  const cleaned = value.replace(/\r\n?/g, "\n").trim();
  if (!cleaned) {
    if (required) throw new WorkBoardError(`${name} is required`, 400);
    return null;
  }
  if (cleaned.length > max) throw new WorkBoardError(`${name} exceeds ${max} characters`, 400);
  if (CONTROL_CHARS.test(multiline ? cleaned.replace(/\n/g, "") : cleaned)) {
    throw new WorkBoardError(`${name} must not contain control characters${multiline ? "" : " or line breaks"}`, 400);
  }
  return cleaned;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadWorkBoard(env: Env, id: string): Promise<WorkBoard | null> {
  return await env.DB.prepare(`SELECT ${WORK_BOARD_COLUMNS} FROM projects WHERE id = ? AND board_kind = 'work'`)
    .bind(id).first<WorkBoard>();
}

function capError(error: unknown): Error | null {
  const limit = boardCapFromError(error);
  if (!limit) return null;
  if (limit === "work_board_parent") return new WorkBoardError("The parent must be a project or the Bulletin board of this team.", 400);
  if (limit === "work_board_closed" || limit === "board_kind_immutable") return new WorkBoardError("This work board is closed.", 409);
  return new BoardCapError(limit);
}

/**
 * An agent opens a work board under a project (or the Bulletin board) it can
 * write. The board expires after ttlDays (default and maximum from the caps
 * table) and the creator is granted write.
 */
export async function createWorkBoard(env: Env, input: {
  agentId: string; parentProjectId: string; name: string; purpose?: string | null; ttlDays?: number | null;
}): Promise<WorkBoard> {
  const agent = await requireAgent(env, input.agentId);
  await assertTenantWritable(env);
  const parent = typeof input.parentProjectId === "string" && input.parentProjectId
    ? await env.DB.prepare("SELECT id, team_id, board_kind, archived_at FROM projects WHERE id = ?")
      .bind(input.parentProjectId).first<{ id: string; team_id: string; board_kind: string; archived_at: string | null }>()
    : null;
  if (!parent || parent.team_id !== agent.team_id) throw new WorkBoardError("Parent project not found.", 404);
  if (parent.board_kind === "work") throw new WorkBoardError("A work board cannot hold another work board.", 400);
  if (parent.archived_at) throw new WorkBoardError("The parent project is archived.", 409);
  if (await agentPermission(env, agent, parent.id) !== "write") {
    throw new WorkBoardError("The agent needs write access to the parent project.", 403);
  }
  const name = cleanText(input.name, "name", 80, true)!;
  const purpose = cleanText(input.purpose, "purpose", 300, false, true);
  const caps = await getWorkBoardCaps(env);
  if (input.ttlDays !== undefined && input.ttlDays !== null && (typeof input.ttlDays !== "number" || !Number.isFinite(input.ttlDays))) {
    throw new WorkBoardError("ttl_days must be a number of days", 400);
  }
  const ttlDays = input.ttlDays === undefined || input.ttlDays === null
    ? caps.default_ttl_days : Math.min(caps.max_ttl_days, Math.max(1, Math.floor(input.ttlDays)));
  const base = slugify(name).slice(0, 48).replace(/-+$/, "");

  for (let attempt = 0; ; attempt += 1) {
    const id = crypto.randomUUID().replace(/-/g, "");
    const slug = `work-${base}-${randomHex(2)}`;
    const exists = "EXISTS (SELECT 1 FROM projects WHERE id = ?)";
    let results: D1Result[];
    try {
      results = await env.DB.batch([
        // Expired boards stop counting toward the caps before the lifecycle job archives them.
        env.DB.prepare(`UPDATE projects SET archived_at = datetime('now'), updated_at = datetime('now')
          WHERE team_id = ? AND board_kind = 'work' AND archived_at IS NULL AND datetime(expires_at) <= datetime('now')`)
          .bind(agent.team_id),
        // Written only while the creator has room for one more grant; the grant needs the board.
        env.DB.prepare(`INSERT INTO projects (id, team_id, slug, name, description, created_by_user_id, board_kind,
            parent_project_id, created_by_agent_id, expires_at)
          SELECT ?, ?, ?, ?, ?, ?, 'work', ?, ?, datetime('now', ?)
          WHERE ${countedGrantsSql("?")} < ?`)
          .bind(id, agent.team_id, slug, name, purpose, agent.created_by_user_id, parent.id, agent.id,
            `+${ttlDays} days`, agent.id, AGENT_GRANT_LIMIT),
        env.DB.prepare(`INSERT INTO agent_project_grants (agent_id, project_id, permission, created_by_user_id)
          SELECT ?, ?, 'write', ? WHERE ${exists}`).bind(agent.id, id, agent.created_by_user_id, id),
        env.DB.prepare(`INSERT INTO audit_log (action, instance_id, details, user_id) SELECT ?, ?, ?, ? WHERE ${exists}`)
          .bind("agent_board.work_board_created", agent.id,
            JSON.stringify({ team_id: agent.team_id, project_id: id, parent_project_id: parent.id, ttl_days: ttlDays }),
            agent.created_by_user_id, id),
      ]);
    } catch (error) {
      const mapped = capError(error);
      if (mapped) throw mapped;
      if (attempt < 2 && /UNIQUE constraint failed: projects\./.test(error instanceof Error ? error.message : String(error))) continue;
      throw error;
    }
    if (!results[1]?.meta?.changes) throw new BoardCapError("agent_grants");
    const board = await loadWorkBoard(env, id);
    if (!board) throw new Error("created work board could not be loaded");
    return board;
  }
}

/** An agent that can write the parent joins a work board (write). Idempotent. */
export async function joinWorkBoard(env: Env, input: { agentId: string; workBoardId: string }): Promise<WorkBoard> {
  const agent = await requireAgent(env, input.agentId);
  const board = await loadWorkBoard(env, input.workBoardId);
  if (!board || board.team_id !== agent.team_id) throw new WorkBoardError("Work board not found.", 404);
  const closed = await env.DB.prepare(`SELECT (p.archived_at IS NOT NULL OR ${EXPIRED("p")} OR ${PARENT_ARCHIVED("p")}) AS closed
    FROM projects p WHERE p.id = ?`).bind(board.id).first<{ closed: number }>();
  if (closed?.closed) throw new WorkBoardError("This work board is closed.", 409);
  if (await agentPermission(env, agent, board.parent_project_id) !== "write") {
    throw new WorkBoardError("The agent needs write access to the work board's parent project.", 403);
  }
  if (await agentPermission(env, agent, board.id) === "write") return board;
  await assertTenantWritable(env);
  const result = await env.DB.prepare(`INSERT INTO agent_project_grants (agent_id, project_id, permission, created_by_user_id)
    SELECT ?, ?, 'write', ? WHERE ${countedGrantsSql("?", "?")} < ?
    ON CONFLICT(agent_id, project_id) DO UPDATE SET permission = 'write'`)
    .bind(agent.id, board.id, agent.created_by_user_id, agent.id, board.id, AGENT_GRANT_LIMIT).run();
  if (!result.meta?.changes) throw new BoardCapError("agent_grants");
  await auditStatement(env, "agent_board.work_board_joined", agent.id,
    { team_id: agent.team_id, project_id: board.id }, agent.created_by_user_id).run();
  return board;
}

/**
 * Closes (archives) a work board. Allowed for the agent that created it, that
 * agent's sponsor, or a team owner/admin. A closed work board never reopens.
 */
export async function closeWorkBoard(env: Env, input: {
  agentId?: string; userId?: string; workBoardId: string;
}): Promise<WorkBoard> {
  const board = await loadWorkBoard(env, input.workBoardId);
  let actorUserId: string;
  if (input.agentId) {
    const agent = await requireAgent(env, input.agentId);
    if (!board || board.team_id !== agent.team_id) throw new WorkBoardError("Work board not found.", 404);
    if (board.created_by_agent_id !== agent.id) throw new WorkBoardError("Only the agent that opened this work board can close it.", 403);
    actorUserId = agent.created_by_user_id;
  } else if (input.userId) {
    const role = board ? (await getWorkspaceMembership(env, board.team_id, input.userId))?.role ?? null : null;
    if (!board || !role) throw new WorkBoardError("Work board not found.", 404);
    const sponsor = board.created_by_agent_id ? await env.DB.prepare("SELECT created_by_user_id FROM agent_identities WHERE id = ?")
      .bind(board.created_by_agent_id).first<{ created_by_user_id: string }>() : null;
    if (!canAdminWorkspace(role) && sponsor?.created_by_user_id !== input.userId) {
      throw new WorkBoardError("Only the agent's sponsor or a team admin can close this work board.", 403);
    }
    actorUserId = input.userId;
  } else {
    throw new WorkBoardError("An agent or a user must close the work board.", 400);
  }
  if (!board.archived_at) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE projects SET archived_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND archived_at IS NULL`).bind(board.id),
      auditStatement(env, "agent_board.work_board_closed", input.agentId ?? board.id,
        { team_id: board.team_id, project_id: board.id, ...(input.agentId ? {} : { by_user: true }) }, actorUserId),
    ]);
  }
  return (await loadWorkBoard(env, board.id))!;
}

/** Boards an agent can use, work boards it may join, and work-board quotas. */
export async function listAgentBoards(env: Env, agentId: string): Promise<AgentBoardsListing> {
  const agent = await requireAgent(env, agentId);
  const caps = await getWorkBoardCaps(env);
  const writable = canWriteWorkspace(agent.role);
  const active = (alias: string) => `${alias}.board_kind = 'work' AND ${alias}.archived_at IS NULL AND NOT ${EXPIRED(alias)}`;
  // A work board is reached through its parent grant (as resolveAgentBoardPrincipal
  // enforces): without one it is not listed, and a read parent makes it read.
  const [boards, joinable, team, own] = await env.DB.batch([
    env.DB.prepare(`SELECT p.id AS project_id, p.name, p.slug, p.board_kind,
        CASE WHEN p.board_kind = 'work' AND pg.permission <> 'write' THEN 'read' ELSE g.permission END AS permission,
        p.parent_project_id, p.expires_at,
        (p.archived_at IS NOT NULL OR (p.board_kind = 'work' AND (${EXPIRED("p")} OR ${PARENT_ARCHIVED("p")}))) AS archived,
        ${USAGE_COLUMNS}, ${OWN_USAGE_COLUMNS}
      FROM agent_project_grants g JOIN projects p ON p.id = g.project_id AND p.team_id = ?
      LEFT JOIN agent_project_grants pg ON p.board_kind = 'work' AND pg.agent_id = g.agent_id AND pg.project_id = p.parent_project_id
      ${USAGE_JOINS("p")}
      ${OWN_USAGE_JOIN("p", "g.agent_id")}
      WHERE g.agent_id = ? AND (p.archived_at IS NULL OR p.board_kind = 'work')
        AND (p.board_kind <> 'work' OR pg.agent_id IS NOT NULL)
      ORDER BY p.board_kind = 'commons' DESC, p.board_kind = 'work', p.name COLLATE NOCASE, p.id`)
      .bind(agent.team_id, agent.id),
    env.DB.prepare(`SELECT w.id AS project_id, w.name, w.slug, w.board_kind, w.parent_project_id, w.expires_at,
        w.description AS purpose, ${USAGE_COLUMNS}
      FROM projects w
      JOIN agent_project_grants pg ON pg.project_id = w.parent_project_id AND pg.agent_id = ? AND pg.permission = 'write'
      ${USAGE_JOINS("w")}
      WHERE w.team_id = ? AND ${active("w")} AND NOT ${PARENT_ARCHIVED("w")} AND ? = 1
        AND NOT EXISTS (SELECT 1 FROM agent_project_grants g WHERE g.agent_id = ? AND g.project_id = w.id)
      ORDER BY w.created_at DESC, w.id LIMIT 50`)
      .bind(agent.id, agent.team_id, writable ? 1 : 0, agent.id),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM projects p WHERE p.team_id = ? AND ${active("p")}`).bind(agent.team_id),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM projects p WHERE p.created_by_agent_id = ? AND ${active("p")}`).bind(agent.id),
  ]);
  type Row = Omit<AgentBoardSummary, "archived"> & { archived: number };
  return {
    boards: ((boards.results ?? []) as Row[]).map((row) => ({
      ...row,
      permission: writable ? row.permission : "read",
      archived: Boolean(row.archived),
    })),
    joinable_work_boards: (joinable.results ?? []) as JoinableWorkBoard[],
    quotas: {
      work_boards_team: { used: (team.results?.[0] as { n: number } | undefined)?.n ?? 0, limit: caps.per_team },
      work_boards_agent: { used: (own.results?.[0] as { n: number } | undefined)?.n ?? 0, limit: caps.per_agent },
    },
  };
}

function sqlTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Daily lifecycle: archive work boards that expired or went idle, delete work
 * boards archived longer than delete_after_days (at most 200 a run), and drop
 * usage counters (per board and per author) older than 35 days. Project and
 * Bulletin boards are never deleted. A board still referenced by a message or
 * artifact is skipped. Counts are boards and counter rows: D1's changes for a
 * DELETE also count the rows its foreign keys cascade to, so the boards to
 * delete are counted in the same batch first.
 */
export async function runAgentBoardLifecycle(env: Env, now: Date = new Date()): Promise<{
  archived: number; deleted: number; usage_pruned: number;
}> {
  const caps = await getWorkBoardCaps(env);
  const at = sqlTime(now);
  const doomed = `SELECT w.id FROM projects w
      WHERE w.board_kind = 'work' AND w.archived_at IS NOT NULL AND datetime(w.archived_at) <= datetime(?, ?)
        AND NOT EXISTS (SELECT 1 FROM messages WHERE project_id = w.id)
        AND NOT EXISTS (SELECT 1 FROM artifacts WHERE project_id = w.id)
        -- A visible handoff must first receive a digest and its full Trash window.
        AND NOT EXISTS (SELECT 1 FROM agent_board_entries e
          LEFT JOIN agent_board_moderation m ON m.entry_id = e.id
          WHERE e.project_id = w.id AND e.kind = 'h' AND m.entry_id IS NULL)
        AND NOT EXISTS (SELECT 1 FROM agent_board_entries e
          JOIN agent_board_trash t ON t.entry_id = e.id
          WHERE e.project_id = w.id AND datetime(t.purge_at) > datetime(?))
      ORDER BY w.archived_at LIMIT 200`;
  const [archived, toDelete, , prunedBoards, prunedAuthors, prunedHelp] = await env.DB.batch([
    env.DB.prepare(`UPDATE projects SET archived_at = ?, updated_at = ?
      WHERE board_kind = 'work' AND archived_at IS NULL
        AND (datetime(expires_at) <= datetime(?) OR datetime(COALESCE(last_post_at, created_at)) <= datetime(?, ?))`)
      .bind(at, at, at, at, `-${caps.idle_days} days`),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM (${doomed})`).bind(at, `-${caps.delete_after_days} days`, at),
    env.DB.prepare(`DELETE FROM projects WHERE id IN (${doomed})`).bind(at, `-${caps.delete_after_days} days`, at),
    env.DB.prepare("DELETE FROM agent_board_usage WHERE day < date(?, '-35 days')").bind(at),
    env.DB.prepare("DELETE FROM agent_board_author_usage WHERE day < date(?, '-35 days')").bind(at),
    env.DB.prepare("DELETE FROM help_usage WHERE day < date(?, '-35 days')").bind(at),
  ]);
  const result = {
    archived: archived.meta?.changes ?? 0,
    deleted: (toDelete.results?.[0] as { n: number } | undefined)?.n ?? 0,
    usage_pruned: (prunedBoards.meta?.changes ?? 0) + (prunedAuthors.meta?.changes ?? 0) + (prunedHelp.meta?.changes ?? 0),
  };
  if (result.archived || result.deleted) {
    await auditStatement(env, "agent_board.lifecycle", null, result, null).run();
  }
  return result;
}
