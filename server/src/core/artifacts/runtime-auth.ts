import type { Env } from "../types";
import { editionAccountActiveSql, editionWireFormat } from "../edition-hooks";
import { isEntraUser, resolveCallerUserId } from "../middleware";

const RUNTIME_TTL_MS = 10 * 60 * 1000;
interface RuntimeClaim { artifact: string; viewer: string; expires: number; }
async function signature(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${editionWireFormat().artifactHmacContext}${payload}`));
  return [...new Uint8Array(signed)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export async function issueArtifactRuntimeToken(env: Env, artifact: string, viewer: string): Promise<string> {
  const payload = btoa(JSON.stringify({ artifact, viewer, expires: Date.now() + RUNTIME_TTL_MS })).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  return `${payload}.${await signature(payload, env.DOC_SHARE_SECRET || env.API_KEY)}`;
}
/** This credential is accepted by /api/artifacts/:id/rt/* only, never normal
 * auth middleware. Authored scripts receive no cookie or general API key. */
export async function resolveArtifactRuntimeUser(request: Request, env: Env, artifactId: string): Promise<string | null> {
  const auth = request.headers.get("Authorization") || "";
  const prefix = `${editionWireFormat().artifactAuthScheme} `;
  if (!auth.startsWith(prefix)) return resolveCallerUserId(request, env);
  const token = auth.slice(prefix.length);
  if (token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[a-f0-9]{64}$/.test(parts[1])) return null;
  const expected = await signature(parts[0], env.DOC_SHARE_SECRET || env.API_KEY);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ parts[1].charCodeAt(i);
  if (difference) return null;
  let claim: RuntimeClaim;
  try { claim = JSON.parse(atob(parts[0].replace(/-/g,"+").replace(/_/g,"/"))) as RuntimeClaim; }
  catch { return null; }
  if (claim.artifact !== artifactId || typeof claim.viewer !== "string" || typeof claim.expires !== "number" || claim.expires <= Date.now()) return null;
  const active = await env.DB.prepare(`SELECT id FROM users WHERE id = ? AND status = 'active'
    AND ${editionAccountActiveSql()}`)
    .bind(claim.viewer).first();
  return active && await isEntraUser(env, claim.viewer) ? claim.viewer : null;
}
