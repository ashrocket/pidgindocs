import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../core/types";
import { sha256Hex } from "../core/auth-utils";
import { handleAssignments } from "../core/assignments/routes";
import { handleMcp } from "../core/routes/mcp";
import { assignmentCatalogs } from "../core/assignments/i18n";
import { createAudioReply, createConnection, listConnections, registerRuntime, listAssignments, claimAssignment, updateAssignment, getAssignment, type AssignmentPrincipal } from "../core/assignments/store";

const env = { ...bindings, WORKER_URL: "https://example.test", ENTRA_ONLY: "false" } as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

async function setup() {
  const userId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users(id,email,status) VALUES(?,?,'active')").bind(userId, `${userId}@example.test`).run();
  const audioId = `aud_${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO audio_items(id,user_id,title,kind,status) VALUES(?,?,'Project overview','narration','ready')").bind(audioId, userId).run();
  const principal: AssignmentPrincipal = { userId, agentId: null };
  const input = { client_id: crypto.randomUUID(), text: "Please follow up on the migration", playback_seconds: 42, target: "auto" };
  const runtime = async (target = "interactive", modalities = ["text"], connection?: {id:string;execution_ref:string}) => registerRuntime(env, principal, { session_id: crypto.randomUUID(), name: "Test Codex", target, modalities, connection_id:connection?.id, execution_ref:connection?.execution_ref });
  return { userId, audioId, principal, input, runtime };
}

describe("durable audio assignments", () => {
  it("has a stored label for every supported language", () => {
    for (const catalog of Object.values(assignmentCatalogs)) {
      expect(Object.keys(catalog)).toEqual(Object.keys(assignmentCatalogs.en));
      expect(Object.values(catalog).every(value=>typeof value === "string" && value.length>0)).toBe(true);
    }
  });

  it("preserves overview context but keeps it out of routine queue polls", async () => {
    const a=await setup(), key=`test-context/${a.audioId}`;
    await env.DOCS.put(key,"The migration needs a staging rehearsal.");
    await env.DB.prepare("UPDATE audio_items SET transcript_key=? WHERE id=?").bind(key,a.audioId).run();
    const task=await createAudioReply(env,a.userId,a.audioId,a.input);
    expect(task.context_text).toBe("The migration needs a staging rehearsal.");
    await env.DB.prepare("DELETE FROM audio_items WHERE id=?").bind(a.audioId).run();
    expect((await getAssignment(env,a.principal,task.id))?.context_text).toBe(task.context_text);
    expect((await listAssignments(env,a.principal)).items[0]).not.toHaveProperty("context_text");
  });

  it("saves an offline reply once and rejects an altered retry", async () => {
    const a = await setup();
    const one = await createAudioReply(env, a.userId, a.audioId, a.input);
    expect(one).toMatchObject({ status: "queued", text: a.input.text, playback_seconds: 42, audio_title: "Project overview" });
    expect((await createAudioReply(env, a.userId, a.audioId, a.input)).id).toBe(one.id);
    await expect(createAudioReply(env, a.userId, a.audioId, { ...a.input, text: "changed" })).rejects.toMatchObject({ status: 409 });
    expect((await listAssignments(env, a.principal)).items.map(x => x.id)).toEqual([one.id]);
  });

  it("never reads or mutates another person's audio or assignments", async () => {
    const a = await setup(), b = await setup();
    await expect(createAudioReply(env, b.userId, a.audioId, b.input)).rejects.toMatchObject({ status: 404 });
    const task = await createAudioReply(env, a.userId, a.audioId, a.input);
    expect(await getAssignment(env, b.principal, task.id)).toBeNull();
    expect((await listAssignments(env, b.principal)).items).toEqual([]);
    const rt = await b.runtime();
    await expect(claimAssignment(env, b.principal, task.id, rt.id)).rejects.toMatchObject({ status: 404 });
  });

  it("lets one concurrent claimant win, rejects a foreign token, and returns the answer", async () => {
    const a = await setup(), task = await createAudioReply(env, a.userId, a.audioId, a.input);
    const first = await a.runtime(), second = await a.runtime();
    const results = await Promise.allSettled([claimAssignment(env, a.principal, task.id, first.id), claimAssignment(env, a.principal, task.id, second.id)]);
    expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
    const win = results.find(x => x.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof claimAssignment>>>;
    await expect(updateAssignment(env, a.principal, task.id, { action: "complete", lease_token: "wrong", result: "Forged" })).rejects.toMatchObject({ status: 409 });
    await updateAssignment(env, a.principal, task.id, { action: "complete", lease_token: win.value.lease_token, result: "Migration tested and ready", session_ref: "codex:local-session" });
    const saved = await getAssignment(env, a.principal, task.id);
    expect(saved).toMatchObject({ status: "completed", result: "Migration tested and ready", session_ref: "codex:local-session" });
    expect(saved).not.toHaveProperty("lease_token");
    expect((await listAssignments(env, a.principal)).items).toEqual([]);
  });

  it("reclaims expired work but never automatically repeats an external dispatch", async () => {
    const a = await setup(), task = await createAudioReply(env, a.userId, a.audioId, a.input), rt = await a.runtime();
    const first = await claimAssignment(env, a.principal, task.id, rt.id);
    await env.DB.prepare("UPDATE agent_assignments SET lease_expires_at=0 WHERE id=?").bind(task.id).run();
    const second = await claimAssignment(env, a.principal, task.id, rt.id);
    expect(second.lease_token).not.toBe(first.lease_token);
    await expect(updateAssignment(env, a.principal, task.id, { action: "complete", lease_token: first.lease_token, result: "Stale" })).rejects.toMatchObject({ status: 409 });
    await updateAssignment(env, a.principal, task.id, { action: "dispatch", lease_token: second.lease_token, session_ref: "attempt:test-1" });
    await env.DB.prepare("UPDATE agent_assignments SET lease_expires_at=0 WHERE id=?").bind(task.id).run();
    await expect(claimAssignment(env, a.principal, task.id, rt.id)).rejects.toMatchObject({ status: 409 });
    expect((await listAssignments(env, a.principal)).items[0].status).toBe("dispatched");
    // The original dispatcher may reconcile the launched job after its lease expired.
    await updateAssignment(env, a.principal, task.id, { action: "complete", lease_token: second.lease_token, result: "Cloud task completed" });
  });

  it("respects execution preference, modalities, runtime freshness, and deferral", async () => {
    const a = await setup();
    const connection = await createConnection(env,a.principal,{name:"Project cloud",target:"cloud",execution_ref:"env-project",context_notes:"Use the project migration plan."});
    const task = await createAudioReply(env, a.userId, a.audioId, { ...a.input, target: "cloud", connection_id:connection.id });
    const local = await a.runtime(), cloud = await a.runtime("cloud",["text"],connection);
    await expect(claimAssignment(env, a.principal, task.id, local.id)).rejects.toMatchObject({ status: 409 });
    await env.DB.prepare("UPDATE agent_runtimes SET expires_at=0 WHERE id=?").bind(cloud.id).run();
    await expect(claimAssignment(env, a.principal, task.id, cloud.id)).rejects.toMatchObject({ status: 409 });
    const fresh = await a.runtime("cloud",["text"],connection), claim = await claimAssignment(env, a.principal, task.id, fresh.id);
    await updateAssignment(env, a.principal, task.id, { action: "defer", lease_token: claim.lease_token, reason: "Cloud temporarily unavailable", retry_after_seconds: 60 });
    expect((await getAssignment(env, a.principal, task.id))?.status).toBe("queued");
    await expect(claimAssignment(env, a.principal, task.id, fresh.id)).rejects.toMatchObject({ status: 409 });
  });

  it("preserves a voice reply without transcription and requires a voice-capable runtime", async () => {
    const a = await setup();
    const bytes = new TextEncoder().encode("recorded voice fixture");
    const task = await createAudioReply(env, a.userId, a.audioId, { ...a.input, text: "" }, { bytes, mime: "audio/webm" });
    expect(task).toMatchObject({ text: null, voice_mime: "audio/webm", voice_size: bytes.length });
    expect(task.voice_url).toBe(`/api/assignments/${task.id}/voice`);
    expect(task).not.toHaveProperty("voice_key");
    const key = await env.DB.prepare("SELECT voice_key FROM agent_assignments WHERE id=?").bind(task.id).first<{voice_key:string}>();
    expect(await (await env.DOCS.get(key!.voice_key))!.text()).toBe("recorded voice fixture");
    const textRuntime = await a.runtime(), voiceRuntime = await a.runtime("interactive", ["text", "voice"]);
    await expect(claimAssignment(env, a.principal, task.id, textRuntime.id)).rejects.toMatchObject({ status: 409 });
    expect((await claimAssignment(env, a.principal, task.id, voiceRuntime.id)).assignment.id).toBe(task.id);
  });

  it("isolates targeted agents, rechecks revocation, and exposes tasks in the agent inbox", async () => {
    const a = await setup(), team = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO teams(id,slug,name,owner_user_id) VALUES(?,?,'Test',?)").bind(team,team,a.userId).run();
    await env.DB.prepare("INSERT INTO team_memberships(team_id,user_id,role) VALUES(?,?,'owner')").bind(team,a.userId).run();
    async function agent() {
      const id = crypto.randomUUID(), key = `pidgin_abk_${await sha256Hex(crypto.randomUUID())}`;
      await env.DB.prepare("INSERT INTO agent_identities(id,team_id,slug,name,created_by_user_id) VALUES(?,?,?,'Test agent',?)").bind(id,team,id,a.userId).run();
      await env.DB.prepare("INSERT INTO agent_keys(key_hash,key_prefix,agent_id,created_by_user_id) VALUES(?,'test',?,?)").bind(await sha256Hex(key),id,a.userId).run();
      return { p:{userId:a.userId,agentId:id}, key };
    }
    const one = await agent(), two = await agent();
    const task = await createAudioReply(env,a.userId,a.audioId,{...a.input,agent_id:one.p.agentId});
    expect((await listAssignments(env,two.p)).items).toEqual([]);
    const rpc = async (name: string, args = {}) => (await handleMcp(new Request("https://example.test/mcp",{method:"POST",headers:{Authorization:`Agent ${one.key}`,"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})}),env)).json<any>();
    const inbox = await rpc("pidgin_agent_inbox");
    expect(inbox, JSON.stringify(inbox)).toHaveProperty("result");
    expect(inbox.result.structuredContent.data.assignments.items[0].id).toBe(task.id);
    const registered = await rpc("pidgin_register_agent_runtime",{session_id:"test-session",name:"Codex",target:"interactive",modalities:["text"]});
    const claimed = await rpc("pidgin_claim_assignment",{assignment_id:task.id,runtime_id:registered.result.structuredContent.data.runtime.id});
    expect(claimed.result.isError).toBe(false);
    await env.DB.prepare("UPDATE agent_identities SET status='revoked' WHERE id=?").bind(one.p.agentId).run();
    expect((await listAssignments(env,one.p)).items).toEqual([]);
    await expect(updateAssignment(env,one.p,task.id,{action:"complete",lease_token:claimed.result.structuredContent.data.lease_token,result:"revoked"})).rejects.toMatchObject({status:404});
    const unauthorized = await handleAssignments(new Request("https://example.test/api/assignments",{headers:{Authorization:`Agent ${one.key}`}}),env,"/api/assignments");
    expect(unauthorized?.status).toBe(401);
  });

  it("accepts web recordings with a base path and refuses cross-origin mutation", async () => {
    const a = await setup(), session = crypto.randomUUID();
    await env.SESSIONS.put(`session:${session}`,`${a.userId}@example.test`);
    const path = `/api/audio/${a.audioId}/replies`;
    const form = new FormData();
    form.set("client_id",a.input.client_id); form.set("playback_seconds","12.5");
    form.set("voice",new Blob(["voice"],{type:"audio/webm"}),"reply.webm");
    const request = new Request(`https://example.test/alice${path}`,{method:"POST",headers:{Cookie:`session=${session}`,Origin:"https://example.test"},body:form});
    const response = await handleAssignments(request,env,path);
    expect(response?.status).toBe(201);
    const {data} = await response!.json<any>();
    expect(data.assignment).toMatchObject({voice_size:5,playback_seconds:12.5});
    const voice = await handleAssignments(new Request(`https://example.test${data.assignment.voice_url}`,{headers:{Cookie:`session=${session}`}}),env,data.assignment.voice_url);
    expect(new TextDecoder().decode(await voice!.arrayBuffer())).toBe("voice");
    const denied = await handleAssignments(new Request(`https://example.test${path}`,{method:"POST",headers:{Cookie:`session=${session}`,Origin:"https://foreign.test"},body:JSON.stringify(a.input)}),env,path);
    expect(denied?.status).toBe(403);
    expect((await handleAssignments(new Request(`https://example.test${data.assignment.voice_url}`),env,data.assignment.voice_url))?.status).toBe(401);
  });

  it("refuses oversized bodies even without Content-Length", async () => {
    const a = await setup(), session = crypto.randomUUID();
    await env.SESSIONS.put(`session:${session}`,`${a.userId}@example.test`);
    const path = `/api/audio/${a.audioId}/replies`;
    const response = await handleAssignments(new Request(`https://example.test${path}`,{method:"POST",headers:{Cookie:`session=${session}`,"Content-Type":"application/json"},body:JSON.stringify({...a.input,text:"x".repeat(100001)})}),env,path);
    expect(response?.status).toBe(413);
  });

  it("bounds input and rejects spoofed assignment targets", async () => {
    const a = await setup();
    for (const input of [{ ...a.input, text: "" }, { ...a.input, playback_seconds: -1 }, { ...a.input, target: "somewhere" }, { ...a.input, agent_id: "foreign-agent" }, { ...a.input, text: "a".repeat(20001) }]) {
      await expect(createAudioReply(env, a.userId, a.audioId, input)).rejects.toBeDefined();
    }
    expect((await listAssignments(env, a.principal)).items).toEqual([]);
  });

  it("keeps execution connections private and routes only to the selected project", async () => {
    const a=await setup(),b=await setup();
    const duva=await createConnection(env,a.principal,{name:"Duva cloud",target:"cloud",execution_ref:"env-duva",context_notes:"Repository: ashrocket/duva; follow AGENTS.md."});
    const other=await createConnection(env,a.principal,{name:"Other project",target:"cloud",execution_ref:"env-other"});
    expect((await listConnections(env,b.principal))).toEqual([]);
    await expect(createAudioReply(env,b.userId,b.audioId,{...b.input,target:"cloud",connection_id:duva.id})).rejects.toMatchObject({status:404});
    await expect(createAudioReply(env,a.userId,a.audioId,{...a.input,target:"cloud"})).rejects.toMatchObject({status:400});
    await expect(a.runtime("cloud",["text"],{...duva,execution_ref:"env-other"})).rejects.toMatchObject({status:409});
    const task=await createAudioReply(env,a.userId,a.audioId,{...a.input,target:"cloud",connection_id:duva.id});
    expect(task).toMatchObject({connection_id:duva.id,connection_name:"Duva cloud",connection_context:duva.context_notes});
    const wrong=await a.runtime("cloud",["text"],other);
    expect((await listAssignments(env,a.principal,{runtimeId:wrong.id})).items).toEqual([]);
    await expect(claimAssignment(env,a.principal,task.id,wrong.id)).rejects.toMatchObject({status:409});
    const right=await a.runtime("cloud",["text"],duva);
    expect((await claimAssignment(env,a.principal,task.id,right.id)).assignment.id).toBe(task.id);
    const unscoped=await createAudioReply(env,a.userId,a.audioId,{...a.input,client_id:crypto.randomUUID()});
    await expect(claimAssignment(env,a.principal,unscoped.id,right.id)).rejects.toMatchObject({status:409});
  });
});
