import { agentSponsorAccessSql } from "../agent-access";
import { sha256Hex } from "../auth-utils";
import { lookupAudio } from "../audio/service";
import { isValidAudioId } from "../audio/store";
import { editionAccountActiveSql, reserveEditionUsage, releaseEditionUsage } from "../edition-hooks";
import type { Env } from "../types";

export class AssignmentError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export interface AssignmentPrincipal { userId: string; agentId: string | null }
export type ExecutionTarget = "auto" | "local" | "cloud" | "interactive";
export const MAX_REPLY_TEXT = 20_000;
export const MAX_VOICE_BYTES = 10 * 1024 * 1024;
export const LEASE_SECONDS = 300;
const RUNTIME_SECONDS = 120;
const VOICE_MIMES = new Set(["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/aac"]);

interface AssignmentRow {
  seq: number; id: string; user_id: string; agent_id: string | null; client_id: string; request_hash: string;
  audio_id: string; audio_title: string; source_message_id: string | null; playback_seconds: number;
  context_text: string | null; context_truncated: number;
  connection_id: string | null; connection_name: string | null; connection_context: string | null;
  text: string | null; voice_key: string | null; voice_mime: string | null; voice_size: number | null;
  target: ExecutionTarget; status: "queued" | "claimed" | "dispatched" | "completed" | "cancelled";
  runtime_id: string | null; lease_token: string | null; lease_expires_at: number | null;
  attempts: number; available_at: number; reason: string | null; result: string | null; session_ref: string | null;
  created_at: string; updated_at: string;
}
export type Assignment = Omit<AssignmentRow, "user_id" | "request_hash" | "voice_key" | "lease_token"> & { voice_url: string | null };
interface RuntimeRow {
  id: string; user_id: string; agent_id: string | null; principal_ref: string;
  session_id: string; name: string; target: Exclude<ExecutionTarget, "auto">; modalities: string; expires_at: number;
  connection_id: string | null;
}
export interface AgentConnection { id:string; name:string; target:"local"|"cloud"; execution_ref:string; context_notes:string|null; created_at:string }
export const principalRef = (p: AssignmentPrincipal) => p.agentId ? `agent:${p.agentId}` : `user:${p.userId}`;
const now = () => Math.floor(Date.now() / 1000);
const view = ({ user_id: _u, request_hash: _h, voice_key, lease_token: _t, ...row }: AssignmentRow): Assignment => ({
  ...row, voice_url: voice_key ? `/api/assignments/${row.id}/voice` : null,
});
export function field(value: unknown, name: string, max: number, required = false): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new AssignmentError(`${name} is required`);
    return null;
  }
  if (typeof value !== "string" || value.length > max || !value.trim()) throw new AssignmentError(`Invalid ${name}`);
  return value.trim();
}
export function target(value: unknown, auto = true): ExecutionTarget {
  if (auto && value === undefined) return "auto";
  if ([...(auto ? ["auto"] : []), "local", "cloud", "interactive"].includes(value as string)) return value as ExecutionTarget;
  throw new AssignmentError("Invalid execution target");
}

// Rechecked inside reads and conditional writes. A runtime never grants access.
function live(env: Env, p: AssignmentPrincipal) {
  const sql = `EXISTS (SELECT 1 FROM users owner WHERE owner.id = ? AND owner.status = 'active'
    AND ${editionAccountActiveSql("owner")}${p.agentId ? ` AND EXISTS (
      SELECT 1 FROM agent_identities a JOIN team_memberships m ON m.team_id=a.team_id AND m.user_id=owner.id
      WHERE a.id=? AND a.created_by_user_id=owner.id AND a.kind='agent' AND a.status='active'
      AND ${agentSponsorAccessSql(env)})` : ""})`;
  return { sql, binds: p.agentId ? [p.userId, p.agentId] : [p.userId] };
}
function scope(env: Env, p: AssignmentPrincipal) {
  const l = live(env, p);
  return { sql: `user_id=?${p.agentId ? " AND (agent_id IS NULL OR agent_id=?)" : ""} AND ${l.sql}`,
    binds: [p.userId, ...(p.agentId ? [p.agentId] : []), ...l.binds] };
}
async function rowFor(env: Env, p: AssignmentPrincipal, id: string): Promise<AssignmentRow | null> {
  const s = scope(env, p);
  return env.DB.prepare(`SELECT * FROM agent_assignments WHERE id=? AND ${s.sql}`).bind(id, ...s.binds).first<AssignmentRow>();
}
export async function getAssignment(env: Env, p: AssignmentPrincipal, id: string): Promise<Assignment | null> {
  const row = await rowFor(env, p, id);
  return row ? view(row) : null;
}
export async function getAssignmentVoice(env: Env, p: AssignmentPrincipal, id: string) {
  const row = await rowFor(env, p, id);
  if (!row?.voice_key) return null;
  const object = await env.DOCS.get(row.voice_key);
  return object ? { object, mime: row.voice_mime! } : null;
}

export async function listReplyAgents(env: Env, userId: string) {
  const { results } = await env.DB.prepare(`SELECT a.id, a.name, a.provider FROM agent_identities a
    JOIN users owner ON owner.id=a.created_by_user_id AND owner.status='active'
    JOIN team_memberships m ON m.team_id=a.team_id AND m.user_id=owner.id
    WHERE a.created_by_user_id=? AND a.kind='agent' AND a.status='active' AND ${agentSponsorAccessSql(env)}
    ORDER BY a.name,a.id`).bind(userId).all<{ id: string; name: string; provider: string | null }>();
  return results;
}

export async function listConnections(env: Env, p: AssignmentPrincipal): Promise<AgentConnection[]> {
  const l=live(env,p);
  const {results}=await env.DB.prepare(`SELECT id,name,target,execution_ref,context_notes,created_at FROM agent_connections WHERE user_id=? AND enabled=1 AND ${l.sql} ORDER BY name,id`).bind(p.userId,...l.binds).all<AgentConnection>();
  return results;
}
export async function createConnection(env: Env, p: AssignmentPrincipal, input: Record<string,unknown>): Promise<AgentConnection> {
  if(p.agentId)throw new AssignmentError("Only the user can configure execution connections",403);
  const name=field(input.name,"name",100,true)!, execution=target(input.target,false);
  if(execution!=="cloud"&&execution!=="local")throw new AssignmentError("A connection must use cloud or local execution");
  const ref=field(input.execution_ref,"execution_ref",500,true)!, context=field(input.context_notes,"context_notes",6000);
  if(execution==="cloud"&&!/^[A-Za-z0-9_-]{3,160}$/.test(ref))throw new AssignmentError("Invalid cloud environment ID");
  if(execution==="local"&&(!ref.startsWith("/")||/[\r\n\0]/.test(ref)))throw new AssignmentError("Use an absolute local project path");
  const l=live(env,p),id=crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO agent_connections(id,user_id,name,target,execution_ref,context_notes)
    SELECT ?,?,?,?,?,? WHERE ${l.sql} ON CONFLICT(user_id,target,execution_ref) DO NOTHING`).bind(id,p.userId,name,execution,ref,context,...l.binds).run();
  const row=(await listConnections(env,p)).find(c=>c.target===execution&&c.execution_ref===ref);
  if(!row)throw new AssignmentError("Connection could not be saved",403);
  if(row.name!==name||row.context_notes!==context)throw new AssignmentError("This environment already has a connection",409);
  return row;
}

export async function createAudioReply(env: Env, userId: string, audioId: string, input: Record<string, unknown>, voice?: { bytes: Uint8Array; mime: string }): Promise<Assignment> {
  if (!isValidAudioId(audioId)) throw new AssignmentError("Audio not found", 404);
  const clientId = field(input.client_id, "client_id", 80, true)!;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/.test(clientId)) throw new AssignmentError("Invalid client_id");
  const text = field(input.text, "text", MAX_REPLY_TEXT);
  const agentId = field(input.agent_id, "agent_id", 64);
  const execution = target(input.target);
  const connectionId = field(input.connection_id,"connection_id",64);
  const position = input.playback_seconds ?? 0;
  if (typeof position !== "number" || !Number.isFinite(position) || position < 0 || position > 604800) throw new AssignmentError("Invalid playback_seconds");
  if (!text && !voice) throw new AssignmentError("A text or voice response is required");
  if (voice && (!VOICE_MIMES.has(voice.mime) || !voice.bytes.length || voice.bytes.length > MAX_VOICE_BYTES)) throw new AssignmentError("Invalid or oversized recording", 413);
  const voiceHash = voice ? await crypto.subtle.digest("SHA-256", voice.bytes as Uint8Array<ArrayBuffer>).then(b => Array.from(new Uint8Array(b), v => v.toString(16).padStart(2,"0")).join("")) : null;
  const hash = await sha256Hex(JSON.stringify([text, agentId, execution, connectionId, position, voice?.mime ?? null, voiceHash]));
  const previous = await env.DB.prepare("SELECT * FROM agent_assignments WHERE user_id=? AND audio_id=? AND client_id=?").bind(userId, audioId, clientId).first<AssignmentRow>();
  if (previous) {
    if (previous.request_hash !== hash) throw new AssignmentError("This reply key was already used for different content", 409);
    return view(previous);
  }
  const source = await lookupAudio(env, userId, audioId, false);
  if (!source) throw new AssignmentError("Audio not found", 404);
  if (agentId && !(await listReplyAgents(env, userId)).some(a => a.id === agentId)) throw new AssignmentError("Agent not found", 404);
  const connection=connectionId ? (await listConnections(env,{userId,agentId:null})).find(c=>c.id===connectionId) : null;
  if(connectionId&&!connection)throw new AssignmentError("Connection not found",404);
  if((execution==="local"||execution==="cloud")&&!connection)throw new AssignmentError("Choose a project connection for this execution target");
  if(connection&&execution!==connection.target)throw new AssignmentError("Connection and execution target do not match");
  const transcriptKey = source.legacy ? source.transcriptKey : source.row.transcript_key;
  // Preserve what the person was hearing, even if the source audio is later removed.
  const transcriptObject=transcriptKey ? await env.DOCS.get(transcriptKey,{range:{offset:0,length:120_004}}) : null;
  const transcript = await transcriptObject?.text() ?? null;
  const context = transcript?.slice(0,30_000) ?? null;
  const id = crypto.randomUUID();
  // Unique object per attempt: a losing concurrent request can remove ONLY its own upload.
  const voiceKey = voice ? `agent-replies/${userId}/${id}` : null;
  if (voiceKey && voice) {
    const reserved = (await reserveEditionUsage(env,userId,"storage_bytes",voice.bytes.length,`agent-reply:${id}:storage`)).managed;
    try { await env.DOCS.put(voiceKey, voice.bytes as Uint8Array<ArrayBuffer>, { httpMetadata: { contentType: voice.mime } }); }
    catch (error) {
      if (reserved) await releaseEditionUsage(env,userId,"storage_bytes",voice.bytes.length,`agent-reply:${id}:rollback`).catch(()=>{});
      throw error;
    }
  }
  let row: AssignmentRow | null;
  try {
    await env.DB.prepare(`INSERT INTO agent_assignments
      (id,user_id,agent_id,client_id,request_hash,audio_id,audio_title,source_message_id,context_text,context_truncated,connection_id,connection_name,connection_context,playback_seconds,text,voice_key,voice_mime,voice_size,target)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,audio_id,client_id) DO NOTHING`)
      .bind(id,userId,agentId,clientId,hash,audioId,source.item.title,source.item.source_message_id,context,transcript && transcript.length>30_000 ? 1 : 0,connectionId,connection?.name??null,connection?.context_notes??null,position,text,voiceKey,voice?.mime ?? null,voice?.bytes.length ?? null,execution).run();
    row = await env.DB.prepare("SELECT * FROM agent_assignments WHERE user_id=? AND audio_id=? AND client_id=?").bind(userId,audioId,clientId).first<AssignmentRow>();
  } catch (error) {
    // D1 may have committed even if its acknowledgement was lost. Preserve the recording
    // until its owning row can be read; orphan cleanup must reconcile ownership first.
    throw error;
  }
  if (!row) throw new Error("Saved reply could not be read");
  if (voiceKey && voice && row.id !== id) {
    await env.DOCS.delete(voiceKey);
    await releaseEditionUsage(env,userId,"storage_bytes",voice.bytes.length,`agent-reply:${id}:rollback`).catch(()=>{});
  }
  if (row.request_hash !== hash) throw new AssignmentError("This reply key was already used for different content", 409);
  return view(row);
}

export async function registerRuntime(env: Env, p: AssignmentPrincipal, input: Record<string, unknown>) {
  const session = field(input.session_id, "session_id", 160, true)!;
  const name = field(input.name, "name", 100, true)!;
  const execution = target(input.target, false);
  const connectionId=field(input.connection_id,"connection_id",64), executionRef=field(input.execution_ref,"execution_ref",500);
  const connection=connectionId ? (await listConnections(env,p)).find(c=>c.id===connectionId) : null;
  if(execution!=="interactive"&&(!connection||connection.target!==execution||connection.execution_ref!==executionRef))throw new AssignmentError("Runtime does not match a configured project connection",409);
  if(execution==="interactive"&&(connectionId||executionRef))throw new AssignmentError("Interactive runtimes do not use an execution connection");
  const modalities = input.modalities;
  if (!Array.isArray(modalities) || !modalities.length || modalities.length > 2 || modalities.some(m => m !== "text" && m !== "voice")) throw new AssignmentError("modalities must contain text or voice");
  const l = live(env, p), id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO agent_runtimes(id,user_id,agent_id,principal_ref,session_id,name,target,connection_id,modalities,expires_at)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${l.sql}
    ON CONFLICT(principal_ref,session_id) DO UPDATE SET name=excluded.name,target=excluded.target,connection_id=excluded.connection_id,modalities=excluded.modalities,expires_at=excluded.expires_at,updated_at=datetime('now')`)
    .bind(id,p.userId,p.agentId,principalRef(p),session,name,execution,connectionId,JSON.stringify([...new Set(modalities)]),now()+RUNTIME_SECONDS,...l.binds).run();
  const row = await env.DB.prepare(`SELECT * FROM agent_runtimes WHERE principal_ref=? AND session_id=? AND ${l.sql}`).bind(principalRef(p),session,...l.binds).first<RuntimeRow>();
  if (!row) throw new AssignmentError("Runtime registration refused", 403);
  return { id: row.id, session_id: row.session_id, name: row.name, target: row.target, connection_id:row.connection_id, modalities: JSON.parse(row.modalities) as string[], expires_at: row.expires_at };
}
async function runtimeFor(env: Env, p: AssignmentPrincipal, id: string): Promise<RuntimeRow> {
  const l = live(env,p);
  const row = await env.DB.prepare(`SELECT * FROM agent_runtimes WHERE id=? AND principal_ref=? AND expires_at>? AND ${l.sql}`).bind(id,principalRef(p),now(),...l.binds).first<RuntimeRow>();
  if (!row) throw new AssignmentError("Runtime is unavailable; register or heartbeat it first",409);
  return row;
}
function compatible(rt: RuntimeRow) {
  // A recording with a transcript is usable by a text-only runtime; the original stays available.
  const modes = JSON.parse(rt.modalities) as string[];
  return { sql: `(target='auto' OR target=?) AND connection_id IS ? AND (${modes.includes("text") ? "text IS NOT NULL" : "0"} OR ${modes.includes("voice") ? "voice_key IS NOT NULL" : "0"})
    AND (connection_id IS NULL OR EXISTS (SELECT 1 FROM agent_connections c WHERE c.id=agent_assignments.connection_id AND c.user_id=agent_assignments.user_id AND c.enabled=1))`, binds: [rt.target,rt.connection_id] };
}
export async function listAssignments(env: Env, p: AssignmentPrincipal, options: { audioId?: string; runtimeId?: string; all?: boolean; after?: number; limit?: number } = {}) {
  const s = scope(env,p), where = [s.sql], binds: unknown[] = [...s.binds];
  const limit = options.limit ?? 25, after = options.after ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(after) || after < 0) throw new AssignmentError("Invalid assignment page");
  if (!options.all) where.push("status IN ('queued','claimed','dispatched')");
  if (options.audioId) { where.push("audio_id=?"); binds.push(options.audioId); }
  if (options.runtimeId) {
    const c = compatible(await runtimeFor(env,p,options.runtimeId)); where.push(c.sql); binds.push(...c.binds);
    where.push("((status='queued' AND available_at<=?) OR (status='claimed' AND lease_expires_at<=?))"); binds.push(now(),now());
  }
  where.push("seq>?"); binds.push(after);
  const { results } = await env.DB.prepare(`SELECT * FROM agent_assignments WHERE ${where.join(" AND ")} ORDER BY seq LIMIT ?`).bind(...binds,limit+1).all<AssignmentRow>();
  // The full context is available on get/claim; keep regular inbox polls bounded.
  return { items: results.slice(0,limit).map(row=>{const {context_text:_context,...item}=view(row);return item;}), next_cursor: results.length>limit ? results[limit-1].seq : null };
}
export async function claimAssignment(env: Env, p: AssignmentPrincipal, id: string, runtimeId: string) {
  if (!await rowFor(env,p,id)) throw new AssignmentError("Assignment not found",404);
  const rt = await runtimeFor(env,p,runtimeId), c = compatible(rt), s = scope(env,p);
  const token = crypto.randomUUID(), timestamp = now();
  const row = await env.DB.prepare(`UPDATE agent_assignments SET status='claimed',runtime_id=?,lease_token=?,lease_expires_at=?,attempts=attempts+1,reason=NULL,updated_at=datetime('now')
    WHERE id=? AND ${s.sql} AND ${c.sql} AND ((status='queued' AND available_at<=?) OR (status='claimed' AND lease_expires_at<=?))
    AND EXISTS (SELECT 1 FROM agent_runtimes WHERE id=? AND principal_ref=? AND expires_at>?) RETURNING *`)
    .bind(runtimeId,token,timestamp+LEASE_SECONDS,id,...s.binds,...c.binds,timestamp,timestamp,runtimeId,principalRef(p),timestamp).first<AssignmentRow>();
  if (!row) throw new AssignmentError("Assignment is busy, deferred, dispatched, or incompatible with this runtime",409);
  return { assignment: view(row), lease_token: token, lease_seconds: LEASE_SECONDS };
}

export async function updateAssignment(env: Env, p: AssignmentPrincipal, id: string, input: Record<string, unknown>): Promise<Assignment> {
  const token = field(input.lease_token,"lease_token",160,true)!;
  const action = input.action, s = scope(env,p), timestamp = now();
  if (!["renew","defer","dispatch","complete"].includes(action as string)) throw new AssignmentError("Invalid assignment action");
  const existing = await rowFor(env,p,id);
  if (!existing) throw new AssignmentError("Assignment not found",404);
  const result = field(input.result,"result",MAX_REPLY_TEXT,action === "complete");
  const reference = field(input.session_ref,"session_ref",500,action === "dispatch");
  const reason = field(input.reason,"reason",1000,action === "defer");
  const retry = input.retry_after_seconds ?? 60;
  if (!Number.isSafeInteger(retry) || (retry as number) < 0 || (retry as number) > 86400) throw new AssignmentError("Invalid retry_after_seconds");
  if (existing.lease_token === token && action === "complete" && existing.status === "completed" && existing.result === result && (!reference || existing.session_ref === reference)) return view(existing);
  let sets = "lease_expires_at=?,updated_at=datetime('now')";
  const values: unknown[] = [timestamp+LEASE_SECONDS];
  if (action === "complete") { sets += ",status='completed',result=?,session_ref=COALESCE(?,session_ref),reason=NULL"; values.push(result,reference); }
  if (action === "dispatch") { sets += ",status='dispatched',session_ref=?"; values.push(reference); }
  if (action === "defer") { sets += ",status='queued',runtime_id=NULL,lease_token=NULL,lease_expires_at=NULL,reason=?,available_at=?"; values.push(reason,timestamp+(retry as number)); }
  // Dispatch must be reconciled by its original claimant, even after a crash/expired lease.
  // It cannot be deferred and automatically launched a second time.
  const state = action === "defer" ? "status='claimed' AND lease_expires_at>?" : "((status='claimed' AND lease_expires_at>?) OR status='dispatched')";
  const row = await env.DB.prepare(`UPDATE agent_assignments SET ${sets} WHERE id=? AND ${s.sql} AND lease_token=? AND ${state}
    AND EXISTS (SELECT 1 FROM agent_runtimes WHERE id=agent_assignments.runtime_id AND principal_ref=?) RETURNING *`)
    .bind(...values,id,...s.binds,token,timestamp,principalRef(p)).first<AssignmentRow>();
  if (!row) throw new AssignmentError("Claim expired, changed, or cannot make that transition",409);
  return view(row);
}
