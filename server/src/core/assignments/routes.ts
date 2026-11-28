import { resolveAgentCredential } from "../agent-board";
import { resolveCallerUserId, unauthorized } from "../middleware";
import { resolveOAuthUser } from "../routes/oauth";
import { assertTenantWritable, TenantWriteRefused, UsageRefused } from "../edition-hooks";
import { isSameOriginMutation } from "../library/auth";
import { checkRateLimit } from "../ratelimit";
import type { Env } from "../types";
import { json } from "../utils";
import { AssignmentError, MAX_VOICE_BYTES, claimAssignment, createAudioReply, createConnection, getAssignment, getAssignmentVoice, listAssignments, listConnections, listReplyAgents, registerRuntime, updateAssignment, type AssignmentPrincipal } from "./store";

export async function assignmentPrincipal(request: Request, env: Env): Promise<AssignmentPrincipal | null> {
  const agent = await resolveAgentCredential(request.headers, env);
  if (agent) return agent;
  if (request.headers.get("Authorization")?.startsWith("Agent ")) return null;
  const userId = await resolveCallerUserId(request, env) ?? (await resolveOAuthUser(request.headers, env))?.userId;
  return userId ? { userId, agentId: null } : null;
}

// Bound actual bytes, including bodies without Content-Length. Avoid buffering an unbounded form.
async function readBody(request: Request, max: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) throw new AssignmentError("A request body is required");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > max) { await reader.cancel(); throw new AssignmentError("Request is too large", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
  return bytes;
}
export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(await readBody(request, 100_000)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch (error) { if (error instanceof AssignmentError) throw error; throw new AssignmentError("Invalid JSON body"); }
}
async function replyInput(request: Request) {
  const type = request.headers.get("Content-Type") ?? "";
  if (!type.startsWith("multipart/form-data")) return { input: await jsonBody(request), voice: undefined };
  let form: FormData;
  const bytes = await readBody(request, MAX_VOICE_BYTES + 100_000);
  try { form = await new Request(request.url, { method: "POST", headers: { "Content-Type": type }, body: bytes }).formData(); }
  catch { throw new AssignmentError("Invalid recording form"); }
  const input: Record<string, unknown> = {};
  for (const key of ["client_id","text","agent_id","target","connection_id"]) {
    const value = form.get(key);
    if (value !== null && typeof value !== "string") throw new AssignmentError(`Invalid ${key}`);
    if (value !== null) input[key] = value;
  }
  if (form.has("playback_seconds")) input.playback_seconds = Number(form.get("playback_seconds"));
  const file = form.get("voice");
  if (file === null) return { input, voice: undefined };
  if (typeof file === "string") throw new AssignmentError("Invalid recording");
  return { input, voice: { bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type.split(";")[0].toLowerCase() } };
}
export function assignmentError(error: unknown): Response {
  if (error instanceof AssignmentError || error instanceof TenantWriteRefused || error instanceof UsageRefused) return json({ ok: false, error: error.message }, error.status);
  throw error;
}

/** Paths have already had a managed Solo base path removed. */
export async function handleAssignments(request: Request, env: Env, path: string): Promise<Response | null> {
  const reply = /^\/api\/audio\/([^/]+)\/replies$/.exec(path);
  if (!reply && !/^\/api\/assignments(?:\/|$)/.test(path) && path !== "/api/agent-runtimes") return null;
  if (!isSameOriginMutation(request)) return json({ ok: false, error: "origin not allowed" },403);
  const p = await assignmentPrincipal(request,env);
  if (!p) return unauthorized();
  const method = request.method, url = new URL(request.url);
  try {
    if (method !== "GET" && method !== "HEAD") {
      await assertTenantWritable(env);
      if (!await checkRateLimit(env, `assignments:${p.agentId ?? p.userId}`,120,60)) throw new AssignmentError("Too many assignment requests",429);
    }
    const ok = (data: unknown, status = 200) => json({ ok: true, data },status);
    if (reply) {
      // Replies are the person's instructions. Board-only credentials cannot invent them.
      if (p.agentId) return unauthorized();
      const audioId = decodeURIComponent(reply[1]);
      if (method === "GET") return ok(await listAssignments(env,p,{ audioId, all:true, after:Number(url.searchParams.get("after") ?? 0) }));
      if (method === "POST") {
        const { input, voice } = await replyInput(request);
        return ok({ assignment: await createAudioReply(env,p.userId,audioId,input,voice) },201);
      }
    }
    if (path === "/api/assignments/agents" && method === "GET") {
      if (p.agentId) return unauthorized();
      return ok({ agents: await listReplyAgents(env,p.userId) });
    }
    if (path === "/api/assignments/connections") {
      if(method === "GET")return ok({connections:await listConnections(env,p)});
      if(method === "POST")return ok({connection:await createConnection(env,p,await jsonBody(request))},201);
    }
    if (path === "/api/agent-runtimes" && method === "POST") return ok({ runtime: await registerRuntime(env,p,await jsonBody(request)) });
    if (path === "/api/assignments" && method === "GET") return ok(await listAssignments(env,p,{
      runtimeId:url.searchParams.get("runtime_id") ?? undefined, after:Number(url.searchParams.get("after") ?? 0), limit:Number(url.searchParams.get("limit") ?? 25), all:url.searchParams.get("state") === "all",
    }));
    const item = /^\/api\/assignments\/([a-f0-9-]+)(?:\/(claim|update|voice))?$/.exec(path);
    if (item) {
      const [,id,action] = item;
      if (!action && method === "GET") {
        const assignment = await getAssignment(env,p,id);
        return assignment ? ok({ assignment }) : json({ok:false,error:"Assignment not found"},404);
      }
      if (action === "voice" && (method === "GET" || method === "HEAD")) {
        const voice = await getAssignmentVoice(env,p,id);
        return voice ? new Response(method === "HEAD" ? null : voice.object.body, { headers: { "Content-Type":voice.mime, "Content-Length":String(voice.object.size), "Cache-Control":"private, no-store", "X-Content-Type-Options":"nosniff" } }) : json({ok:false,error:"Recording not found"},404);
      }
      if (method === "POST") {
        const body = await jsonBody(request);
        if (action === "claim") {
          if (typeof body.runtime_id !== "string") throw new AssignmentError("runtime_id is required");
          return ok(await claimAssignment(env,p,id,body.runtime_id));
        }
        if (action === "update") return ok({ assignment: await updateAssignment(env,p,id,body) });
      }
    }
    return json({ok:false,error:"Not found"},404);
  } catch (error) { if (error instanceof URIError) return json({ok:false,error:"Invalid path"},400); return assignmentError(error); }
}
