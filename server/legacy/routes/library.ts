import { json } from "../utils";
import { resolveCallerUserId, unauthorized } from "../middleware";
import {
  LibraryInputError,
  createLibraryProject,
  createLibraryTag,
  deleteLibraryProject,
  deleteLibraryTag,
  fileLibraryItems,
  getLibraryOverview,
  updateLibraryProject,
  updateLibraryTag,
} from "../library";
import type { Env } from "../types";

// Personal library routes (PidginDocs app Projects and Tags). Every route is
// scoped to the caller; mutations answer with the refreshed overview so a
// client can replace its whole library state in one step.

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function withLibrary(
  request: Request,
  env: Env,
  action: (userId: string, body: Record<string, unknown>) => Promise<{ status?: number; data?: Record<string, unknown> } | null>
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  const body = request.method === "DELETE" ? {} : await readBody(request);
  if (!body) return json({ ok: false, error: "invalid JSON body" }, 400);
  try {
    const result = await action(userId, body);
    if (!result) return json({ ok: false, error: "not found" }, 404);
    const library = await getLibraryOverview(env, userId);
    return json({ ok: true, data: { ...result.data, library } }, result.status ?? 200);
  } catch (err) {
    if (err instanceof LibraryInputError) return json({ ok: false, error: err.message }, 400);
    throw err;
  }
}

export async function handleGetLibrary(request: Request, env: Env): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  return json({ ok: true, data: { library: await getLibraryOverview(env, userId) } });
}

export function handleCreateLibraryProject(request: Request, env: Env): Promise<Response> {
  return withLibrary(request, env, async (userId, body) => {
    const id = await createLibraryProject(env, userId, body);
    return { status: 201, data: { project_id: id } };
  });
}

export function handleUpdateLibraryProject(request: Request, env: Env, projectId: string): Promise<Response> {
  return withLibrary(request, env, async (userId, body) =>
    (await updateLibraryProject(env, userId, projectId, body)) ? { data: { project_id: projectId } } : null
  );
}

export function handleDeleteLibraryProject(request: Request, env: Env, projectId: string): Promise<Response> {
  return withLibrary(request, env, async (userId) =>
    (await deleteLibraryProject(env, userId, projectId)) ? { data: { deleted: projectId } } : null
  );
}

export function handleCreateLibraryTag(request: Request, env: Env): Promise<Response> {
  return withLibrary(request, env, async (userId, body) => {
    const tag = await createLibraryTag(env, userId, body);
    return { status: 201, data: { tag } };
  });
}

export function handleUpdateLibraryTag(request: Request, env: Env, tagId: string): Promise<Response> {
  return withLibrary(request, env, async (userId, body) =>
    (await updateLibraryTag(env, userId, tagId, body)) ? { data: { tag_id: tagId } } : null
  );
}

export function handleDeleteLibraryTag(request: Request, env: Env, tagId: string): Promise<Response> {
  return withLibrary(request, env, async (userId) =>
    (await deleteLibraryTag(env, userId, tagId)) ? { data: { deleted: tagId } } : null
  );
}

export function handleFileLibraryItems(request: Request, env: Env): Promise<Response> {
  return withLibrary(request, env, async (userId, body) => {
    const result = await fileLibraryItems(env, userId, body);
    return { data: { ...result } };
  });
}
