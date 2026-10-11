import type { Env } from "../types";
import type { Jwks } from "./jwt-verify";

// Providers rotate signing keys (Google roughly daily) and publish the next
// key only shortly before they start signing with it. Cache for as long as the
// provider says the set is fresh (Cache-Control max-age), clamped so a missing
// or absurd header can't pin a stale set for hours.
const MIN_TTL_SECONDS = 5 * 60;
const MAX_TTL_SECONDS = 6 * 60 * 60;
const DEFAULT_TTL_SECONDS = 60 * 60;

export interface FetchJwksOptions {
  // Skip the KV cache and refetch from the provider (used after a token
  // arrives signed with a kid the cached set doesn't know).
  bypassCache?: boolean;
}

// A forged kid must not turn every unauthenticated request into a provider
// round trip: after one bypass fetch, further bypass requests for the same
// host within this window are served from KV.
const REFETCH_COOLDOWN_SECONDS = 60;

export function cacheTtlSeconds(cacheControl: string | null | undefined): number {
  const match = /max-age=(\d+)/i.exec(cacheControl ?? "");
  const maxAge = match ? parseInt(match[1], 10) : NaN;
  if (!Number.isFinite(maxAge)) return DEFAULT_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, maxAge));
}

// Fetch a provider's JWKS (public signing keys), cached in KV by host.
export async function fetchJwks(
  jwksUri: string,
  env: Env,
  opts: FetchJwksOptions = {}
): Promise<Jwks> {
  const host = new URL(jwksUri).host;
  const cacheKey = `jwks:${host}`;

  const cooldownKey = `jwks_refetch:${host}`;
  const useCache = !opts.bypassCache || (await env.SESSIONS.get(cooldownKey)) !== null;
  if (useCache) {
    const cached = await env.SESSIONS.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as Jwks;
      } catch {
        // fall through and refetch
      }
    }
  }

  // KV is the only cache layer we want: `no-store` keeps the Worker's own
  // edge cache from answering a bypass refetch with the same stale set. (The
  // runtime honours `cache` since the 2024-11 compatibility date; the installed
  // workers-types don't declare it yet, hence the cast.)
  const init = { headers: { Accept: "application/json" }, cache: "no-store" } as unknown as RequestInit;
  const res = await fetch(jwksUri, init);
  if (!res.ok) throw new Error(`failed to fetch JWKS (${res.status})`);
  const jwks = (await res.json()) as Jwks;
  if (!jwks || !Array.isArray(jwks.keys)) throw new Error("malformed JWKS response");

  const ttl = cacheTtlSeconds(res.headers.get("Cache-Control"));
  await env.SESSIONS.put(cacheKey, JSON.stringify(jwks), { expirationTtl: ttl });
  if (opts.bypassCache) {
    await env.SESSIONS.put(cooldownKey, "1", { expirationTtl: REFETCH_COOLDOWN_SECONDS });
  }
  return jwks;
}
