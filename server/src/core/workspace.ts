import { restrictedContentTeams } from "./content-policy";
import { editionRecordMentions, editionResolveMentions, editionOwnerProvisioned } from "./edition-hooks";
import { editionMemberIdentityAllowed } from "./edition-hooks";
import { recheckEventStreams } from "./events/live";
import { endAgentAccessStatements, narrowToAgentScopeStatements } from "./member-access";
import { canReadResource, getWorkspaceResource, assertWorkspacePublishScope, resolveSharingTeam, WorkspaceAccessError, messageReadSql, artifactReadSql, type Sharing } from "./workspace-access";
import { DOCUMENT_FAMILY_SQL, documentFamilyBinds } from "./documents/family";
import type { Env, Project, Team, TeamMembership, WorkspaceComment, WorkspaceRole, WorkspaceResourceType } from "./types";
import { editionSlug } from "./wire-names";

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
    "SELECT id, team_id, slug, name, description, pinned, archived_at, created_by_user_id, created_at, updated_at FROM projects WHERE id = ?"
  )
    .bind(projectId)
    .first<Project>();
}

export async function ensureDefaultWorkspace(env: Env, ownerUserId: string): Promise<void> {
  if (editionOwnerProvisioned(env)) return;
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
    `SELECT p.id, p.team_id, p.slug, p.name, p.description, p.board_kind, p.pinned, p.archived_at, p.created_by_user_id, p.created_at, p.updated_at
     FROM projects p
     JOIN team_memberships m ON m.team_id = p.team_id
     WHERE m.user_id = ? ${teamClause} AND p.board_kind <> 'work'
     ORDER BY p.archived_at IS NOT NULL, p.pinned DESC, p.name COLLATE NOCASE ASC`
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
    "SELECT id, team_id, slug, name, description, pinned, archived_at, created_by_user_id, created_at, updated_at FROM projects WHERE id = ?"
  )
    .bind(id)
    .first<Project>()) as Project;
}

// Work boards are not channels: they are closed through work-boards.ts and never reopen.
export async function updateProject(env: Env, input: { id: string; userId: string; name?: string; description?: string | null; pinned?: boolean; archived?: boolean }): Promise<Project | null> {
  const project = await getProjectById(env, input.id);
  if (!project || !canAdminWorkspace((await getWorkspaceMembership(env, project.team_id, input.userId))?.role)) return null;
  if (await env.DB.prepare("SELECT 1 AS work FROM projects WHERE id = ? AND board_kind = 'work'").bind(input.id).first()) return null;
  // Archiving a project closes its open work boards too: they would otherwise
  // keep taking posts while the board index no longer shows them. Unarchiving
  // never reopens them; a closed work board stays closed.
  const archiving = input.archived === true;
  await env.DB.batch([
    env.DB.prepare(`UPDATE projects SET name=?, description=?, pinned=?, archived_at=?, updated_at=datetime('now') WHERE id=?`)
      .bind(input.name ?? project.name, input.description === undefined ? project.description : input.description,
        input.pinned === undefined ? project.pinned : Number(input.pinned),
        input.archived === undefined ? project.archived_at : input.archived ? new Date().toISOString() : null, input.id),
    ...(archiving ? [env.DB.prepare(`UPDATE projects SET archived_at = datetime('now'), updated_at = datetime('now')
      WHERE parent_project_id = ? AND board_kind = 'work' AND archived_at IS NULL`).bind(input.id)] : []),
  ]);
  return getProjectById(env, input.id);
}

export async function listWorkspaceTags(env: Env, teamId: string, userId: string) {
  if (!canReadWorkspace((await getWorkspaceMembership(env, teamId, userId))?.role)) return null;
  return (await env.DB.prepare("SELECT id,team_id,slug,name,color,created_at FROM workspace_tags WHERE team_id=? ORDER BY name COLLATE NOCASE")
    .bind(teamId).all<{ id: string; team_id: string; slug: string; name: string; color: string; created_at: string }>()).results;
}

export async function createWorkspaceTag(env: Env, input: { teamId: string; userId: string; name: string; color: string }) {
  if (!canAdminWorkspace((await getWorkspaceMembership(env, input.teamId, input.userId))?.role)) return null;
  const id = crypto.randomUUID().replace(/-/g, "");
  await env.DB.prepare("INSERT INTO workspace_tags(id,team_id,slug,name,color,created_by_user_id) VALUES (?,?,?,?,?,?)")
    .bind(id, input.teamId, slugify(input.name), input.name, input.color, input.userId).run();
  return env.DB.prepare("SELECT id,team_id,slug,name,color,created_at FROM workspace_tags WHERE id=?")
    .bind(id).first<{ id: string; team_id: string; slug: string; name: string; color: string; created_at: string }>();
}

export async function setResourceTags(env: Env, input: { teamId: string; userId: string; resourceType: "message" | "artifact"; resourceId: string; tagIds: string[] }) {
  if (!canWriteWorkspace((await getWorkspaceMembership(env, input.teamId, input.userId))?.role)) return false;
  // Documents are stored in messages, so the tagging type is the table kind.
  const resource = input.resourceType === "message"
    ? await env.DB.prepare("SELECT id,user_id,team_id,project_id,sharing,type FROM messages WHERE id=?").bind(input.resourceId)
      .first<{ id: string; user_id: string | null; team_id: string | null; project_id: string | null; sharing: string; type: string }>()
    : await getWorkspaceResource(env, input.resourceType, input.resourceId);
  if (!resource || resource.team_id !== input.teamId || !await canReadResource(env, input.userId, resource)) return false;
  const unique = [...new Set(input.tagIds)];
  if (unique.length > 10) return false;
  if (unique.length) {
    const placeholders = unique.map(() => "?").join(",");
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM workspace_tags WHERE team_id=? AND id IN (${placeholders})`)
      .bind(input.teamId, ...unique).first<{ n: number }>();
    if (row?.n !== unique.length) return false;
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM workspace_resource_tags WHERE team_id=? AND resource_type=? AND resource_id=?")
      .bind(input.teamId, input.resourceType, input.resourceId),
    ...unique.map(tagId => env.DB.prepare("INSERT INTO workspace_resource_tags(team_id,tag_id,resource_type,resource_id,created_by_user_id) VALUES (?,?,?,?,?)")
      .bind(input.teamId, tagId, input.resourceType, input.resourceId, input.userId)),
  ]);
  return true;
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
  if (input.resourceType && input.resourceId) {
    const resource = await getWorkspaceResource(env, input.resourceType, input.resourceId);
    if (!resource || resource.team_id !== input.teamId || !await canReadResource(env, input.userId, resource)) return [];
  }
  const clauses = ["c.team_id = ?", `(EXISTS (SELECT 1 FROM messages r WHERE r.id = c.resource_id AND r.team_id = c.team_id AND c.resource_type != 'artifact' AND ${messageReadSql('r')}) OR EXISTS (SELECT 1 FROM artifacts r WHERE r.id = c.resource_id AND r.team_id = c.team_id AND c.resource_type = 'artifact' AND ${artifactReadSql('r')}))`];
  const binds: string[] = [input.teamId, input.userId, input.userId, input.userId, input.userId];
  if (input.resourceType) {
    clauses.push("c.resource_type = ?");
    binds.push(input.resourceType);
  }
  if (input.resourceId) {
    clauses.push("c.resource_id = ?");
    binds.push(input.resourceId);
  }
  const { results } = await env.DB.prepare(
    `SELECT c.*, COALESCE(e.display_name, u.email) AS author_name
     FROM resource_comments c JOIN users u ON u.id = c.author_user_id
     LEFT JOIN entra_identities e ON e.user_id = u.id
     WHERE ${clauses.join(" AND ")}
     ORDER BY c.created_at ASC, c.id ASC`
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
  const resource = await getWorkspaceResource(env, input.resourceType, input.resourceId);
  if (!resource || resource.team_id !== input.teamId || !await canReadResource(env, input.userId, resource)) return null;
  if (input.projectId && resource.project_id !== input.projectId) return null;
  if (input.parentId && !await env.DB.prepare(
    "SELECT id FROM resource_comments WHERE id = ? AND team_id = ? AND resource_type = ? AND resource_id = ?"
  ).bind(input.parentId, input.teamId, input.resourceType, input.resourceId).first()) return null;
  const recipients = await editionResolveMentions(env, input.teamId, input.userId, input.body);
  const id = crypto.randomUUID().replace(/-/g, "");
  await env.DB.prepare(
    `INSERT INTO resource_comments (id, team_id, project_id, resource_type, resource_id, parent_id, body, author_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      input.teamId,
      resource.project_id,
      input.resourceType,
      input.resourceId,
      input.parentId ?? null,
      input.body.trim(),
      input.userId
    )
    .run();
  const comment = (await env.DB.prepare(
    `SELECT c.*, COALESCE(e.display_name, u.email) AS author_name
     FROM resource_comments c JOIN users u ON u.id = c.author_user_id
     LEFT JOIN entra_identities e ON e.user_id = u.id WHERE c.id = ?`
  )
    .bind(id)
    .first<WorkspaceComment>()) as WorkspaceComment;
  await editionRecordMentions(env, { teamId: input.teamId, authorId: input.userId, recipients,
    resourceType: input.resourceType, resourceId: input.resourceId,
    sourceKind: "comment", sourceId: id, text: input.body });
  return comment;
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

export interface WorkspaceFeedItem {
  id: string;
  resource_type: "message" | "document" | "artifact";
  title: string;
  body: string | null;
  author_user_id: string;
  author_name: string;
  team_id: string;
  project_id: string | null;
  created_at: string;
  url: string;
  source: string | null;
  model: string | null;
  comment_count: number;
  tags_json: string;
  sharing: Sharing;
}

export async function listWorkspaceFeed(env: Env, input: {
  userId: string; teamId: string; projectId?: string; tagId?: string; resourceId?: string; limit?: number; cursor?: string;
}): Promise<{ items: WorkspaceFeedItem[]; next_cursor: string | null }> {
  const membership = await getWorkspaceMembership(env, input.teamId, input.userId);
  if (!canReadWorkspace(membership?.role)) return { items: [], next_cursor: null };
  const limit = Math.min(100, Math.max(1, input.limit || 50));
  const clauses = ["f.team_id = ?"];
  const binds: (string | number)[] = [input.userId, input.userId, input.userId, input.userId, input.teamId];
  if (input.projectId) { clauses.push("f.project_id = ?"); binds.push(input.projectId); }
  if (input.tagId) {
    clauses.push("EXISTS (SELECT 1 FROM workspace_resource_tags rt WHERE rt.team_id=f.team_id AND rt.tag_id=? AND rt.resource_id=f.id AND rt.resource_type=CASE WHEN f.resource_type='artifact' THEN 'artifact' ELSE 'message' END)");
    binds.push(input.tagId);
  }
  if (input.resourceId) { clauses.push("f.id = ?"); binds.push(input.resourceId); }
  if (input.cursor) {
    try {
      const c = JSON.parse(atob(input.cursor)) as { at: string; id: string; type: string };
      if (typeof c.at === "string" && typeof c.id === "string" && typeof c.type === "string") {
        clauses.push("(f.created_at < ? OR (f.created_at = ? AND (f.id < ? OR (f.id = ? AND f.resource_type < ?))))");
        binds.push(c.at, c.at, c.id, c.id, c.type);
      }
    } catch { /* An invalid cursor starts at the beginning. */ }
  }
  const rows = await env.DB.prepare(`
    SELECT f.*, COALESCE(e.display_name, u.email, 'Team member') AS author_name,
      COALESCE((SELECT json_group_array(json_object('id',t.id,'name',t.name,'color',t.color))
        FROM workspace_resource_tags rt JOIN workspace_tags t ON t.id=rt.tag_id
        WHERE rt.team_id=f.team_id AND rt.resource_id=f.id AND rt.resource_type=CASE WHEN f.resource_type='artifact' THEN 'artifact' ELSE 'message' END), '[]') AS tags_json,
      (SELECT COUNT(*) FROM resource_comments c WHERE c.team_id = f.team_id AND c.resource_id = f.id
        AND (c.resource_type = f.resource_type OR (f.resource_type = 'document' AND c.resource_type = 'decision_memo'))) AS comment_count
    FROM (
      SELECT id, CASE WHEN type = 'document' THEN 'document' ELSE 'message' END AS resource_type,
        title, body, user_id AS author_user_id, team_id, project_id, created_at,
        CASE WHEN type = 'document' THEN CASE WHEN interactive = 1 THEN '/idoc/' ELSE '/docs/' END ELSE '/messages/' END || id AS url,
        instance_source AS source, instance_model AS model, sharing
      FROM messages WHERE team_id IS NOT NULL AND COALESCE(is_latest, 1) = 1 AND ${messageReadSql("messages")}
      UNION ALL
      SELECT id, 'artifact', title, description, user_id, team_id, project_id, updated_at,
        '/a/' || id, 'agent', NULL, sharing FROM artifacts WHERE team_id IS NOT NULL AND role = 'page' AND ${artifactReadSql("artifacts")}
    ) f
    LEFT JOIN users u ON u.id = f.author_user_id
    LEFT JOIN entra_identities e ON e.user_id = f.author_user_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY f.created_at DESC, f.id DESC, f.resource_type DESC LIMIT ?
  `).bind(...binds, limit + 1).all<WorkspaceFeedItem>();
  const items = (rows.results || []).slice(0, limit);
  const last = items.at(-1);
  return { items, next_cursor: rows.results.length > limit && last
    ? btoa(JSON.stringify({ at: last.created_at, id: last.id, type: last.resource_type })) : null };
}

export async function listWorkspaceMembers(env: Env, teamId: string, userId: string) {
  if (!await getWorkspaceMembership(env, teamId, userId)) return null;
  const result = await env.DB.prepare(`SELECT m.user_id, m.role, m.created_at, COALESCE(e.principal_name, u.email) AS email,
    COALESCE(e.display_name, u.email) AS display_name
    FROM team_memberships m JOIN users u ON u.id = m.user_id
    LEFT JOIN entra_identities e ON e.user_id = m.user_id
    WHERE m.team_id = ? ORDER BY display_name`).bind(teamId).all();
  return result.results;
}

export async function setWorkspaceMember(env: Env, input: {
  teamId: string; actorId: string; userId?: string; email?: string; role?: "admin" | "member" | "viewer"; remove?: boolean;
}): Promise<boolean> {
  // Governed memberships change only through the human-session governance API,
  // with its current revision, hierarchy rules and atomic audit record.
  if (await restrictedContentTeams(env, input.teamId)) return false;
  const actor = await getWorkspaceMembership(env, input.teamId, input.actorId);
  if (!canAdminWorkspace(actor?.role)) return false;
  const target = await env.DB.prepare(
    `SELECT u.id, COALESCE(e.principal_name, u.email) AS email FROM users u
     LEFT JOIN entra_identities e ON e.user_id = u.id
     WHERE u.status = 'active' AND (u.id = ? OR lower(u.email) = ? OR lower(e.principal_name) = ?)`
  ).bind(input.userId || "", input.email?.toLowerCase() || "", input.email?.toLowerCase() || "").first<{ id: string; email: string }>();
  if (!target) return false;
  const existing = await getWorkspaceMembership(env, input.teamId, target.id);
  // Owner transfer is deliberately separate; an admin cannot elevate itself
  // or remove/demote another admin, including the owner.
  if (existing?.role === "owner" || (actor?.role !== "owner" && (existing?.role === "admin" || input.role === "admin"))) return false;
  const access = { teamId: input.teamId, userId: target.id, actorUserId: input.actorId };
  if (input.remove) {
    // Leaving ends the person's agent access for good: a later re-add starts
    // with no agents, keys, agent scope or handover board.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?").bind(input.teamId, target.id),
      ...endAgentAccessStatements(env, access),
    ]);
    // Close the live event sockets of the person and of the agents they sponsored now, not at the next event.
    await recheckEventStreams(env, [{ teamId: input.teamId }]);
  } else {
    // The edition decides who may join (for example invitation-only public teams or home-tenant identities).
    if (!await editionMemberIdentityAllowed(env, input, target, existing)) return false;
    await env.DB.batch([
      // Before the insert: clears agents and scope left from an earlier membership.
      ...endAgentAccessStatements(env, access),
      env.DB.prepare(`INSERT INTO team_memberships (team_id, user_id, role) VALUES (?, ?, ?)
        ON CONFLICT(team_id, user_id) DO UPDATE SET role = excluded.role`)
        .bind(input.teamId, target.id, input.role || "member"),
      // After it: a demoted admin's own agent grants shrink to their agent scope.
      ...narrowToAgentScopeStatements(env, access),
    ]);
  }
  await env.DB.prepare("INSERT INTO audit_log (action, instance_id, details, user_id) VALUES (?, ?, ?, ?)")
    .bind(input.remove ? "remove_team_member" : "set_team_member", `${editionSlug()}-workspace`, JSON.stringify({ team_id: input.teamId, user_id: target.id, role: input.role }), input.actorId).run();
  return true;
}

export async function shareResourceToWorkspace(env: Env, input: {
  actorId: string; resourceType: WorkspaceResourceType; resourceId: string; teamId: string; projectId?: string;
}): Promise<boolean> {
  const resource = await getWorkspaceResource(env, input.resourceType, input.resourceId);
  if (!resource || resource.user_id !== input.actorId || !await canReadResource(env, input.actorId, resource)) return false;
  if (await restrictedContentTeams(env, resource.team_id, input.teamId)) return false;
  await assertWorkspacePublishScope(env, input.actorId, input.teamId, input.projectId);
  // Existing references cannot silently change audience. Share the child
  // artifacts first and retain the same team on an already composed message.
  if (input.resourceType === "message") {
    const incompatible = await env.DB.prepare(`SELECT b.artifact_id FROM message_blocks b JOIN artifacts a ON a.id = b.artifact_id
      WHERE b.message_id = ? AND (a.team_id IS NULL OR a.team_id != ? OR a.sharing != 'shared') LIMIT 1`)
      .bind(input.resourceId, input.teamId).first();
    if (incompatible) return false;
  }
  if (input.resourceType === "artifact" && resource.team_id && resource.team_id !== input.teamId) {
    const references = await env.DB.prepare("SELECT message_id FROM message_blocks WHERE artifact_id = ? LIMIT 1").bind(input.resourceId).first();
    if (references) return false;
  }
  const table = input.resourceType === "artifact" ? "artifacts" : "messages";
  const document = table === "messages" ? await env.DB.prepare(
    "SELECT id, doc_slug, team_id, user_id FROM messages WHERE id = ? AND type = 'document'"
  ).bind(input.resourceId).first<{ id: string; doc_slug: string | null; team_id: string | null; user_id: string | null }>() : null;
  if (document) {
    // A document moves with all its versions: moving one row would split the
    // family across audiences (and leave older versions public). Only the
    // author of every version may move it, and never onto a slug the
    // destination already uses.
    const family = documentFamilyBinds(document);
    const destination = documentFamilyBinds({ ...document, team_id: input.teamId, user_id: input.actorId });
    const [foreign, taken] = await Promise.all([
      env.DB.prepare(`SELECT 1 FROM messages WHERE ${DOCUMENT_FAMILY_SQL} AND user_id IS NOT ? LIMIT 1`).bind(...family, input.actorId).first(),
      document.team_id === input.teamId ? null
        : env.DB.prepare(`SELECT 1 FROM messages WHERE ${DOCUMENT_FAMILY_SQL} LIMIT 1`).bind(...destination).first(),
    ]);
    if (foreign || taken) return false;
    const updated = await env.DB.prepare(`UPDATE messages SET team_id = ?, project_id = ?, sharing = 'shared', sharing_explicit = 1, public = 0, expires_at = NULL WHERE ${DOCUMENT_FAMILY_SQL} AND user_id = ?
        AND NOT EXISTS (SELECT 1 FROM messages WHERE ${DOCUMENT_FAMILY_SQL} AND user_id IS NOT ?)
        AND EXISTS (SELECT 1 FROM team_memberships WHERE team_id=? AND user_id=? AND role IN ('owner','admin','member'))
        AND (? IS NULL OR EXISTS (SELECT 1 FROM team_memberships WHERE team_id=? AND user_id=?))
        ${document.team_id === input.teamId ? '' : `AND NOT EXISTS (SELECT 1 FROM messages WHERE ${DOCUMENT_FAMILY_SQL})`}`)
      .bind(input.teamId, input.projectId || null, ...family, input.actorId, ...family, input.actorId,
        input.teamId, input.actorId, document.team_id, document.team_id, input.actorId,
        ...(document.team_id === input.teamId ? [] : destination)).run();
    if (!updated.meta.changes) return false;
  } else {
    const updated = await env.DB.prepare(`UPDATE ${table} SET team_id = ?, project_id = ?, sharing = 'shared', ${table === "artifacts" ? "visibility = 'private'" : "public = 0, expires_at = NULL"} WHERE id = ? AND user_id = ? AND team_id IS ?
      AND EXISTS (SELECT 1 FROM team_memberships WHERE team_id=? AND user_id=? AND role IN ('owner','admin','member'))
      AND (? IS NULL OR EXISTS (SELECT 1 FROM team_memberships WHERE team_id=? AND user_id=?))`)
      .bind(input.teamId, input.projectId || null, input.resourceId, input.actorId, resource.team_id,
        input.teamId, input.actorId, resource.team_id, resource.team_id, input.actorId).run();
    if (!updated.meta.changes) return false;
  }
  await env.DB.prepare("INSERT INTO audit_log (action, instance_id, details, user_id) VALUES ('share_team_resource', ?, ?, ?)")
    .bind(`${editionSlug()}-workspace`, JSON.stringify({ resource_type: input.resourceType, resource_id: input.resourceId, team_id: input.teamId, project_id: input.projectId }), input.actorId).run();
  return true;
}


export class SharingError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** Team sharing is explicit and owner-controlled. Public URLs/tokens remain a separate personal-resource feature. */
export async function setResourceSharing(env: Env, input: {
  actorId: string; resourceType: WorkspaceResourceType; resourceId: string; sharing: Sharing;
  teamId?: string | null; projectId?: string | null;
}) {
  if (!["document", "decision_memo", "artifact"].includes(input.resourceType) || !["private", "shared"].includes(input.sharing)) {
    throw new SharingError("invalid request");
  }
  const resource = await getWorkspaceResource(env, input.resourceType, input.resourceId);
  if (!resource || resource.user_id !== input.actorId || !await canReadResource(env, input.actorId, resource)) throw new SharingError("resource not found", 404);
  if (await restrictedContentTeams(env, resource.team_id, input.teamId)) {
    throw new SharingError("Use Access controls to manage document roles.", 403);
  }
  if (input.teamId && resource.team_id && input.teamId !== resource.team_id) throw new SharingError("forbidden", 403);
  const kind = input.resourceType === "artifact" ? "artifact" : "document";
  let teamId = resource.team_id;
  const projectId = resource.project_id || input.projectId || null;
  try {
    if (input.sharing === "shared" && !teamId) teamId = await resolveSharingTeam(env, input.actorId, input.teamId);
    await assertWorkspacePublishScope(env, input.actorId, teamId, projectId);
    if (input.sharing === "shared") {
      if (!teamId || !await shareResourceToWorkspace(env, { actorId: input.actorId, resourceType: input.resourceType,
        resourceId: input.resourceId, teamId, projectId: projectId || undefined })) throw new SharingError("resource not found or composed artifacts have a different audience", 409);
    } else if (kind === "artifact") {
      // Historical message blocks contain title/summary snapshots: refuse to make a
      // referenced shared item private while those copies are still team-readable.
      const references = await env.DB.prepare("SELECT 1 FROM message_blocks WHERE artifact_id = ? LIMIT 1").bind(resource.id).first();
      if (resource.sharing === "shared" && references) throw new SharingError("resource not found or composed artifacts have a different audience", 409);
      const updated = await env.DB.prepare("UPDATE artifacts SET sharing = 'private', updated_at = datetime('now') WHERE id = ? AND user_id = ? AND team_id IS ? AND (team_id IS NULL OR EXISTS (SELECT 1 FROM team_memberships WHERE team_id=artifacts.team_id AND user_id=?))")
        .bind(resource.id, input.actorId, resource.team_id, input.actorId).run();
      if (!updated.meta.changes) throw new SharingError("resource changed; reload before changing sharing", 409);
    } else {
      const family = documentFamilyBinds(resource);
      const foreign = await env.DB.prepare(`SELECT 1 FROM messages WHERE ${DOCUMENT_FAMILY_SQL} AND user_id IS NOT ? LIMIT 1`)
        .bind(...family, input.actorId).first();
      if (foreign) throw new SharingError("forbidden", 403);
      const updated = await env.DB.prepare(`UPDATE messages SET sharing = 'private', sharing_explicit = 1 WHERE ${DOCUMENT_FAMILY_SQL} AND user_id = ?
        AND NOT EXISTS (SELECT 1 FROM messages WHERE ${DOCUMENT_FAMILY_SQL} AND user_id IS NOT ?)
        AND (team_id IS NULL OR EXISTS (SELECT 1 FROM team_memberships WHERE team_id=messages.team_id AND user_id=?))`)
        .bind(...family, input.actorId, ...family, input.actorId, input.actorId).run();
      if (!updated.meta.changes) throw new SharingError("resource changed; reload before changing sharing", 409);
    }
  } catch (error) {
    if (error instanceof Error && /team deletion in progress|referenced artifact/i.test(error.message)) throw new SharingError("Sharing cannot change while this resource is referenced or team deletion is in progress", 409);
    if (error instanceof WorkspaceAccessError) throw new SharingError(error.message, 403);
    throw error;
  }
  return { resource_type: kind, resource_id: resource.id, team_id: teamId, project_id: projectId, sharing: input.sharing };
}
