import type { Env } from "../types";
import { resolveCallerUserId as resolvePersonalCaller } from "../middleware";
import { resolveOAuthUser } from "../routes/oauth";
export { unauthorized } from "../middleware";

/** Board Agent credentials cannot become personal-library credentials, even
 * when the browser also supplies a personal cookie. */
export async function resolveCallerUserId(request: Request, env: Env): Promise<string | null> {
  if (/^Agent\s/i.test(request.headers.get("Authorization") ?? "")) return null;
  return await resolvePersonalCaller(request, env)
    ?? (await resolveOAuthUser(request.headers, env))?.userId
    ?? null;
}

export function isSameOriginMutation(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return false;
  return request.headers.get("Sec-Fetch-Site") !== "cross-site";
}
