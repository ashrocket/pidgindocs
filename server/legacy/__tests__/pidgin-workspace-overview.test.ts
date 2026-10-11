import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";

const mocks = vi.hoisted(() => ({
  userId: vi.fn<() => Promise<string | null>>(),
  listTeams: vi.fn(),
  listProjects: vi.fn(),
  listComments: vi.fn(),
  listDocuments: vi.fn(),
  listBoard: vi.fn(),
}));

vi.mock("../middleware", async (importOriginal) => {
  const original = await importOriginal<typeof import("../middleware")>();
  return { ...original, resolveCallerUserId: mocks.userId };
});
vi.mock("../workspace", () => ({
  listTeams: mocks.listTeams,
  listProjects: mocks.listProjects,
  listComments: mocks.listComments,
}));
vi.mock("../documents", () => ({ listDocuments: mocks.listDocuments }));
vi.mock("../agent-board", () => ({ listTeamAgentBoardEntries: mocks.listBoard }));

import { handleWorkspaceOverview } from "../routes/workspace";

const env = {} as Env;

describe("PidginDocs workspace overview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userId.mockResolvedValue("member-a");
    mocks.listTeams.mockResolvedValue([{ id: "team-a", name: "A", slug: "a", role: "member" }]);
    mocks.listProjects.mockResolvedValue([{ id: "project-a", team_id: "team-a", name: "Project A" }]);
    mocks.listDocuments.mockResolvedValue({ items: [{ id: "memo-a", title: "Decision" }] });
    mocks.listComments.mockResolvedValue([{ id: "comment-a", body: "Reviewed" }]);
    mocks.listBoard.mockResolvedValue([{ id: "board-a", topic: "Status" }]);
  });

  it("requires an authenticated member before reading team data", async () => {
    mocks.userId.mockResolvedValue(null);
    const response = await handleWorkspaceOverview(new Request("https://pidgindocs.example.workers.dev/api/workspace/overview"), env);
    expect(response.status).toBe(401);
    expect(mocks.listTeams).not.toHaveBeenCalled();
  });

  it("ignores a requested foreign team and scopes every read to member teams", async () => {
    const response = await handleWorkspaceOverview(
      new Request("https://pidgindocs.example.workers.dev/api/workspace/overview?team_id=foreign"), env
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { teams: Array<{ team: { id: string } }> } };
    expect(body.data.teams.map((snapshot) => snapshot.team.id)).toEqual(["team-a"]);
    expect(mocks.listTeams).toHaveBeenCalledWith(env, "member-a");
    expect(mocks.listProjects).toHaveBeenCalledWith(env, { userId: "member-a", teamId: "team-a" });
    expect(mocks.listComments).toHaveBeenCalledWith(env, { userId: "member-a", teamId: "team-a" });
    expect(mocks.listDocuments).toHaveBeenCalledWith(env, { teamId: "team-a", docKind: "decision_memo", limit: 4 });
    expect(mocks.listBoard).toHaveBeenCalledWith(env, { userId: "member-a", teamId: "team-a", limit: 12 });
  });
});
