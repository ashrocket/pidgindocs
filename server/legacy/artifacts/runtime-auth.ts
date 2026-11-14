import type { Env } from "../types";

// The server-backed runtime (window.pidgin) is called by authored script that
// runs in an opaque origin. It has no cookie, and must never hold a general
// credential. Its page is served with this short-lived token instead: an HMAC
// bound to one artifact and one viewer, accepted by /api/artifacts/:id/rt/* only.

const RUNTIME_TTL_MS = 10 * 60 * 1000;
const AUTH_SCHEME = "PidginArtifact";
const HMAC_CONTEXT = "pidgin-artifact-runtime:";

interface RuntimeClaim { artifact: string; viewer: string; expires: number; }

function secretOf(env: Env): string {
  return env.DOC_SHARE_SECRET ?? env.API_KEY;
}

async function signature(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${HMAC_CONTEXT}${payload}`));
  return [...new Uint8Array(signed)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function issueArtifactRuntimeToken(env: Env, artifact: string, viewer: string): Promise<string> {
  const claim: RuntimeClaim = { artifact, viewer, expires: Date.now() + RUNTIME_TTL_MS };
  const payload = btoa(JSON.stringify(claim)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${payload}.${await signature(payload, secretOf(env))}`;
}

/**
 * The viewer a runtime token names, or null. Only the token is accepted: a
 * session cookie, session header or API key does not authenticate these calls.
 */
export async function resolveArtifactRuntimeUser(request: Request, env: Env, artifactId: string): Promise<string | null> {
  const auth = request.headers.get("Authorization") || "";
  const prefix = `${AUTH_SCHEME} `;
  if (!auth.startsWith(prefix)) return null;
  const token = auth.slice(prefix.length);
  if (token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[a-f0-9]{64}$/.test(parts[1])) return null;
  const expected = await signature(parts[0], secretOf(env));
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ parts[1].charCodeAt(i);
  if (difference) return null;
  let claim: RuntimeClaim;
  try { claim = JSON.parse(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/"))) as RuntimeClaim; }
  catch { return null; }
  if (claim.artifact !== artifactId || typeof claim.viewer !== "string" || typeof claim.expires !== "number" || claim.expires <= Date.now()) return null;
  const active = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND status = 'active'").bind(claim.viewer).first();
  return active ? claim.viewer : null;
}
