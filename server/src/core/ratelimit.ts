import type { Env } from "./types";

/**
 * Counts one attempt against `key` and returns false once the window's count passes `maxAttempts`.
 * A self-host counts in D1 (rate_limits); everything else keeps the KV counter.
 */
export async function checkRateLimit(
  env: Env,
  key: string,
  maxAttempts: number,
  windowSecs: number
): Promise<boolean> {
  if (env.SELF_HOST) return checkRateLimitD1(env, key, maxAttempts, windowSecs);
  const rlKey = `rl:${key}`;
  const current = await env.SESSIONS.get(rlKey);
  const count = current ? parseInt(current, 10) : 0;
  if (count >= maxAttempts) return false;
  await env.SESSIONS.put(rlKey, String(count + 1), { expirationTtl: windowSecs });
  return true;
}

// The window is fixed at the first hit: a bucket whose expiry has passed starts again at 1.
async function checkRateLimitD1(env: Env, key: string, maxAttempts: number, windowSecs: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (bucket, count, expires_at) VALUES (?1, 1, ?2)
     ON CONFLICT(bucket) DO UPDATE SET
       count = CASE WHEN rate_limits.expires_at <= ?3 THEN 1 ELSE rate_limits.count + 1 END,
       expires_at = CASE WHEN rate_limits.expires_at <= ?3 THEN ?2 ELSE rate_limits.expires_at END
     RETURNING count`
  ).bind(`rl:${key}`, now + windowSecs, now).first<{ count: number }>();
  return (row?.count ?? 0) <= maxAttempts;
}

/** Deletes self-host rate-limit counters whose window ended at or before `nowSeconds`. */
export async function pruneRateLimits(db: D1Database, nowSeconds: number): Promise<void> {
  await db.prepare("DELETE FROM rate_limits WHERE expires_at <= ?").bind(nowSeconds).run();
}
