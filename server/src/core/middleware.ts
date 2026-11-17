import { editionSessionLookup, editionSignInIdentity, editionAccountActiveSql, editionApiKeyAccountSql, editionWorkspaceSignInOnly } from "./edition-hooks";
import type { AuthedApiUser, Env } from "./types";
import { sha256Hex } from "./auth-utils";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function verifyApiKey(headers: Headers, apiKey: string): boolean {
  const auth = headers.get("Authorization");
  if (!auth) return false;
  const [scheme, token] = auth.split(" ");
  if (scheme !== "Bearer" || !token) return false;
  // Support comma-separated keys: API_KEY="key-one,key-two"
  const validKeys = apiKey.split(",").map((k) => k.trim());
  return validKeys.some((k) => timingSafeEqual(k, token));
}

// Sessions live 48 hours, but renew themselves whenever an active session is
// seen with under 24 hours left — so a device in regular use never gets logged
// out; only true inactivity expires.
export const SESSION_TTL_SECONDS = 48 * 60 * 60;
const SESSION_RENEW_THRESHOLD_SECONDS = 24 * 60 * 60;

export function sessionMetadata(): { exp: number } {
  return { exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
}

async function lookupSession(
  sessions: KVNamespace,
  token: string
): Promise<string | null> {
  const key = `session:${token}`;
  const { value, metadata } = await sessions.getWithMetadata<{ exp?: number }>(key);
  if (!value) return null;

  const now = Math.floor(Date.now() / 1000);
  const exp = metadata?.exp;
  if (!exp || exp - now < SESSION_RENEW_THRESHOLD_SECONDS) {
    await sessions
      .put(key, value, { expirationTtl: SESSION_TTL_SECONDS, metadata: sessionMetadata() })
      .catch(() => {});
  }
  return value;
}

export async function verifySession(
  headers: Headers,
  sessions: KVNamespace,
  env?: Env
): Promise<string | null> {
  const cookieToken = headers.get("Cookie")?.match(/(?:^|;\s*)session=([^;]+)/)?.[1];
  const auth = headers.get("Authorization");
  const token = cookieToken || (auth?.startsWith("Session ") ? auth.slice(8) : null);
  if (!token) return null;
  // An edition resolves its own session tokens first.
  const edition = editionSessionLookup(env, token);
  if (edition !== undefined) return edition;
  return lookupSession(sessions, token);
}

/** Whether this active user may still sign in here; the edition decides (for example Entra, Google Workspace or managed identity). */
export async function isEntraUser(env: Env, userId: string): Promise<boolean> {
  return editionSignInIdentity(env, userId);
}

export function unauthorized(message = "unauthorized"): Response {
  // Lazy import to avoid circular dependency at module level
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key",
  };
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 401,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

// Per-isolate cache of resolved API keys. Agent sessions hammer the API (sends
// plus a 5s reply-poll loop), and isolates stay warm between those requests, so
// this removes 1-2 D1 reads from nearly every authenticated call. Short TTL
// keeps key revocation latency bounded; only successful lookups are cached.
const API_KEY_CACHE_TTL_MS = 60_000;
const apiKeyCache = new Map<string, { user: AuthedApiUser; expires: number }>();

export function __clearApiKeyCache(): void {
  apiKeyCache.clear();
}

// Evict a single cached key (called on revoke so a deleted key stops
// authenticating immediately instead of lingering for the cache TTL).
export function evictApiKeyCacheEntry(keyHash: string): void {
  apiKeyCache.delete(keyHash);
}

// Which credential authenticated a caller. POST /api/reply records it as
// messages.replied_via, so an agent's reply can be told apart from the person's.
//   app_session  "Authorization: Session <token>" (the edition's Apple apps). Only a
//                magic link or Apple, Google or Entra sign-in mints a session
//                token, and the apps never hand it to the pages they show, so
//                this is the one value that shows a signed-in person replied.
//   web_cookie   the "session" cookie. It shows only that the request carried
//                the web inbox cookie, not that a person sent it: the browser
//                attaches it to every same-origin request, whatever page script
//                made it, and Origin, Referer and Sec-Fetch-* cannot tell such a
//                request from the inbox's own (fetch() lets a page send any
//                same-origin Referer). Pidgin found exactly this with agent
//                artifacts and documents served on the cookie's origin.
//   api_key      "Authorization: Bearer <key>": an API key, or the deployment
//                API_KEY that resolves to the owner (agents, shell clients, scripts)
//   web_session  reserved for a cookie reply that no agent-authored page can
//                cause, once every same-origin HTML surface is shown to be out of
//                the cookie's reach. Nothing records it today; do not start
//                writing it before then.
// OAuth access tokens (MCP clients) are not a value: /api/reply refuses them.
export type CallerCredential = "app_session" | "web_cookie" | "api_key" | "web_session";

export interface ResolvedCaller {
  userId: string;
  via: CallerCredential;
}

// Resolve the caller once and report which credential matched. A session
// first, then an API key; a session that names no active user is a 401, not a
// fall-through to the API key. verifySession prefers the "session" cookie and
// reads "Authorization: Session" only without one, so the same cookie test
// tells which session form matched.
export async function resolveCallerCredential(
  request: Request,
  env: Env
): Promise<ResolvedCaller | null> {
  const sessionEmail = await verifySession(request.headers, env.SESSIONS, env);
  if (sessionEmail) {
    const u = await env.DB.prepare(
      `SELECT id FROM users WHERE email = ? AND status = 'active'
       AND ${editionAccountActiveSql()}`
    )
      .bind(sessionEmail.toLowerCase())
      .first<{ id: string }>();
    if (!u) return null;
    const cookieSession = /(?:^|;\s*)session=([^;]+)/.test(request.headers.get("Cookie") ?? "");
    return { userId: u.id, via: cookieSession ? "web_cookie" : "app_session" };
  }
  const authedUser = await resolveApiKeyUser(request.headers, env);
  return authedUser ? { userId: authedUser.userId, via: "api_key" } : null;
}

// Resolve the caller's user id from either auth path (session cookie/header for
// the web app, or an API key for bots). By-id message handlers scope EVERYONE —
// including the owner — to their own user_id, so they need the caller's id
// regardless of which credential was presented. Returns null when neither auth
// succeeds, so callers can preserve the existing 401 behavior via unauthorized().
export async function resolveCallerUserId(
  request: Request,
  env: Env
): Promise<string | null> {
  return (await resolveCallerCredential(request, env))?.userId ?? null;
}

// Session-ONLY caller resolution for endpoints that must require a logged-in
// human (the web/app session), never an API key. Mirrors resolveCallerUserId's
// session branch but deliberately omits the resolveApiKeyUser fallback — so a
// leaked API key cannot mint or revoke API keys. Returns the caller's user_id,
// or null when there is no valid active session.
export async function resolveSessionUserId(
  request: Request,
  env: Env
): Promise<string | null> {
  const sessionEmail = await verifySession(request.headers, env.SESSIONS, env);
  if (!sessionEmail) return null;
  const u = await env.DB.prepare(
    `SELECT id FROM users WHERE email = ? AND status = 'active'
     AND ${editionAccountActiveSql()}`
  )
    .bind(sessionEmail.toLowerCase())
    .first<{ id: string }>();
  return u?.id ?? null;
}

export async function resolveApiKeyUser(
  headers: Headers,
  env: Env
): Promise<AuthedApiUser | null> {
  const auth = headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);

  // 1. Check DB api_keys table
  const keyHash = await sha256Hex(token);

  const cached = apiKeyCache.get(keyHash);
  if (cached && cached.expires > Date.now()) {
    return await isEntraUser(env, cached.user.userId) ? cached.user : null;
  }
  const access = editionApiKeyAccountSql("u");
  const row = await env.DB.prepare(
    `SELECT ak.user_id, u.email, ${access.endsAt} AS access_ends_at
     FROM api_keys ak
     JOIN users u ON u.id = ak.user_id
     ${access.join}
     WHERE ak.key_hash = ? AND u.status = 'active'
       AND ${access.active}`
  )
    .bind(keyHash)
    .first<{ user_id: string; email: string; access_ends_at?: string | null }>();

  if (row) {
    if (!await isEntraUser(env, row.user_id)) return null;
    env.DB.prepare(
      "UPDATE api_keys SET last_used_at = datetime('now') WHERE key_hash = ?"
    )
      .bind(keyHash)
      .run()
      .catch(() => {});
    const user = { userId: row.user_id, email: row.email };
    const accessEnds = row.access_ends_at
      ? new Date(row.access_ends_at).getTime()
      : Number.POSITIVE_INFINITY;
    apiKeyCache.set(keyHash, {
      user,
      expires: Math.min(Date.now() + API_KEY_CACHE_TTL_MS, accessEnds),
    });
    return user;
  }

  // 2. Fallback: env.API_KEY (comma-separated for backward compat)
  const validKeys = env.API_KEY?.split(",").map((k) => k.trim()) ?? [];
  if (!validKeys.some((k) => timingSafeEqual(k, token))) return null;

  const owner = await env.DB.prepare(
    `SELECT id, email FROM users WHERE email = ? AND status = 'active'
     AND ${editionAccountActiveSql()}`
  )
    .bind(env.OWNER_EMAIL?.toLowerCase() ?? "")
    .first<{ id: string; email: string }>();

  if (!owner || !await isEntraUser(env, owner.id)) return null;
  const user = { userId: owner.id, email: owner.email };
  apiKeyCache.set(keyHash, { user, expires: Date.now() + API_KEY_CACHE_TTL_MS });
  return user;
}

export interface AdminUser { userId: string; email: string; isAdmin: true; }

export async function resolveAdminUser(
  headers: Headers,
  env: Env
): Promise<AdminUser | null> {
  if (!env.ADMIN_API_KEY) return null;
  const auth = headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  if (!timingSafeEqual(token, env.ADMIN_API_KEY)) return null;

  const owner = await env.DB.prepare(
    "SELECT id, email FROM users WHERE email = ? AND status = 'active'"
  )
    .bind(env.OWNER_EMAIL?.toLowerCase() ?? "")
    .first<{ id: string; email: string }>();
  if (!owner || !await isEntraUser(env, owner.id)) return null;
  return { userId: owner.id, email: owner.email, isAdmin: true };
}

/** Legacy master keys remain usable only for a currently permitted owner. */
export async function verifyOwnerCredential(headers: Headers, env: Env): Promise<boolean> {
  if (!editionWorkspaceSignInOnly(env)) return verifyApiKey(headers, env.API_KEY);
  const owner = await resolveApiKeyUser(headers, env);
  return !!owner && owner.email.toLowerCase() === env.OWNER_EMAIL?.toLowerCase();
}
