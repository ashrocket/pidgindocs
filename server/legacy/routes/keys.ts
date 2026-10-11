import type { Env } from "../types";
import { resolveSessionUserId, unauthorized, evictApiKeyCacheEntry } from "../middleware";
import { json } from "../utils";
import { generateApiKey, storeApiKey } from "../auth-utils";
import { checkRateLimit } from "../ratelimit";

// Per-user API keys minted self-serve. The macOS app calls these with its
// Session token (see resolveSessionUserId — session-only, so a leaked API key
// cannot mint more keys); the same core functions back the web /setup form.
const MAX_KEYS_PER_USER = 10;
const KEYMINT_RATE_MAX = 10;
const KEYMINT_RATE_WINDOW_SECS = 3600;
const MAX_LABEL_LEN = 80;

type CreateResult = { key: string; key_prefix: string; label: string } | { error: "limit" | "rate" };

export async function createKeyForUser(
  env: Env,
  userId: string,
  label: string
): Promise<CreateResult> {
  // The web form caps the label client-side only; clamp it here too.
  const safeLabel = label.slice(0, MAX_LABEL_LEN);

  const countRow = await env.DB.prepare(
    "SELECT COUNT(*) as c FROM api_keys WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ c: number }>();
  if ((countRow?.c ?? 0) >= MAX_KEYS_PER_USER) return { error: "limit" };

  const allowed = await checkRateLimit(
    env,
    `keymint:${userId}`,
    KEYMINT_RATE_MAX,
    KEYMINT_RATE_WINDOW_SECS
  );
  if (!allowed) return { error: "rate" };

  // Only the SHA-256 hash is persisted (storeApiKey); the plaintext is returned
  // to the caller exactly once and never stored.
  const key = generateApiKey();
  await storeApiKey(env, userId, key, safeLabel);
  return { key, key_prefix: key.slice(0, 16), label: safeLabel };
}

export interface ApiKeyRow {
  key_prefix: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  key_hash: string;
}

export async function listKeysForUser(env: Env, userId: string): Promise<ApiKeyRow[]> {
  const res = await env.DB.prepare(
    "SELECT key_prefix, label, created_at, last_used_at, key_hash FROM api_keys WHERE user_id = ? ORDER BY created_at DESC"
  )
    .bind(userId)
    .all<ApiKeyRow>();
  return res.results ?? [];
}

export async function revokeKeyForUser(
  env: Env,
  userId: string,
  keyHash: string
): Promise<number> {
  const res = await env.DB.prepare(
    "DELETE FROM api_keys WHERE key_hash = ? AND user_id = ?"
  )
    .bind(keyHash, userId)
    .run();
  // Evict the per-isolate auth cache so a revoked key stops working immediately
  // instead of lingering up to the 60s cache TTL on a warm isolate.
  evictApiKeyCacheEntry(keyHash);
  return res.meta?.changes ?? 0;
}

export async function handleApiKeysCreate(request: Request, env: Env): Promise<Response> {
  const userId = await resolveSessionUserId(request, env);
  if (!userId) return unauthorized();

  let body: { label?: string } = {};
  try {
    body = (await request.json()) as { label?: string };
  } catch {
    body = {};
  }
  const label = (body.label ?? "").toString().trim() || "macOS app";

  const result = await createKeyForUser(env, userId, label);
  if ("error" in result) {
    return result.error === "limit"
      ? json({ ok: false, error: `key limit reached (max ${MAX_KEYS_PER_USER})` }, 409)
      : json({ ok: false, error: "too many key requests, try again later" }, 429);
  }
  return json(
    { ok: true, data: { key: result.key, key_prefix: result.key_prefix, label: result.label } },
    201
  );
}

export async function handleApiKeysList(request: Request, env: Env): Promise<Response> {
  const userId = await resolveSessionUserId(request, env);
  if (!userId) return unauthorized();
  const keys = await listKeysForUser(env, userId);
  return json({ ok: true, data: keys });
}

export async function handleApiKeysRevoke(
  request: Request,
  env: Env,
  keyHash: string
): Promise<Response> {
  const userId = await resolveSessionUserId(request, env);
  if (!userId) return unauthorized();
  const changes = await revokeKeyForUser(env, userId, keyHash);
  return json({ ok: true, data: { revoked: changes > 0 } });
}
