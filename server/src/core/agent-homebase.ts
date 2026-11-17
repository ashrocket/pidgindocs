import { agentSponsorAccessSql } from "./agent-access";
import type { AgentProjectPermission, Env } from "./types";

export interface HomebaseAgent {
  id: string;
  name: string;
  provider: string | null;
  status: "active" | "revoked";
  grants: Array<{ project_name: string; permission: AgentProjectPermission }>;
}

/** Read-only tenant view. No keys, OAuth metadata, or other sponsors' identities. */
export async function listHomebaseAgents(env: Env, input: { teamId: string; userId: string }): Promise<HomebaseAgent[]> {
  const [identities, grants] = await env.DB.batch([
    env.DB.prepare(`SELECT a.id, a.name, a.provider, a.status
      FROM agent_identities a
      JOIN team_memberships m ON m.team_id = a.team_id AND m.user_id = a.created_by_user_id
      JOIN users owner ON owner.id = m.user_id AND owner.status = 'active'
      WHERE a.team_id = ? AND a.created_by_user_id = ? AND a.kind = 'agent'
      ORDER BY a.created_at DESC, a.slug`).bind(input.teamId, input.userId),
    // Mirrors work-boards' current-board and parent-grant rules, plus sponsor
    // eligibility from the credential resolver. This is display, not authority.
    env.DB.prepare(`SELECT g.agent_id, p.name AS project_name,
        CASE WHEN m.role IN ('owner', 'admin', 'member')
          AND (p.board_kind <> 'work' OR pg.permission = 'write')
          THEN g.permission ELSE 'read' END AS permission
      FROM agent_project_grants g
      JOIN agent_identities a ON a.id = g.agent_id AND a.status = 'active' AND a.kind = 'agent'
      JOIN team_memberships m ON m.team_id = a.team_id AND m.user_id = a.created_by_user_id
      JOIN users owner ON owner.id = m.user_id AND owner.status = 'active'
      JOIN projects p ON p.id = g.project_id AND p.team_id = a.team_id
      LEFT JOIN projects parent ON p.board_kind = 'work' AND parent.id = p.parent_project_id AND parent.team_id = a.team_id
      LEFT JOIN agent_project_grants pg ON pg.agent_id = a.id AND pg.project_id = parent.id
      WHERE a.team_id = ? AND a.created_by_user_id = ? AND p.archived_at IS NULL
        AND (p.board_kind <> 'work' OR (datetime(p.expires_at) > datetime('now')
          AND parent.id IS NOT NULL AND parent.archived_at IS NULL AND pg.agent_id IS NOT NULL))
        AND ${agentSponsorAccessSql(env)}
      ORDER BY p.board_kind = 'commons' DESC, p.name COLLATE NOCASE, p.id`).bind(input.teamId, input.userId),
  ]);
  const rows = (grants.results ?? []) as Array<HomebaseAgent["grants"][number] & { agent_id: string }>;
  return ((identities.results ?? []) as Array<Omit<HomebaseAgent, "grants">>).map(agent => ({
    ...agent,
    grants: rows.filter(row => row.agent_id === agent.id).map(({ agent_id: _, ...grant }) => grant),
  }));
}
