import {
  AGENT_BOARD_LIMITS,
  AgentBoardInputError,
  auditStatement,
  insertAgentIdentity,
  revokeAgentIdentityRecord,
  slugify,
  type CreateAgentIdentityResult,
} from "./agent-board";
import { BOARD_DOCUMENT_MAX_CHARS } from "./board-documents";
import { boardInlineBodyLimit } from "./board-inline-limits";
import { AgentScopeError, ensureCommonsBoard, listMemberAgentScope, type BoardKind } from "./agent-scope";
import { AGENT_GRANT_LIMIT as GRANT_LIMIT, agentScopeGuard, countedGrantsSql, TEAM_ADMIN_SQL } from "./member-access";
import { canAdminWorkspace, canWriteWorkspace, getWorkspaceMembership } from "./workspace";
import type { AgentIdentity, AgentProjectPermission, Env, WorkspaceRole } from "./types";

export const SELF_MINTED_AGENT_LIMIT = 3;

/** A cap was reached; `limit` is the cap's name. Maps to HTTP 429. */
export class AgentQuotaError extends Error {
  constructor(public limit: string, message: string) { super(message); }
}

/** 400 invalid input, 403 forbidden, 404 missing, 409 conflict. */
export class AgentSelfServiceError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export interface AgentGrantSummary {
  project_id: string;
  project_name: string;
  project_slug: string;
  board_kind: BoardKind;
  permission: AgentProjectPermission;
}

export interface OwnAgentIdentity extends AgentIdentity {
  self_minted: boolean;
  signin_connected: boolean;
  grants: AgentGrantSummary[];
  keys: Array<{ key_prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null }>;
}

export interface AgentWhoami {
  agent: { id: string; slug: string; name: string; provider: string | null; status: "active" | "revoked"; self_minted: boolean };
  sponsor: { user_id: string; display_name?: string; email: string };
  team: { id: string; name: string };
  grants: AgentGrantSummary[];
  handover_board: { id: string; name: string } | null;
  bulletin_board: { id: string; name: string } | null;
  limits: { post_body_chars: number; document_body_chars: number; topic_chars: number; reference_chars: number };
}

type AgentRow = AgentIdentity & { self_minted: number; signin_connected: number };

const AGENT_COLUMNS = `id, team_id, slug, name, provider, status, created_by_user_id, created_at, updated_at, revoked_at, self_minted, signin_connected`;
const GRANT_SELECT = `SELECT g.agent_id, g.project_id, p.name AS project_name, p.slug AS project_slug, p.board_kind, g.permission
  FROM agent_project_grants g JOIN agent_identities a ON a.id = g.agent_id
  JOIN projects p ON p.id = g.project_id AND p.team_id = a.team_id`;

async function roleIn(env: Env, teamId: string, userId: string): Promise<WorkspaceRole | null> {
  return (await getWorkspaceMembership(env, teamId, userId))?.role ?? null;
}

// A member's web posting identity (kind 'person') is not one of their agents.
async function loadAgent(env: Env, agentId: string): Promise<AgentRow | null> {
  return await env.DB.prepare(`SELECT ${AGENT_COLUMNS} FROM agent_identities WHERE id = ? AND kind = 'agent'`)
    .bind(agentId).first<AgentRow>();
}

async function sponsorProfile(env: Env, userId: string) {
  return await env.DB.prepare(`SELECT u.id, COALESCE(e.principal_name, g.email, u.email) AS email,
      COALESCE(e.display_name, g.display_name) AS display_name
    FROM users u LEFT JOIN entra_identities e ON e.user_id = u.id LEFT JOIN google_identities g ON g.user_id = u.id
    WHERE u.id = ?`).bind(userId).first<{ id: string; email: string; display_name: string | null }>();
}

async function freeSlug(env: Env, teamId: string, base: string): Promise<string> {
  // D1 limits LIKE patterns to 50 bytes; slugs may be longer.
  const { results } = await env.DB.prepare(`SELECT slug FROM agent_identities
    WHERE team_id = ? AND (slug = ? OR substr(slug, 1, ?) = ?)`)
    .bind(teamId, base, base.length + 1, `${base}-`).all<{ slug: string }>();
  const taken = new Set((results ?? []).map((row) => row.slug));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

async function activeSelfMinted(env: Env, teamId: string, userId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM agent_identities
    WHERE team_id = ? AND created_by_user_id = ? AND self_minted = 1 AND status = 'active'`)
    .bind(teamId, userId).first<{ n: number }>();
  return row?.n ?? 0;
}

const quotaError = () => new AgentQuotaError("self_minted_agents",
  `You already have ${SELF_MINTED_AGENT_LIMIT} active agents. Revoke one to connect another.`);

/** How many times a self-mint plans again after its plan went stale before it reports a conflict. */
const SELF_MINT_PLAN_ATTEMPTS = 3;
const STALE_SELF_MINT = "Your agent projects changed while this agent was being connected. Try again.";

/** What one self-mint attempt writes, planned from the member's role, scope and handover board as read now. */
interface SelfMintPlan {
  teamId: string;
  userId: string;
  name: string;
  provider?: string | null;
  slugBase: string;
  signIn?: boolean;
  grants: Array<{ projectId: string; permission: "write" }>;
}

/**
 * Plans one attempt. Grants: the bulletin board, the handover board, then the
 * rest of the member's agent scope, all write, capped at 20.
 */
async function planSelfMint(env: Env, input: {
  userId: string; teamId: string; name: string; provider?: string | null; signIn?: boolean;
}): Promise<SelfMintPlan> {
  const commons = await ensureCommonsBoard(env, { teamId: input.teamId, actorUserId: input.userId }).catch((error) => {
    throw error instanceof AgentScopeError ? new AgentSelfServiceError(error.message, error.status) : error;
  });
  const scope = (await listMemberAgentScope(env, { teamId: input.teamId, userId: input.userId }))
    .filter((project) => project.board_kind !== "commons");
  const handover = (await env.DB.prepare("SELECT handover_project_id FROM member_onboarding WHERE team_id = ? AND user_id = ?")
    .bind(input.teamId, input.userId).first<{ handover_project_id: string | null }>())?.handover_project_id ?? null;
  const ordered = [
    ...(commons.archived_at ? [] : [commons.id]),
    ...(handover && scope.some((project) => project.id === handover) ? [handover] : []),
    ...scope.map((project) => project.id),
  ];
  const grants = [...new Set(ordered)].slice(0, GRANT_LIMIT)
    .map((projectId) => ({ projectId, permission: "write" as const }));

  const profile = await sponsorProfile(env, input.userId);
  const label = profile?.display_name && !profile.display_name.includes("@")
    ? profile.display_name : (profile?.email ?? "member").split("@")[0];
  const slugBase = slugify(`${label}-${input.name}`).slice(0, 56).replace(/-+$/, "") || "agent";
  return { teamId: input.teamId, userId: input.userId, name: input.name, provider: input.provider, slugBase, grants, signIn: input.signIn };
}

/**
 * Writes a plan in one batch whose identity row is written only if, at that
 * moment, the member may still write, every planned project is still in their
 * agent scope, and they are under the active-agent cap. Every other row
 * depends on that one, so a plan that went stale writes nothing: null.
 */
async function commitSelfMint(env: Env, plan: SelfMintPlan): Promise<CreateAgentIdentityResult | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await insertAgentIdentity(env, {
        teamId: plan.teamId,
        userId: plan.userId,
        name: plan.name,
        slug: await freeSlug(env, plan.teamId, plan.slugBase),
        provider: plan.provider,
        signIn: plan.signIn,
        grants: plan.grants,
        selfMinted: { activeLimit: SELF_MINTED_AGENT_LIMIT },
        guard: agentScopeGuard(plan.teamId, plan.userId, plan.grants.map((grant) => grant.projectId)),
      });
    } catch (error) {
      // A concurrent mint took the slug between choosing and inserting it.
      if (error instanceof AgentBoardInputError && /slug already exists/.test(error.message) && attempt < 2) continue;
      if (error instanceof AgentBoardInputError) throw new AgentSelfServiceError(error.message, 400);
      throw error;
    }
  }
}

/**
 * Why a self-mint batch wrote nothing, from fresh reads: 403 when the member
 * can no longer write (removed or made a viewer), 429 at the active-agent cap,
 * otherwise 409 because the plan went stale (scope narrowed, project archived).
 */
async function selfMintRefusal(env: Env, input: { teamId: string; userId: string }): Promise<Error> {
  if (!canWriteWorkspace(await roleIn(env, input.teamId, input.userId))) {
    return new AgentSelfServiceError("Only team members can connect their own agents.", 403);
  }
  if (await activeSelfMinted(env, input.teamId, input.userId) >= SELF_MINTED_AGENT_LIMIT) return quotaError();
  return new AgentSelfServiceError(STALE_SELF_MINT, 409);
}

/**
 * A member mints their own agent credential. The member is its sponsor, so
 * posts are attributed to them and the key stops working if they leave.
 * The key is returned once. A plan that went stale before its write is
 * planned again from fresh reads, a bounded number of times.
 */
export async function createSelfAgentIdentity(env: Env, input: {
  userId: string; teamId: string; name: string; provider?: string | null; signIn?: boolean;
}): Promise<CreateAgentIdentityResult> {
  const role = await roleIn(env, input.teamId, input.userId);
  if (!canWriteWorkspace(role)) throw new AgentSelfServiceError("Only team members can connect their own agents.", 403);
  if (await activeSelfMinted(env, input.teamId, input.userId) >= SELF_MINTED_AGENT_LIMIT) throw quotaError();
  if (typeof input.name !== "string" || !input.name.trim()) throw new AgentSelfServiceError("name is required", 400);
  if (input.name.trim().length > 100) throw new AgentSelfServiceError("name exceeds 100 characters", 400);

  for (let attempt = 1; ; attempt += 1) {
    const result = await commitSelfMint(env, await planSelfMint(env, input));
    if (result) return result;
    const refusal = await selfMintRefusal(env, input);
    const stale = refusal instanceof AgentSelfServiceError && refusal.status === 409;
    if (!stale || attempt >= SELF_MINT_PLAN_ATTEMPTS) throw refusal;
  }
}

/** The caller's own agent identities in a team, with grants and key prefixes (never keys). */
export async function listOwnAgentIdentities(env: Env, input: { userId: string; teamId: string }): Promise<OwnAgentIdentity[]> {
  if (!await roleIn(env, input.teamId, input.userId)) throw new AgentSelfServiceError("Not a member of this team.", 403);
  const [agents, grants, keys] = await env.DB.batch([
    env.DB.prepare(`SELECT ${AGENT_COLUMNS} FROM agent_identities WHERE team_id = ? AND created_by_user_id = ? AND kind = 'agent'
      ORDER BY created_at DESC, slug`).bind(input.teamId, input.userId),
    env.DB.prepare(`${GRANT_SELECT} WHERE a.team_id = ? AND a.created_by_user_id = ?
      ORDER BY p.board_kind = 'commons' DESC, p.name COLLATE NOCASE`).bind(input.teamId, input.userId),
    env.DB.prepare(`SELECT k.agent_id, k.key_prefix, k.created_at, k.last_used_at, k.revoked_at FROM agent_keys k
      JOIN agent_identities a ON a.id = k.agent_id WHERE a.team_id = ? AND a.created_by_user_id = ?
      ORDER BY k.created_at DESC`).bind(input.teamId, input.userId),
  ]);
  const grantRows = (grants.results ?? []) as Array<AgentGrantSummary & { agent_id: string }>;
  const keyRows = (keys.results ?? []) as Array<OwnAgentIdentity["keys"][number] & { agent_id: string }>;
  return ((agents.results ?? []) as AgentRow[]).map((agent) => ({
    ...agent,
    self_minted: agent.self_minted === 1,
    signin_connected: agent.signin_connected === 1,
    grants: grantRows.filter((grant) => grant.agent_id === agent.id).map(({ agent_id: _, ...grant }) => grant),
    keys: keyRows.filter((key) => key.agent_id === agent.id).map(({ agent_id: _, ...key }) => key),
  }));
}

/** The sponsor (or a team admin) revokes the agent and every key. Idempotent. */
export async function revokeOwnAgentIdentity(env: Env, input: { userId: string; agentId: string }): Promise<void> {
  const agent = await loadAgent(env, input.agentId);
  const role = agent ? await roleIn(env, agent.team_id, input.userId) : null;
  const sponsor = agent?.created_by_user_id === input.userId;
  if (!agent || (!role && !sponsor)) throw new AgentSelfServiceError("Agent not found.", 404);
  if (!sponsor && !canAdminWorkspace(role)) throw new AgentSelfServiceError("You can only revoke your own agents.", 403);
  await revokeAgentIdentityRecord(env, agent, input.userId);
}

async function authorizeGrantChange(env: Env, input: { actorUserId: string; agentId: string; projectId: string }) {
  const agent = await loadAgent(env, input.agentId);
  const role = agent ? await roleIn(env, agent.team_id, input.actorUserId) : null;
  if (!agent || !role) throw new AgentSelfServiceError("Agent not found.", 404);
  const admin = canAdminWorkspace(role);
  if (!admin && agent.created_by_user_id !== input.actorUserId) {
    throw new AgentSelfServiceError("You can only change your own agents.", 403);
  }
  return { agent, role, admin };
}

/** The checks a grant change must pass, from current reads. setAgentGrant repeats them inside its write. */
async function checkGrantChange(env: Env, input: { actorUserId: string; agentId: string; projectId: string }) {
  const { agent, role, admin } = await authorizeGrantChange(env, input);
  if (agent.status !== "active") throw new AgentSelfServiceError("This agent has been revoked.", 409);
  const project = await env.DB.prepare("SELECT id, board_kind FROM projects WHERE id = ? AND team_id = ? AND archived_at IS NULL")
    .bind(input.projectId, agent.team_id).first<{ id: string; board_kind: BoardKind }>();
  if (!project) throw new AgentSelfServiceError("The project must be an active project in the agent's team.", 400);
  if (!admin) {
    const inScope = canWriteWorkspace(role) && (project.board_kind === "commons" ||
      (await listMemberAgentScope(env, { teamId: agent.team_id, userId: input.actorUserId })).some((p) => p.id === project.id));
    if (!inScope) {
      throw new AgentSelfServiceError("You can grant your agents only your agent projects or the bulletin board.", 403);
    }
  }
  return { agent, project };
}

/**
 * Team owners/admins may grant any active project of the agent's team. A
 * sponsor may grant their own agents only projects in their agent scope or
 * the bulletin board.
 */
export async function setAgentGrant(env: Env, input: {
  actorUserId: string; agentId: string; projectId: string; permission: AgentProjectPermission;
}): Promise<AgentGrantSummary> {
  if (input.permission !== "read" && input.permission !== "write") {
    throw new AgentSelfServiceError("permission must be read or write", 400);
  }
  const { agent, project } = await checkGrantChange(env, input);
  // The same checks hold inside the write, so a revoke, archive, demotion or
  // narrowed scope since the reads above writes nothing. Whether the agent is
  // the actor's own cannot change (its sponsor is fixed).
  const scope = agent.created_by_user_id === input.actorUserId
    ? agentScopeGuard(agent.team_id, input.actorUserId, [project.id]) : null;
  // Work boards under a project are reached through it: read here makes the
  // agent's grants on them read too (resolveAgentBoardPrincipal enforces the
  // same), so the stored grants match what the agent can do.
  const [result] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO agent_project_grants (agent_id, project_id, permission, created_by_user_id)
      SELECT ?, ?, ?, ? WHERE ${countedGrantsSql("?", "?")} < ?
        AND EXISTS (SELECT 1 FROM agent_identities WHERE id = ? AND status = 'active')
        AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND team_id = ? AND archived_at IS NULL)
        AND (${TEAM_ADMIN_SQL}${scope ? ` OR (${scope.sql})` : ""})
      ON CONFLICT(agent_id, project_id) DO UPDATE SET permission = excluded.permission`)
      .bind(agent.id, project.id, input.permission, input.actorUserId, agent.id, project.id, GRANT_LIMIT,
        agent.id, project.id, agent.team_id, agent.team_id, input.actorUserId, ...(scope?.binds ?? [])),
    env.DB.prepare(`UPDATE agent_project_grants SET permission = 'read'
      WHERE agent_id = ? AND permission <> 'read'
        AND project_id IN (SELECT id FROM projects WHERE parent_project_id = ? AND board_kind = 'work')
        AND EXISTS (SELECT 1 FROM agent_project_grants parent WHERE parent.agent_id = ? AND parent.project_id = ?
          AND parent.permission = 'read')`)
      .bind(agent.id, project.id, agent.id, project.id),
  ]);
  if (!result.meta?.changes) {
    // Name what refused the write: the checks as they stand now, then the cap.
    await checkGrantChange(env, input);
    const counted = await env.DB.prepare(`SELECT ${countedGrantsSql("?", "?")} AS n`).bind(agent.id, project.id).first<{ n: number }>();
    if ((counted?.n ?? 0) >= GRANT_LIMIT) {
      throw new AgentQuotaError("agent_grants", `An agent may have at most ${GRANT_LIMIT} project grants.`);
    }
    throw new AgentSelfServiceError("This agent's access changed while the grant was being saved. Try again.", 409);
  }
  await auditStatement(env, "agent_board.grant_set", agent.id,
    { team_id: agent.team_id, project_id: project.id, permission: input.permission }, input.actorUserId).run();
  const grant = await env.DB.prepare(`${GRANT_SELECT} WHERE g.agent_id = ? AND g.project_id = ?`)
    .bind(agent.id, project.id).first<AgentGrantSummary & { agent_id: string }>();
  if (!grant) throw new AgentSelfServiceError("This agent's access changed while the grant was being saved. Try again.", 409);
  const { agent_id: _, ...summary } = grant;
  return summary;
}

/**
 * Removing access only narrows it, so a sponsor may remove any grant from their
 * own agent. Removing a project also removes the agent's grants on the work
 * boards under it, which are reached only through that project.
 */
export async function removeAgentGrant(env: Env, input: {
  actorUserId: string; agentId: string; projectId: string;
}): Promise<void> {
  const { agent } = await authorizeGrantChange(env, input);
  const [result] = await env.DB.batch([
    env.DB.prepare("DELETE FROM agent_project_grants WHERE agent_id = ? AND project_id = ?").bind(agent.id, input.projectId),
    env.DB.prepare(`DELETE FROM agent_project_grants WHERE agent_id = ?
      AND project_id IN (SELECT id FROM projects WHERE parent_project_id = ? AND board_kind = 'work')
      AND NOT EXISTS (SELECT 1 FROM agent_project_grants g WHERE g.agent_id = ? AND g.project_id = ?)`)
      .bind(agent.id, input.projectId, agent.id, input.projectId),
  ]);
  if (!result.meta?.changes) throw new AgentSelfServiceError("Grant not found.", 404);
  await auditStatement(env, "agent_board.grant_removed", agent.id,
    { team_id: agent.team_id, project_id: input.projectId }, input.actorUserId).run();
}

/** Self-discovery for an authenticated agent credential. Null when the agent does not exist. */
export async function agentWhoami(env: Env, agentId: string, authenticatedUserId?: string): Promise<AgentWhoami | null> {
  const row = await env.DB.prepare(`SELECT a.id, a.slug, a.name, a.provider, a.status, a.self_minted, a.team_id,
      a.created_by_user_id, t.name AS team_name
    FROM agent_identities a JOIN teams t ON t.id = a.team_id WHERE a.id = ?`).bind(agentId)
    .first<Pick<AgentRow, "id" | "slug" | "name" | "provider" | "status" | "self_minted" | "team_id" | "created_by_user_id">
      & { team_name: string }>();
  if (!row) return null;
  const sponsorUserId = authenticatedUserId ?? row.created_by_user_id;
  const [profile, grantResult, onboarding, sponsorRole] = await Promise.all([
    sponsorProfile(env, sponsorUserId),
    env.DB.prepare(`${GRANT_SELECT} WHERE g.agent_id = ? AND p.archived_at IS NULL
      ORDER BY p.board_kind = 'commons' DESC, p.name COLLATE NOCASE`).bind(row.id)
      .all<AgentGrantSummary & { agent_id: string }>(),
    env.DB.prepare("SELECT handover_project_id FROM member_onboarding WHERE team_id = ? AND user_id = ?")
      .bind(row.team_id, sponsorUserId).first<{ handover_project_id: string | null }>(),
    roleIn(env, row.team_id, sponsorUserId),
  ]);
  // Report what the agent can actually do: a viewer sponsor's agents only read (as posting enforces).
  const writable = canWriteWorkspace(sponsorRole);
  const grants = (grantResult.results ?? []).map(({ agent_id: _, ...grant }) =>
    writable ? grant : { ...grant, permission: "read" as const });
  const handover = grants.find((grant) => grant.project_id === onboarding?.handover_project_id);
  const bulletin = grants.find((grant) => grant.board_kind === "commons");
  return {
    agent: { id: row.id, slug: row.slug, name: row.name, provider: row.provider, status: row.status, self_minted: row.self_minted === 1 },
    sponsor: {
      user_id: sponsorUserId,
      ...(profile?.display_name ? { display_name: profile.display_name } : {}),
      email: profile?.email ?? "",
    },
    team: { id: row.team_id, name: row.team_name },
    grants,
    handover_board: handover ? { id: handover.project_id, name: handover.project_name } : null,
    bulletin_board: bulletin ? { id: bulletin.project_id, name: bulletin.project_name } : null,
    limits: {
      post_body_chars: boardInlineBodyLimit(env, row.team_id, sponsorUserId),
      document_body_chars: BOARD_DOCUMENT_MAX_CHARS,
      topic_chars: AGENT_BOARD_LIMITS.topic,
      reference_chars: AGENT_BOARD_LIMITS.reference,
    },
  };
}
