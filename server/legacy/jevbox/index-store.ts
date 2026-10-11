import type { Env } from "../types";
import {
  DOCUMENT_KEY_SQL,
  VISIBLE_ARTIFACTS,
  VISIBLE_DOCUMENTS,
  effectiveProjectSql,
  type LibraryResourceType,
} from "../library";
import { sourceMarkdownKey } from "../documents";
import { artifactVersionKey } from "../artifacts/store";
import { INDEX_VERSION, buildIndex, flatten, htmlToText, type IndexNode, type ParsedItem } from "./indexing";

// Persistence for the library search index (migration 0038). D1 keeps the
// small routing rows; R2 keeps each item's section tree and passages. Items
// are indexed on demand: a search (or the app's "prepare" call) indexes a
// bounded number of new or changed items, newest first.

export interface LibraryItem {
  type: LibraryResourceType;
  /** Document version id or artifact id: what the app opens. */
  id: string;
  /** Library resource key (document family or artifact id). */
  key: string;
  title: string;
  description: string;
  created_at: string;
  /** Effective library project id ('' when unfiled). */
  project_id: string;
  signature: string;
  /** R2 locations of the content, in preference order. */
  sources: { key: string; kind: "markdown" | "html" }[];
  /** Plain-text fallback when no stored content exists (documents only). */
  fallback: string;
}

export interface IndexRow {
  resource_type: LibraryResourceType;
  resource_key: string;
  resource_id: string;
  signature: string;
  index_version: number;
  outline: string;
  r2_key: string | null;
  sections: number;
  passages: number;
  status: "ready" | "empty" | "failed";
  error: string | null;
}

export interface IndexStatus {
  total: number;
  ready: number;
  pending: number;
  failed: number;
  indexed: number;
}

export const DEFAULT_INDEX_BUDGET = 40;
const INDEX_CONCURRENCY = 6;
const PRUNE_LIMIT = 50;

export function itemRef(item: { type: LibraryResourceType; key: string }): string {
  return `${item.type}:${item.key}`;
}

function indexObjectKey(userId: string, type: LibraryResourceType, key: string): string {
  return `library-index/v${INDEX_VERSION}/${userId}/${type}/${encodeURIComponent(key)}.json`;
}

/** Every document and page artifact the PidginDocs app shows the user, with its project. */
export async function listLibraryItems(env: Env, userId: string): Promise<LibraryItem[]> {
  const [docs, artifacts] = await Promise.all([
    env.DB.prepare(
      `SELECT m.id, ${DOCUMENT_KEY_SQL("m")} AS key, m.title, m.body, m.doc_key, m.created_at,
         m.id || ':' || COALESCE(m.enhance_status, '') || ':' || COALESCE(m.doc_size, 0) || ':' || COALESCE(m.source_size, 0) AS signature,
         ${effectiveProjectSql("document", "m")} AS project_id
       FROM messages m WHERE ${VISIBLE_DOCUMENTS}`
    ).bind(userId).all<{ id: string; key: string; title: string; body: string | null; doc_key: string | null; created_at: string; signature: string; project_id: string }>(),
    env.DB.prepare(
      `SELECT a.id, a.title, a.description, a.current_version, a.created_at,
         'v' || a.current_version AS signature,
         ${effectiveProjectSql("artifact", "a")} AS project_id
       FROM artifacts a WHERE ${VISIBLE_ARTIFACTS}`
    ).bind(userId).all<{ id: string; title: string; description: string | null; current_version: number; created_at: string; signature: string; project_id: string }>(),
  ]);
  const items: LibraryItem[] = [];
  for (const row of docs.results ?? []) {
    const markdown = sourceMarkdownKey(row.doc_key);
    items.push({
      type: "document",
      id: row.id,
      key: row.key,
      title: row.title,
      description: "",
      created_at: row.created_at,
      project_id: row.project_id ?? "",
      signature: row.signature,
      sources: [
        ...(markdown ? [{ key: markdown, kind: "markdown" as const }] : []),
        ...(row.doc_key ? [{ key: row.doc_key, kind: "html" as const }] : []),
      ],
      fallback: row.body ?? "",
    });
  }
  for (const row of artifacts.results ?? []) {
    const html = artifactVersionKey(row.id, row.current_version);
    items.push({
      type: "artifact",
      id: row.id,
      key: row.id,
      title: row.title,
      description: row.description ?? "",
      created_at: row.created_at,
      project_id: row.project_id ?? "",
      signature: row.signature,
      sources: [
        { key: html.replace(/\.html$/, ".md"), kind: "markdown" },
        { key: html, kind: "html" },
      ],
      fallback: "",
    });
  }
  return items;
}

export async function loadIndexRows(env: Env, userId: string): Promise<Map<string, IndexRow>> {
  const rows = await env.DB.prepare(
    `SELECT resource_type, resource_key, resource_id, signature, index_version, outline, r2_key,
       sections, passages, status, error
     FROM library_search_index WHERE user_id = ?`
  ).bind(userId).all<IndexRow>();
  return new Map((rows.results ?? []).map((row) => [`${row.resource_type}:${row.resource_key}`, row]));
}

/** An index row describes the item's current content. Failed rows wait for new content. */
export function isCurrent(item: LibraryItem, row: IndexRow | undefined): boolean {
  return !!row && row.signature === item.signature && row.index_version === INDEX_VERSION;
}

async function loadText(env: Env, item: LibraryItem): Promise<string> {
  for (const source of item.sources) {
    const object = await env.DOCS.get(source.key);
    if (!object) continue;
    const raw = await object.text();
    if (!raw.trim()) continue;
    return source.kind === "html" ? htmlToText(raw) : raw;
  }
  return item.fallback;
}

function counts(parsed: ParsedItem) {
  const nodes = flatten(parsed.nodes);
  return { sections: nodes.length, passages: nodes.reduce((sum, node) => sum + node.passages.length, 0) };
}

async function indexItem(env: Env, userId: string, item: LibraryItem): Promise<void> {
  const objectKey = indexObjectKey(userId, item.type, item.key);
  let status: IndexRow["status"] = "ready";
  let error: string | null = null;
  let parsed: ParsedItem | null = null;
  try {
    const text = await loadText(env, item);
    if (!text.trim()) status = "empty";
    else parsed = buildIndex(text, item.title);
    if (parsed && !counts(parsed).passages) status = "empty";
  } catch (err) {
    status = "failed";
    error = err instanceof Error ? err.message.slice(0, 300) : "indexing failed";
  }
  if (status === "ready" && parsed) {
    await env.DOCS.put(objectKey, JSON.stringify(parsed), { httpMetadata: { contentType: "application/json" } });
  }
  const { sections, passages } = parsed && status === "ready" ? counts(parsed) : { sections: 0, passages: 0 };
  await env.DB.prepare(
    `INSERT INTO library_search_index (user_id, resource_type, resource_key, resource_id, signature, index_version,
       outline, r2_key, sections, passages, characters, status, error, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (user_id, resource_type, resource_key) DO UPDATE SET
       resource_id = excluded.resource_id, signature = excluded.signature, index_version = excluded.index_version,
       outline = excluded.outline, r2_key = excluded.r2_key, sections = excluded.sections,
       passages = excluded.passages, characters = excluded.characters, status = excluded.status,
       error = excluded.error, indexed_at = excluded.indexed_at`
  ).bind(
    userId, item.type, item.key, item.id, item.signature, INDEX_VERSION,
    parsed?.outline ?? "", status === "ready" ? objectKey : null, sections, passages,
    parsed?.characters ?? 0, status, error
  ).run();
  if (status !== "ready") await env.DOCS.delete(objectKey);
}

async function pool<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) await run(items[next++]);
    })
  );
}

/**
 * Index up to `budget` new or changed items (newest first) and prune rows for
 * items that no longer exist. Returns the index state after this pass.
 */
export async function ensureLibraryIndex(
  env: Env,
  userId: string,
  budget = DEFAULT_INDEX_BUDGET,
  known?: { items: LibraryItem[]; rows: Map<string, IndexRow> }
): Promise<IndexStatus & { items: LibraryItem[]; rows: Map<string, IndexRow> }> {
  const items = known?.items ?? (await listLibraryItems(env, userId));
  let rows = known?.rows ?? (await loadIndexRows(env, userId));
  const stale = items
    .filter((item) => !isCurrent(item, rows.get(itemRef(item))))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const batch = stale.slice(0, Math.max(0, budget));
  await pool(batch, INDEX_CONCURRENCY, (item) => indexItem(env, userId, item));

  const live = new Set(items.map(itemRef));
  const orphans = [...rows.entries()].filter(([ref]) => !live.has(ref)).slice(0, PRUNE_LIMIT);
  if (orphans.length) {
    await env.DB.batch(
      orphans.map(([, row]) =>
        env.DB.prepare("DELETE FROM library_search_index WHERE user_id = ? AND resource_type = ? AND resource_key = ?")
          .bind(userId, row.resource_type, row.resource_key)
      )
    );
    await Promise.all(orphans.flatMap(([, row]) => (row.r2_key ? [env.DOCS.delete(row.r2_key)] : [])));
  }
  if (batch.length || orphans.length) rows = await loadIndexRows(env, userId);

  let ready = 0;
  let failed = 0;
  for (const item of items) {
    const row = rows.get(itemRef(item));
    if (!isCurrent(item, row)) continue;
    if (row!.status === "failed") failed++;
    else ready++;
  }
  return { total: items.length, ready, failed, pending: items.length - ready - failed, indexed: batch.length, items, rows };
}

/** The stored section tree of an indexed item, or null when it is missing. */
export async function loadParsedItem(env: Env, row: IndexRow): Promise<ParsedItem | null> {
  if (!row.r2_key) return null;
  const object = await env.DOCS.get(row.r2_key);
  if (!object) return null;
  try {
    const parsed = JSON.parse(await object.text()) as ParsedItem;
    return Array.isArray(parsed.nodes) ? parsed : null;
  } catch {
    return null;
  }
}

export type { IndexNode };
