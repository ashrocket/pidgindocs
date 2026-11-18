import { messageReadSql } from "../document-rbac";
import { COMMUTE_SOURCE_READ_SQL, ensureCommuteBriefingsTable } from "../commute/store";
import type { Env } from "../types";

// Audio items: D1 rows (migration 0043) and the wire shape the apps decode.
// Every query is scoped to one user_id.

export type AudioKind = "upload" | "narration" | "briefing";
export type AudioMode = "full" | "summary";
export type AudioStatus = "processing" | "ready" | "failed" | "transcript_only";

export const LEGACY_ID_PREFIX = "commute:";
export const DEFAULT_AUDIO_TITLE = "Untitled audio";
export const MAX_AUDIO_TITLE_LENGTH = 300;

export interface AudioRow {
  id: string;
  user_id: string;
  title: string;
  kind: "upload" | "narration";
  mode: AudioMode | null;
  status: AudioStatus;
  error: string | null;
  mime: string | null;
  size_bytes: number | null;
  duration_seconds: number | null;
  estimated_seconds: number | null;
  source_words: number | null;
  script_words: number | null;
  provider: string | null;
  voice: string | null;
  model: string | null;
  source_message_id: string | null;
  audio_key: string | null;
  transcript_key: string | null;
  source_key: string | null;
  storage_bytes: number;
  created_at: string;
  updated_at: string;
}

export interface AudioItem {
  id: string;
  title: string;
  kind: AudioKind;
  mode: AudioMode | null;
  status: AudioStatus;
  error: string | null;
  mime: string | null;
  size_bytes: number | null;
  duration_seconds: number | null;
  estimated_seconds: number | null;
  source_words: number | null;
  script_words: number | null;
  provider: string | null;
  voice: string | null;
  model: string | null;
  source_message_id: string | null;
  stream_url: string;
  transcript_url: string | null;
  web_url: string;
  created_at: string;
  updated_at: string;
}

export function newAudioId(): string {
  return `aud_${crypto.randomUUID()}`;
}

export function isLegacyAudioId(id: string): boolean {
  return id.startsWith(LEGACY_ID_PREFIX);
}

// New ids, and the message id behind a legacy one, are UUID-like.
export function isValidAudioId(id: string): boolean {
  return /^(?:aud_[A-Za-z0-9-]{1,60}|commute:[A-Za-z0-9-]{1,64})$/.test(id);
}

export function cleanAudioTitle(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_AUDIO_TITLE;
  const title = value.replace(/\s+/g, " ").trim().slice(0, MAX_AUDIO_TITLE_LENGTH).trim();
  return title || DEFAULT_AUDIO_TITLE;
}

export function audioKeys(id: string, ext: string) {
  return {
    audio: `audio/${id}/audio.${ext}`,
    transcript: `audio/${id}/transcript.txt`,
    source: `audio/${id}/source.txt`,
  };
}

export function serializeAudioRow(row: AudioRow): AudioItem {
  const hasTranscript = row.transcript_key !== null && (row.status === "ready" || row.status === "transcript_only");
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    mode: row.mode,
    status: row.status,
    error: row.error,
    mime: row.mime,
    size_bytes: row.size_bytes,
    duration_seconds: row.duration_seconds,
    estimated_seconds: row.estimated_seconds,
    source_words: row.source_words,
    script_words: row.script_words,
    provider: row.provider,
    voice: row.voice,
    model: row.model,
    source_message_id: row.source_message_id,
    stream_url: `/api/audio/${encodeURIComponent(row.id)}/stream`,
    transcript_url: hasTranscript ? `/api/audio/${encodeURIComponent(row.id)}/transcript` : null,
    web_url: `/audio/${encodeURIComponent(row.id)}`,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function insertAudioRow(
  env: Env,
  row: Pick<AudioRow, "id" | "user_id" | "title" | "kind"> & Partial<AudioRow>
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audio_items (
       id, user_id, title, kind, mode, status, error, mime, size_bytes, duration_seconds,
       estimated_seconds, source_words, script_words, provider, voice, model,
       source_message_id, audio_key, transcript_key, source_key, storage_bytes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      row.id,
      row.user_id,
      row.title,
      row.kind,
      row.mode ?? null,
      row.status ?? "processing",
      row.error ?? null,
      row.mime ?? null,
      row.size_bytes ?? null,
      row.duration_seconds ?? null,
      row.estimated_seconds ?? null,
      row.source_words ?? null,
      row.script_words ?? null,
      row.provider ?? null,
      row.voice ?? null,
      row.model ?? null,
      row.source_message_id ?? null,
      row.audio_key ?? null,
      row.transcript_key ?? null,
      row.source_key ?? null,
      row.storage_bytes ?? 0
    )
    .run();
}

const UPDATABLE = [
  "title", "mode", "status", "error", "mime", "size_bytes", "duration_seconds", "estimated_seconds",
  "source_words", "script_words", "provider", "voice", "model", "audio_key", "transcript_key",
  "source_key", "storage_bytes",
] as const;
type UpdatableColumn = (typeof UPDATABLE)[number];

export async function updateAudioRow(
  env: Env,
  userId: string,
  id: string,
  fields: Partial<Pick<AudioRow, UpdatableColumn>>
): Promise<void> {
  const columns = UPDATABLE.filter((column) => column in fields);
  if (columns.length === 0) return;
  const sets = columns.map((column) => `${column} = ?`).join(", ");
  await env.DB.prepare(
    `UPDATE audio_items SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND user_id = ?`
  )
    .bind(...columns.map((column) => (fields as Record<string, unknown>)[column] ?? null), id, userId)
    .run();
}

export const AUDIO_SOURCE_READ_SQL = (): string => `(audio_items.source_message_id IS NULL OR EXISTS (SELECT 1 FROM messages source
  WHERE source.id = audio_items.source_message_id AND ${messageReadSql("source")}))`;

export async function getAudioRow(env: Env, userId: string, id: string): Promise<AudioRow | null> {
  const row = await env.DB.prepare(`SELECT * FROM audio_items WHERE id = ? AND user_id = ? AND ${AUDIO_SOURCE_READ_SQL()}`)
    .bind(id, userId, userId, userId)
    .first<AudioRow>();
  return row ?? null;
}

export async function deleteAudioRow(env: Env, userId: string, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM audio_items WHERE id = ? AND user_id = ?").bind(id, userId).run();
  await env.DB.prepare("DELETE FROM user_favorites WHERE user_id = ? AND kind = 'audio' AND item_id = ?")
    .bind(userId, id)
    .run();
}

// ---- Commute briefings, listed as kind "briefing" ----

interface BriefingRow {
  source_message_id: string;
  title: string;
  transcript_key: string;
  audio_key: string | null;
  provider: string | null;
  voice: string | null;
  model: string | null;
  status: string;
  error: string | null;
  audio_size: number;
  created_iso: string;
  updated_iso: string;
}

const BRIEFING_SELECT = `SELECT cb.source_message_id, cb.title, cb.transcript_key, cb.audio_key, cb.provider,
    cb.voice, cb.model, cb.status, cb.error, cb.audio_size,
    strftime('%Y-%m-%dT%H:%M:%SZ', cb.created_at) AS created_iso,
    strftime('%Y-%m-%dT%H:%M:%SZ', cb.updated_at) AS updated_iso
  FROM commute_briefings cb JOIN messages m ON m.id = cb.source_message_id`;

function briefingStatus(status: string, hasAudio: boolean): AudioStatus {
  if (status === "ready" && hasAudio) return "ready";
  if (status === "transcript_only" || status === "ready") return "transcript_only";
  if (status === "failed" || status === "error") return "failed";
  return "processing";
}

function serializeBriefing(row: BriefingRow): AudioItem {
  const id = `${LEGACY_ID_PREFIX}${row.source_message_id}`;
  const hasAudio = Boolean(row.audio_key);
  const status = briefingStatus(row.status, hasAudio);
  return {
    id,
    title: row.title,
    kind: "briefing",
    mode: null,
    status,
    error: row.error,
    mime: row.audio_key ? (row.audio_key.endsWith(".wav") ? "audio/wav" : "audio/mpeg") : null,
    size_bytes: hasAudio && row.audio_size > 0 ? row.audio_size : null,
    duration_seconds: null,
    estimated_seconds: null,
    source_words: null,
    script_words: null,
    provider: row.provider,
    voice: row.voice,
    model: row.model,
    source_message_id: row.source_message_id,
    stream_url: `/api/audio/${encodeURIComponent(id)}/stream`,
    transcript_url: `/api/audio/${encodeURIComponent(id)}/transcript`,
    web_url: `/audio/${encodeURIComponent(id)}`,
    created_at: row.created_iso,
    updated_at: row.updated_iso,
  };
}

export interface LegacyAudioSource {
  item: AudioItem;
  audio_key: string | null;
  transcript_key: string;
}

export async function getLegacyBriefing(
  env: Env,
  userId: string,
  messageId: string
): Promise<LegacyAudioSource | null> {
  await ensureCommuteBriefingsTable(env);
  const row = await env.DB.prepare(`${BRIEFING_SELECT} WHERE cb.source_message_id = ? AND m.user_id = ? AND ${COMMUTE_SOURCE_READ_SQL()}`)
    .bind(messageId, userId, userId, userId, userId, userId)
    .first<BriefingRow>();
  return row ? { item: serializeBriefing(row), audio_key: row.audio_key, transcript_key: row.transcript_key } : null;
}

// ---- Listing: new items and briefings, newest first ----

interface Cursor {
  t: string;
  id: string;
}

function encodeCursor(item: AudioItem): string {
  return btoa(JSON.stringify({ t: item.created_at, id: item.id }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded)) as Partial<Cursor>;
    return typeof parsed.t === "string" && typeof parsed.id === "string" ? { t: parsed.t, id: parsed.id } : null;
  } catch {
    return null;
  }
}

function newer(a: AudioItem, b: AudioItem): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export class AudioCursorError extends Error {}

export async function listAudioItems(
  env: Env,
  userId: string,
  options: { limit: number; cursor?: string | null }
): Promise<{ items: AudioItem[]; next_cursor: string | null }> {
  const cursor = decodeCursor(options.cursor);
  if (options.cursor && !cursor) throw new AudioCursorError("invalid cursor");
  const limit = options.limit;

  await ensureCommuteBriefingsTable(env);
  const rowCursor = cursor ? " AND (created_at < ? OR (created_at = ? AND id < ?))" : "";
  const briefingCursor = cursor
    ? " AND (strftime('%Y-%m-%dT%H:%M:%SZ', cb.created_at) < ? OR (strftime('%Y-%m-%dT%H:%M:%SZ', cb.created_at) = ? AND ('commute:' || cb.source_message_id) < ?))"
    : "";
  const cursorBinds = cursor ? [cursor.t, cursor.t, cursor.id] : [];

  const [rows, briefings] = await Promise.all([
    env.DB.prepare(`SELECT * FROM audio_items WHERE user_id = ? AND ${AUDIO_SOURCE_READ_SQL()}${rowCursor} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(userId, userId, userId, ...cursorBinds, limit + 1)
      .all<AudioRow>(),
    env.DB.prepare(
      `${BRIEFING_SELECT} WHERE m.user_id = ? AND ${COMMUTE_SOURCE_READ_SQL()}${briefingCursor} ORDER BY created_iso DESC, cb.source_message_id DESC LIMIT ?`
    )
      .bind(userId, userId, userId, userId, userId, ...cursorBinds, limit + 1)
      .all<BriefingRow>(),
  ]);

  const merged = [...(rows.results ?? []).map(serializeAudioRow), ...(briefings.results ?? []).map(serializeBriefing)].sort(
    newer
  );
  const items = merged.slice(0, limit);
  return {
    items,
    next_cursor: merged.length > limit ? encodeCursor(items[items.length - 1]) : null,
  };
}
