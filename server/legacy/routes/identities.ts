import type { Env } from "../types";
import { json } from "../utils";
import { verifySession } from "../middleware";
import {
  verifyProviderAssertion,
  type OAuthLoginDeps,
  type OAuthProvider,
  rateLimitScope,
} from "../auth/oauth-login";

// Linked login identities (/api/identities): lets one PidginDocs account sign in
// through multiple OAuth providers — e.g. an Apple ID and a Google account
// resolving to the same user. All three handlers are session-ONLY on purpose:
// an API key must never be able to grant a new login identity (that would let
// a leaked key escalate to full account login via magic link), and list/unlink
// stay symmetric with link since they serve the same profile UI.

interface IdentityRow {
  email: string;
  provider: string;
  created_at: string;
}

async function resolveSessionUser(
  request: Request,
  env: Env
): Promise<{ id: string; email: string } | null> {
  const sessionEmail = await verifySession(request.headers, env.SESSIONS);
  if (!sessionEmail) return null;
  return await env.DB.prepare(
    "SELECT id, email FROM users WHERE email = ? AND status = 'active'"
  )
    .bind(sessionEmail.toLowerCase())
    .first<{ id: string; email: string }>();
}

export async function handleListIdentities(
  request: Request,
  env: Env
): Promise<Response> {
  const user = await resolveSessionUser(request, env);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);

  const rows = await env.DB.prepare(
    "SELECT email, provider, created_at FROM user_identities WHERE user_id = ? ORDER BY created_at ASC"
  )
    .bind(user.id)
    .all<IdentityRow>();

  return json({
    ok: true,
    data: {
      identities: [
        { email: user.email, provider: "primary", primary: true },
        ...(rows.results ?? []).map((r) => ({
          email: r.email,
          provider: r.provider,
          primary: false,
          created_at: r.created_at,
        })),
      ],
    },
  });
}

// POST /api/identities — link a provider identity to the calling account.
// Requires a verified id_token from that provider: possession of the second
// identity is proven cryptographically, never just asserted, so a logged-in
// session can't attach an email it doesn't control.
export async function handleLinkIdentity(
  request: Request,
  env: Env,
  deps: OAuthLoginDeps = {}
): Promise<Response> {
  const user = await resolveSessionUser(request, env);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);

  let body: { provider?: string; id_token?: string; nonce?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  const provider = (body.provider || "") as OAuthProvider;
  const assertion = await verifyProviderAssertion(env, provider, body.id_token, body.nonce, {
    ...deps,
    rateLimitScope: deps.rateLimitScope ?? rateLimitScope(request),
  });
  if (!assertion.ok) {
    return json({ ok: false, error: assertion.error }, assertion.status);
  }

  const email = assertion.email;

  // Linking the account's own canonical email is a no-op success — the
  // provider already signs in to this account through users.email.
  if (email === user.email.toLowerCase()) {
    return json({ ok: true, data: { linked: true, email, provider, primary: true } });
  }

  // An email maps to at most one account: reject if it's another user's
  // canonical email or already linked elsewhere.
  const primaryOwner = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (primaryOwner && primaryOwner.id !== user.id) {
    return json({ ok: false, error: "email already belongs to another account" }, 409);
  }

  const existing = await env.DB.prepare(
    "SELECT user_id FROM user_identities WHERE email = ?"
  )
    .bind(email)
    .first<{ user_id: string }>();
  if (existing && existing.user_id !== user.id) {
    return json({ ok: false, error: "email already linked to another account" }, 409);
  }

  // INSERT OR REPLACE keeps re-linking idempotent and refreshes provider/sub.
  await env.DB.prepare(
    "INSERT OR REPLACE INTO user_identities (email, user_id, provider, provider_sub) VALUES (?, ?, ?, ?)"
  )
    .bind(email, user.id, provider, assertion.sub ?? null)
    .run();

  await env.DB.prepare("INSERT INTO audit_log (action, details) VALUES (?, ?)")
    .bind("identity_link", `linked ${provider} identity ${email} to ${user.email}`)
    .run();

  return json({ ok: true, data: { linked: true, email, provider, primary: false } }, 201);
}

// DELETE /api/identities — unlink a previously linked identity. The canonical
// users.email can't be removed (it isn't stored in user_identities).
export async function handleUnlinkIdentity(
  request: Request,
  env: Env
): Promise<Response> {
  const user = await resolveSessionUser(request, env);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);

  let body: { email?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  const email = (body.email || "").toLowerCase().trim();
  if (!email) return json({ ok: false, error: "email required" }, 400);

  if (email === user.email.toLowerCase()) {
    return json({ ok: false, error: "cannot unlink the primary email" }, 400);
  }

  const result = await env.DB.prepare(
    "DELETE FROM user_identities WHERE email = ? AND user_id = ?"
  )
    .bind(email, user.id)
    .run();

  if (!result.meta || result.meta.changes === 0) {
    return json({ ok: false, error: "identity not found" }, 404);
  }

  await env.DB.prepare("INSERT INTO audit_log (action, details) VALUES (?, ?)")
    .bind("identity_unlink", `unlinked identity ${email} from ${user.email}`)
    .run();

  return json({ ok: true, data: { unlinked: true, email } });
}
