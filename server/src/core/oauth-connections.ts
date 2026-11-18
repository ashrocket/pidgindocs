import type { Env } from "./types";
import { editionTableNames } from "./edition-hooks";

export interface OAuthConnectionSummary {
  client_id: string;
  client_name: string;
  created_at: string | null;
  last_refreshed_at: string | null;
  agent_name: string | null;
  team_name: string | null;
  legacy: boolean;
}

/** Only the person's own connection metadata; never tokens or hashes. */
export async function listOAuthConnections(env: Env, userId: string, page: { limit: number; offset: number } = { limit: 100, offset: 0 }): Promise<OAuthConnectionSummary[]> {
  const tables = editionTableNames();
  const { results } = await env.DB.prepare(`SELECT c.client_id, c.client_name, c.created_at, c.last_refreshed_at,
      a.name AS agent_name, t.name AS team_name, 0 AS legacy, c.id AS sort_id
    FROM ${tables.oauthConnections} c LEFT JOIN agent_identities a ON a.id = c.agent_id
    LEFT JOIN teams t ON t.id = c.team_id WHERE c.user_id = ? AND c.revoked_at IS NULL
    UNION ALL SELECT r.client_id, r.client_id, NULL, NULL, NULL, NULL, 1, r.client_id
    FROM ${tables.oauthRefresh} r WHERE r.user_id = ? AND r.connection_id IS NULL AND r.expires_at > ?
      AND NOT EXISTS (SELECT 1 FROM ${tables.oauthConnections} c
        WHERE c.user_id = r.user_id AND c.client_id = r.client_id AND c.revoked_at IS NULL)
    GROUP BY r.client_id ORDER BY 3 DESC, 8 DESC LIMIT ? OFFSET ?`)
    .bind(userId, userId, Math.floor(Date.now() / 1000), page.limit, page.offset).all<Omit<OAuthConnectionSummary, "legacy"> & { legacy: number; sort_id: string }>();
  return await Promise.all((results ?? []).map(async ({ sort_id: _, ...row }) => {
    let name = row.client_name;
    if (row.legacy) {
      const registration = await env.SESSIONS.get(`oauth:client:${row.client_id}`, "json") as { client_name?: string } | null;
      if (typeof registration?.client_name === "string") name = registration.client_name;
    }
    return { ...row, client_name: name, legacy: Boolean(row.legacy) };
  }));
}

/** Revocation is client-wide for this person, including legacy refresh rows. */
export async function revokeOAuthConnection(env: Env, userId: string, clientId: string): Promise<void> {
  const tables = editionTableNames();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM ${tables.oauthRefresh} WHERE user_id = ? AND client_id = ?`).bind(userId, clientId),
    env.DB.prepare(`UPDATE ${tables.oauthConnections} SET revoked_at = datetime('now')
      WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL`).bind(userId, clientId),
  ]);
}
