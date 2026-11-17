import type { Env } from "./types";

// Statements that keep a person's agents in line with their membership. This
// is a leaf module (types only) so workspace.ts and member-invitations.ts can
// both use it without an import cycle. Every builder returns statements for a
// caller's D1 batch; `guard` adds SQL that must also hold (for example, that
// an invitation was accepted in the same batch).

/** Most project grants one agent may hold. */
export const AGENT_GRANT_LIMIT = 20;

/**
 * SQL counting the grants of `agentExpr` that use up AGENT_GRANT_LIMIT,
 * optionally leaving out `exceptProjectExpr` (the grant being written). A
 * grant on a closed or expired work board does not count: it stays until the
 * lifecycle deletes the board, so the board is still listed as archived, but
 * it gives no access to post. `agentExpr`/`exceptProjectExpr` are SQL (a
 * column or `?`), and their binds stay in that order.
 */
export function countedGrantsSql(agentExpr: string, exceptProjectExpr?: string): string {
  return `(SELECT COUNT(*) FROM agent_project_grants cg JOIN projects cp ON cp.id = cg.project_id
    WHERE cg.agent_id = ${agentExpr}${exceptProjectExpr ? ` AND cg.project_id <> ${exceptProjectExpr}` : ""}
      AND NOT (cp.board_kind = 'work' AND (cp.archived_at IS NOT NULL OR datetime(cp.expires_at) <= datetime('now'))))`;
}

export interface StatementGuard {
  sql: string;
  binds: unknown[];
}

const andGuard = (guard?: StatementGuard) => (guard ? ` AND ${guard.sql}` : "");
const guardBinds = (guard?: StatementGuard) => guard?.binds ?? [];

// Authorization re-checked inside a write. Callers check in JS first for a
// clear error; these predicates make the batch itself refuse a plan that went
// stale in between (a removal, a demotion, a narrowed scope, an archive).

/** The person may write in the team (owner, admin or member). Binds: team, user. */
export const SPONSOR_CAN_WRITE_SQL =
  "EXISTS (SELECT 1 FROM team_memberships WHERE team_id = ? AND user_id = ? AND role IN ('owner', 'admin', 'member'))";
/** The person is a team owner or admin. Binds: team, user. */
export const TEAM_ADMIN_SQL =
  "EXISTS (SELECT 1 FROM team_memberships WHERE team_id = ? AND user_id = ? AND role IN ('owner', 'admin'))";

/**
 * The person is in the team and every one of `projectIds` is still in their
 * agent scope: an active, non-work project of the team that is the bulletin
 * board, or any such project for an owner/admin, or one in their
 * member_agent_scopes rows. Mirrors listMemberAgentScope plus the bulletin
 * board. Any role passes, viewers included.
 */
export function inAgentScopeGuard(teamId: string, userId: string, projectIds: string[]): StatementGuard {
  return {
    sql: `(SELECT COUNT(*) FROM projects p WHERE p.id IN (SELECT value FROM json_each(?)) AND p.team_id = ?
      AND p.archived_at IS NULL AND p.board_kind <> 'work'
      AND EXISTS (SELECT 1 FROM team_memberships t WHERE t.team_id = p.team_id AND t.user_id = ?)
      AND (p.board_kind = 'commons'
        OR EXISTS (SELECT 1 FROM team_memberships m WHERE m.team_id = p.team_id AND m.user_id = ? AND m.role IN ('owner', 'admin'))
        OR EXISTS (SELECT 1 FROM member_agent_scopes s WHERE s.team_id = p.team_id AND s.user_id = ? AND s.project_id = p.id))) = ?`,
    binds: [JSON.stringify(projectIds), teamId, userId, userId, userId, new Set(projectIds).size],
  };
}

/** The person may write and may give their own agents every one of `projectIds` right now. */
export function agentScopeGuard(teamId: string, userId: string, projectIds: string[]): StatementGuard {
  const scope = inAgentScopeGuard(teamId, userId, projectIds);
  return { sql: `${SPONSOR_CAN_WRITE_SQL} AND ${scope.sql}`, binds: [teamId, userId, ...scope.binds] };
}

/**
 * A person who is not (or no longer) a member of the team loses every agent
 * they sponsor there, with its keys, plus their agent scope and onboarding
 * state. Each statement applies only while the person has no membership row,
 * so the same list serves removal (after the DELETE) and a re-add (before the
 * INSERT), where it clears what an earlier membership left behind. Revoking,
 * not just relying on the membership join, keeps old keys dead after a re-add.
 */
export function endAgentAccessStatements(env: Env, input: {
  teamId: string; userId: string; actorUserId: string; guard?: StatementGuard;
}): D1PreparedStatement[] {
  const { teamId, userId } = input;
  const notMember = "NOT EXISTS (SELECT 1 FROM team_memberships WHERE team_id = ? AND user_id = ?)";
  const where = `${notMember}${andGuard(input.guard)}`;
  const binds = [teamId, userId, ...guardBinds(input.guard)];
  return [
    env.DB.prepare(`INSERT INTO audit_log (action, instance_id, details, user_id)
      SELECT 'agent_board.agent_revoked', id,
        json_object('team_id', team_id, 'slug', slug, 'reason', 'sponsor_not_in_team'), ?
      FROM agent_identities WHERE team_id = ? AND created_by_user_id = ? AND status = 'active' AND ${where}`)
      .bind(input.actorUserId, teamId, userId, ...binds),
    env.DB.prepare(`UPDATE agent_keys SET revoked_at = datetime('now')
      WHERE revoked_at IS NULL AND agent_id IN (SELECT id FROM agent_identities WHERE team_id = ? AND created_by_user_id = ?)
        AND ${where}`)
      .bind(teamId, userId, ...binds),
    env.DB.prepare(`UPDATE agent_identities SET status = 'revoked', revoked_at = datetime('now'), updated_at = datetime('now')
      WHERE team_id = ? AND created_by_user_id = ? AND status = 'active' AND ${where}`)
      .bind(teamId, userId, ...binds),
    env.DB.prepare(`DELETE FROM member_agent_scopes WHERE team_id = ? AND user_id = ? AND ${where}`)
      .bind(teamId, userId, ...binds),
    env.DB.prepare(`DELETE FROM member_onboarding WHERE team_id = ? AND user_id = ? AND ${where}`)
      .bind(teamId, userId, ...binds),
  ];
}

/**
 * While the person is a member or viewer (owners and admins are implicitly
 * scoped to every project), grants they gave their own agents must stay
 * within their explicit agent scope plus the bulletin board, and their
 * handover board must be one of those. Run after any role or scope change in
 * the same batch; it reads the role and scope as they stand at that point.
 * Grants an admin added to their agents stay.
 */
export function narrowToAgentScopeStatements(env: Env, input: {
  teamId: string; userId: string; guard?: StatementGuard;
}): D1PreparedStatement[] {
  const { teamId, userId } = input;
  // Work boards are never in a scope; they stay while their parent does.
  // Binds, in order: scope (team, user), commons (team), work-board parent
  // (team, user, team), role (team, user), then the guard.
  const condition = (column: string) => `${column} NOT IN (SELECT project_id FROM member_agent_scopes WHERE team_id = ? AND user_id = ?)
        AND ${column} NOT IN (SELECT id FROM projects WHERE team_id = ? AND board_kind = 'commons')
        AND ${column} NOT IN (SELECT w.id FROM projects w WHERE w.board_kind = 'work' AND w.parent_project_id IN (
          SELECT project_id FROM member_agent_scopes WHERE team_id = ? AND user_id = ?
          UNION SELECT id FROM projects WHERE team_id = ? AND board_kind = 'commons'))
        AND EXISTS (SELECT 1 FROM team_memberships WHERE team_id = ? AND user_id = ? AND role IN ('member', 'viewer'))${andGuard(input.guard)}`;
  const conditionBinds = [teamId, userId, teamId, teamId, userId, teamId, teamId, userId, ...guardBinds(input.guard)];
  return [
    env.DB.prepare(`DELETE FROM agent_project_grants
      WHERE created_by_user_id = ?
        AND agent_id IN (SELECT id FROM agent_identities WHERE team_id = ? AND created_by_user_id = ?)
        AND ${condition("project_id")}`)
      .bind(userId, teamId, userId, ...conditionBinds),
    env.DB.prepare(`UPDATE member_onboarding SET handover_project_id = NULL, updated_at = datetime('now')
      WHERE team_id = ? AND user_id = ? AND handover_project_id IS NOT NULL
        AND ${condition("handover_project_id")}`)
      .bind(teamId, userId, ...conditionBinds),
  ];
}

/**
 * Gives a project (write) to the person's active self-minted agents that do
 * not have it yet, skipping any agent already at the grant limit. The grant is
 * recorded as the sponsor's own, like the grants copied at mint, so narrowing
 * the scope later takes it away again. One statement per project keeps the
 * limit exact across a batch. Work boards are never granted this way: agents
 * join them (joinWorkBoard), which checks the parent and expiry.
 */
export function grantToOwnAgentsStatement(env: Env, input: {
  teamId: string; userId: string; projectId: string; guard?: StatementGuard;
}): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO agent_project_grants (agent_id, project_id, permission, created_by_user_id)
    SELECT a.id, p.id, 'write', a.created_by_user_id
    FROM agent_identities a JOIN projects p ON p.id = ? AND p.team_id = a.team_id AND p.archived_at IS NULL
      AND p.board_kind <> 'work'
    WHERE a.team_id = ? AND a.created_by_user_id = ? AND a.self_minted = 1 AND a.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM agent_project_grants g WHERE g.agent_id = a.id AND g.project_id = p.id)
      AND ${countedGrantsSql("a.id")} < ?${andGuard(input.guard)}`)
    .bind(input.projectId, input.teamId, input.userId, AGENT_GRANT_LIMIT, ...guardBinds(input.guard));
}
