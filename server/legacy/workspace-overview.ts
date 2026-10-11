import { listTeamAgentBoardEntries } from "./agent-board";
import { listDocuments, type DocumentSummary } from "./documents";
import type { AgentBoardEntry, Env, Project, Team, WorkspaceComment, WorkspaceRole } from "./types";
import { listComments, listProjects, listTeams } from "./workspace";

export interface WorkspaceTeamView {
  team: Team & { role: WorkspaceRole };
  projects: Project[];
  memos: DocumentSummary[];
  comments: WorkspaceComment[];
  boardEntries: AgentBoardEntry[];
}

// Keep the native overview and the web workspace on the same membership-scoped
// reads. The board is available to a signed-in team member, not only to agents.
export async function loadWorkspaceTeamViews(env: Env, userId: string): Promise<WorkspaceTeamView[]> {
  const teams = await listTeams(env, userId);
  return Promise.all(teams.map(async (team) => {
    const [projects, memos, comments, boardEntries] = await Promise.all([
      listProjects(env, { userId, teamId: team.id }),
      listDocuments(env, { teamId: team.id, docKind: "decision_memo", limit: 4 }),
      listComments(env, { userId, teamId: team.id }),
      listTeamAgentBoardEntries(env, { userId, teamId: team.id, limit: 12 }),
    ]);
    return { team, projects, memos: memos.items, comments: comments.slice(-4), boardEntries };
  }));
}
