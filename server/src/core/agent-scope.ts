// Agent board scope: the team's bulletin board and the projects that a
// member's agents may reach. Moved from teams/member-invitations.ts so that
// PidginCore does not import Teams code; that module re-exports these names,
// and its MemberInvitationError is this module's AgentScopeError.
import type { Env, Project, WorkspaceRole } from "./types";
import { canAdminWorkspace, getWorkspaceMembership } from "./workspace";

export type BoardKind = "project" | "commons" | "work";

export interface ScopedProject {
  id: string;
  slug: string;
  name: string;
  board_kind: BoardKind;
}

export type BoardProject = Project & { board_kind: BoardKind };

/** A refused member, invitation or scope action, with its HTTP status. */
export class AgentScopeError extends Error {
  constructor(message: string, public status: number, public limit?: string, public retryAfter?: number | null) { super(message); }
}

const PROJECT_COLUMNS = "id, team_id, slug, name, description, pinned, archived_at, created_by_user_id, created_at, updated_at, board_kind";

const COMMONS = {
  name: "Bulletin",
  slugs: ["bulletin", "bulletin-board", "team-bulletin"],
  description: "Cross-team bulletin board for people and their agents.",
};

const newId = () => crypto.randomUUID().replace(/-/g, "");

async function roleIn(env: Env, teamId: string, userId: string): Promise<WorkspaceRole | null> {
  return (await getWorkspaceMembership(env, teamId, userId))?.role ?? null;
}

function audit(env: Env, action: string, instanceId: string, details: Record<string, unknown>, userId: string) {
  return env.DB.prepare("INSERT INTO audit_log (action, instance_id, details, user_id) VALUES (?, ?, ?, ?)")
    .bind(action, instanceId, JSON.stringify(details), userId);
}

export async function listMemberAgentScope(env: Env, input: { teamId: string; userId: string }): Promise<ScopedProject[]> {
  const role = await roleIn(env, input.teamId, input.userId);
  if (!role) return [];
  const { results } = canAdminWorkspace(role)
    ? await env.DB.prepare(`SELECT id, slug, name, board_kind FROM projects
        WHERE team_id = ? AND archived_at IS NULL AND board_kind <> 'work'
        ORDER BY pinned DESC, name COLLATE NOCASE, id`).bind(input.teamId).all<ScopedProject>()
    : await env.DB.prepare(`SELECT p.id, p.slug, p.name, p.board_kind FROM member_agent_scopes s
        JOIN projects p ON p.id = s.project_id AND p.team_id = s.team_id
        WHERE s.team_id = ? AND s.user_id = ? AND p.archived_at IS NULL AND p.board_kind <> 'work'
        ORDER BY p.pinned DESC, p.name COLLATE NOCASE, p.id`).bind(input.teamId, input.userId).all<ScopedProject>();
  return results ?? [];
}

export async function getCommonsBoard(env: Env, teamId: string): Promise<BoardProject | null> {
  return await env.DB.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE team_id = ? AND board_kind = 'commons'`)
    .bind(teamId).first<BoardProject>();
}

/** Any team member may create the team's single bulletin board; concurrent calls return the same board. */
export async function ensureCommonsBoard(env: Env, input: { teamId: string; actorUserId: string }): Promise<BoardProject> {
  if (!await roleIn(env, input.teamId, input.actorUserId)) throw new AgentScopeError("Not a member of this team.", 403);
  for (const slug of COMMONS.slugs) {
    const existing = await getCommonsBoard(env, input.teamId);
    if (existing) return existing;
    const id = newId();
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO projects (id, team_id, slug, name, description, created_by_user_id, board_kind)
          VALUES (?, ?, ?, ?, ?, ?, 'commons')`)
          .bind(id, input.teamId, slug, COMMONS.name, COMMONS.description, input.actorUserId),
        audit(env, "workspace.commons_created", id, { team_id: input.teamId, slug }, input.actorUserId),
      ]);
    } catch (error) {
      // Another request created the board, or this slug belongs to a project.
      // Anything else (an unavailable database) is not a name conflict.
      if (!/UNIQUE constraint failed: projects\./.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
  const board = await getCommonsBoard(env, input.teamId);
  if (board) return board;
  throw new AgentScopeError("The bulletin board could not be created because its names are taken.", 409);
}
