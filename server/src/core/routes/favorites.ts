import { AUDIO_SOURCE_READ_SQL } from "../audio/store";
import { artifactReadSql, messageReadSql } from "../workspace-access";
import type { Env } from "../types";
import { resolveCallerUserId, unauthorized } from "../middleware";
import { json } from "../utils";
import { editionWorkspaceSignInOnly } from "../edition-hooks";

/** Favorites are bookmarks owned by one user. A row never grants access: every read
 * re-checks that the user can still see the item and drops the row when they cannot. */
export const FAVORITE_KINDS = ["doc", "artifact", "message", "runbook", "audio"] as const;
export type FavoriteKind = (typeof FAVORITE_KINDS)[number];

export interface Favorite {
  kind: FavoriteKind;
  item_id: string;
  key: string;
  title: string;
  url: string;
  position: number;
  created_at: string;
  team_id?: string;
}

interface StoredFavorite { kind: FavoriteKind; item_id: string; title: string; team_id: string | null; position: number; created_at: string }
interface VisibleItem { title: string; url: string; team_id: string | null }

const MAX_TITLE = 300;
const MAX_FAVORITES = 500;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;
const IN_CHUNK = 80;

const isKind = (value: string): value is FavoriteKind => (FAVORITE_KINDS as readonly string[]).includes(value);

function chunks<T>(items: T[]): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += IN_CHUNK) result.push(items.slice(i, i + IN_CHUNK));
  return result;
}

async function memberTeams(env: Env, userId: string): Promise<Set<string>> {
  const rows = await env.DB.prepare("SELECT team_id FROM team_memberships WHERE user_id = ?").bind(userId).all<{ team_id: string }>();
  return new Set(rows.results.map(row => row.team_id));
}

/** Items of one kind the user can currently see, keyed by id. */
async function visibleItems(env: Env, userId: string, teams: Set<string>, kind: FavoriteKind, ids: string[]): Promise<Map<string, VisibleItem>> {
  const found = new Map<string, VisibleItem>();
  for (const part of chunks(ids)) {
    const marks = part.map(() => "?").join(",");
    if (kind === "doc" || kind === "message") {
      const typeClause = kind === "doc" ? "type = 'document'" : "type != 'document'";
      const rows = await env.DB.prepare(`SELECT id, title, user_id, team_id, sharing, public, interactive FROM messages WHERE ${typeClause} AND id IN (${marks})
        AND (${messageReadSql("messages")} OR (team_id IS NULL AND type = 'document' AND public = 1 AND ? = 1))`)
        .bind(...part, userId, userId, editionWorkspaceSignInOnly(env) ? 0 : 1).all<{ id: string; title: string; user_id: string | null; team_id: string | null; sharing: string; public: number; interactive: number }>();
      for (const row of rows.results) {
        const url = kind === "message" ? `/messages/${row.id}` : `${row.interactive === 1 ? "/idoc/" : "/docs/"}${row.id}`;
        found.set(row.id, { title: row.title, url, team_id: row.team_id });
      }
    } else if (kind === "artifact") {
      const rows = await env.DB.prepare(`SELECT id, title, user_id, team_id, sharing, visibility FROM artifacts WHERE id IN (${marks})
        AND (${artifactReadSql("artifacts")} OR (team_id IS NULL AND visibility = 'public'))`)
        .bind(...part, userId, userId).all<{ id: string; title: string; user_id: string | null; team_id: string | null; sharing: string; visibility: string }>();
      for (const row of rows.results) {
        found.set(row.id, { title: row.title, url: `/a/${row.id}`, team_id: row.team_id });
      }
    } else if (kind === "audio") {
      // Audio items stay per user: they never belong to a team.
      const rows = await env.DB.prepare(`SELECT id, title FROM audio_items WHERE user_id = ? AND ${AUDIO_SOURCE_READ_SQL()} AND id IN (${marks})`)
        .bind(userId, userId, userId, ...part).all<{ id: string; title: string }>();
      for (const row of rows.results) found.set(row.id, { title: row.title, url: `/audio/${encodeURIComponent(row.id)}`, team_id: null });
    } else {
      const rows = await env.DB.prepare(`SELECT id, title, team_id FROM ops_runbooks WHERE id IN (${marks})`)
        .bind(...part).all<{ id: string; title: string; team_id: string }>();
      for (const row of rows.results) {
        if (teams.has(row.team_id)) found.set(row.id, { title: row.title, url: `/runbooks?runbook=${row.id}`, team_id: row.team_id });
      }
    }
  }
  return found;
}

function shape(stored: StoredFavorite, item: VisibleItem): Favorite {
  const favorite: Favorite = {
    kind: stored.kind, item_id: stored.item_id, key: `${stored.kind}:${stored.item_id}`,
    title: stored.title || item.title, url: item.url, position: stored.position, created_at: stored.created_at,
  };
  if (item.team_id) favorite.team_id = item.team_id;
  return favorite;
}

/** The user's favorites in order. Rows for items the user can no longer see are deleted. */
export async function listFavorites(env: Env, userId: string): Promise<Favorite[]> {
  const rows = await env.DB.prepare("SELECT kind, item_id, title, team_id, position, created_at FROM user_favorites WHERE user_id = ? ORDER BY position ASC, created_at ASC, item_id ASC")
    .bind(userId).all<StoredFavorite>();
  if (!rows.results.length) return [];
  const teams = await memberTeams(env, userId);
  const visible = new Map<FavoriteKind, Map<string, VisibleItem>>();
  for (const kind of FAVORITE_KINDS) {
    const ids = rows.results.filter(row => row.kind === kind).map(row => row.item_id);
    if (ids.length) visible.set(kind, await visibleItems(env, userId, teams, kind, ids));
  }
  const favorites: Favorite[] = [];
  const stale: StoredFavorite[] = [];
  for (const row of rows.results) {
    const item = visible.get(row.kind)?.get(row.item_id);
    if (item) favorites.push(shape(row, item)); else stale.push(row);
  }
  if (stale.length) {
    await env.DB.batch(stale.map(row => env.DB.prepare("DELETE FROM user_favorites WHERE user_id = ? AND kind = ? AND item_id = ?").bind(userId, row.kind, row.item_id)));
  }
  return favorites;
}

async function upsertFavorite(request: Request, env: Env, userId: string, kind: FavoriteKind, itemId: string): Promise<Response> {
  let title: string | undefined;
  if ((request.headers.get("Content-Type") || "").includes("json") || Number(request.headers.get("Content-Length") || 0) > 0) {
    let body: unknown;
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400); }
    if (body === null || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "Expected an object." }, 400);
    const raw = (body as { title?: unknown }).title;
    if (raw !== undefined && raw !== null) {
      if (typeof raw !== "string") return json({ ok: false, error: "title must be text." }, 400);
      title = raw.trim();
      if (title.length > MAX_TITLE) return json({ ok: false, error: `title must be at most ${MAX_TITLE} characters.` }, 400);
    }
  }
  const teams = await memberTeams(env, userId);
  const item = (await visibleItems(env, userId, teams, kind, [itemId])).get(itemId);
  if (!item) return json({ ok: false, error: "not found" }, 404);
  const existing = await env.DB.prepare("SELECT 1 AS found FROM user_favorites WHERE user_id = ? AND kind = ? AND item_id = ?").bind(userId, kind, itemId).first();
  if (!existing) {
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM user_favorites WHERE user_id = ?").bind(userId).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_FAVORITES) return json({ ok: false, error: `You can keep up to ${MAX_FAVORITES} favorites.` }, 400);
  }
  // A new favorite goes last. A repeat call keeps its place and only changes the title when one is sent.
  await env.DB.prepare(`INSERT INTO user_favorites (user_id, kind, item_id, title, team_id, position)
    VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM user_favorites WHERE user_id = ?))
    ON CONFLICT(user_id, kind, item_id) DO UPDATE SET team_id = excluded.team_id${title === undefined ? "" : ", title = excluded.title"}`)
    .bind(userId, kind, itemId, (title ?? item.title).slice(0, MAX_TITLE), item.team_id, userId).run();
  const row = await env.DB.prepare("SELECT kind, item_id, title, team_id, position, created_at FROM user_favorites WHERE user_id = ? AND kind = ? AND item_id = ?")
    .bind(userId, kind, itemId).first<StoredFavorite>();
  return json({ ok: true, data: { favorite: shape(row!, item) } });
}

async function reorderFavorites(request: Request, env: Env, userId: string): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400); }
  const keys = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length > MAX_FAVORITES || keys.some(key => typeof key !== "string" || key.length > 120)) {
    return json({ ok: false, error: "keys must be a list of kind:id text." }, 400);
  }
  const current = await env.DB.prepare("SELECT kind, item_id FROM user_favorites WHERE user_id = ? ORDER BY position ASC, created_at ASC, item_id ASC")
    .bind(userId).all<{ kind: string; item_id: string }>();
  const known = new Set(current.results.map(row => `${row.kind}:${row.item_id}`));
  // Keys the user does not have are ignored. Favorites left out of the list keep their order after the listed ones.
  const ordered = [...new Set(keys as string[])].filter(key => known.has(key));
  const listed = new Set(ordered);
  const rest = current.results.map(row => `${row.kind}:${row.item_id}`).filter(key => !listed.has(key));
  const final = [...ordered, ...rest];
  if (final.length) {
    await env.DB.batch(final.map((key, index) => {
      const split = key.indexOf(":");
      return env.DB.prepare("UPDATE user_favorites SET position = ? WHERE user_id = ? AND kind = ? AND item_id = ?").bind(index, userId, key.slice(0, split), key.slice(split + 1));
    }));
  }
  return json({ ok: true, data: { favorites: await listFavorites(env, userId) } });
}

/** Cookie sessions are SameSite=Lax. A request that names a different site as its origin is still refused. */
function foreignOrigin(request: Request): boolean {
  if (request.headers.has("Authorization")) return false;
  const origin = request.headers.get("Origin");
  return !!origin && origin !== "null" && origin !== new URL(request.url).origin;
}

export async function handleFavorites(request: Request, env: Env): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (method !== "GET" && foreignOrigin(request)) return json({ ok: false, error: "invalid origin" }, 403);
  if (path === "/api/favorites") {
    if (method === "GET") return json({ ok: true, data: { favorites: await listFavorites(env, userId) } });
    return json({ ok: false, error: "method not allowed" }, 405);
  }
  if (path === "/api/favorites/order") {
    if (method === "POST") return reorderFavorites(request, env, userId);
    return json({ ok: false, error: "method not allowed" }, 405);
  }
  const match = path.match(/^\/api\/favorites\/([a-z]+)\/([^/]+)$/);
  if (!match) return json({ ok: false, error: "not found" }, 404);
  const [, kind, rawId] = match;
  let itemId: string;
  try { itemId = decodeURIComponent(rawId); } catch { return json({ ok: false, error: "invalid id" }, 400); }
  if (!isKind(kind)) return json({ ok: false, error: "kind must be one of: " + FAVORITE_KINDS.join(", ") }, 400);
  if (!ID_PATTERN.test(itemId)) return json({ ok: false, error: "invalid id" }, 400);
  if (method === "PUT") return upsertFavorite(request, env, userId, kind, itemId);
  if (method === "DELETE") {
    await env.DB.prepare("DELETE FROM user_favorites WHERE user_id = ? AND kind = ? AND item_id = ?").bind(userId, kind, itemId).run();
    return json({ ok: true, data: { ok: true } });
  }
  return json({ ok: false, error: "method not allowed" }, 405);
}
