import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../index";
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
