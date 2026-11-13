import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../index";
import { loadArtifactVersionContent, publishArtifact, deleteArtifact, flushArtifactUploadCleanup } from "../artifacts/store";
import { sha256Hex } from "../auth-utils";
import { commitDraft, commitStaleDrafts, currentDraft, deleteDraft, deleteOldDrafts, flushDraftCleanup, putDraft, DRAFT_KEEP_MS, DRAFT_MAX_BYTES, DRAFT_MAX_RETAINED_BYTES } from "../drafts";
import { setMeterHooks, type Units } from "../meter";
import type { Env } from "../types";
const origin="https://pidgindocs.example.workers.dev";
const env={...bindings,API_KEY:"draft-test",OWNER_EMAIL:"owner@example.com",WORKER_URL:origin,ENVIRONMENT:"production"} as unknown as Env & {TEST_MIGRATIONS:D1Migration[]};
const ctx={waitUntil(){},passThroughOnException(){}} as unknown as ExecutionContext;
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
beforeEach(async()=>{setMeterHooks({});await env.DB.batch([env.DB.prepare("DELETE FROM draft_commit_keys"),env.DB.prepare("DELETE FROM draft_commits"),env.DB.prepare("DELETE FROM draft_revisions")]);});
afterEach(()=>setMeterHooks({}));
const key=()=>crypto.randomUUID().replace(/-/g,"");
const doc=(html="<p>hello</p>",more={})=>({kind:"document",title:"A draft",html,...more});
function wrap(base:Env, overrides:Record<string,(real:any,...args:any[])=>any>):Env {
  return {...base,DOCS:new Proxy(base.DOCS,{get(target,prop:string){if(overrides[prop])return(...args:any[])=>overrides[prop](target,...args);const value=(target as any)[prop];return typeof value === "function" ? value.bind(target) : value;}})};
}
async function user(){
 const id=crypto.randomUUID(),email=`${id}@example.com`,token=key();
 await env.DB.prepare("INSERT INTO users(id,email,status) VALUES(?,?,'active')").bind(id,email).run();
 await env.DB.prepare("INSERT INTO api_keys(key_hash,key_prefix,user_id) VALUES(?,?,?)").bind(await sha256Hex(token),"test",id).run();
 const call=async(method:string,path:string,body?:unknown,headers:Record<string,string>={})=>{
  const response=await worker.fetch(new Request(origin+path,{method,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",...headers},body:body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)}),env,ctx);
  return {status:response.status,units:response.headers.get("X-Pidgin-Units"),body:await response.json() as any};
 };
 return {id,email,token,call,put:(k:string,body:unknown)=>call("PUT",`/api/drafts/${k}`,body),commit:(k:string,idem?:string)=>call("POST",`/api/drafts/${k}/commit`,undefined,idem?{"Idempotency-Key":idem}:{}),
 count:async()=>((await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND type = 'document'").bind(id).first<{n:number}>())!).n};
}
function ledger(){
 const retained=new Map<string,Units>(),settled=new Set<string>();let released=0;
 setMeterHooks({reserve:async(_e,_u,units,rk)=>{if(settled.has(rk))return {ok:false};retained.set(rk,units);return {ok:true};},settle:async(_e,rk,actual)=>{if(settled.has(rk))return;settled.add(rk);if(retained.get(rk)?.draft_bytes)released++;retained.set(rk,actual);}});
 return {retained,settled,get bytes(){return [...retained.values()].reduce((n,u)=>n+(u.draft_bytes??0),0);},get commits(){return [...retained.values()].reduce((n,u)=>n+(u.draft_commit??0),0);},get released(){return released;}};
}

describe("draft revisions",()=>{
 it("replaces ten edits with one document and releases every retained byte once",async()=>{
  const u=await user(),k=key(),m=ledger();
  for(let i=0;i<10;i++)expect((await u.put(k,doc(`<p>${i}</p>`))).status).toBe(200);
  const current=await currentDraft(env,u.id,k);expect(m.bytes).toBe(current!.size_bytes);
  const r=await u.commit(k);expect(r.status).toBe(200);expect(r.units).toBe("draft_commit=1");expect(await u.count()).toBe(1);expect(await currentDraft(env,u.id,k)).toBeNull();expect(m.bytes).toBe(0);expect(m.commits).toBe(1);expect(m.released).toBe(10);
  expect((await u.commit(k)).status).toBe(404);await flushDraftCleanup(env);expect(m.released).toBe(10);
 });
 it("replays one idempotency alias and treats a later identical upload as a new revision",async()=>{
  const u=await user(),k=key();await u.put(k,doc());const a=await u.commit(k,"same");expect(a.status).toBe(200);
  expect((await u.commit(k,"same")).body).toEqual(a.body);await u.put(k,doc());expect((await u.commit(k,"same")).body).toEqual(a.body);expect(await currentDraft(env,u.id,k)).not.toBeNull();expect((await u.commit(k,"new")).status).toBe(200);expect(await u.count()).toBe(2);
 });
 it("one revision is shared by different manual keys and the idle cron",async()=>{
  const u=await user(),k=key(),m=ledger();await u.put(k,doc());let release!:()=>void,entered!:()=>void;
  const waiting=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);
  const delayed=wrap(env,{put:async(real,k,...args)=>{if(String(k).startsWith("docs/")){entered();await waiting;}return real.put(k,...args);}});
  const first=commitDraft(delayed,u.id,k,undefined,"manual-a");await ready;
  expect((await u.commit(k,"manual-b")).status).toBe(409);await commitStaleDrafts(env,0,Date.now()+60_000);release();expect((await first).status).toBe(200);expect(await u.count()).toBe(1);expect(m.commits).toBe(1);
 });
 it("preserves an edit arriving while an older revision is publishing",async()=>{
  const u=await user(),k=key();await u.put(k,doc("<p>old</p>"));let swapped=false;
  const race=wrap(env,{put:async(real,name,...args)=>{if(!swapped && String(name).startsWith("docs/")){swapped=true;await u.put(k,doc("<p>new</p>"));}return real.put(name,...args);}});
  expect((await commitDraft(race,u.id,k)).status).toBe(200);const newer=await currentDraft(env,u.id,k);expect(newer).not.toBeNull();expect(await(await env.DOCS.get(newer!.object_key))!.text()).toContain("new");expect((await u.commit(k)).status).toBe(200);expect(await u.count()).toBe(2);
 });
 it("a delayed cleanup delete cannot erase a concurrent new revision",async()=>{
  const u=await user(),k=key();await u.put(k,doc());const old=await currentDraft(env,u.id,k);let swapped=false;
  const race=wrap(env,{delete:async(real,name)=>{if(!swapped && name===old!.object_key){swapped=true;await u.put(k,doc("<p>new</p>"));}return real.delete(name);}});
  expect((await commitDraft(race,u.id,k)).status).toBe(200);const newer=await currentDraft(env,u.id,k);expect(await env.DOCS.head(newer!.object_key)).not.toBeNull();
 });
 it("retains byte accounting while R2 deletion fails, then releases it idempotently",async()=>{
  const u=await user(),k=key(),m=ledger();await u.put(k,doc());const revision=await currentDraft(env,u.id,k);
  const broken=wrap(env,{delete:async()=>{throw new Error("offline");}});expect(await deleteDraft(broken,u.id,k)).toBe(true);expect(m.bytes).toBe(revision!.size_bytes);expect(await env.DB.prepare("SELECT id FROM draft_revisions WHERE id = ?").bind(revision!.id).first()).not.toBeNull();
  await flushDraftCleanup(env);await flushDraftCleanup(env);expect(m.bytes).toBe(0);expect(m.released).toBe(1);
 });
 it("retains a failed release and retries with the same storage reservation key",async()=>{
  const u=await user(),k=key();let fail=true;const releases:string[]=[];
  setMeterHooks({settle:async(_e,rk)=>{if(rk.startsWith("draft-storage:")){releases.push(rk);if(fail)throw new Error("lost response");}}});
  await u.put(k,doc());await deleteDraft(env,u.id,k);expect(releases).toHaveLength(1);fail=false;await flushDraftCleanup(env);expect(releases).toEqual([releases[0],releases[0]]);expect((await env.DB.prepare("SELECT COUNT(*) n FROM draft_revisions WHERE owner = ?").bind(u.id).first<{n:number}>())!.n).toBe(0);
 });
 it("holds a possibly committed publication without refund or automatic replay",async()=>{
  const u=await user(),k=key(),m=ledger();await u.put(k,doc());const DB=new Proxy(env.DB,{get(target,prop:string){if(prop==="prepare")return(sql:string)=>{if(sql.startsWith("UPDATE draft_commits SET status = ?,"))throw new Error("lost receipt response");return target.prepare(sql);};const value=(target as any)[prop];return typeof value==="function"?value.bind(target):value;}});
  expect((await commitDraft({...env,DB},u.id,k)).status).toBe(503);expect(await u.count()).toBe(1);expect((await u.commit(k,"new-key")).status).toBe(409);await commitStaleDrafts(env,0,Date.now()+60_000);await deleteOldDrafts(env,Date.now()+2*DRAFT_KEEP_MS);expect(await u.count()).toBe(1);expect(m.commits).toBe(1);expect(m.bytes).toBeGreaterThan(0);expect((await env.DB.prepare("SELECT status FROM draft_commits WHERE owner = ?").bind(u.id).first<{status:string}>())!.status).toBe("held");
 });
 it("does not publish as an inactive owner or a viewer, including scheduled work",async()=>{
  const u=await user(),k=key();await u.put(k,doc());await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").bind(u.id).run();expect((await commitDraft(env,u.id,k)).status).toBe(403);await commitStaleDrafts(env,0,Date.now()+60_000);expect(await u.count()).toBe(0);
  await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(u.id).run();const team=key();await env.DB.prepare("INSERT INTO teams(id,slug,name,owner_user_id) VALUES(?,?,?,?)").bind(team,team,"Team",u.id).run();await env.DB.prepare("INSERT INTO team_memberships(team_id,user_id,role) VALUES(?,?,'viewer')").bind(team,u.id).run();await u.put(k,doc("<p>x</p>",{team_id:team}));expect((await u.commit(k)).status).toBe(403);expect(await u.count()).toBe(0);
 });
 it("rejects sibling ownership and cookie writes without same-origin proof",async()=>{
  const a=await user(),b=await user(),k=key();await a.put(k,doc());expect((await b.commit(k)).status).toBe(404);
  const session=key();await env.SESSIONS.put(`session:${session}`,a.email);
  for(const originHeader of [undefined,"https://attacker.example"]){const response=await worker.fetch(new Request(origin+`/api/drafts/${k}`,{method:"DELETE",headers:{Cookie:`session=${session}`,...(originHeader?{Origin:originHeader}:{})}}),env,ctx);expect(response.status).toBe(403);}expect(await currentDraft(env,a.id,k)).not.toBeNull();
 });
 it("bounds streamed writes and atomically caps new keys and retained bytes",async()=>{
  const u=await user(),k=key();const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(DRAFT_MAX_BYTES));c.enqueue(new Uint8Array(1));c.close();}});
  const response=await worker.fetch(new Request(origin+`/api/drafts/${k}`,{method:"PUT",headers:{Authorization:`Bearer ${u.token}`},body}),env,ctx);expect(response.status).toBe(413);expect(await currentDraft(env,u.id,k)).toBeNull();
  for(let i=0;i<49;i++)await putDraft(env,u.id,key(),JSON.stringify(doc()));const results=await Promise.all([putDraft(env,u.id,key(),JSON.stringify(doc())),putDraft(env,u.id,key(),JSON.stringify(doc()))]);expect(results.sort()).toEqual(["limit","ok"]);
  await env.DB.prepare("UPDATE draft_revisions SET size_bytes = ? WHERE id = (SELECT id FROM draft_revisions WHERE owner = ? LIMIT 1)").bind(DRAFT_MAX_RETAINED_BYTES,u.id).run();expect(await putDraft(env,u.id,key(),JSON.stringify(doc()))).toBe("limit");
 });
 it("honors a metering refusal before retaining any R2 object",async()=>{
  const u=await user(),k=key();setMeterHooks({reserve:async()=>({ok:false})});expect((await u.put(k,doc())).status).toBe(409);expect(await currentDraft(env,u.id,k)).toBeNull();expect((await env.DB.prepare("SELECT COUNT(*) n FROM draft_revisions WHERE owner = ?").bind(u.id).first<{n:number}>())!.n).toBe(0);
 });
 it("commits artifacts with optimistic versions and scopes projects to their team",async()=>{
  const u=await user(),k=key();await u.put(k,{kind:"artifact",title:"Page",favicon:"📄",html:"<p>x</p>"});const first=await u.commit(k);expect(first.status).toBe(200);const id=first.body.data.id;
  await u.put(k,{kind:"artifact",title:"Page",favicon:"📄",html:"<p>v2</p>",target:{artifact_id:id,base_version:1}});expect((await u.commit(k)).body.data.version).toBe(2);
  await u.put(k,{kind:"artifact",title:"Page",favicon:"📄",html:"<p>stale</p>",target:{artifact_id:id,base_version:1}});expect((await u.commit(k)).status).toBe(409);
  await u.put(k,doc("<p>x</p>",{project_id:"unknown"}));expect((await u.commit(k)).status).toBe(403);
 });
});

it("leaves an incomplete document editable without holding a publication",async()=>{
 const u=await user(),k=key();await u.put(k,{kind:"document",html:"<p>draft</p>"});expect((await u.commit(k)).status).toBe(400);expect(await u.count()).toBe(0);await u.put(k,doc());expect((await u.commit(k)).status).toBe(200);
});


describe("artifact publication ownership",()=>{
 it("isolates two different drafts racing for the same artifact version",async()=>{
  const u=await user(),m=ledger();
  const initial=await publishArtifact(env,{userId:u.id,html:"<p>initial</p>",favicon:"📄"});
  const left=key(),right=key(),id=initial.artifact.id;
  for(const [k,text] of [[left,"left"],[right,"right"]]) await u.put(k,{kind:"artifact",markdown:`# ${text}`,target:{artifact_id:id,base_version:1}});
  let entered=0,release!:()=>void;const waiting=new Promise<void>(r=>release=r);
  const race=wrap(env,{put:async(real,k,...args)=>{if(String(k).startsWith(`artifacts/${id}/`) && String(k).endsWith(".html")){entered++;if(entered===2)release();await waiting;}return real.put(k,...args);}});
  const results=await Promise.all([commitDraft(race,u.id,left),commitDraft(race,u.id,right)]);
  expect(results.map(r=>r.status).sort()).toEqual([200,409]);
  const row=await env.DB.prepare("SELECT r2_key FROM artifact_versions WHERE artifact_id = ? AND version = 2").bind(id).first<{r2_key:string}>();
  const winner=results[0].status===200?"left":"right";
  expect(await loadArtifactVersionContent(env,id,2)).toContain(winner);
  expect(await(await env.DOCS.get(row!.r2_key.replace(/\.html$/,".md")))!.text()).toBe(`# ${winner}`);
  expect((await env.DB.prepare("SELECT current_version FROM artifacts WHERE id = ?").bind(id).first<{current_version:number}>())!.current_version).toBe(2);
  expect(m.commits).toBe(1);expect(m.bytes).toBeGreaterThan(0);
  expect((await env.DB.prepare("SELECT COUNT(*) n FROM artifact_upload_attempts WHERE artifact_id = ?").bind(id).first<{n:number}>())!.n).toBe(0);
 });
 it("retains committed artifact bytes and draft reservations when D1 loses its batch response",async()=>{
  const u=await user(),k=key(),m=ledger();await u.put(k,{kind:"artifact",markdown:"# committed",favicon:"📄"});
  const DB=new Proxy(env.DB,{get(target,prop:string){if(prop==="batch")return async(statements:D1PreparedStatement[])=>{await target.batch(statements);throw new Error("lost committed response");};const v=(target as any)[prop];return typeof v==="function"?v.bind(target):v;}});
  expect((await commitDraft({...env,DB},u.id,k)).status).toBe(503);
  const artifact=await env.DB.prepare("SELECT id FROM artifacts WHERE user_id = ?").bind(u.id).first<{id:string}>();
  expect(await loadArtifactVersionContent(env,artifact!.id,1)).toContain("committed");
  const version=await env.DB.prepare("SELECT r2_key FROM artifact_versions WHERE artifact_id = ?").bind(artifact!.id).first<{r2_key:string}>();
  expect(await env.DOCS.head(version!.r2_key.replace(/\.html$/,".md"))).not.toBeNull();
  expect((await u.commit(k,"retry")).status).toBe(409);expect(m.commits).toBe(1);expect(m.bytes).toBeGreaterThan(0);
  expect((await env.DB.prepare("SELECT status FROM draft_commits WHERE owner = ?").bind(u.id).first<{status:string}>())!.status).toBe("held");
 });
 it("keeps a durable staging record after an uncertain upload instead of deleting its bytes",async()=>{
  const u=await user(),k=key(),m=ledger();await u.put(k,{kind:"artifact",html:"<p>upload accepted</p>",favicon:"📄"});
  const broken=wrap(env,{put:async(real,k,...args)=>{const result=await real.put(k,...args);if(String(k).startsWith("artifacts/"))throw new Error("lost upload response");return result;}});
  expect((await commitDraft(broken,u.id,k)).status).toBe(503);
  const attempt=await env.DB.prepare("SELECT r2_key,state,size_bytes FROM artifact_upload_attempts WHERE owner = ?").bind(u.id).first<{r2_key:string;state:string;size_bytes:number}>();
  expect(attempt!.state).toBe("staging");expect(attempt!.size_bytes).toBeGreaterThan(0);expect(await env.DOCS.head(attempt!.r2_key)).not.toBeNull();
  await flushArtifactUploadCleanup(env);expect(await env.DOCS.head(attempt!.r2_key)).not.toBeNull();expect(m.bytes).toBeGreaterThan(0);expect(m.commits).toBe(1);
 });
 it("checks the existing artifact scope when draft or batch fields omit it",async()=>{
  const u=await user(),k=key(),team=key();
  await env.DB.prepare("INSERT INTO teams(id,slug,name,owner_user_id) VALUES(?,?,?,?)").bind(team,team,"Team",u.id).run();
  await env.DB.prepare("INSERT INTO team_memberships(team_id,user_id,role) VALUES(?,?,'member')").bind(team,u.id).run();
  const initial=await publishArtifact(env,{userId:u.id,teamId:team,sourcePath:"team/page.html",html:"<p>original</p>",favicon:"📄"}),id=initial.artifact.id;
  await env.DB.prepare("UPDATE team_memberships SET role = 'viewer' WHERE team_id = ? AND user_id = ?").bind(team,u.id).run();
  await u.put(k,{kind:"artifact",html:"<p>omitted</p>",target:{artifact_id:id,base_version:1}});expect((await u.commit(k)).status).toBe(403);
  const batch=await u.call("POST","/api/batch",{items:[{kind:"artifact",artifact_id:id,html:"<p>batch</p>"},{kind:"delete",id}]},{"Idempotency-Key":key()});
  expect(batch.body.results.map((r:any)=>r.ok)).toEqual([false,false]);expect(batch.body.results[0].error.code).toBe("forbidden");
  expect((await u.call("POST","/api/artifacts",{source_path:"team/page.html",html:"<p>path</p>"})).status).toBe(403);
  expect((await u.call("PATCH",`/api/artifacts/${id}`,{title:"forbidden rename"})).status).toBe(403);
  expect(await loadArtifactVersionContent(env,id,1)).toContain("original");expect(await loadArtifactVersionContent(env,id,2)).toBeNull();
 });
 it("rechecks membership atomically after an upload and preserves the current version",async()=>{
  const u=await user(),team=key(),k=key();await env.DB.prepare("INSERT INTO teams(id,slug,name,owner_user_id) VALUES(?,?,?,?)").bind(team,team,"Team",u.id).run();await env.DB.prepare("INSERT INTO team_memberships(team_id,user_id,role) VALUES(?,?,'member')").bind(team,u.id).run();
  const initial=await publishArtifact(env,{userId:u.id,teamId:team,html:"<p>original</p>",favicon:"📄"});
  await u.put(k,{kind:"artifact",html:"<p>revoked while uploading</p>",target:{artifact_id:initial.artifact.id,base_version:1}});
  const revoke=wrap(env,{put:async(real,k,...args)=>{const result=await real.put(k,...args);if(String(k).startsWith("artifacts/"))await env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?").bind(team,u.id).run();return result;}});
  expect((await commitDraft(revoke,u.id,k)).status).toBe(403);expect(await loadArtifactVersionContent(env,initial.artifact.id,1)).toContain("original");expect(await loadArtifactVersionContent(env,initial.artifact.id,2)).toBeNull();
 });
});

it("refuses publication if the old scope moves without a version change during upload",async()=>{
 const u=await user(),k=key(),team=key();await env.DB.prepare("INSERT INTO teams(id,slug,name,owner_user_id) VALUES(?,?,?,?)").bind(team,team,"Team",u.id).run();
 const initial=await publishArtifact(env,{userId:u.id,html:"<p>original</p>",favicon:"📄"});
 await u.put(k,{kind:"artifact",html:"<p>stale scope</p>",target:{artifact_id:initial.artifact.id,base_version:1}});
 const move=wrap(env,{put:async(real,k,...args)=>{const result=await real.put(k,...args);if(String(k).startsWith("artifacts/"))await env.DB.prepare("UPDATE artifacts SET team_id = ? WHERE id = ?").bind(team,initial.artifact.id).run();return result;}});
 expect((await commitDraft(move,u.id,k)).status).toBe(409);expect(await loadArtifactVersionContent(env,initial.artifact.id,1)).toContain("original");expect(await loadArtifactVersionContent(env,initial.artifact.id,2)).toBeNull();
 expect((await env.DB.prepare("SELECT team_id FROM artifacts WHERE id = ?").bind(initial.artifact.id).first<{team_id:string}>())!.team_id).toBe(team);
});

it("keeps deleted artifact bytes accountable when R2 cleanup fails",async()=>{
 const u=await user(),result=await publishArtifact(env,{userId:u.id,markdown:"# deletion retry",favicon:"📄"});
 const version=await env.DB.prepare("SELECT r2_key FROM artifact_versions WHERE artifact_id = ?").bind(result.artifact.id).first<{r2_key:string}>();
 const broken=wrap(env,{delete:async()=>{throw new Error("offline");}});
 expect(await deleteArtifact(broken,result.artifact.id,u.id)).toBe(true);
 expect(await env.DB.prepare("SELECT id FROM artifacts WHERE id = ?").bind(result.artifact.id).first()).toBeNull();
 const held=await env.DB.prepare("SELECT state,size_bytes,source_size FROM artifact_upload_attempts WHERE artifact_id = ?").bind(result.artifact.id).first<{state:string;size_bytes:number;source_size:number}>();
 expect(held!.state).toBe("retired");expect(held!.size_bytes+held!.source_size).toBeGreaterThan(0);expect(await env.DOCS.head(version!.r2_key)).not.toBeNull();
 await flushArtifactUploadCleanup(env);expect(await env.DOCS.head(version!.r2_key)).toBeNull();expect(await env.DOCS.head(version!.r2_key.replace(/\.html$/,".md"))).toBeNull();
 expect(await env.DB.prepare("SELECT id FROM artifact_upload_attempts WHERE artifact_id = ?").bind(result.artifact.id).first()).toBeNull();
});

it("does not delete an artifact moved after authorization but before the delete transaction",async()=>{
 const u=await user(),team=key();await env.DB.prepare("INSERT INTO teams(id,slug,name,owner_user_id) VALUES(?,?,?,?)").bind(team,team,"Team",u.id).run();
 const result=await publishArtifact(env,{userId:u.id,html:"<p>moved safely</p>",favicon:"📄"});
 const DB=new Proxy(env.DB,{get(target,prop:string){if(prop==="batch")return async(statements:D1PreparedStatement[])=>{await target.prepare("UPDATE artifacts SET team_id = ? WHERE id = ?").bind(team,result.artifact.id).run();return target.batch(statements);};const v=(target as any)[prop];return typeof v==="function"?v.bind(target):v;}});
 expect(await deleteArtifact({...env,DB},result.artifact.id,u.id)).toBe(false);expect(await loadArtifactVersionContent(env,result.artifact.id,1)).toContain("moved safely");
 expect(await env.DB.prepare("SELECT id FROM artifact_upload_attempts WHERE artifact_id = ?").bind(result.artifact.id).first()).toBeNull();
});


it("rechecks new block and share pins inside each prune transaction",async()=>{
 for(const kind of ["block","share"]) {
  const u=await user(),initial=await publishArtifact(env,{userId:u.id,markdown:"# pinned original",favicon:"📄"}),id=initial.artifact.id;
  const first=await env.DB.prepare("SELECT r2_key FROM artifact_versions WHERE artifact_id = ? AND version = 1").bind(id).first<{r2_key:string}>();
  for(let version=2;version<=20;version++)await env.DB.prepare("INSERT INTO artifact_versions(artifact_id,version,r2_key,size) VALUES(?,?,?,1)").bind(id,version,`artifacts/${id}/fixture-${version}.html`).run();
  await env.DB.prepare("UPDATE artifacts SET current_version = 20 WHERE id = ?").bind(id).run();
  const message=key();await env.DB.prepare("INSERT INTO messages(id,type,title,body,instance_model,instance_session_id,instance_project,instance_source,user_id) VALUES(?,'message','pin','pin','test','test','test','test',?)").bind(message,u.id).run();
  let batches=0;
  const DB=new Proxy(env.DB,{get(target,prop:string){if(prop==="batch")return async(statements:D1PreparedStatement[])=>{
   if(++batches===2) {
    if(kind==="block")await target.prepare("INSERT INTO message_blocks(message_id,position,kind,artifact_id,artifact_version) VALUES(?,0,'artifact',?,1)").bind(message,id).run();
    else await target.prepare("UPDATE artifacts SET shared_version = 1 WHERE id = ?").bind(id).run();
   }
   return target.batch(statements);
  };const v=(target as any)[prop];return typeof v==="function"?v.bind(target):v;}});
  await publishArtifact({...env,DB},{userId:u.id,artifactId:id,baseVersion:20,html:"<p>latest</p>"});
  expect(await loadArtifactVersionContent(env,id,1)).toContain("pinned original");expect(await env.DOCS.head(first!.r2_key.replace(/\.html$/,".md"))).not.toBeNull();
  expect(await env.DB.prepare("SELECT id FROM artifact_upload_attempts WHERE artifact_id = ? AND version = 1").bind(id).first()).toBeNull();
  await env.DB.prepare("DELETE FROM message_blocks WHERE message_id = ?").bind(message).run();await env.DB.prepare("UPDATE artifacts SET shared_version = NULL WHERE id = ?").bind(id).run();
  const broken=wrap(env,{delete:async()=>{throw new Error("offline");}});await publishArtifact(broken,{userId:u.id,artifactId:id,baseVersion:21,html:"<p>new latest</p>"});
  expect(await loadArtifactVersionContent(env,id,1)).toBeNull();expect(await env.DOCS.head(first!.r2_key)).not.toBeNull();
  expect((await env.DB.prepare("SELECT state FROM artifact_upload_attempts WHERE artifact_id = ? AND version = 1").bind(id).first<{state:string}>())!.state).toBe("retired");
  await flushArtifactUploadCleanup(env);expect(await env.DOCS.head(first!.r2_key)).toBeNull();expect(await loadArtifactVersionContent(env,id,22)).toContain("new latest");
 }
});
