import type { Env } from "../types";

export type CommuteSourcePreference = "latest" | "playlist";

export interface PlaylistItem {
  message_id: string;
  title: string;
  position: number;
  instance_project: string;
  instance_model: string;
  created_at: string;
  playlist_added_at: string;
}

let playlistTableReady: Promise<void> | null = null;

async function ensurePlaylistTables(env: Env): Promise<void> {
  if (!playlistTableReady) {
    playlistTableReady = env.DB.batch([
      env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS commute_playlist_items (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (user_id, message_id)
        )`
      ),
      env.DB.prepare(
        `CREATE INDEX IF NOT EXISTS idx_playlist_user_pos
         ON commute_playlist_items(user_id, position)`
      ),
      env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS user_settings (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          commute_source TEXT NOT NULL DEFAULT 'latest'
            CHECK (commute_source IN ('latest', 'playlist')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ),
    ]).then(() => undefined);
  }
  await playlistTableReady;
}

function normalizeMessageIds(messageIds: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawId of messageIds) {
    if (typeof rawId !== "string") {
      throw new Error("playlist ids must be strings");
    }
    const id = rawId.trim();
    if (!id) {
      throw new Error("playlist ids must be non-empty strings");
    }
    if (seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

export async function listPlaylistItems(
  env: Env,
  userId: string
): Promise<PlaylistItem[]> {
  await ensurePlaylistTables(env);
  const result = await env.DB.prepare(
    `SELECT
       p.message_id,
       m.title,
       p.position,
       m.instance_project,
       m.instance_model,
       m.created_at,
       p.created_at AS playlist_added_at
     FROM commute_playlist_items p
     JOIN messages m ON m.id = p.message_id
     WHERE p.user_id = ? AND m.user_id = ?
     ORDER BY p.position ASC`
  )
    .bind(userId, userId)
    .all<PlaylistItem>();
  return result.results ?? [];
}

export async function addToPlaylist(
  env: Env,
  userId: string,
  messageId: string
): Promise<void> {
  await ensurePlaylistTables(env);
  const [id] = normalizeMessageIds([messageId]);

  const message = await env.DB.prepare(
    "SELECT id FROM messages WHERE id = ? AND type = 'document' AND user_id = ?"
  )
    .bind(id, userId)
    .first<{ id: string }>();

  if (!message) {
    throw new Error("document not found or does not belong to you");
  }

  const maxRow = await env.DB.prepare(
    "SELECT MAX(position) as max_pos FROM commute_playlist_items WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ max_pos: number | null }>();

  const nextPosition = (maxRow?.max_pos ?? -1) + 1;

  await env.DB.prepare(
    `INSERT INTO commute_playlist_items (user_id, message_id, position, created_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, message_id) DO UPDATE SET
       position = excluded.position,
       created_at = datetime('now')`
  )
    .bind(userId, id, nextPosition)
    .run();

  await recompactPositions(env, userId);
}

export async function removeFromPlaylist(
  env: Env,
  userId: string,
  messageId: string
): Promise<void> {
  await ensurePlaylistTables(env);
  const [id] = normalizeMessageIds([messageId]);
  await env.DB.prepare(
    "DELETE FROM commute_playlist_items WHERE user_id = ? AND message_id = ?"
  )
    .bind(userId, id)
    .run();

  await recompactPositions(env, userId);
}

async function recompactPositions(env: Env, userId: string): Promise<void> {
  const items = await env.DB.prepare(
    "SELECT message_id FROM commute_playlist_items WHERE user_id = ? ORDER BY position ASC"
  )
    .bind(userId)
    .all<{ message_id: string }>();

  const rows = items.results ?? [];
  if (rows.length === 0) return;

  const statements = rows.map((row, position) =>
    env.DB.prepare(
      "UPDATE commute_playlist_items SET position = ? WHERE user_id = ? AND message_id = ?"
    ).bind(position, userId, row.message_id)
  );

  await env.DB.batch(statements);
}

export async function setPlaylist(
  env: Env,
  userId: string,
  messageIds: string[]
): Promise<void> {
  await ensurePlaylistTables(env);
  const normalizedIds = normalizeMessageIds(messageIds);

  if (normalizedIds.length > 0) {
    const placeholders = normalizedIds.map(() => "?").join(",");
    const result = await env.DB.prepare(
      `SELECT id FROM messages
       WHERE id IN (${placeholders}) AND type = 'document' AND user_id = ?`
    )
      .bind(...normalizedIds, userId)
      .all<{ id: string }>();

    const foundIds = new Set((result.results ?? []).map((row) => row.id));
    const missing = normalizedIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new Error(`documents not found: ${missing.join(", ")}`);
    }
  }

  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM commute_playlist_items WHERE user_id = ?").bind(userId),
    ...normalizedIds.map((id, position) =>
      env.DB.prepare(
        `INSERT INTO commute_playlist_items (user_id, message_id, position, created_at)
         VALUES (?, ?, ?, datetime('now'))`
      ).bind(userId, id, position)
    ),
  ];

  await env.DB.batch(statements);
}

export async function clearPlaylist(env: Env, userId: string): Promise<void> {
  await ensurePlaylistTables(env);
  await env.DB.prepare("DELETE FROM commute_playlist_items WHERE user_id = ?")
    .bind(userId)
    .run();
}

export async function getCommuteSource(
  env: Env,
  userId: string
): Promise<CommuteSourcePreference> {
  await ensurePlaylistTables(env);
  const row = await env.DB.prepare(
    "SELECT commute_source FROM user_settings WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ commute_source: string }>();

  return row?.commute_source === "playlist" ? "playlist" : "latest";
}

export async function setCommuteSource(
  env: Env,
  userId: string,
  source: CommuteSourcePreference
): Promise<void> {
  await ensurePlaylistTables(env);
  await env.DB.prepare(
    `INSERT INTO user_settings (user_id, commute_source, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       commute_source = excluded.commute_source,
       updated_at = datetime('now')`
  )
    .bind(userId, source)
    .run();
}
