import type { Env } from "./types";
import { canWriteWorkspace, getProjectById, getWorkspaceMembership } from "./workspace";

export async function canWriteContentScope(env: Env, userId: string, teamId?: unknown, projectId?: unknown): Promise<boolean> {
  if ((teamId != null && typeof teamId !== "string") || (projectId != null && typeof projectId !== "string")) return false;
  if (!await env.DB.prepare("SELECT 1 FROM users WHERE id = ? AND status = 'active'").bind(userId).first()) return false;
  if (projectId) {
    const project = await getProjectById(env, projectId as string);
    if (!project || project.team_id !== teamId) return false;
  }
  if (!teamId) return !projectId;
  const membership = await getWorkspaceMembership(env, teamId as string, userId);
  return canWriteWorkspace(membership?.role);
}
