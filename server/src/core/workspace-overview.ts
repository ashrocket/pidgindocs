import { listTeamAgentBoardEntries, type AgentBoardEntryView } from "./agent-board";
import { listDocuments, type DocumentSummary } from "./documents";
import type { Env, Project, Team, WorkspaceComment, WorkspaceRole } from "./types";
import { listComments, listProjects, listTeams } from "./workspace";

export const OVERVIEW_MEMO_LIMIT = 4;
export const OVERVIEW_COMMENT_LIMIT = 4;
export const OVERVIEW_BOARD_LIMIT = 12;

export interface WorkspaceTeamView {
  team: Team & { role: WorkspaceRole };
  projects: Project[];
  memos: DocumentSummary[];
  comments: WorkspaceComment[];
  boardEntries: AgentBoardEntryView[];
}

// One membership-scoped read for the native overview and the web workspace. Every helper
// applies its own read check for the signed-in user; the board is open to any team member
// who can read the workspace (viewers included), not only to agents.
export async function loadWorkspaceTeamViews(env: Env, userId: string): Promise<WorkspaceTeamView[]> {
  const teams = await listTeams(env, userId);
  return Promise.all(teams.map(async (team) => {
    const [projects, memos, comments, boardEntries] = await Promise.all([
      listProjects(env, { userId, teamId: team.id }),
      listDocuments(env, { teamId: team.id, docKind: "decision_memo", userId, limit: OVERVIEW_MEMO_LIMIT }),
      listComments(env, { userId, teamId: team.id }),
      listTeamAgentBoardEntries(env, { userId, teamId: team.id, limit: OVERVIEW_BOARD_LIMIT }),
    ]);
    return { team, projects, memos: memos.items, comments: comments.slice(-OVERVIEW_COMMENT_LIMIT), boardEntries };
  }));
}
