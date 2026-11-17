import type { Env } from "../types";
import { json } from "../utils";
import { verifySession, unauthorized } from "../middleware";
import { createInviteCode } from "../invites";
import { editionPublicSite, editionWorkspaceSignInOnly } from "../edition-hooks";

// Session-accepted JSON twins of the owner HTML pages GET /admin/users and
// POST /admin/users/invite-code (index.ts). The /api/admin/* JSON routes take
// only ADMIN_API_KEY, so the native app cannot call them; these accept the
// app's `Authorization: Session <token>` and apply the HTML pages' rule:
// verifySession, then the session email must equal OWNER_EMAIL
// (case-insensitive). The public site 404s exactly where the HTML pages do.

// createInviteCode (invites.ts) stores codes with a 7-day KV TTL.
const INVITE_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface UserRow {
  id: string;
  email: string;
  invited_by: string | null;
  created_at: string | null;
  status: string;
}

/** The query the HTML page uses (index.ts GET /admin/users). */
const USERS_QUERY = "SELECT id, email, invited_by, created_at, status FROM users ORDER BY created_at ASC";

/** False when the tenant requires Entra or private Google sign-in: /join and /auth/invite answer 403 there. */
const codesUsable = (env: Env): boolean => !editionWorkspaceSignInOnly(env);

/** Returns an error Response, or the owner's session email. */
async function requireOwner(request: Request, env: Env): Promise<Response | string> {
  if (editionPublicSite(env)) return json({ ok: false, error: "not found" }, 404);
  const email = await verifySession(request.headers, env.SESSIONS, env);
  if (!email) return unauthorized();
  if (!env.OWNER_EMAIL || email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) {
    return json({ ok: false, error: "only the owner can use the admin pages" }, 403);
  }
  return email;
}

export async function handleOwnerUsers(request: Request, env: Env): Promise<Response> {
  const owner = await requireOwner(request, env);
  if (owner instanceof Response) return owner;
  const result = await env.DB.prepare(USERS_QUERY).all<UserRow>();
  const ownerEmail = env.OWNER_EMAIL!.toLowerCase();
  const users = result.results.map((u) => ({
    id: u.id,
    email: u.email,
    status: u.status,
    invited_by: u.invited_by,
    created_at: u.created_at,
    is_owner: u.email.toLowerCase() === ownerEmail,
  }));
  return json({ ok: true, data: { users, codes_usable: codesUsable(env) } });
}

export async function handleOwnerInviteCode(request: Request, env: Env): Promise<Response> {
  const owner = await requireOwner(request, env);
  if (owner instanceof Response) return owner;
  const code = await createInviteCode(env, owner);
  const expiresAt = new Date(Date.now() + INVITE_CODE_TTL_MS).toISOString();
  return json({ ok: true, data: { code, expires_at: expiresAt, codes_usable: codesUsable(env) } });
}
