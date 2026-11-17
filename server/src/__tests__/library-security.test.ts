import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../core/types";
import { sha256Hex } from "../core/auth-utils";
import { installEditionHooks, TenantWriteRefused } from "../core/edition-hooks";
import { installContentPolicy } from "../core/content-policy";
import { handleLibrary, callLibraryTool } from "../core/library";
import { createLibraryProject, fileLibraryItems, getLibraryOverview, loadLibraryPlacements, appendLibraryFilters } from "../core/library/store";
import { ensureLibraryIndex, isCurrent, loadIndexRows, loadParsedItem, listLibraryItems } from "../core/library/search/index-store";
import { createMeteredJev } from "../core/library/meter";
import { JEV_MODEL } from "../core/library/search/jev";
import { writeIndexObject } from "../core/library/storage";
import { libraryCatalogs } from "../core/library/i18n";
import { priceMicroUsd } from "../core/ai/tiers";

const env = { ...bindings, ENTRA_ONLY: "false", WORKER_URL: "https://example.test/alice", BASE_PATH: "/alice", TYPESAFE_API_KEY: "test-key" } as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => {
  installEditionHooks({}); installContentPolicy({});
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected provider call"); }));
});
afterEach(() => { vi.unstubAllGlobals(); installEditionHooks({}); installContentPolicy({}); });

async function person() {
  const id = crypto.randomUUID(), key = `test_${id}`, session = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users(id,email,status) VALUES(?,?,'active')").bind(id, `${id}@example.test`).run();
  await env.DB.prepare("INSERT INTO api_keys(key_hash,key_prefix,user_id) VALUES(?, 'test', ?)").bind(await sha256Hex(key), id).run();
  await env.SESSIONS.put(`session:${session}`, `${id}@example.test`);
  const request = (path: string, body?: unknown, headers: Record<string,string> = { Authorization: `Bearer ${key}` }, method = body === undefined ? "GET" : "POST") => new Request(`https://example.test/alice${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const api = async (path: string, body?: unknown, method?: string) => {
    const response = (await handleLibrary(request(path, body, undefined, method), env, path))!;
    return { status: response.status, body: await response.json() as any };
  };
  return { id, key, session, request, api };
}

async function document(user: string, title = "Garden plan", label = "home", slug?: string) {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO messages(id,type,title,body,priority,doc_key,doc_slug,doc_version,is_latest,instance_model,instance_session_id,instance_project,instance_source,user_id)
    VALUES(?,'document',?,'A cedar garden fence.','normal',?,?,1,1,'test','test',?,'test',?)`).bind(id,title,`docs/${id}.html`,slug ?? id,label,user).run();
  await env.DOCS.put(`docs/${id}.html`, "<h1>Garden</h1><p>A cedar garden fence.</p>");
  return id;
}

describe("Library boundaries", () => {
  it("accepts personal API keys, sessions and OAuth; refuses board Agent keys and deployments without the Library", async () => {
    const user = await person();
    for (const headers of [{Authorization:`Bearer ${user.key}`}, {Authorization:`Session ${user.session}`}, {Cookie:`session=${user.session}`}] as Record<string,string>[]) {
      expect((await handleLibrary(user.request('/api/library',undefined,headers),env,'/api/library'))?.status).toBe(200);
    }
    const oauth = crypto.randomUUID();
    await env.SESSIONS.put(`oauth:token:${oauth}`, JSON.stringify({ user_id:user.id,email:`${user.id}@example.test`,client_id:'library-test',scope:'read write' }));
    const oauthRequest = user.request('/api/library',undefined,{Authorization:`Bearer ${oauth}`});
    expect((await handleLibrary(oauthRequest,env,'/api/library'))?.status).toBe(200);
    expect((await callLibraryTool({env,request:oauthRequest,name:'pidgin_get_library',args:{}}))?.isError).not.toBe(true);
    const agent = user.request('/api/library',undefined,{Authorization:'Agent board-secret',Cookie:`session=${user.session}`});
    expect((await handleLibrary(agent,env,'/api/library'))?.status).toBe(401);
    expect((await callLibraryTool({env,request:agent,name:'pidgin_get_library',args:{}}))?.isError).toBe(true);
    expect((await handleLibrary(user.request('/api/library',undefined,{}),env,'/api/library'))?.status).toBe(401);
    installEditionHooks({libraryEnabled:()=>false});
    expect(await handleLibrary(oauthRequest,env,'/api/library')).toBeNull();
    expect(await callLibraryTool({env,request:oauthRequest,name:'pidgin_get_library',args:{}})).toBeUndefined();
  });

  it("keeps source rules, explicit overrides, family tags and foreign resources separate", async () => {
    const a=await person(), b=await person(), first=await document(a.id), foreign=await document(b.id);
    const project=await createLibraryProject(env,a.id,{name:'House',sources:[' HOME ']});
    expect((await getLibraryOverview(env,a.id)).projects[0].counts.documents).toBe(1);
    const filed=await fileLibraryItems(env,a.id,{items:[{type:'document',id:first},{type:'document',id:foreign}],project_id:'unfiled',add_tags:['Plan']});
    expect(filed.updated).toBe(1);expect(filed.missing).toEqual([foreign]);expect(filed.placements[0]).toMatchObject({project_id:null,filed:'explicit'});
    const next=await document(a.id,'Garden revision','home',first);
    await env.DB.prepare('UPDATE messages SET is_latest=0 WHERE id=?').bind(first).run();
    const placements=await loadLibraryPlacements(env,a.id,[{type:'document',id:next},{type:'document',id:foreign}]);
    expect(placements.size).toBe(1);expect(placements.get(`document:${next}`)?.tags[0].name).toBe('Plan');
    await fileLibraryItems(env,a.id,{items:[{type:'document',id:next}],project_id:'auto'});
    expect((await getLibraryOverview(env,a.id)).projects[0]).toMatchObject({id:project,counts:{documents:1}});
    const conditions:string[]=[],binds:Array<string|number>=[];
    appendLibraryFilters(new URL(`https://example.test/api/docs?library_project=${project}`),'document','m',conditions,binds);
    const rows=await env.DB.prepare(`SELECT m.id FROM messages m WHERE m.user_id=? AND m.is_latest=1 AND ${conditions.join(' AND ')}`).bind(a.id,...binds).all<{id:string}>();
    expect(rows.results.map(row=>row.id)).toEqual([next]);
    expect((await b.api(`/api/library/projects/${project}`,{name:'Stolen'},'PATCH')).status).toBe(404);
    expect((await a.api('/api/library/file',{items:[null]})).status).toBe(400);
  });

  it("applies the current resource policy to counts, tags, filing, placements and indexing", async () => {
    const a=await person(), id=await document(a.id);
    await fileLibraryItems(env,a.id,{items:[{type:'document',id}],add_tags:['Restricted']});
    installContentPolicy({accessSql:alias=>`(${alias}.user_id = ? AND ${alias}.user_id = ? AND 0)`});
    const library=await getLibraryOverview(env,a.id);
    expect(library.unfiled.documents).toBe(0);expect(library.tags[0].count).toBe(0);
    expect(await listLibraryItems(env,a.id)).toEqual([]);
    expect((await loadLibraryPlacements(env,a.id,[{type:'document',id}])).size).toBe(0);
    expect((await fileLibraryItems(env,a.id,{items:[{type:'document',id}],project_id:'unfiled'})).updated).toBe(0);
  });

  it("does no index pruning on GET and refuses forged index object keys", async () => {
    const a=await person(), id=await document(a.id);
    await ensureLibraryIndex(env,a.id);
    const rows=await loadIndexRows(env,a.id), row=[...rows.values()][0];
    const stored=await env.DOCS.head(row.r2_key!);expect(stored).not.toBeNull();
    expect(await loadParsedItem(env,{...row,r2_key:'docs/private-other-person.html'})).toBeNull();
    expect(isCurrent((await listLibraryItems(env,a.id))[0],{...row,r2_key:'library-index/v1/old-user/document/old-key.json'})).toBe(false);
    await env.DB.prepare('DELETE FROM messages WHERE id=?').bind(id).run();
    expect((await ensureLibraryIndex(env,a.id,0)).total).toBe(0);
    expect((await loadIndexRows(env,a.id)).size).toBe(1);
    await ensureLibraryIndex(env,a.id,1);
    expect((await loadIndexRows(env,a.id)).size).toBe(0);
    expect(await env.DOCS.head(row.r2_key!)).toBeNull();
  });

  it("rejects foreign browser origins and ended write access before mutations", async () => {
    const a=await person();
    const cross=a.request('/api/library/projects',{name:'Blocked'},{Authorization:`Bearer ${a.key}`,Origin:'https://attacker.test'});
    expect((await handleLibrary(cross,env,'/api/library/projects'))?.status).toBe(403);
    installEditionHooks({assertWritable:async()=>{throw new TenantWriteRefused('Access ended',403,'expired')}});
    expect((await a.api('/api/library/projects',{name:'Blocked'})).status).toBe(403);
    expect((await a.api('/api/library')).body.data.library.projects).toEqual([]);
  });

  it("renders escaped, base-aware controls with four complete stored catalogs", async () => {
    const a=await person();await document(a.id,'</script><img src=x onerror=alert(1)>');
    for(const catalog of Object.values(libraryCatalogs))expect(Object.keys(catalog).sort()).toEqual(Object.keys(libraryCatalogs.en).sort());
    const response=(await handleLibrary(a.request('/library?lang=es'),env,'/library'))!;
    const html=await response.text();
    expect(html).toContain('<html lang="es">');expect(html).toContain('Biblioteca');expect(html).toContain('href="/alice/"');
    expect(html).not.toContain('<img src=x');expect(html).toContain('\\u003c/script>');
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(html).toMatch(/<script nonce="[^"]+">const initial=/);
  });
});

describe("Library provider and storage accounting", () => {
  it("pins the search model, meters resolved tokens, and stops when the allowance is gone", async () => {
    const limit = 500000; let spent = 0;
    installEditionHooks({ aiBudgetLeft: async () => limit - spent, recordAiUsage: async (_env, _ctx, model, input, output) => { spent += priceMicroUsd(model, input, output); } });
    const fetcher=vi.fn(async(_input: RequestInfo | URL, _init?: RequestInit)=>Response.json({model:JEV_MODEL,answers:{},usage:{input_tokens:100,output_tokens:20}}));
    vi.stubGlobal('fetch',fetcher);
    const client=createMeteredJev(env,'test-key');await client.evaluate({},{});
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).model).toBe(JEV_MODEL);
    expect(spent).toBe(priceMicroUsd(JEV_MODEL,100,20));
    spent = limit;
    await expect(client.evaluate({},{})).rejects.toThrow('AI allowance');expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rechecks the allowance between concurrent retrieval steps and meters malformed success", async () => {
    let remaining=100;const charged=vi.fn(async()=>{remaining=0});
    installEditionHooks({aiBudgetLeft:async()=>remaining,recordAiUsage:charged});
    const fetcher=vi.fn(async()=>Response.json({model:JEV_MODEL,usage:{input_tokens:200,output_tokens:0}}));vi.stubGlobal('fetch',fetcher);
    const client=createMeteredJev(env,'test-key');
    const results=await Promise.allSettled([client.evaluate({},{}),client.evaluate({},{})]);
    expect(results.every(result=>result.status==='rejected')).toBe(true);expect(fetcher).toHaveBeenCalledTimes(1);expect(charged).toHaveBeenCalledOnce();
    expect(client.usage.input_tokens).toBe(200);
  });

  it("reserves stored bytes, rolls failed writes back, and releases shrunk/deleted indexes", async () => {
    const a=await person(), key=`library-index/test/${a.id}.json`;
    const record=vi.fn(async(_env: Env, _userId: string, _bytes: number, _key: string)=>true);installEditionHooks({recordStorage:record});
    await writeIndexObject(env,a.id,key,'123456');await writeIndexObject(env,a.id,key,'12');await writeIndexObject(env,a.id,key,null);
    expect(record.mock.calls.map(call=>call[2])).toEqual([6,-4,-2]);
    const failing={...env,DOCS:new Proxy(env.DOCS,{get(target,prop){if(prop==='put')return async()=>{throw new Error('R2 refused')};const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value}})};
    await expect(writeIndexObject(failing,a.id,key,'123')).rejects.toThrow('R2 refused');
    expect(record.mock.calls.slice(-2).map(call=>call[2])).toEqual([3,-3]);
    expect(record.mock.calls.at(-1)?.[3]).toBe(`${record.mock.calls.at(-2)?.[3]}:rollback`);
  });
});
