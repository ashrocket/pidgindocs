import type { Env } from "../types";

interface ConfigRow {
  value: string;
  updated_at: string;
}

let destinationConfigTableReady: Promise<void> | null = null;

async function ensureDestinationConfigTable(env: Env): Promise<void> {
  if (!destinationConfigTableReady) {
    destinationConfigTableReady = env.DB
      .prepare(
        "CREATE TABLE IF NOT EXISTS destination_configs (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))"
      )
      .run()
      .then(() => undefined);
  }

  await destinationConfigTableReady;
}

async function fetchRow(env: Env, name: string): Promise<ConfigRow | null> {
  await ensureDestinationConfigTable(env);
  const row = await env.DB.prepare(
    "SELECT value, updated_at FROM destination_configs WHERE name = ?"
  )
    .bind(name)
    .first<ConfigRow>();
  return row ?? null;
}

export async function getDestinationConfig<T>(
  env: Env,
  name: string
): Promise<{ config: T; updated_at: string } | null> {
  const row = await fetchRow(env, name);
  if (!row) return null;
  return { config: JSON.parse(row.value) as T, updated_at: row.updated_at };
}

export async function getDestinationConfigValue<T>(
  env: Env,
  name: string
): Promise<T | null> {
  const row = await fetchRow(env, name);
  return row ? (JSON.parse(row.value) as T) : null;
}

export async function destinationConfigured(
  env: Env,
  name: string
): Promise<{ configured: boolean; updated_at?: string }> {
  const row = await fetchRow(env, name);
  if (!row) return { configured: false };
  return { configured: true, updated_at: row.updated_at };
}

export async function saveDestinationConfig(
  env: Env,
  name: string,
  value: unknown
): Promise<void> {
  await ensureDestinationConfigTable(env);
  await env.DB.prepare(
    `INSERT INTO destination_configs (name, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  )
    .bind(name, JSON.stringify(value))
    .run();
}

export async function deleteDestinationConfig(
  env: Env,
  name: string
): Promise<void> {
  await ensureDestinationConfigTable(env);
  await env.DB.prepare("DELETE FROM destination_configs WHERE name = ?")
    .bind(name)
    .run();
}
