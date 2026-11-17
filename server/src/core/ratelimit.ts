import type { Env } from "./types";

export async function checkRateLimit(
  env: Env,
  key: string,
  maxAttempts: number,
  windowSecs: number
): Promise<boolean> {
  const rlKey = `rl:${key}`;
  const current = await env.SESSIONS.get(rlKey);
  const count = current ? parseInt(current, 10) : 0;
  if (count >= maxAttempts) return false;
  await env.SESSIONS.put(rlKey, String(count + 1), { expirationTtl: windowSecs });
  return true;
}
