import type { Env } from "./types";
import { editionAccountActiveSql, editionTableNames, editionOAuthAccessToken, editionWorkspaceSignInOnly } from "./edition-hooks";
import { accessTokenStart } from "./wire-names";
import { isEntraUser } from "./middleware";
import { agentSponsorAccessSql } from "./agent-access";

export interface OAuthTokenRecord {
  user_id?: string;
  client_id: string;
  email: string;
  scope: string;
  agent_id?: string | null;
  team_id?: string | null;
  connection_id?: string | null;
}


export async function currentTokenUser(env: Env, payload: { user_id?: string; email?: string }): Promise<{ id: string; email: string } | null> {
  const user = payload.user_id
    ? await env.DB.prepare("SELECT id, email FROM users WHERE id = ? AND status = 'active'").bind(payload.user_id).first<{ id: string; email: string }>()
    : await env.DB.prepare("SELECT id, email FROM users WHERE email = ? AND status = 'active'").bind(payload.email?.toLowerCase() || "").first<{ id: string; email: string }>();
  if (!user || !await isEntraUser(env, user.id)) return null;
  const active = await env.DB.prepare(`SELECT id FROM users WHERE id = ? AND ${editionAccountActiveSql()}`).bind(user.id).first();
  return active ? user : null;
}


/** Records that a legacy refresh token (one kept in KV) has been used. False when it was already used, so the caller must refuse it. */
export async function claimLegacyRefreshToken(env: Env, tokenHash: string, expiresAt: number): Promise<boolean> {
  const tables = editionTableNames();
  const claimed = await env.DB.prepare(`INSERT OR IGNORE INTO ${tables.oauthLegacyConsumed}(token_hash,expires_at) VALUES (?,?) RETURNING token_hash`)
    .bind(tokenHash, expiresAt).first();
  return !!claimed;
}

/** Validate identity, sponsor and current membership for the whole connection. */
export async function oauthBindingActive(env: Env, record: OAuthTokenRecord): Promise<boolean> {
  const tables = editionTableNames();
  if (record.connection_id) {
    const connection = await env.DB.prepare(`SELECT id FROM ${tables.oauthConnections}
      WHERE id = ? AND user_id = ? AND client_id = ? AND revoked_at IS NULL
        AND agent_id IS ? AND team_id IS ?`)
      .bind(record.connection_id, record.user_id ?? null, record.client_id, record.agent_id ?? null, record.team_id ?? null).first();
    if (!connection) return false;
  }
  if (!record.agent_id) return true;
  if (!record.user_id || !record.team_id) return false;
  return !!await env.DB.prepare(`SELECT a.id FROM agent_identities a
    JOIN users owner ON owner.id = a.created_by_user_id AND owner.status = 'active'
    JOIN team_memberships m ON m.team_id = a.team_id AND m.user_id = owner.id
    WHERE a.id = ? AND a.team_id = ? AND a.created_by_user_id = ?
      AND a.status = 'active' AND a.kind = 'agent' AND ${agentSponsorAccessSql(env)}`)
    .bind(record.agent_id, record.team_id, record.user_id).first();
}

export async function verifyOAuthAccessToken(headers: Headers, env: Env): Promise<OAuthTokenRecord | null> {
  const edition = await editionOAuthAccessToken(headers, env);
  if (edition !== undefined) return edition;
  const match = /^Bearer ([^ ]+)$/.exec(headers.get("Authorization") ?? "");
  const bearer = match?.[1];
  if (!bearer || bearer === env.API_KEY) return null;
  const raw = await env.SESSIONS.get(`oauth:token:${bearer}`);
  if (!raw) return null;
  let record: OAuthTokenRecord;
  try { record = JSON.parse(raw); } catch { return null; }
  if (!record || typeof record.client_id !== "string") return null;
  if (editionWorkspaceSignInOnly(env) && (!bearer.startsWith(accessTokenStart()) || !record.user_id)) return null;
  return await oauthBindingActive(env, record) ? record : null;
}
