import { editionOAuthWriteRefusal, editionProductName, editionTableNames, editionWireFormat, editionWriteProtected, editionPublicSite, editionWorkspaceSignInOnly } from "../edition-hooks";
import { accessTokenStart, authCodeStart, refreshTokenStart } from "../wire-names";
import type { AuthedApiUser, Env } from "../types";
import { json } from "../utils";
import { appPath, appRootUrl, basePath } from "../base-path";
import { verifyOwnerCredential, verifySession, resolveSessionUserId } from "../middleware";
import { editionLoginPage } from "../edition-hooks";
import { oauthConsentHtml } from "../web/oauth-consent";
import { claimLegacyRefreshToken, currentTokenUser, oauthBindingActive, verifyOAuthAccessToken, type OAuthTokenRecord } from "../oauth-tokens";
export { verifyOAuthAccessToken } from "../oauth-tokens";
import { createSelfAgentIdentity, listOwnAgentIdentities, SELF_MINTED_AGENT_LIMIT, AgentSelfServiceError, AgentQuotaError } from "../agent-self-service";
import { canWriteWorkspace, listTeams } from "../workspace";
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
  user_id: string;
  scope: string;
  code_challenge: string;
  agent_id?: string | null;
  team_id?: string | null;
  connection_id?: string | null;
}
interface OAuthConsent extends OAuthCode { state: string; }
const now = () => Math.floor(Date.now() / 1000);
const randomToken = () => crypto.randomUUID() + crypto.randomUUID();


function originFromRequest(request: Request, env: Env): string {
  return env.WORKER_URL || new URL(request.url).origin;
}

// The issuer and resource URLs of this deployment. With BASE_PATH=/alice that is
// https://example.com/alice (a path issuer, RFC 8414); with no base it is WORKER_URL as before.
function deploymentRoot(request: Request, env: Env): string {
  return appRootUrl(env, new URL(request.url).origin);
}

function oauthJson(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Pragma": "no-cache" },
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

async function storeAccessToken(env: Env, token: string, payload: OAuthTokenRecord): Promise<void> {
  await env.SESSIONS.put(`oauth:token:${token}`, JSON.stringify(payload), { expirationTtl: ACCESS_TOKEN_TTL });
}


function validRedirect(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash &&
      (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  } catch { return false; }
}
function sessionToken(request: Request): string {
  return request.headers.get("Cookie")?.match(/(?:^|;\s*)session=([^;]+)/)?.[1] ||
    (request.headers.get("Authorization")?.startsWith("Session ") ? request.headers.get("Authorization")!.slice(8) : "");
}
function escapeHtml(value: string): string {
  return value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
// CSP host-source cannot express an IPv6 literal, so the [::1] loopback falls back to its scheme.
function formActionSource(redirectUri: string): string {
  const url = new URL(redirectUri);
  return url.hostname.startsWith("[") ? `${url.protocol}` : url.origin;
}
// Client labels are display text, never provider authority or instructions.
function signInAgentName(client: OAuthClient): string {
  return (client.client_name ?? "External application").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "External application";
}
async function consentTeams(env: Env, userId: string) {
  return editionPublicSite(env) ? [] : await listTeams(env, userId);
}
function preferredTeam(env: Env, teams: Array<{ id: string }>): string | null {
  return teams.find(t => t.id === env.ENTRA_DEFAULT_TEAM_ID)?.id ?? teams[0]?.id ?? null;
}
async function agentConsentSection(env: Env, userId: string, client: OAuthClient, nonce: string) {
  const teams = await consentTeams(env, userId);
  const selected = preferredTeam(env, teams);
  if (!teams.some(t => canWriteWorkspace(t.role))) return { html: "", teamId: null, agentId: null, boardPostingOff: false };
  const name = signInAgentName(client);
  const groups = await Promise.all(teams.map(async team => {
    const agents = (await listOwnAgentIdentities(env, { userId, teamId: team.id })).filter(a => a.status === "active");
    const reuse = agents.find(a => a.signin_connected && a.name === name);
    const canCreate = canWriteWorkspace(team.role) && agents.filter(a => a.self_minted).length < SELF_MINTED_AGENT_LIMIT;
    // Never silently bind a different app to an unrelated identity when the quota is full.
    const choice = canWriteWorkspace(team.role) ? reuse?.id ?? (canCreate ? "new" : "none") : "none";
    const options = [
      ...(canCreate ? [{ value: "new", label: `New agent: ${name}` }] : []),
      ...(canWriteWorkspace(team.role) ? agents.map(a => ({ value: a.id, label: a.name })) : []),
      { value: "none", label: "Don't post to agent boards" },
    ];
    return { team, choice, reuse, options };
  }));
  const active = groups.find(g => g.team.id === selected)!;
  const optionHtml = (options: typeof active.options, choice: string) => options.map(o =>
    `<option value="${escapeHtml(o.value)}"${o.value !== "new" && o.value !== "none" ? ' translate="no"' : ""}${o.value === choice ? " selected" : ""}>${escapeHtml(o.label)}</option>`).join("");
  // Templates keep untrusted client/team/agent names out of executable JavaScript.
  const templates = groups.map(g => `<template data-team="${escapeHtml(g.team.id)}">${optionHtml(g.options, g.choice)}</template>`).join("");
  const teamField = teams.length === 1 || teams.some(t => t.id === env.ENTRA_DEFAULT_TEAM_ID)
    ? `<p>Team: <span translate="no">${escapeHtml(active.team.name)}</span></p><input type="hidden" name="team" value="${escapeHtml(active.team.id)}">`
    : `<label for="oauth-team">Team</label><select id="oauth-team" name="team">${teams.map(t => `<option value="${escapeHtml(t.id)}" translate="no"${t.id === selected ? " selected" : ""}>${escapeHtml(t.name)}</option>`).join("")}</select>`;
  return {
    teamId: active.team.id, agentId: active.reuse?.id ?? null,
    boardPostingOff: active.choice === "none",
    html: `<div class="agent-settings"><p>${editionProductName()} sets up a posting identity for this app. Change it only if you need a different identity.</p>${teamField}<label for="oauth-agent">Posting identity</label><select id="oauth-agent" name="agent">${optionHtml(active.options, active.choice)}</select><p class="note">Only your approved team projects are available. New identities count toward your agent limit.</p></div>${templates}<script nonce="${nonce}">const team=document.getElementById('oauth-team'),agent=document.getElementById('oauth-agent'),notice=document.getElementById('oauth-board-notice');const updateNotice=()=>{if(notice)notice.hidden=agent.value!=='none';};agent.addEventListener('change',updateNotice);if(team)team.addEventListener('change',()=>{const template=Array.from(document.querySelectorAll('template[data-team]')).find(t=>t.dataset.team===team.value);if(template)agent.replaceChildren(template.content.cloneNode(true));updateNotice();});</script>`,
  };
}
function consentPage(client: OAuthClient, redirectUri: string, requestId: string, csrf: string, agentSection: string, nonce: string, accountEmail: string, boardPostingOff: boolean, base: string): Response {
  return new Response(oauthConsentHtml({
    clientName: client.client_name || "External application",
    accountEmail,
    destination: new URL(redirectUri).origin,
    requestId, csrf, agentSection, boardPostingOff, base,
  }), { headers: {
    // same-origin, not no-referrer: under no-referrer the browser sends `Origin: null` on the Allow POST,
    // which the same-origin check in handleOAuthAuthorize refuses. clientRedirect keeps no-referrer.
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "same-origin",
    // Chrome applies form-action to the redirect that answers the form, so the validated redirect origin
    // (for Claude Code, http://localhost:<port>) must be allowed or the code never reaches the client.
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self' ${formActionSource(redirectUri)}; base-uri 'none'; frame-ancestors 'none'`,
    "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff",
  } });
}
function clientRedirect(uri: string, state: string, values: Record<string, string>): Response {
  const target = new URL(uri);
  for (const [key, value] of Object.entries(values)) target.searchParams.set(key, value);
  if (state) target.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { Location: target.href, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}


// `env` is needed only for a base path: the protected-resource metadata of a path
// deployment lives at the origin root with the path inserted (RFC 9728), for example
// https://example.com/.well-known/oauth-protected-resource/alice/mcp.
function oauthUnauthorized(request: Request, error?: string, env?: Pick<Env, "BASE_PATH" | "WORKER_URL">): Response {
  const base = env ? basePath(env) : "";
  const origin = base && env?.WORKER_URL ? new URL(env.WORKER_URL).origin : new URL(request.url).origin;
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource${base}/mcp`;
  const params = [`realm="${editionWireFormat().authRealm}"`, `resource_metadata="${metadataUrl}"`];
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
  const origin = deploymentRoot(request, env);
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
  const origin = deploymentRoot(request, env);
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
  const hasApiKey = await verifyOwnerCredential(request.headers, env);
  if (!hasApiKey) {
    const sessionEmail = await verifySession(request.headers, env.SESSIONS, env);
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

  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0 || body.redirect_uris.length > 10 || !body.redirect_uris.every(validRedirect)) {
    return oauthJson({ error: "invalid_redirect_uri" }, 400);
  }

  const authMethod = body.token_endpoint_auth_method || "none";
  if (authMethod !== "none") {
    return oauthJson({ error: "invalid_client_metadata", error_description: "Only token_endpoint_auth_method=none is supported" }, 400);
  }

  const client: OAuthClient = {
    client_id: `cp_${crypto.randomUUID()}`,
    client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 160) : undefined,
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

export async function handleOAuthAuthorize(request: Request, env: Env): Promise<Response> {
  const tables = editionTableNames();
  const url = new URL(request.url);
  const origin = new URL(originFromRequest(request, env)).origin;
  if (url.origin !== origin) {
    return request.method === "GET"
      ? Response.redirect(new URL(appPath(env, url.pathname) + url.search, origin).href, 302)
      : oauthJson({ error: "invalid_request" }, 400);
  }
  const userId = await resolveSessionUserId(request, env);
  if (!userId) return request.method === "GET"
    ? editionLoginPage(env, undefined, url.pathname + url.search)
    : oauthJson({ error: "login_required" }, 401);
  const binding = await sha256(sessionToken(request));

  if (request.method === "POST") {
    const requestOrigin = request.headers.get("Origin");
    if ((requestOrigin && requestOrigin !== origin) || url.search) return oauthJson({ error: "invalid_request" }, 403);
    let form: FormData;
    try { form = await request.formData(); } catch { return oauthJson({ error: "invalid_request" }, 400); }
    if ([...form.keys()].some(key => (!["request_id", "csrf", "decision", "agent", "team"].includes(key) || form.getAll(key).length !== 1))) return oauthJson({ error: "invalid_request" }, 400);
    const requestId = form.get("request_id"), csrf = form.get("csrf"), decision = form.get("decision");
    if (typeof requestId !== "string" || typeof csrf !== "string" || !["allow", "deny"].includes(String(decision))) return oauthJson({ error: "invalid_request" }, 400);
    const consent = await env.DB.prepare(`DELETE FROM ${tables.oauthConsents} WHERE request_hash=? AND csrf_hash=? AND session_hash=?
      AND user_id=? AND expires_at>? RETURNING user_id,client_id,redirect_uri,state,scope,code_challenge`)
      .bind(await sha256(requestId), await sha256(csrf), binding, userId, now()).first<OAuthConsent>();
    if (!consent) return oauthJson({ error: "invalid_request", error_description: "Connection approval expired or was already used. Start again from your application." }, 400);
    const client = await loadClient(env, consent.client_id);
    if (!client || !client.redirect_uris.includes(consent.redirect_uri) || !validRedirect(consent.redirect_uri)) return oauthJson({ error: "unauthorized_client" }, 400);
    if (decision === "deny") return clientRedirect(consent.redirect_uri, consent.state, { error: "access_denied" });
    let agentId: string | null = null, teamId: string | null = null;
    try {
      const choice = form.get("agent") ?? "none";
      if (typeof choice !== "string") return oauthJson({ error: "invalid_request" }, 400);
      const teams = await consentTeams(env, userId);
      const postedTeam = form.get("team");
      if (postedTeam !== null && (typeof postedTeam !== "string" || !teams.some(t => t.id === postedTeam))) {
        return oauthJson({ error: "invalid_request", error_description: "Choose one of your teams." }, 400);
      }
      if (choice !== "none") {
        const team = teams.find(t => t.id === (postedTeam ?? preferredTeam(env, teams)));
        if (!team || !canWriteWorkspace(team.role)) return oauthJson({ error: "invalid_request" }, 400);
        teamId = team.id;
        const agents = await listOwnAgentIdentities(env, { userId, teamId });
        const existing = agents.find(a => a.status === "active" && (choice === "new"
          ? a.signin_connected && a.name === signInAgentName(client) : a.id === choice));
        if (choice !== "new" && !existing) return oauthJson({ error: "invalid_request", error_description: "Choose one of your active agents." }, 400);
        // Existing identities can reconnect for reading; minting an identity and
        // its project grants is a product write, even inside OAuth consent.
        if (!existing && editionWriteProtected(env)) {
          const denied = await editionOAuthWriteRefusal(env);
          if (denied) return denied;
        }
        agentId = existing?.id ?? (await createSelfAgentIdentity(env, {
          userId, teamId, name: signInAgentName(client), signIn: true,
        })).agent.id;
        if (!await oauthBindingActive(env, { user_id: userId, client_id: client.client_id, email: "", scope: consent.scope, agent_id: agentId, team_id: teamId })) {
          return oauthJson({ error: "invalid_request" }, 400);
        }
      }
    } catch (error) {
      if (error instanceof AgentSelfServiceError || error instanceof AgentQuotaError) {
        return oauthJson({ error: "invalid_request", error_description: error.message }, error instanceof AgentQuotaError ? 429 : error.status);
      }
      throw error;
    }
    const code = authCodeStart() + randomToken(), connectionId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(`UPDATE agent_identities SET signin_connected = 1
        WHERE id = ? AND team_id = ? AND created_by_user_id = ? AND status = 'active' AND kind = 'agent'`)
        .bind(agentId, teamId, userId),
      env.DB.prepare(`INSERT INTO ${tables.oauthConnections}(id,user_id,client_id,client_name,agent_id,team_id) VALUES (?,?,?,?,?,?)`)
        .bind(connectionId, userId, client.client_id, signInAgentName(client), agentId, teamId),
      env.DB.prepare(`INSERT INTO ${tables.oauthCodes}(code_hash,user_id,client_id,redirect_uri,scope,code_challenge,expires_at,agent_id,team_id,connection_id)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(await sha256(code), userId, consent.client_id, consent.redirect_uri, consent.scope, consent.code_challenge, now() + AUTH_CODE_TTL, agentId, teamId, connectionId),
    ]);
    return clientRedirect(consent.redirect_uri, consent.state, { code });
  }

  const clientId = url.searchParams.get("client_id") || "", redirectUri = url.searchParams.get("redirect_uri") || "";
  if (url.searchParams.get("response_type") !== "code") return oauthJson({ error: "unsupported_response_type" }, 400);
  const client = await loadClient(env, clientId);
  if (!client) return oauthJson({ error: "unauthorized_client" }, 400);
  if (!validRedirect(redirectUri) || !client.redirect_uris.includes(redirectUri)) return oauthJson({ error: "invalid_request", error_description: "redirect_uri does not match registered client" }, 400);
  const challenge = url.searchParams.get("code_challenge") || "";
  if (url.searchParams.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return oauthJson({ error: "invalid_request", error_description: "S256 PKCE is required" }, 400);
  const scope = url.searchParams.get("scope") || DEFAULT_SCOPE;
  if (scope.split(/\s+/).some(value => !SCOPES_SUPPORTED.includes(value))) return oauthJson({ error: "invalid_scope" }, 400);
  const state = url.searchParams.get("state") || "";
  if (state.length > 2048) return oauthJson({ error: "invalid_request" }, 400);
  if (!await checkRateLimit(env, `oauth-consent:${userId}`, 30, 600)) return oauthJson({ error: "slow_down" }, 429);
  const requestId = randomToken(), csrf = randomToken(), nonce = crypto.randomUUID();
  const section = await agentConsentSection(env, userId, client, nonce);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM ${tables.oauthConsents} WHERE expires_at<=?`).bind(now()),
    env.DB.prepare(`DELETE FROM ${tables.oauthCodes} WHERE expires_at<=?`).bind(now()),
    env.DB.prepare(`DELETE FROM ${tables.oauthRefresh} WHERE expires_at<=?`).bind(now()),
    env.DB.prepare(`DELETE FROM ${tables.oauthLegacyConsumed} WHERE expires_at<=?`).bind(now()),
    env.DB.prepare(`INSERT INTO ${tables.oauthConsents}(request_hash,csrf_hash,session_hash,user_id,client_id,redirect_uri,state,scope,code_challenge,expires_at,team_id,agent_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(await sha256(requestId), await sha256(csrf), binding, userId, clientId, redirectUri, state, scope, challenge, now() + 600, section.teamId, section.agentId),
  ]);
  const profile = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first<{ email: string }>();
  return consentPage(client, redirectUri, requestId, csrf, section.html, nonce, profile?.email ?? "", section.boardPostingOff, basePath(env));
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

async function issueTokens(env: Env, payload: OAuthTokenRecord & { user_id: string }) {
  const tables = editionTableNames();
  const accessToken = accessTokenStart() + randomToken(), refreshToken = refreshTokenStart() + randomToken();
  // A revoke between validation and this write must not resurrect a refresh row.
  const result = await env.DB.prepare(`INSERT INTO ${tables.oauthRefresh}(token_hash,user_id,client_id,scope,expires_at,agent_id,team_id,connection_id)
    SELECT ?,?,?,?,?,?,?,? WHERE (? IS NULL OR EXISTS (
      SELECT 1 FROM ${tables.oauthConnections} WHERE id = ? AND revoked_at IS NULL))
      AND (? IS NULL OR EXISTS (SELECT 1 FROM agent_identities a
        JOIN users u ON u.id = a.created_by_user_id AND u.status = 'active'
        JOIN team_memberships m ON m.team_id = a.team_id AND m.user_id = u.id
        WHERE a.id = ? AND a.status = 'active' AND a.team_id = ? AND u.id = ?))`)
    .bind(await sha256(refreshToken), payload.user_id, payload.client_id, payload.scope, now() + REFRESH_TOKEN_TTL,
      payload.agent_id ?? null, payload.team_id ?? null, payload.connection_id ?? null,
      payload.connection_id ?? null, payload.connection_id ?? null, payload.agent_id ?? null, payload.agent_id ?? null, payload.team_id ?? null, payload.user_id).run();
  if (!result.meta.changes) return null;
  if (payload.connection_id) await env.DB.prepare(`UPDATE ${tables.oauthConnections} SET last_refreshed_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`).bind(payload.connection_id).run();
  await storeAccessToken(env, accessToken, payload);
  return { access_token: accessToken, token_type: "Bearer", refresh_token: refreshToken, expires_in: ACCESS_TOKEN_TTL, scope: payload.scope };
}

export async function handleOAuthToken(request: Request, env: Env): Promise<Response> {
  const tables = editionTableNames();
  let params: Record<string, string>;
  try { params = await parseTokenRequest(request); } catch { return oauthJson({ error: "invalid_request" }, 400); }
  const clientId = params.client_id || "";
  const client = await loadClient(env, clientId);
  if (!client) return oauthJson({ error: "invalid_client" }, 401);
  // A registration lives 90 days in KV. Renew it whenever it earns tokens, so a connection that
  // refreshes regularly is not cut off when the original registration ages out.
  const issue = async (payload: OAuthTokenRecord & { user_id: string }) => {
    const tokens = await issueTokens(env, payload);
    if (!tokens) return oauthJson({ error: "invalid_grant" }, 400);
    await storeClient(env, client);
    return oauthJson(tokens);
  };
  if (params.grant_type === "authorization_code") {
    const verifier = params.code_verifier || "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthJson({ error: "invalid_grant", error_description: "S256 PKCE proof is required" }, 400);
    const code = await env.DB.prepare(`DELETE FROM ${tables.oauthCodes} WHERE code_hash=? AND client_id=? AND redirect_uri=?
      AND code_challenge=? AND expires_at>? RETURNING user_id,client_id,scope,agent_id,team_id,connection_id`)
      .bind(await sha256(params.code || ""), clientId, params.redirect_uri || "", await sha256(verifier), now()).first<OAuthTokenRecord & { user_id: string }>();
    if (!code) return oauthJson({ error: "invalid_grant" }, 400);
    const user = await currentTokenUser(env, code);
    if (!user || !await oauthBindingActive(env, code)) return oauthJson({ error: "invalid_grant" }, 400);
    return await issue({ ...code, email: user.email });
  }
  if (params.grant_type === "refresh_token") {
    const token = params.refresh_token || "";
    let payload: OAuthTokenRecord | null = null;
    if (token.startsWith(refreshTokenStart())) {
      const stored = await env.DB.prepare(`DELETE FROM ${tables.oauthRefresh} WHERE token_hash=? AND client_id=? AND expires_at>?
        RETURNING user_id,client_id,scope,agent_id,team_id,connection_id`).bind(await sha256(token), clientId, now()).first<OAuthTokenRecord & { user_id: string }>();
      if (stored) payload = { ...stored, email: "" };
    } else if (token) {
      if (editionWorkspaceSignInOnly(env)) return oauthJson({ error: "invalid_grant", error_description: `Connect again and approve ${editionProductName()} access.` }, 400);
      const raw = await env.SESSIONS.get(`oauth:refresh:${token}`);
      try { payload = raw ? JSON.parse(raw) as OAuthTokenRecord : null; } catch { payload = null; }
      if (!payload || payload.client_id !== clientId) return oauthJson({ error: "invalid_grant" }, 400);
      if (!await claimLegacyRefreshToken(env, await sha256(token), now() + REFRESH_TOKEN_TTL + 3600)) return oauthJson({ error: "invalid_grant" }, 400);
      await env.SESSIONS.delete(`oauth:refresh:${token}`);
    }
    if (!payload) return oauthJson({ error: "invalid_grant" }, 400);
    const user = await currentTokenUser(env, payload);
    if (!user || !await oauthBindingActive(env, payload)) return oauthJson({ error: "invalid_grant" }, 400);
    return await issue({ ...payload, user_id: user.id, email: user.email });
  }
  return oauthJson({ error: "unsupported_grant_type" }, 400);
}

export async function resolveOAuthUser(
  headers: Headers,
  env: Env
): Promise<AuthedApiUser | null> {
  const tokenRecord = await verifyOAuthAccessToken(headers, env);
  if (!tokenRecord) return null;

  const user = await currentTokenUser(env, tokenRecord);
  return user ? { userId: user.id, email: user.email } : null;
}

export { oauthUnauthorized };
