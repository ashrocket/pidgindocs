import type { Env } from "./types";

export const DEFAULT_BOARD_INLINE_CHARS = 1200;
export const MAX_BOARD_INLINE_CHARS = 6000;

/** Only call with the verified person's ID or the authenticated agent's sponsor.
 * Tenant configuration names a single team and exact user IDs, never roles,
 * email addresses, display names, or client-reported session metadata. */
export function boardInlineBodyLimit(env: Env, teamId: string, userId: string): number {
  const fallback = DEFAULT_BOARD_INLINE_CHARS;
  if (!env.AGENT_BOARD_INLINE_LIMITS) return fallback;
  try {
    const config: unknown = JSON.parse(env.AGENT_BOARD_INLINE_LIMITS);
    if (!config || typeof config !== "object" || Array.isArray(config)) return fallback;
    const record = config as Record<string, unknown>;
    const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
    if (Object.keys(record).length !== 2 || typeof record.team_id !== "string" || !id.test(record.team_id)
        || record.team_id !== teamId || !record.users || typeof record.users !== "object" || Array.isArray(record.users)) return fallback;
    const users = record.users as Record<string, unknown>;
    if (!Object.entries(users).every(([key, value]) => id.test(key) && typeof value === "number"
        && Number.isSafeInteger(value) && value >= fallback)) return fallback;
    return Object.hasOwn(users, userId) ? Math.min(users[userId] as number, MAX_BOARD_INLINE_CHARS) : fallback;
  } catch { return fallback; }
}
