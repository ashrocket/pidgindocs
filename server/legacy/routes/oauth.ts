import type { AuthedApiUser, Env } from "../types";
import { json } from "../utils";
import { verifyApiKey, verifySession } from "../middleware";
import { loginPage } from "../web/index";
import { checkRateLimit } from "../ratelimit";

const AUTH_CODE_TTL = 5 * 60;
const ACCESS_TOKEN_TTL = 60 * 60;
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60;
const DEFAULT_SCOPE = "mcp";
// Advertised so MCP clients (e.g. Claude Code) request a refresh token. The
// token + authorize paths already pass scope through and issue refresh tokens
// unconditionally; verifyOAuthAccessToken does not gate on scope value.
const SCOPES_SUPPORTED = [DEFAULT_SCOPE, "offline_access"];

interface OAuthClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
  scope?: string;
  created_at: number;
}

interface OAuthCode {
  client_id: string;
  redirect_uri: string;
  email: string;
  scope: string;
  code_challenge?: string;
  code_challenge_method?: string;
}

interface OAuthTokenRecord {
  client_id: string;
  email: string;
  scope: string;
}

function originFromRequest(request: Request, env: Env): string {
  return env.WORKER_URL || new URL(request.url).origin;
}

function oauthJson(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getBearerToken(headers: Headers): string | null {
  const auth = headers.get("Authorization");
  if (!auth) return null;
  const [scheme, token] = auth.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return base64UrlEncode(new Uint8Array(digest));
}

async function loadClient(env: Env, clientId: string): Promise<OAuthClient | null> {
  const raw = await env.SESSIONS.get(`oauth:client:${clientId}`);
  if (!raw) return null;
  return JSON.parse(raw) as OAuthClient;
}

async function storeClient(env: Env, client: OAuthClient): Promise<void> {
  await env.SESSIONS.put(`oauth:client:${client.client_id}`, JSON.stringify(client), {
    expirationTtl: 90 * 24 * 60 * 60,
  });
}

async function storeAuthCode(env: Env, code: string, payload: OAuthCode): Promise<void> {
  await env.SESSIONS.put(`oauth:code:${code}`, JSON.stringify(payload), {
    expirationTtl: AUTH_CODE_TTL,
  });
}

async function consumeAuthCode(env: Env, code: string): Promise<OAuthCode | null> {
  const key = `oauth:code:${code}`;
  const raw = await env.SESSIONS.get(key);
  if (!raw) return null;
  await env.SESSIONS.delete(key);
  return JSON.parse(raw) as OAuthCode;
}

async function storeAccessToken(env: Env, token: string, payload: OAuthTokenRecord): Promise<void> {
  await env.SESSIONS.put(`oauth:token:${token}`, JSON.stringify(payload), {
    expirationTtl: ACCESS_TOKEN_TTL,
  });
}

async function storeRefreshToken(env: Env, token: string, payload: OAuthTokenRecord): Promise<void> {
  await env.SESSIONS.put(`oauth:refresh:${token}`, JSON.stringify(payload), {
    expirationTtl: REFRESH_TOKEN_TTL,
  });
}

async function readRefreshToken(env: Env, token: string): Promise<OAuthTokenRecord | null> {
  const raw = await env.SESSIONS.get(`oauth:refresh:${token}`);
  if (!raw) return null;
  return JSON.parse(raw) as OAuthTokenRecord;
}

async function revokeRefreshToken(env: Env, token: string): Promise<void> {
  await env.SESSIONS.delete(`oauth:refresh:${token}`);
}

export async function verifyOAuthAccessToken(
  headers: Headers,
  env: Env
): Promise<OAuthTokenRecord | null> {
  const bearer = getBearerToken(headers);
  if (!bearer || bearer === env.API_KEY) return null;
  const raw = await env.SESSIONS.get(`oauth:token:${bearer}`);
  if (!raw) return null;
  return JSON.parse(raw) as OAuthTokenRecord;
}

function oauthUnauthorized(request: Request, error?: string): Response {
  const origin = new URL(request.url).origin;
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
  const params = [`realm="pidgin"`, `resource_metadata="${metadataUrl}"`];
  if (error) params.push(`error="${error}"`);

  return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer ${params.join(", ")}`,
    },
  });
}

export function handleOAuthProtectedResourceMetadata(
  request: Request,
  env: Env
): Response {
  const origin = originFromRequest(request, env);
  return oauthJson({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: SCOPES_SUPPORTED,
    bearer_methods_supported: ["header"],
    resource_documentation: `${origin}/`,
  });
}

export function handleOAuthAuthorizationServerMetadata(
  request: Request,
  env: Env
): Response {
  const origin = originFromRequest(request, env);
  return oauthJson({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: SCOPES_SUPPORTED,
  });
}

export async function handleOAuthRegister(
  request: Request,
  env: Env
): Promise<Response> {
  // Dynamic MCP clients need to register before they can send the user through OAuth.
  // Authorization and tool calls still require a logged-in active user or API key.
  const hasApiKey = verifyApiKey(request.headers, env.API_KEY);
  if (!hasApiKey) {
    const sessionEmail = await verifySession(request.headers, env.SESSIONS);
    if (!sessionEmail) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const allowed = await checkRateLimit(env, `oauth-register:${ip}`, 60, 3600);
      if (!allowed) {
        return oauthJson({ error: "slow_down", error_description: "Too many client registration attempts" }, 429);
      }
    }
  }

  let body: {
    client_name?: string;
    redirect_uris?: string[];
    grant_types?: string[];
    response_types?: string[];
    token_endpoint_auth_method?: string;
    scope?: string;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return oauthJson({ error: "invalid_client_metadata" }, 400);
  }

  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
    return oauthJson({ error: "invalid_redirect_uri" }, 400);
  }

  const authMethod = body.token_endpoint_auth_method || "none";
  if (authMethod !== "none") {
    return oauthJson({ error: "invalid_client_metadata", error_description: "Only token_endpoint_auth_method=none is supported" }, 400);
  }

  const client: OAuthClient = {
    client_id: `cp_${crypto.randomUUID()}`,
    client_name: body.client_name,
    redirect_uris: body.redirect_uris,
    grant_types: body.grant_types || ["authorization_code", "refresh_token"],
    response_types: body.response_types || ["code"],
    token_endpoint_auth_method: "none",
    scope: body.scope || DEFAULT_SCOPE,
    created_at: Math.floor(Date.now() / 1000),
  };

  await storeClient(env, client);

  return oauthJson({
    ...client,
    client_id_issued_at: client.created_at,
  }, 201);
}

export async function handleOAuthAuthorize(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const sessionEmail = await verifySession(request.headers, env.SESSIONS);
  if (!sessionEmail) {
    return await loginPage(env, undefined, request.url);
  }

  // Only registered active users can authorize OAuth clients
  const userRow = await env.DB.prepare(
    "SELECT id FROM users WHERE email = ? AND status = 'active'"
  ).bind(sessionEmail.toLowerCase()).first<{ id: string }>();
  if (!userRow) {
    return await loginPage(env, "Your account is not yet active. Please use your invite link.", request.url);
  }

  const clientId = url.searchParams.get("client_id") || "";
  const redirectUri = url.searchParams.get("redirect_uri") || "";
  const responseType = url.searchParams.get("response_type") || "";
  const state = url.searchParams.get("state") || "";
  const scope = url.searchParams.get("scope") || DEFAULT_SCOPE;
  const codeChallenge = url.searchParams.get("code_challenge") || undefined;
  const codeChallengeMethod = url.searchParams.get("code_challenge_method") || undefined;

  if (responseType !== "code") {
    return oauthJson({ error: "unsupported_response_type" }, 400);
  }

  const client = await loadClient(env, clientId);
  if (!client) {
    return oauthJson({ error: "unauthorized_client" }, 400);
  }

  if (!client.redirect_uris.includes(redirectUri)) {
    return oauthJson({ error: "invalid_request", error_description: "redirect_uri does not match registered client" }, 400);
  }

  if (codeChallengeMethod && codeChallengeMethod !== "S256") {
    return oauthJson({ error: "invalid_request", error_description: "Unsupported code_challenge_method" }, 400);
  }

  const code = crypto.randomUUID();
  await storeAuthCode(env, code, {
    client_id: clientId,
    redirect_uri: redirectUri,
    email: sessionEmail,
    scope,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
  });

  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirect.toString(),
    },
  });
}

async function parseTokenRequest(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get("Content-Type") || "";

  if (contentType.includes("application/json")) {
    const body = (await request.json()) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(body).map(([key, value]) => [key, typeof value === "string" ? value : String(value ?? "")])
    );
  }

  const form = await request.formData();
  const entries: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    entries[key] = typeof value === "string" ? value : "";
  }
  return entries;
}

async function issueTokens(
  env: Env,
  payload: OAuthTokenRecord
): Promise<{ access_token: string; refresh_token: string; expires_in: number; scope: string }> {
  const accessToken = crypto.randomUUID();
  const refreshToken = crypto.randomUUID();

  await storeAccessToken(env, accessToken, payload);
  await storeRefreshToken(env, refreshToken, payload);

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: ACCESS_TOKEN_TTL,
    scope: payload.scope,
  };
}

export async function handleOAuthToken(
  request: Request,
  env: Env
): Promise<Response> {
  const params = await parseTokenRequest(request);
  const grantType = params.grant_type || "";
  const clientId = params.client_id || "";

  const client = clientId ? await loadClient(env, clientId) : null;
  if (!client) {
    return oauthJson({ error: "invalid_client" }, 401);
  }

  if (grantType === "authorization_code") {
    const code = params.code || "";
    const redirectUri = params.redirect_uri || "";
    const verifier = params.code_verifier || "";
    const authCode = await consumeAuthCode(env, code);

    if (!authCode) {
      return oauthJson({ error: "invalid_grant" }, 400);
    }
    if (authCode.client_id !== clientId || authCode.redirect_uri !== redirectUri) {
      return oauthJson({ error: "invalid_grant" }, 400);
    }

    if (authCode.code_challenge) {
      if (!verifier) {
        return oauthJson({ error: "invalid_grant", error_description: "code_verifier required" }, 400);
      }
      const expected = await sha256(verifier);
      if (expected !== authCode.code_challenge) {
        return oauthJson({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
      }
    }

    const tokens = await issueTokens(env, {
      client_id: clientId,
      email: authCode.email,
      scope: authCode.scope || DEFAULT_SCOPE,
    });

    return oauthJson({
      access_token: tokens.access_token,
      token_type: "Bearer",
      expires_in: tokens.expires_in,
      refresh_token: tokens.refresh_token,
      scope: tokens.scope,
    });
  }

  if (grantType === "refresh_token") {
    const refreshToken = params.refresh_token || "";
    const payload = await readRefreshToken(env, refreshToken);
    if (!payload || payload.client_id !== clientId) {
      return oauthJson({ error: "invalid_grant" }, 400);
    }

    await revokeRefreshToken(env, refreshToken);
    const tokens = await issueTokens(env, payload);
    return oauthJson({
      access_token: tokens.access_token,
      token_type: "Bearer",
      expires_in: tokens.expires_in,
      refresh_token: tokens.refresh_token,
      scope: tokens.scope,
    });
  }

  return oauthJson({ error: "unsupported_grant_type" }, 400);
}

export async function resolveOAuthUser(
  headers: Headers,
  env: Env
): Promise<AuthedApiUser | null> {
  const tokenRecord = await verifyOAuthAccessToken(headers, env);
  if (!tokenRecord) return null;

  const u = await env.DB.prepare(
    "SELECT id FROM users WHERE email = ? AND status = 'active'"
  ).bind(tokenRecord.email.toLowerCase()).first<{ id: string }>();

  if (!u) return null;
  return { userId: u.id, email: tokenRecord.email };
}

export { oauthUnauthorized };
