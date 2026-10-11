import type { Env } from "../types";
import { json } from "../utils";
import { checkRateLimit } from "../ratelimit";
import { verifyIdToken, UnknownSigningKeyError, type Jwks } from "./jwt-verify";
import { fetchJwks, type FetchJwksOptions } from "./jwks";
import { SESSION_TTL_SECONDS, sessionMetadata } from "../middleware";
import { findActiveUserByEmail } from "../auth-utils";

export type OAuthProvider = "apple" | "google";

interface ProviderConfig {
  issuer: string | string[];
  jwksUri: string;
  audiences: string[];
  requireEmailVerified: boolean;
}

const DEFAULT_APPLE_AUDIENCES: string[] = [];

// Resolve provider verification config from env. Returns null when the provider
// is not configured (→ 501), so an operator can ship Apple before Google.
function providerConfig(provider: OAuthProvider, env: Env): ProviderConfig | null {
  if (provider === "apple") {
    const audiences = env.APPLE_AUDIENCES
      ? env.APPLE_AUDIENCES.split(",").map((a) => a.trim()).filter(Boolean)
      : DEFAULT_APPLE_AUDIENCES;
    if (audiences.length === 0) return null;
    return {
      issuer: "https://appleid.apple.com",
      jwksUri: "https://appleid.apple.com/auth/keys",
      audiences,
      requireEmailVerified: false,
    };
  }
  if (provider === "google") {
    // Two distinct client IDs can both mint tokens we need to accept: the iOS
    // app's client (GOOGLE_CLIENT_ID) and the web button's client
    // (GOOGLE_WEB_CLIENT_ID, rendered in loginPage). Either configured alone
    // is enough to enable Google sign-in for that surface.
    const audiences = [env.GOOGLE_CLIENT_ID, env.GOOGLE_WEB_CLIENT_ID].filter(
      (id): id is string => Boolean(id)
    );
    if (audiences.length === 0) return null;
    return {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
      audiences,
      requireEmailVerified: true,
    };
  }
  return null;
}

export interface OAuthLoginDeps {
  fetchJwks?: (jwksUri: string, env: Env, opts?: FetchJwksOptions) => Promise<Jwks>;
  now?: number;
  // Who is asking, for rate limiting — normally the client IP. Without it the
  // limit is shared by everyone, so 30 junk POSTs from anywhere would lock
  // every user out for ten minutes.
  rateLimitScope?: string;
}

export function rateLimitScope(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

// Per-client limit, plus a looser global backstop so a botnet can't turn the
// endpoint into a JWKS-fetch / D1 amplifier. Returns false when limited.
async function oauthRateLimitAllows(env: Env, provider: OAuthProvider, scope: string | undefined): Promise<boolean> {
  if (scope === undefined) {
    return checkRateLimit(env, `oauth:${provider}`, 30, 600);
  }
  const perClient = await checkRateLimit(env, `oauth:${provider}:${scope}`, 30, 600);
  if (!perClient) return false;
  return checkRateLimit(env, `oauth:${provider}:all`, 300, 600);
}

// Record a rate-limit trip once per window per scope — enough to see it in
// audit_log, without letting a flood write a row per request.
async function auditRateLimitOnce(env: Env, provider: OAuthProvider, scope: string | undefined): Promise<void> {
  const marker = `rl_audited:oauth:${provider}:${scope ?? "global"}`;
  if (await env.SESSIONS.get(marker)) return;
  await env.SESSIONS.put(marker, "1", { expirationTtl: 600 });
  await auditOAuthFailure(env, provider, `rate limited (${scope ?? "global"})`);
}

// Failed sign-ins used to vanish without a trace (only successes hit
// audit_log), which made "Google login isn't working" undiagnosable after the
// fact. Record the provider and the reason — never the token. Only genuine
// rejections (401) are recorded: 429s would let an unauthenticated flood turn
// the cheap rate limiter into a D1 write per request. Best-effort: an audit
// hiccup must not turn a clean 401 into a 500.
async function auditOAuthFailure(env: Env, provider: OAuthProvider, reason: string): Promise<void> {
  const details = `${provider}: ${reason}`.replace(/[^\x20-\x7e]/g, "?").slice(0, 200);
  try {
    await env.DB.prepare("INSERT INTO audit_log (action, details) VALUES (?, ?)")
      .bind("oauth_login_failed", details)
      .run();
  } catch (err) {
    console.error(`audit_log write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// `a***@example.com`: enough to tell which account the chooser picked
// without persisting a stranger's full address where any session can read
// it (/api/audit is not user-scoped).
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

export type ProviderLoginResult =
  | { ok: true; email: string; sessionToken: string }
  | { ok: false; status: number; error: string };

export type ProviderAssertionResult =
  | { ok: true; email: string; sub?: string }
  | { ok: false; status: number; error: string };

// Verify a provider id_token and return its verified email/sub WITHOUT any
// account lookup or session minting. Shared by login (verifyProviderIdToken)
// and identity linking (routes/identities.ts), which both need the same
// config resolution, rate limiting, signature/claims verification, and
// single-use nonce enforcement — but do different things with the identity.
export async function verifyProviderAssertion(
  env: Env,
  provider: OAuthProvider,
  idToken: string | undefined,
  nonce: string | undefined,
  deps: OAuthLoginDeps = {}
): Promise<ProviderAssertionResult> {
  if (provider !== "apple" && provider !== "google") {
    return { ok: false, status: 400, error: "unknown provider" };
  }

  const config = providerConfig(provider, env);
  if (!config) {
    return { ok: false, status: 501, error: `${provider} sign-in is not configured` };
  }

  // Rate limit per provider and client (cheap brute-force / abuse guard).
  const allowed = await oauthRateLimitAllows(env, provider, deps.rateLimitScope);
  if (!allowed) {
    await auditRateLimitOnce(env, provider, deps.rateLimitScope);
    return { ok: false, status: 429, error: "too many sign-in attempts, try again shortly" };
  }

  if (!idToken) {
    return { ok: false, status: 400, error: "id_token required" };
  }

  const getJwks = deps.fetchJwks ?? fetchJwks;

  let email: string;
  let sub: string | undefined;
  let nonceHash: string | undefined;
  try {
    const verifyWith = (jwks: Jwks) =>
      verifyIdToken(idToken, {
        issuer: config.issuer,
        audiences: config.audiences,
        jwks,
        now: deps.now,
        requireEmailVerified: config.requireEmailVerified,
        // When the client sends a nonce, bind the token to it (Apple replay hardening).
        expectedNonce: nonce,
      });
    let verified;
    try {
      verified = await verifyWith(await getJwks(config.jwksUri, env));
    } catch (err) {
      // A token without a kid can't be helped by a fresh key set.
      if (!(err instanceof UnknownSigningKeyError) || err.kid === undefined) throw err;
      // The provider rotated keys since we cached its JWKS (Google does this
      // about daily): refresh the set once and retry before rejecting.
      console.warn(`${provider} id_token signed with unknown kid; refreshing JWKS`);
      verified = await verifyWith(await getJwks(config.jwksUri, env, { bypassCache: true }));
    }
    email = verified.email.toLowerCase();
    sub = typeof verified.claims.sub === "string" ? verified.claims.sub : undefined;
    nonceHash = typeof verified.claims.nonce === "string" ? verified.claims.nonce : undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : "token verification failed";
    return { ok: false, status: 401, error: `sign-in rejected: ${message}` };
  }

  // Single-use nonce: even a validly-signed token can't be redeemed twice within
  // its short validity window. Keyed by the token's nonce hash; TTL covers the
  // token lifetime (Apple id_tokens last ~10 min).
  if (nonce && nonceHash) {
    const nonceKey = `oauth_nonce:${nonceHash}`;
    if (await env.SESSIONS.get(nonceKey)) {
      return { ok: false, status: 401, error: "sign-in rejected: nonce already used" };
    }
    await env.SESSIONS.put(nonceKey, "1", { expirationTtl: 600 });
  }

  return { ok: true, email, sub };
}

// Core of SSO login shared by the JSON app endpoint (handleOAuthLogin) and the
// browser/cookie web endpoint (handleOAuthLoginWeb in routes/auth.ts): verify
// the provider's id_token, enforce single-use nonce, confirm an active invited
// user, and mint a session. Callers decide how to surface the session (JSON
// body vs. Set-Cookie + redirect).
export async function verifyProviderIdToken(
  env: Env,
  provider: OAuthProvider,
  idToken: string | undefined,
  nonce: string | undefined,
  deps: OAuthLoginDeps = {}
): Promise<ProviderLoginResult> {
  const assertion = await verifyProviderAssertion(env, provider, idToken, nonce, deps);
  if (!assertion.ok) {
    if (assertion.status === 401) await auditOAuthFailure(env, provider, assertion.error);
    return assertion;
  }

  // Invite-only: SSO is a faster login for existing active users, never
  // signup. The email may be the account's canonical email OR any linked
  // identity (user_identities) — e.g. an Apple ID resolving to an account
  // whose canonical email is a Gmail address.
  const user = await findActiveUserByEmail(env, assertion.email);
  if (!user) {
    // The email matters here: "not working" is often the account chooser
    // defaulting to a Google account that was never invited or linked.
    await auditOAuthFailure(env, provider, `not a registered user (${maskEmail(assertion.email)})`);
    return { ok: false, status: 401, error: "not a registered user" };
  }

  // Mint a session token, same shape/lifetime as the magic-link flow. Always
  // store the CANONICAL email so every provider identity lands on one account.
  const sessionToken = crypto.randomUUID();
  await env.SESSIONS.put(`session:${sessionToken}`, user.email, {
    expirationTtl: SESSION_TTL_SECONDS,
    metadata: sessionMetadata(),
  });

  const detail =
    assertion.email === user.email
      ? `${provider} sign-in for ${user.email}`
      : `${provider} sign-in for ${user.email} (via linked ${assertion.email})`;
  await env.DB.prepare("INSERT INTO audit_log (action, details) VALUES (?, ?)")
    .bind("oauth_login", detail)
    .run();

  return { ok: true, email: user.email, sessionToken };
}

export async function handleOAuthLogin(
  request: Request,
  env: Env,
  provider: OAuthProvider,
  deps: OAuthLoginDeps = {}
): Promise<Response> {
  let body: { id_token?: string; nonce?: string };
  try {
    body = (await request.json()) as { id_token?: string; nonce?: string };
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  const result = await verifyProviderIdToken(env, provider, body.id_token, body.nonce, {
    ...deps,
    rateLimitScope: deps.rateLimitScope ?? rateLimitScope(request),
  });
  if (!result.ok) {
    return json({ ok: false, error: result.error }, result.status);
  }

  return json({ ok: true, data: { session_token: result.sessionToken, email: result.email } });
}
