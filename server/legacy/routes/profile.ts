import type { Env } from "../types";
import { json } from "../utils";
import { verifySession } from "../middleware";
import { listKeysForUser } from "./keys";

// Aggregate account facts for the profile surfaces (the /profile web page and
// the apps' ProfileView): user row + linked identities + registered devices +
// API key count in one round-trip. Session-ONLY like the identity handlers it
// aggregates — an API key must never read or mutate login credentials.

export interface ProfileUserRow {
  id: string;
  email: string;
  created_at: string;
  status: string;
}

export interface ProfileData {
  user: { email: string; created_at: number; status: string };
  identities: Array<{ email: string; provider: string; primary: boolean; created_at?: number }>;
  devices: Array<{ token: string; platform: string; created_at: number }>;
  key_count: number;
}

// D1 stores datetime('now') TEXT; the wire contract is unix seconds, matching
// the artifacts API and the Swift DTOs (which decode Int and would reject the
// raw strings outright).
function toUnixSeconds(dateStr: string): number {
  const s = dateStr.replace(" ", "T");
  const normalized = /z$|[+-]\d{2}:\d{2}$/i.test(s) ? s : s + "Z";
  return Math.floor(new Date(normalized).getTime() / 1000);
}

async function resolveSessionUser(request: Request, env: Env): Promise<ProfileUserRow | null> {
  const sessionEmail = await verifySession(request.headers, env.SESSIONS);
  if (!sessionEmail) return null;
  return await env.DB.prepare(
    "SELECT id, email, created_at, status FROM users WHERE email = ? AND status = 'active'"
  )
    .bind(sessionEmail.toLowerCase())
    .first<ProfileUserRow>();
}

// Shared by GET /api/profile and the /profile web page so the JSON and HTML
// surfaces can never drift.
export async function loadProfile(env: Env, user: ProfileUserRow): Promise<ProfileData> {
  const identityRows = await env.DB.prepare(
    "SELECT email, provider, created_at FROM user_identities WHERE user_id = ? ORDER BY created_at ASC"
  )
    .bind(user.id)
    .all<{ email: string; provider: string; created_at: string }>();

  const deviceRows = await env.DB.prepare(
    "SELECT token, platform, created_at FROM device_tokens WHERE user_id = ? ORDER BY created_at DESC"
  )
    .bind(user.id)
    .all<{ token: string; platform: string; created_at: string }>();

  const keys = await listKeysForUser(env, user.id);

  return {
    user: { email: user.email, created_at: toUnixSeconds(user.created_at), status: user.status },
    identities: [
      { email: user.email, provider: "primary", primary: true },
      ...(identityRows.results ?? []).map((r) => ({
        email: r.email,
        provider: r.provider,
        primary: false,
        created_at: toUnixSeconds(r.created_at),
      })),
    ],
    devices: (deviceRows.results ?? []).map((d) => ({
      token: d.token,
      platform: d.platform,
      created_at: toUnixSeconds(d.created_at),
    })),
    key_count: keys.length,
  };
}

export async function handleGetProfile(request: Request, env: Env): Promise<Response> {
  const user = await resolveSessionUser(request, env);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);
  return json({ ok: true, data: await loadProfile(env, user) });
}

// DELETE /api/devices — forget a registered push device. Scoped to the caller:
// a token belonging to another user 404s exactly like a token that never
// existed. The audit row keeps only a suffix — push tokens don't belong in
// the log.
export async function handleRevokeDevice(request: Request, env: Env): Promise<Response> {
  const user = await resolveSessionUser(request, env);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);

  let body: { token?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const token = (body.token || "").trim();
  if (!token) return json({ ok: false, error: "token required" }, 400);

  const result = await env.DB.prepare(
    "DELETE FROM device_tokens WHERE token = ? AND user_id = ?"
  )
    .bind(token, user.id)
    .run();
  if (!result.meta || result.meta.changes === 0) {
    return json({ ok: false, error: "device not found" }, 404);
  }

  await env.DB.prepare("INSERT INTO audit_log (action, details) VALUES (?, ?)")
    .bind("device_revoke", `revoked device token …${token.slice(-8)} for ${user.email}`)
    .run();

  return json({ ok: true, data: { revoked: true } });
}
