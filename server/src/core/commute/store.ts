import type { Env } from "../types";
import { messageReadSql } from "../document-rbac";

/** Four caller-id binds: the briefing source, then every playlist input.
 * A generated playlist keeps its original sources as its access boundary. */
export const COMMUTE_SOURCE_READ_SQL = (): string => `${messageReadSql("m")} AND (cb.source_type IS NOT 'playlist' OR (
  json_valid(cb.playlist_doc_ids) AND json_type(CASE WHEN json_valid(cb.playlist_doc_ids) THEN cb.playlist_doc_ids ELSE 'null' END) = 'array'
  AND json_array_length(CASE WHEN json_valid(cb.playlist_doc_ids) THEN cb.playlist_doc_ids ELSE '[]' END) > 0
  AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(cb.playlist_doc_ids) THEN cb.playlist_doc_ids ELSE '[]' END) playlist_input
    LEFT JOIN messages playlist_source ON playlist_source.id = playlist_input.value
    WHERE playlist_input.type <> 'text' OR playlist_source.id IS NULL OR playlist_source.type <> 'document'
      OR NOT ${messageReadSql("playlist_source")})))`;

export type CommuteSourceType = "document" | "playlist";

export interface CommuteBriefingRecord {
  source_message_id: string;
  title: string;
  transcript_key: string;
  audio_key?: string | null;
  metadata_key?: string | null;
  provider: string;
  voice?: string | null;
  model?: string | null;
  minutes: number;
  status: string;
  error?: string | null;
  source_type?: CommuteSourceType;
  playlist_doc_ids?: string | null;
  transcript_size?: number;
  audio_size?: number;
  metadata_size?: number;
}

export interface CommuteBriefingListItem extends CommuteBriefingRecord {
  created_at: string;
  updated_at: string;
  instance_project: string;
  instance_model: string;
  source_type: CommuteSourceType;
  playlist_doc_ids: string | null;
  transcript_size: number;
  audio_size: number;
  metadata_size: number;
}

export interface CommuteBriefingListOptions {
  userId?: string;
  sourceType?: CommuteSourceType;
}

let commuteBriefingsTableReady: Promise<void> | null = null;

export async function ensureCommuteBriefingsTable(env: Env): Promise<void> {
  if (!commuteBriefingsTableReady) {
    commuteBriefingsTableReady = env.DB.batch([
      env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS commute_briefings (
          source_message_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          transcript_key TEXT NOT NULL,
          audio_key TEXT,
          metadata_key TEXT,
          provider TEXT NOT NULL DEFAULT 'openai',
          voice TEXT,
          model TEXT,
          minutes INTEGER NOT NULL DEFAULT 3,
          status TEXT NOT NULL DEFAULT 'pending',
          error TEXT,
          source_type TEXT NOT NULL DEFAULT 'document',
          playlist_doc_ids TEXT,
          transcript_size INTEGER NOT NULL DEFAULT 0,
          audio_size INTEGER NOT NULL DEFAULT 0,
          metadata_size INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (source_message_id) REFERENCES messages(id)
        )`
      ),
      env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS idx_commute_briefings_created ON commute_briefings(created_at DESC)"
      ),
      env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS idx_commute_briefings_source_created ON commute_briefings(source_type, created_at DESC)"
      ),
    ]).then(() => undefined);
  }

  await commuteBriefingsTableReady;
}

function commuteWhere(
  options: CommuteBriefingListOptions,
  leading: string[] = []
): { clause: string; binds: string[] } {
  const conditions = [...leading];
  const binds: string[] = [];

  if (options.userId) {
    conditions.push(`m.user_id = ? AND ${COMMUTE_SOURCE_READ_SQL()}`);
    binds.push(options.userId, options.userId, options.userId, options.userId, options.userId);
  }

  if (options.sourceType) {
    conditions.push("cb.source_type = ?");
    binds.push(options.sourceType);
  }

  return {
    clause: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    binds,
  };
}

export async function saveCommuteBriefing(
  env: Env,
  briefing: CommuteBriefingRecord
): Promise<void> {
  await ensureCommuteBriefingsTable(env);
  await env.DB.prepare(
    `INSERT INTO commute_briefings (
      source_message_id, title, transcript_key, audio_key, metadata_key,
      provider, voice, model, minutes, status, error, source_type, playlist_doc_ids,
      transcript_size, audio_size, metadata_size, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(source_message_id) DO UPDATE SET
      title = excluded.title,
      transcript_key = excluded.transcript_key,
      audio_key = excluded.audio_key,
      metadata_key = excluded.metadata_key,
      provider = excluded.provider,
      voice = excluded.voice,
      model = excluded.model,
      minutes = excluded.minutes,
      status = excluded.status,
      error = excluded.error,
      source_type = excluded.source_type,
      playlist_doc_ids = excluded.playlist_doc_ids,
      transcript_size = excluded.transcript_size,
      audio_size = excluded.audio_size,
      metadata_size = excluded.metadata_size,
      updated_at = datetime('now')`
  )
    .bind(
      briefing.source_message_id,
      briefing.title,
      briefing.transcript_key,
      briefing.audio_key || null,
      briefing.metadata_key || null,
      briefing.provider,
      briefing.voice || null,
      briefing.model || null,
      briefing.minutes,
      briefing.status,
      briefing.error || null,
      briefing.source_type || "document",
      briefing.playlist_doc_ids || null,
      briefing.transcript_size ?? 0,
      briefing.audio_size ?? 0,
      briefing.metadata_size ?? 0
    )
    .run();
}

export async function getCommuteBriefing(
  env: Env,
  sourceMessageId: string,
  userId?: string
): Promise<CommuteBriefingListItem | null> {
  await ensureCommuteBriefingsTable(env);
  const { clause, binds } = commuteWhere(
    userId ? { userId } : {},
    ["cb.source_message_id = ?"]
  );
  const row = await env.DB.prepare(
    `SELECT
      cb.source_message_id,
      cb.title,
      cb.transcript_key,
      cb.audio_key,
      cb.metadata_key,
      cb.provider,
      cb.voice,
      cb.model,
      cb.minutes,
      cb.status,
      cb.error,
      cb.source_type,
      cb.playlist_doc_ids,
      cb.transcript_size,
      cb.audio_size,
      cb.metadata_size,
      cb.created_at,
      cb.updated_at,
      m.instance_project,
      m.instance_model
    FROM commute_briefings cb
    JOIN messages m ON m.id = cb.source_message_id
    ${clause}`
  )
    .bind(sourceMessageId, ...binds)
    .first<CommuteBriefingListItem>();

  return row ?? null;
}

export async function listCommuteBriefings(
  env: Env,
  limit = 25,
  options: CommuteBriefingListOptions = {}
): Promise<CommuteBriefingListItem[]> {
  await ensureCommuteBriefingsTable(env);
  const { clause, binds } = commuteWhere(options);
  const result = await env.DB.prepare(
    `SELECT
      cb.source_message_id,
      cb.title,
      cb.transcript_key,
      cb.audio_key,
      cb.metadata_key,
      cb.provider,
      cb.voice,
      cb.model,
      cb.minutes,
      cb.status,
      cb.error,
      cb.source_type,
      cb.playlist_doc_ids,
      cb.transcript_size,
      cb.audio_size,
      cb.metadata_size,
      cb.created_at,
      cb.updated_at,
      m.instance_project,
      m.instance_model
    FROM commute_briefings cb
    JOIN messages m ON m.id = cb.source_message_id
    ${clause}
    ORDER BY cb.created_at DESC
    LIMIT ?`
  )
    .bind(...binds, limit)
    .all<CommuteBriefingListItem>();

  return result.results ?? [];
}

export async function getLatestCommuteBriefing(
  env: Env,
  options: CommuteBriefingListOptions = {}
): Promise<CommuteBriefingListItem | null> {
  const result = await listCommuteBriefings(env, 1, options);
  return result[0] ?? null;
}
