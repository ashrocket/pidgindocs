import { json } from "../utils";
import { resolveCallerUserId, unauthorized } from "../middleware";
import {
  buildDecisionMemoMarkdown,
  canReadWorkspace,
  canWriteWorkspace,
  createComment,
  createProject,
  createTeam,
  getProjectById,
  getWorkspaceMembership,
  listComments,
  listProjects,
  listTeams,
} from "../workspace";
import { listDocuments, publishDocument } from "../documents";
import { loadWorkspaceTeamViews } from "../workspace-overview";
import { canListGlobalWorkspaceBackups, listWorkspaceBackups } from "../workspace-backup";
import type { Env, WorkspaceResourceType } from "../types";

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
  return json({ ok: true, data: { teams } });
}

export async function handleWorkspaceOverview(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  if (!userId) return unauthorized();
  const teams = await loadWorkspaceTeamViews(env, userId);
  return json({ ok: true, data: { teams } });
}

export async function handleCreateTeam(request: Request, env: Env): Promise<Response> {
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
  const project = await createProject(env, {
    teamId,
    userId,
    name,
    slug: parseString(body.slug) || undefined,
    description: body.description?.trim() || null,
  });
  if (!project) return json({ ok: false, error: "forbidden" }, 403);
  return json({ ok: true, data: { project } }, 201);
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
  const comment = await createComment(env, {
    userId,
    teamId,
    projectId: parseString(body.project_id),
    resourceType,
    resourceId,
    body: text,
    parentId: parseString(body.parent_id),
  });
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
    limit: 25,
  });
  return json({ ok: true, data: { memos: documents.items } });
}

export async function handleListWorkspaceBackups(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  if (!userId) return unauthorized();
  if (!await canListGlobalWorkspaceBackups(env, userId)) {
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
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
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
  });
  return json({ ok: true, data: { memo } }, 201);
}
