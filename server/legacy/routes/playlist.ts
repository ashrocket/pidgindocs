import {
  addToPlaylist,
  clearPlaylist,
  getCommuteSource,
  listPlaylistItems,
  removeFromPlaylist,
  setCommuteSource,
  setPlaylist,
} from "../commute/playlist";
import { generatePlaylistBriefing } from "../commute/playlist-briefing";
import { resolveCallerUserId, unauthorized } from "../middleware";
import type { Env } from "../types";
import { json } from "../utils";

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

export async function handleGetPlaylist(
  request: Request,
  env: Env
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  const [items, commuteSource] = await Promise.all([
    listPlaylistItems(env, userId),
    getCommuteSource(env, userId),
  ]);
  return json({ ok: true, data: { items, commute_source: commuteSource } });
}

export async function handleSetPlaylist(
  request: Request,
  env: Env
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  const body = await readJson<{ ids?: unknown }>(request);
  if (!body) {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  if (!Array.isArray(body.ids)) {
    return json({ ok: false, error: "ids must be an array of strings" }, 400);
  }

  try {
    await setPlaylist(env, userId, body.ids as string[]);
    const items = await listPlaylistItems(env, userId);
    return json({ ok: true, data: { items } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "set playlist failed";
    return json({ ok: false, error: message }, 400);
  }
}

export async function handleAddToPlaylist(
  request: Request,
  env: Env
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  const body = await readJson<{ id?: unknown }>(request);
  if (!body) {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  if (typeof body.id !== "string" || !body.id.trim()) {
    return json({ ok: false, error: "id is required" }, 400);
  }

  try {
    await addToPlaylist(env, userId, body.id);
    const items = await listPlaylistItems(env, userId);
    return json({ ok: true, data: { items } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "add to playlist failed";
    return json({ ok: false, error: message }, 400);
  }
}

export async function handleRemoveFromPlaylist(
  request: Request,
  env: Env
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  const body = await readJson<{ id?: unknown }>(request);
  if (!body) {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  if (typeof body.id !== "string" || !body.id.trim()) {
    return json({ ok: false, error: "id is required" }, 400);
  }

  try {
    await removeFromPlaylist(env, userId, body.id);
    const items = await listPlaylistItems(env, userId);
    return json({ ok: true, data: { items } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "remove from playlist failed";
    return json({ ok: false, error: message }, 400);
  }
}

export async function handleClearPlaylist(
  request: Request,
  env: Env
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  try {
    await clearPlaylist(env, userId);
    return json({ ok: true, data: { items: [] } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "clear playlist failed";
    return json({ ok: false, error: message }, 400);
  }
}

export async function handleGeneratePlaylistBriefing(
  request: Request,
  env: Env
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  try {
    const result = await generatePlaylistBriefing(env, userId);
    return json({ ok: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "briefing generation failed";
    return json({ ok: false, error: message }, 400);
  }
}

export async function handleGetCommuteSource(
  request: Request,
  env: Env
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  const source = await getCommuteSource(env, userId);
  return json({ ok: true, data: { source } });
}

export async function handleSetCommuteSource(
  request: Request,
  env: Env
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  const body = await readJson<{ source?: unknown }>(request);
  if (!body) {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  if (body.source !== "latest" && body.source !== "playlist") {
    return json({ ok: false, error: "source must be 'latest' or 'playlist'" }, 400);
  }

  await setCommuteSource(env, userId, body.source);
  return json({ ok: true, data: { source: body.source } });
}
