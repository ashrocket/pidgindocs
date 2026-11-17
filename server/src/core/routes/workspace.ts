import { editionRecordMentions, editionResolveMentions, MentionRejected } from "../edition-hooks";
import { editionAccessError, editionBrand, editionMemberLimitMessage, editionSingleWorkspaceRefusal, editionTeamCreationError } from "../edition-hooks";
import { json } from "../utils";
import { resolveCallerUserId, unauthorized } from "../middleware";
import {
  buildDecisionMemoMarkdown,
  canReadWorkspace,
  canWriteWorkspace,
  createComment,
  createProject,
  createWorkspaceTag,
  createTeam,
  getProjectById,
  getWorkspaceMembership,
  listComments,
  listProjects,
  listWorkspaceTags,
  listTeams,
  listWorkspaceFeed, listWorkspaceMembers, setWorkspaceMember, shareResourceToWorkspace,
  setResourceSharing, setResourceTags, SharingError, updateProject,
} from "../workspace";
import { createMessage } from "../messages/store";
import { WorkspaceAccessError, assertWorkspacePublishScope, getWorkspaceResource, parseSharing } from "../workspace-access";
import { listDocuments, publishDocument } from "../documents";
import { loadWorkspaceTeamViews } from "../workspace-overview";
import { listWorkspaceBackups } from "../workspace-backup";
import type { Env, WorkspaceResourceType } from "../types";
import { editionSlug, workspaceUserSessionId } from "../wire-names";

const VALID_RESOURCE_TYPES: WorkspaceResourceType[] = ["message", "artifact", "document", "decision_memo"];

function parseString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function requireUser(request: Request, env: Env): Promise<string | null> {
  const userId = await resolveCallerUserId(request, env);
  return userId;
}

export async function handleListTeams(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  if (!userId) return unauthorized();
  const teams = await listTeams(env, userId);
  // The brand is returned only with an authenticated membership. Clients must
  // never infer it from the selected login server or an email address.
  const brandKey = editionBrand(env);
  return json({ ok: true, data: { teams: teams.map(team => ({ ...team, brand_key: brandKey })) } });
}

export async function handleWorkspaceOverview(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  if (!userId) return unauthorized();
  const teams = await loadWorkspaceTeamViews(env, userId);
  return json({ ok: true, data: { teams } });
}

export async function handleCreateTeam(request: Request, env: Env): Promise<Response> {
  const paidOnly = editionTeamCreationError(env);
  if (paidOnly) return json({ ok: false, error: paidOnly }, 403);
  const single = editionSingleWorkspaceRefusal(env);
  if (single) return json({ ok: false, error: single }, 403);
  const userId = await requireUser(request, env);
  if (!userId) return unauthorized();
  let body: { name?: string; slug?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const name = parseString(body.name);
  if (!name) return json({ ok: false, error: "name is required" }, 400);
  const team = await createTeam(env, { name, slug: parseString(body.slug) || undefined, ownerUserId: userId });
  return json({ ok: true, data: { team } }, 201);
}

export async function handleListProjects(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  if (!userId) return unauthorized();
  const url = new URL(request.url);
  const teamId = parseString(url.searchParams.get("team_id")) || undefined;
  const projects = await listProjects(env, { userId, teamId });
  return json({ ok: true, data: { projects } });
}

export async function handleCreateProject(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  if (!userId) return unauthorized();
  let body: { team_id?: string; name?: string; slug?: string; description?: string | null };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const teamId = parseString(body.team_id);
  const name = parseString(body.name);
  if (!teamId) return json({ ok: false, error: "team_id is required" }, 400);
  if (!name) return json({ ok: false, error: "name is required" }, 400);
  if (name.length > 100 || (body.description != null && (typeof body.description !== "string" || body.description.length > 240))) return json({ ok: false, error: "invalid project name or description" }, 400);
  try {
    const project = await createProject(env, {
      teamId,
      userId,
      name,
      slug: parseString(body.slug) || undefined,
      description: body.description?.trim() || null,
    });
    if (!project) return json({ ok: false, error: "forbidden" }, 403);
    return json({ ok: true, data: { project } }, 201);
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed")) return json({ ok: false, error: "project already exists" }, 409);
    throw error;
  }
}

export async function handleUpdateProject(request: Request, env: Env, projectId: string): Promise<Response> {
  const userId = await requireUser(request, env);
  if (!userId) return unauthorized();
  let body: { name?: string; description?: string | null; pinned?: boolean; archived?: boolean };
  try { body = await request.json() as typeof body; } catch { return json({ ok: false, error: "invalid JSON body" }, 400); }
  if (body.name !== undefined && (!parseString(body.name) || body.name.length > 100)) return json({ ok: false, error: "invalid project name" }, 400);
  if (body.description !== undefined && body.description !== null && (typeof body.description !== "string" || body.description.length > 240)) return json({ ok: false, error: "invalid description" }, 400);
  if (body.pinned !== undefined && typeof body.pinned !== "boolean" || body.archived !== undefined && typeof body.archived !== "boolean") return json({ ok: false, error: "invalid project state" }, 400);
  const project = await updateProject(env, { id: projectId, userId, name: body.name?.trim(), description: body.description, pinned: body.pinned, archived: body.archived });
  if (!project) return json({ ok: false, error: "not found" }, 404);
  return json({ ok: true, data: { project } });
}

export async function handleWorkspaceTags(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  if (!userId) return unauthorized();
  const teamId = request.method === "GET" ? parseString(new URL(request.url).searchParams.get("team_id")) : null;
  if (request.method === "GET") {
    if (!teamId) return json({ ok: false, error: "team_id is required" }, 400);
    const tags = await listWorkspaceTags(env, teamId, userId);
    return tags ? json({ ok: true, data: { tags } }) : json({ ok: false, error: "not found" }, 404);
  }
  let body: { team_id?: string; name?: string; color?: string };
  try { body = await request.json() as typeof body; } catch { return json({ ok: false, error: "invalid JSON body" }, 400); }
  const name = parseString(body.name);
  if (!name || name.length > 40 || !parseString(body.team_id) || !["teal", "blue", "amber", "violet", "rose"].includes(body.color || "teal")) return json({ ok: false, error: "invalid tag" }, 400);
  try {
    const tag = await createWorkspaceTag(env, { teamId: body.team_id!, userId, name, color: body.color || "teal" });
    return tag ? json({ ok: true, data: { tag } }, 201) : json({ ok: false, error: "forbidden" }, 403);
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed")) return json({ ok: false, error: "tag already exists" }, 409);
    throw error;
  }
}

export async function handleSetResourceTags(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  if (!userId) return unauthorized();
  let body: { team_id?: string; resource_type?: string; resource_id?: string; tag_ids?: string[] };
  try { body = await request.json() as typeof body; } catch { return json({ ok: false, error: "invalid JSON body" }, 400); }
  if (!parseString(body.team_id) || !parseString(body.resource_id) || !["message", "artifact"].includes(body.resource_type || "") || !Array.isArray(body.tag_ids) || body.tag_ids.length > 10 || !body.tag_ids.every(id => typeof id === "string" && /^[a-f0-9]{32}$/.test(id))) return json({ ok: false, error: "invalid tag assignment" }, 400);
  const ok = await setResourceTags(env, { teamId: body.team_id!, userId, resourceType: body.resource_type as "message" | "artifact", resourceId: body.resource_id!, tagIds: body.tag_ids });
  return ok ? json({ ok: true, data: {} }) : json({ ok: false, error: "forbidden" }, 403);
}

export async function handleListComments(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  if (!userId) return unauthorized();
  const url = new URL(request.url);
  const teamId = parseString(url.searchParams.get("team_id"));
  if (!teamId) return json({ ok: false, error: "team_id is required" }, 400);
  const resourceType = parseString(url.searchParams.get("resource_type")) as WorkspaceResourceType | null;
  if (resourceType && !VALID_RESOURCE_TYPES.includes(resourceType)) {
    return json({ ok: false, error: "invalid resource_type" }, 400);
  }
  const resourceId = parseString(url.searchParams.get("resource_id")) || undefined;
  if (!await getWorkspaceMembership(env, teamId, userId)) return json({ ok: false, error: "not found" }, 404);
  if (resourceType && resourceId) {
    const resource = await getWorkspaceResource(env, resourceType, resourceId);
    if (!resource || resource.team_id !== teamId) return json({ ok: false, error: "not found" }, 404);
  }
  const comments = await listComments(env, {
    userId,
    teamId,
    resourceType: resourceType || undefined,
    resourceId,
  });
  return json({ ok: true, data: { comments } });
}

export async function handleCreateComment(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  if (!userId) return unauthorized();
  let body: {
    team_id?: string;
    project_id?: string | null;
    resource_type?: string;
    resource_id?: string;
    parent_id?: string | null;
    body?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const teamId = parseString(body.team_id);
  const resourceType = parseString(body.resource_type) as WorkspaceResourceType | null;
  const resourceId = parseString(body.resource_id);
  const text = parseString(body.body);
  if (!teamId) return json({ ok: false, error: "team_id is required" }, 400);
  if (!resourceType || !VALID_RESOURCE_TYPES.includes(resourceType)) {
    return json({ ok: false, error: "resource_type is required" }, 400);
  }
  if (!resourceId) return json({ ok: false, error: "resource_id is required" }, 400);
  if (!text) return json({ ok: false, error: "body is required" }, 400);
  if (!canWriteWorkspace((await getWorkspaceMembership(env, teamId, userId))?.role)) {
    return json({ ok: false, error: "forbidden" }, 403);
  }
  const denied = await editionAccessError(env, { teamId });
  if (denied) return json({ ok: false, error: denied }, 403);
  let comment;
  try {
    comment = await createComment(env, {
      userId,
      teamId,
      projectId: parseString(body.project_id),
      resourceType,
      resourceId,
      body: text,
      parentId: parseString(body.parent_id),
    });
  } catch (error) {
    if (error instanceof MentionRejected) return json({ ok: false, error: error.message }, 400);
    throw error;
  }
  if (!comment) return json({ ok: false, error: "forbidden" }, 403);
  return json({ ok: true, data: { comment } }, 201);
}

export async function handleListDecisionMemos(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  if (!userId) return unauthorized();
  const url = new URL(request.url);
  const teamId = parseString(url.searchParams.get("team_id"));
  if (!teamId) return json({ ok: false, error: "team_id is required" }, 400);
  const projectId = parseString(url.searchParams.get("project_id")) || undefined;
  const membership = await getWorkspaceMembership(env, teamId, userId);
  if (!canReadWorkspace(membership?.role ?? null)) {
    return json({ ok: false, error: "forbidden" }, 403);
  }
  const documents = await listDocuments(env, {
    teamId,
    projectId,
    docKind: "decision_memo",
    userId,
    limit: 25,
  });
  return json({ ok: true, data: { memos: documents.items } });
}

export async function handleListWorkspaceBackups(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  if (!userId) return unauthorized();
  const teams = await listTeams(env, userId);
  if (!teams.some((team) => team.role === "owner" || team.role === "admin")) {
    return json({ ok: false, error: "forbidden" }, 403);
  }
  const backups = await listWorkspaceBackups(env, 20);
  return json({ ok: true, data: { backups } });
}

export async function handleCreateDecisionMemo(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  if (!userId) return unauthorized();
  let body: {
    team_id?: string;
    project_id?: string | null;
    project?: string;
    title?: string;
    status?: string;
    decision?: string;
    context?: string;
    options?: string;
    consequences?: string;
    owners?: string;
    public?: boolean;
    sharing?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  if (body.sharing != null && !parseSharing(body.sharing)) return json({ ok: false, error: "invalid sharing" }, 400);
  const teamId = parseString(body.team_id);
  const title = parseString(body.title);
  const decision = parseString(body.decision);
  if (!teamId) return json({ ok: false, error: "team_id is required" }, 400);
  if (!title) return json({ ok: false, error: "title is required" }, 400);
  if (!decision) return json({ ok: false, error: "decision is required" }, 400);
  const membership = await getWorkspaceMembership(env, teamId, userId);
  if (!canWriteWorkspace(membership?.role ?? null)) {
    return json({ ok: false, error: "forbidden" }, 403);
  }
  const projectId = parseString(body.project_id);
  if (projectId) {
    const project = await getProjectById(env, projectId);
    if (!project || project.team_id !== teamId) {
      return json({ ok: false, error: "forbidden" }, 403);
    }
  }
  const markdown = buildDecisionMemoMarkdown({
    title,
    status: parseString(body.status),
    decision,
    context: body.context ?? null,
    options: body.options ?? null,
    consequences: body.consequences ?? null,
    owners: body.owners ?? null,
  });
  const memo = await publishDocument(env, {
    title,
    markdown,
    public: body.public ?? false,
    userId,
    teamId,
    projectId: projectId || undefined,
    project: parseString(body.project) || "workspace",
    docKind: "decision_memo",
    sharing: parseSharing(body.sharing),
  });
  return json({ ok: true, data: { memo } }, 201);
}

export async function handleWorkspaceFeed(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  if (!userId) return unauthorized();
  const url = new URL(request.url);
  const teamId = parseString(url.searchParams.get("team_id"));
  if (!teamId) return json({ ok: false, error: "team_id is required" }, 400);
  if (!await getWorkspaceMembership(env, teamId, userId)) return json({ ok: false, error: "not found" }, 404);
  const data = await listWorkspaceFeed(env, { userId, teamId,
    projectId: parseString(url.searchParams.get("project_id")) || undefined,
    tagId: parseString(url.searchParams.get("tag_id")) || undefined,
    resourceId: parseString(url.searchParams.get("resource_id")) || undefined,
    limit: Number(url.searchParams.get("limit") || 50), cursor: url.searchParams.get("cursor") || undefined });
  return json({ ok: true, data });
}

export async function handleCreateWorkspacePost(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  if (!userId) return unauthorized();
  let body: { team_id?: string; project_id?: string; title?: string; body?: string };
  try { body = await request.json() as typeof body; } catch { return json({ ok: false, error: "invalid JSON body" }, 400); }
  const teamId = parseString(body.team_id), title = parseString(body.title), text = parseString(body.body);
  if (!teamId || !title || !text || title.length > 300 || text.length > 50000) return json({ ok: false, error: "team_id, title (up to 300 characters), and body (up to 50000 characters) are required" }, 400);
  const projectId = parseString(body.project_id);
  try { await assertWorkspacePublishScope(env, userId, teamId, projectId); }
  catch (err) { if (err instanceof WorkspaceAccessError) return json({ ok: false, error: err.message }, 403); throw err; }
  let recipients: string[];
  try { recipients = await editionResolveMentions(env, teamId, userId, `${title}\n${text}`); }
  catch (error) { if (error instanceof MentionRejected) return json({ ok: false, error: error.message }, 400); throw error; }
  const result = await createMessage(env, { type: "message", title, body: text, userId, teamId, projectId,
    instance: { model: "human", session_id: workspaceUserSessionId(userId), source: editionSlug(), project: "team" } });
  await editionRecordMentions(env, { teamId, authorId: userId, recipients, resourceType: "message",
    resourceId: result.id, sourceKind: "post", sourceId: result.id, text: `${title}: ${text}` });
  const feed = await listWorkspaceFeed(env, { userId, teamId, resourceId: result.id, limit: 1 });
  return json({ ok: true, data: { item: feed.items.find(item => item.id === result.id) } }, 201);
}

export async function handleWorkspaceMembers(request: Request, env: Env, teamId: string, targetUserId?: string): Promise<Response> {
  const userId = await requireUser(request, env);
  if (!userId) return unauthorized();
  if (request.method === "GET") {
    const members = await listWorkspaceMembers(env, teamId, userId);
    return members ? json({ ok: true, data: { members } }) : json({ ok: false, error: "not found" }, 404);
  }
  let body: { user_id?: string; email?: string; role?: string } = {};
  if (request.method !== "DELETE") {
    try { body = await request.json() as typeof body; } catch { return json({ ok: false, error: "invalid JSON body" }, 400); }
    if (!["admin", "member", "viewer"].includes(body.role || "")) return json({ ok: false, error: "role must be admin, member, or viewer" }, 400);
  }
  try {
    const success = await setWorkspaceMember(env, { teamId, actorId: userId,
      userId: targetUserId || parseString(body.user_id) || undefined, email: parseString(body.email) || undefined,
      role: body.role as "admin" | "member" | "viewer", remove: request.method === "DELETE" });
    return success ? json({ ok: true, data: { updated: true } })
      : json({ ok: false, error: "forbidden or member does not have a supported verified identity" }, 403);
  } catch (error) {
    const limit = editionMemberLimitMessage(error);
    if (limit) return json({ ok: false, error: limit }, 409);
    throw error;
  }
}

export async function handleShareWorkspaceResource(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  if (!userId) return unauthorized();
  let body: { resource_type?: WorkspaceResourceType; resource_id?: string; team_id?: string; project_id?: string };
  try { body = await request.json() as typeof body; } catch { return json({ ok: false, error: "invalid JSON body" }, 400); }
  const resourceId = parseString(body.resource_id), teamId = parseString(body.team_id);
  if (!resourceId || !teamId || !body.resource_type || !VALID_RESOURCE_TYPES.includes(body.resource_type)) return json({ ok: false, error: "resource_type, resource_id, and team_id are required" }, 400);
  try {
    const shared = await shareResourceToWorkspace(env, { actorId: userId, resourceType: body.resource_type, resourceId, teamId,
      projectId: parseString(body.project_id) || undefined });
    if (!shared) return json({ ok: false, error: "resource not found or composed artifacts have a different audience" }, 403);
    return json({ ok: true, data: { resource_id: resourceId, team_id: teamId, shared: true } });
  } catch (err) { if (err instanceof WorkspaceAccessError) return json({ ok: false, error: err.message }, 403); throw err; }
}

// POST /api/sharing — {resource_type: document|artifact, resource_id, sharing:
// private|shared, team_id?, project_id?}. The owner publishes an item to its
// team (shared) or takes it back (private). A personal item that is published
// moves into team_id, or the owner's only team.
export async function handleSetResourceSharing(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  if (!userId) return unauthorized();
  let body: { resource_type?: WorkspaceResourceType; resource_id?: string; sharing?: string; team_id?: string; project_id?: string };
  try { body = await request.json() as typeof body; } catch { return json({ ok: false, error: "invalid JSON body" }, 400); }
  const resourceId = parseString(body.resource_id), sharing = parseSharing(body.sharing);
  if (!resourceId || !body.resource_type || !VALID_RESOURCE_TYPES.includes(body.resource_type) || !sharing) {
    return json({ ok: false, error: 'resource_type, resource_id, and sharing ("private" or "shared") are required' }, 400);
  }
  try {
    const result = await setResourceSharing(env, { actorId: userId, resourceType: body.resource_type, resourceId, sharing,
      teamId: parseString(body.team_id), projectId: parseString(body.project_id) });
    return json({ ok: true, data: result });
  } catch (err) {
    if (err instanceof SharingError) return json({ ok: false, error: err.message }, err.status);
    throw err;
  }
}
