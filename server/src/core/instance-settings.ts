// Values a self-hosted install stores once, such as its public origin and share-link secret.
// Only core/self-host.ts reads them; hosted entries never call into this module.

/** Names a self-hosted install can store. Drive settings are added with their own change. */
export type InstanceSettingName = "origin" | "share_secret";

/** How long a read is reused per database before it goes back to D1. */
export const INSTANCE_SETTINGS_CACHE_MS = 60_000;

type Snapshot = { cachedAt: number; values: Partial<Record<InstanceSettingName, string>> };

let cache = new WeakMap<D1Database, Snapshot>();

/** Returns every stored setting. Reads within the cache window reuse the last result. */
export async function readInstanceSettings(
  db: D1Database,
  now = Date.now(),
): Promise<Partial<Record<InstanceSettingName, string>>> {
  const cached = cache.get(db);
  if (cached && now - cached.cachedAt < INSTANCE_SETTINGS_CACHE_MS) return cached.values;
  const rows = await db.prepare("SELECT name, value FROM instance_settings").all<{ name: InstanceSettingName; value: string }>();
  const values = Object.fromEntries(rows.results.map((row) => [row.name, row.value]));
  cache.set(db, { cachedAt: now, values });
  return values;
}

/**
 * Stores a setting and returns the value now stored. "keep" leaves an existing value in place;
 * "replace" overwrites it. The returned value is read back from D1, not from the cache.
 */
export async function setInstanceSetting(
  db: D1Database,
  name: InstanceSettingName,
  value: string,
  mode: "keep" | "replace",
): Promise<string> {
  const updatedAt = new Date().toISOString();
  if (mode === "keep") {
    await db.prepare("INSERT OR IGNORE INTO instance_settings (name, value, updated_at) VALUES (?1, ?2, ?3)")
      .bind(name, value, updatedAt).run();
  } else {
    await db.prepare(
      `INSERT INTO instance_settings (name, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(name, value, updatedAt).run();
  }
  cache.delete(db);
  const row = await db.prepare("SELECT value FROM instance_settings WHERE name = ?1").bind(name).first<{ value: string }>();
  if (!row) throw new Error(`instance setting ${name} was not stored`);
  return row.value;
}

/** Test hook: forgets every cached read. */
export function __clearInstanceSettingsCache(): void {
  cache = new WeakMap();
}
