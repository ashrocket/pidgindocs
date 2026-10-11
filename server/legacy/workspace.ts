import type { Env, Project, Team, TeamMembership, WorkspaceComment, WorkspaceRole, WorkspaceResourceType } from "./types";

export const WORKSPACE_ROLES: WorkspaceRole[] = ["owner", "admin", "member", "viewer"];

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-") || "workspace";
}

function rank(role: WorkspaceRole | null | undefined): number {
  switch (role) {
    case "owner":
      return 4;
    case "admin":
      return 3;
    case "member":
      return 2;
    case "viewer":
      return 1;
    default:
      return 0;
  }
}

export function canReadWorkspace(role: WorkspaceRole | null | undefined): boolean {
  return rank(role) >= 1;
}

export function canWriteWorkspace(role: WorkspaceRole | null | undefined): boolean {
  return rank(role) >= 2;
}

export function canAdminWorkspace(role: WorkspaceRole | null | undefined): boolean {
  return rank(role) >= 3;
}

export async function getWorkspaceMembership(
  env: Env,
  teamId: string,
  userId: string
): Promise<TeamMembership | null> {
  return await env.DB.prepare(
    "SELECT team_id, user_id, role, created_at FROM team_memberships WHERE team_id = ? AND user_id = ?"
  )
    .bind(teamId, userId)
    .first<TeamMembership>();
}

export async function getProjectById(env: Env, projectId: string): Promise<Project | null> {
  return await env.DB.prepare(
    "SELECT id, team_id, slug, name, description, created_by_user_id, created_at, updated_at FROM projects WHERE id = ?"
  )
    .bind(projectId)
    .first<Project>();
}

/** Create an invited customer's private workspace without relying on a global default team. */
export function personalWorkspaceStatements(env: Env, userId: string): D1PreparedStatement[] {
  const teamId = `pidgin-${userId}`;
  const projectId = `pidgin-general-${userId}`;
  const slug = `pidgin-${userId}`;
  return [
    env.DB.prepare("INSERT OR IGNORE INTO teams (id, slug, name, owner_user_id) VALUES (?, ?, ?, ?)")
      .bind(teamId, slug, "My PidginDocs", userId),
    env.DB.prepare("INSERT OR IGNORE INTO team_memberships (team_id, user_id, role) VALUES (?, ?, 'owner')")
      .bind(teamId, userId),
    env.DB.prepare(
      "INSERT OR IGNORE INTO projects (id, team_id, slug, name, description, created_by_user_id) VALUES (?, ?, 'general', 'General', ?, ?)"
    ).bind(projectId, teamId, "Your private PidginDocs workspace", userId),
  ];
}

export async function ensurePersonalWorkspace(env: Env, userId: string): Promise<void> {
  await env.DB.batch(personalWorkspaceStatements(env, userId));
}

export async function ensureDefaultWorkspace(env: Env, ownerUserId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM teams").first<{ count: number }>();
  if ((row?.count ?? 0) > 0) return;

  const teamId = crypto.randomUUID().replace(/-/g, "");
  const projectId = crypto.randomUUID().replace(/-/g, "");
  const teamSlug = "company";
  const projectSlug = "general";

  await env.DB.prepare(
    "INSERT INTO teams (id, slug, name, owner_user_id) VALUES (?, ?, ?, ?)"
  )
    .bind(teamId, teamSlug, "Company", ownerUserId)
    .run();
  await env.DB.prepare(
    "INSERT INTO team_memberships (team_id, user_id, role) VALUES (?, ?, 'owner')"
  )
    .bind(teamId, ownerUserId)
    .run();
  await env.DB.prepare(
    "INSERT INTO projects (id, team_id, slug, name, description, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(projectId, teamId, projectSlug, "General", "Default company workspace project", ownerUserId)
    .run();
}

export async function listTeams(env: Env, userId: string): Promise<Array<Team & { role: WorkspaceRole }>> {
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.slug, t.name, t.owner_user_id, t.created_at, t.updated_at, m.role
     FROM teams t
     JOIN team_memberships m ON m.team_id = t.id
     WHERE m.user_id = ?
     ORDER BY t.created_at DESC, t.name ASC`
  )
    .bind(userId)
    .all<Team & { role: WorkspaceRole }>();
  return results ?? [];
}

export async function createTeam(
  env: Env,
  input: { name: string; ownerUserId: string; slug?: string }
): Promise<Team> {
  const id = crypto.randomUUID().replace(/-/g, "");
  const slug = slugify(input.slug || input.name);
  await env.DB.prepare(
    "INSERT INTO teams (id, slug, name, owner_user_id) VALUES (?, ?, ?, ?)"
  )
    .bind(id, slug, input.name.trim(), input.ownerUserId)
    .run();
  await env.DB.prepare(
    "INSERT INTO team_memberships (team_id, user_id, role) VALUES (?, ?, 'owner')"
  )
    .bind(id, input.ownerUserId)
    .run();
  return (await env.DB.prepare(
    "SELECT id, slug, name, owner_user_id, created_at, updated_at FROM teams WHERE id = ?"
  )
    .bind(id)
    .first<Team>()) as Team;
}

export async function listProjects(
  env: Env,
  input: { userId: string; teamId?: string }
): Promise<Project[]> {
  const binds: string[] = [input.userId];
  const teamClause = input.teamId ? "AND p.team_id = ?" : "";
  if (input.teamId) binds.push(input.teamId);
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.team_id, p.slug, p.name, p.description, p.created_by_user_id, p.created_at, p.updated_at
     FROM projects p
     JOIN team_memberships m ON m.team_id = p.team_id
     WHERE m.user_id = ? ${teamClause}
     ORDER BY p.created_at DESC, p.name ASC`
  )
    .bind(...binds)
    .all<Project>();
  return results ?? [];
}

export async function createProject(
  env: Env,
  input: { teamId: string; userId: string; name: string; slug?: string; description?: string | null }
): Promise<Project | null> {
  const membership = await getWorkspaceMembership(env, input.teamId, input.userId);
  if (!canAdminWorkspace(membership?.role ?? null)) return null;
  const id = crypto.randomUUID().replace(/-/g, "");
  const slug = slugify(input.slug || input.name);
  await env.DB.prepare(
    "INSERT INTO projects (id, team_id, slug, name, description, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(id, input.teamId, slug, input.name.trim(), input.description ?? null, input.userId)
    .run();
  return (await env.DB.prepare(
    "SELECT id, team_id, slug, name, description, created_by_user_id, created_at, updated_at FROM projects WHERE id = ?"
  )
    .bind(id)
    .first<Project>()) as Project;
}

export async function listComments(
  env: Env,
  input: {
    userId: string;
    teamId: string;
    resourceType?: WorkspaceResourceType;
    resourceId?: string;
  }
): Promise<WorkspaceComment[]> {
  const membership = await getWorkspaceMembership(env, input.teamId, input.userId);
  if (!canReadWorkspace(membership?.role ?? null)) return [];
  const clauses = ["team_id = ?"];
  const binds: string[] = [input.teamId];
  if (input.resourceType) {
    clauses.push("resource_type = ?");
    binds.push(input.resourceType);
  }
  if (input.resourceId) {
    clauses.push("resource_id = ?");
    binds.push(input.resourceId);
  }
  const { results } = await env.DB.prepare(
    `SELECT id, team_id, project_id, resource_type, resource_id, parent_id, body, status,
            author_user_id, created_at, updated_at
     FROM resource_comments
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at ASC, id ASC`
  )
    .bind(...binds)
    .all<WorkspaceComment>();
  return results ?? [];
}

export async function createComment(
  env: Env,
  input: {
    userId: string;
    teamId: string;
    projectId?: string | null;
    resourceType: WorkspaceResourceType;
    resourceId: string;
    body: string;
    parentId?: string | null;
  }
): Promise<WorkspaceComment | null> {
  const membership = await getWorkspaceMembership(env, input.teamId, input.userId);
  if (!canWriteWorkspace(membership?.role ?? null)) return null;
  if (input.projectId) {
    const project = await getProjectById(env, input.projectId);
    if (!project || project.team_id !== input.teamId) return null;
  }
  const id = crypto.randomUUID().replace(/-/g, "");
  await env.DB.prepare(
    `INSERT INTO resource_comments (id, team_id, project_id, resource_type, resource_id, parent_id, body, author_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      input.teamId,
      input.projectId ?? null,
      input.resourceType,
      input.resourceId,
      input.parentId ?? null,
      input.body.trim(),
      input.userId
    )
    .run();
  return (await env.DB.prepare(
    `SELECT id, team_id, project_id, resource_type, resource_id, parent_id, body, status,
            author_user_id, created_at, updated_at
     FROM resource_comments WHERE id = ?`
  )
    .bind(id)
    .first<WorkspaceComment>()) as WorkspaceComment;
}

export function buildDecisionMemoMarkdown(input: {
  title: string;
  status?: string | null;
  decision: string;
  context?: string | null;
  options?: string | null;
  consequences?: string | null;
  owners?: string | null;
}): string {
  const lines = [
    `# ${input.title.trim()}`,
    "",
    `Status: ${input.status?.trim() || "proposed"}`,
    "",
    "## Decision",
    input.decision.trim(),
  ];
  if (input.context?.trim()) {
    lines.push("", "## Context", input.context.trim());
  }
  if (input.options?.trim()) {
    lines.push("", "## Options Considered", input.options.trim());
  }
  if (input.consequences?.trim()) {
    lines.push("", "## Consequences", input.consequences.trim());
  }
  if (input.owners?.trim()) {
    lines.push("", "## Owners", input.owners.trim());
  }
  return lines.join("\n");
}
