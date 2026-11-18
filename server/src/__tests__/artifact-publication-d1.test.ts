import { env as bindings } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../core/types';
import { installEditionHooks, UsageRefused, type UsageMetric } from '../core/edition-hooks';
import { deleteArtifact, getArtifactById, listArtifactVersions, loadArtifactVersionContent, patchArtifact, publishArtifact } from '../core/artifacts/store';
import { runGovernedContentCleanup } from '../core/governed-content-cleanup';
import { createMessage, type CreateMessageInput } from '../core/messages/store';

const env = { ...bindings, WORKER_URL: 'https://example.test', ENTRA_ONLY: 'false' } as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
afterEach(() => installEditionHooks({}));

function proxy<T extends object>(target: T, overrides: Partial<Record<keyof T, unknown>>): T {
  return new Proxy(target, { get(object, key) {
    if (Object.hasOwn(overrides, key)) return Reflect.get(overrides,key);
    const value = Reflect.get(object,key);
    return typeof value === 'function' ? value.bind(object) : value;
  } });
}
async function fixture(team = false) {
  const userId = crypto.randomUUID(), teamId = team ? crypto.randomUUID() : undefined;
  await env.DB.prepare("INSERT INTO users(id,email,status) VALUES (?,?,'active')").bind(userId,`${userId}@example.test`).run();
  if (teamId) await env.DB.batch([
    env.DB.prepare("INSERT INTO teams(id,slug,name,owner_user_id) VALUES (?,?,'Test',?)").bind(teamId,teamId,userId),
    env.DB.prepare("INSERT INTO team_memberships(team_id,user_id,role) VALUES (?,?,'owner')").bind(teamId,userId),
  ]);
  const { artifact } = await publishArtifact(env,{userId,teamId,title:'Original',favicon:'📄',html:'<p>Original</p>'});
  return {userId,teamId,artifactId:artifact.id};
}
function ledger(retention = 20) {
  const reservations = new Map<string,{metric:UsageMetric;amount:number}>(), releases = new Map<string,{metric:UsageMetric;amount:number}>();
  installEditionHooks({
    accountLimits: async () => ({max_upload_bytes:10_000_000,versions_per_artifact:retention}),
    reserveUsage: async (_env,_user,metric,amount,key) => { if (!reservations.has(key)) reservations.set(key,{metric,amount}); return {managed:true}; },
    releaseUsage: async (_env,_user,metric,amount,key) => { if (!releases.has(key)) releases.set(key,{metric,amount}); return {managed:true}; },
  });
  return { reservations,releases, balance(metric:UsageMetric) {
    return [...reservations.values()].filter(r=>r.metric===metric).reduce((n,r)=>n+r.amount,0)
      - [...releases.values()].filter(r=>r.metric===metric).reduce((n,r)=>n+r.amount,0);
  } };
}
function publicationBarrier() {
  let arrived = 0, open!: () => void;
  const ready = new Promise<void>(resolve => {open=resolve;});
  const keys: string[] = [];
  const DOCS = proxy(env.DOCS,{put:async (key:string,value:ReadableStream|ArrayBuffer|string,options?:R2PutOptions) => {
    keys.push(key);
    const result = await env.DOCS.put(key,value,options);
    if (++arrived === 2) open();
    await ready;
    return result;
  }});
  return {DOCS,keys};
}
const attempts = (userId:string) => env.DB.prepare('SELECT * FROM artifact_upload_attempts WHERE owner=?').bind(userId).all<{id:string;r2_key:string;state:string}>();
function interceptBatch(match:(sql:string)=>boolean, action:(statements:D1PreparedStatement[])=>Promise<D1Result[]>) {
  const marked=new WeakSet<D1PreparedStatement>();
  return proxy(env.DB,{
    prepare:(sql:string)=>{
      const statement=env.DB.prepare(sql);
      return !match(sql)?statement:proxy(statement,{bind:(...values:unknown[])=>{const bound=statement.bind(...values);marked.add(bound);return bound;}});
    },
    batch:async(statements:D1PreparedStatement[])=>marked.has(statements[0])?action(statements):env.DB.batch(statements),
  });
}
const isPrune=(sql:string)=>sql.startsWith('INSERT INTO artifact_upload_attempts')&&sql.includes('FROM artifact_versions v JOIN artifacts');
function beforePatch(action:()=>Promise<unknown>) {
  return proxy(env.DB,{prepare:(sql:string)=>{
    const statement=env.DB.prepare(sql);
    if(!sql.includes('UPDATE artifacts SET title = ?, description = ?, visibility = ?'))return statement;
    return proxy(statement,{bind:(...values:unknown[])=>{
      const bound=statement.bind(...values);
      return proxy(bound,{run:async()=>{await action();return bound.run();}});
    }});
  }});
}

describe('artifact publication ownership with real D1 and R2',()=>{
  for (const team of [false,true]) it(`isolates competing ${team?'team':'personal'} uploads and reservations`,async()=>{
    const f=await fixture(team), meter=ledger(), gate=publicationBarrier();
    const results=await Promise.allSettled(['<p>A</p>','<p>Longer B</p>'].map(html=>publishArtifact({...env,DOCS:gate.DOCS},{...f,html,baseVersion:1})));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
    expect(new Set(gate.keys).size).toBe(2);
    const versions=await listArtifactVersions(env,f.artifactId), winner=versions.find(v=>v.version===2)!;
    expect(versions).toHaveLength(2);
    expect(await loadArtifactVersionContent(env,f.artifactId,2)).toMatch(/^<p>(A|Longer B)<\/p>$/);
    expect(await env.DOCS.head(gate.keys.find(k=>k!==winner.r2_key)!)).toBeNull();
    expect(meter.reservations.size).toBe(2);
    expect(meter.balance('storage_bytes')).toBe(winner.size);
    expect((await attempts(f.userId)).results).toHaveLength(0);
  });

  it('retains committed objects and charges when the D1 response is lost',async()=>{
    const f=await fixture(),meter=ledger();
    const DB=proxy(env.DB,{batch:async (statements:D1PreparedStatement[])=>{await env.DB.batch(statements);throw new Error('lost committed response');}});
    await expect(publishArtifact({...env,DB},{...f,html:'<p>Committed</p>',baseVersion:1})).rejects.toThrow('lost committed response');
    expect((await getArtifactById(env,f.artifactId))!.current_version).toBe(2);
    expect(await loadArtifactVersionContent(env,f.artifactId,2)).toBe('<p>Committed</p>');
    expect(meter.balance('storage_bytes')).toBe(new TextEncoder().encode('<p>Committed</p>').byteLength);
    expect(meter.releases.size).toBe(0);
    expect((await attempts(f.userId)).results).toHaveLength(0); // committed version is the durable evidence
  });

  it('does not clean an absent readback while the lost D1 batch can still commit',async()=>{
    const f=await fixture(),meter=ledger();let pending:D1PreparedStatement[]=[];
    const DB=proxy(env.DB,{batch:async (statements:D1PreparedStatement[])=>{pending=statements;throw new Error('response timed out before commit');}});
    await expect(publishArtifact({...env,DB},{...f,html:'<p>Late commit</p>',baseVersion:1})).rejects.toThrow('timed out');
    expect((await getArtifactById(env,f.artifactId))!.current_version).toBe(1);
    const retained=(await attempts(f.userId)).results;
    expect(retained).toHaveLength(1);expect(retained[0].state).toBe('staging');
    expect(await env.DOCS.head(retained[0].r2_key)).not.toBeNull();
    expect(meter.releases.size).toBe(0);
    await env.DB.batch(pending);
    expect(await loadArtifactVersionContent(env,f.artifactId,2)).toBe('<p>Late commit</p>');
    expect((await attempts(f.userId)).results).toHaveLength(0);
  });

  it('retains a possibly successful R2 put and its accounting',async()=>{
    const f=await fixture(),meter=ledger();
    const DOCS=proxy(env.DOCS,{put:async (key:string,value:string,options?:R2PutOptions)=>{await env.DOCS.put(key,value,options);throw new Error('lost R2 response');}});
    await expect(publishArtifact({...env,DOCS},{...f,html:'<p>Retained</p>'})).rejects.toThrow('lost R2 response');
    const retained=(await attempts(f.userId)).results;
    expect(retained).toHaveLength(1);expect(retained[0].state).toBe('staging');
    expect(await env.DOCS.head(retained[0].r2_key)).not.toBeNull();
    expect(meter.releases.size).toBe(0);
    expect((await getArtifactById(env,f.artifactId))!.current_version).toBe(1);
  });

  it('keeps a losing upload charged and recorded when its R2 cleanup fails',async()=>{
    const f=await fixture(),meter=ledger(),gate=publicationBarrier();
    const DOCS=proxy(gate.DOCS,{delete:async()=>{throw new Error('delete unavailable');}});
    const result=await Promise.allSettled(['<p>A</p>','<p>B</p>'].map(html=>publishArtifact({...env,DOCS},{...f,html})));
    expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const retained=(await attempts(f.userId)).results;
    expect(retained).toHaveLength(1);expect(retained[0].state).toBe('retired');
    expect(await env.DOCS.head(retained[0].r2_key)).not.toBeNull();
    expect(meter.releases.size).toBe(0);
    expect(await loadArtifactVersionContent(env,f.artifactId,2)).not.toBeNull();
  });

  it('retains an uncertain metering response before uploading',async()=>{
    const f=await fixture();let charged=0;
    installEditionHooks({reserveUsage:async(_e,_u,_m,n)=>{charged+=n;throw new UsageRefused('meter response lost',503);}});
    await expect(publishArtifact(env,{...f,html:'<p>Pending meter</p>'})).rejects.toThrow('meter response lost');
    const retained=(await attempts(f.userId)).results;
    expect(retained).toHaveLength(1);expect(charged).toBeGreaterThan(0);
    expect(await env.DOCS.head(retained[0].r2_key)).toBeNull();
  });

  it('refunds only a confirmed pre-upload quota refusal',async()=>{
    const userId=crypto.randomUUID();await env.DB.prepare("INSERT INTO users(id,email,status) VALUES (?,?,'active')").bind(userId,`${userId}@example.test`).run();
    const released:string[]=[];
    installEditionHooks({reserveUsage:async(_e,_u,metric)=>{if(metric==='storage_bytes')throw new UsageRefused('full',429);return {managed:true};},releaseUsage:async(_e,_u,metric)=>{released.push(metric);return {managed:true};}});
    await expect(publishArtifact(env,{userId,html:'<p>x</p>',favicon:'📄'})).rejects.toThrow('full');
    expect(released).toEqual(['active_artifacts']);expect((await attempts(userId)).results).toHaveLength(0);
  });

  it('prunes one stale version once even when later publications overlap cleanup',async()=>{
    const f=await fixture(),first=(await listArtifactVersions(env,f.artifactId))[0],meter=ledger(1);
    let seen=0,release!:()=>void;const both=new Promise<void>(resolve=>{release=resolve;});
    const DB=interceptBatch(isPrune,async statements=>{if(++seen===2)release();await both;return env.DB.batch(statements);});
    const second=publishArtifact({...env,DB},{...f,html:'<p>Two</p>'});
    // Wait for the confirmed v2 commit before starting v3; both then prune v1.
    for(let i=0;i<100 && (await getArtifactById(env,f.artifactId))!.current_version!==2;i++) await new Promise(r=>setTimeout(r,1));
    await Promise.all([second,publishArtifact({...env,DB},{...f,html:'<p>Three</p>'})]);
    const refunds=[...meter.releases.entries()].filter(([key])=>key.includes(`:v1:prune:${first.r2_key}`));
    expect(refunds).toHaveLength(1);expect(refunds[0][1].amount).toBe(first.size);
    expect(await loadArtifactVersionContent(env,f.artifactId,3)).toBe('<p>Three</p>');
  });

  for(const pin of ['block','shared'] as const)it(`preserves a ${pin} pin installed after retention's snapshot`,async()=>{
    const f=await fixture();ledger(1);let inserted=false;
    const DB=interceptBatch(isPrune,async statements=>{
      if(!inserted){inserted=true;
        if(pin==='shared')await env.DB.prepare('UPDATE artifacts SET shared_version=1 WHERE id=?').bind(f.artifactId).run();
        else {const id=crypto.randomUUID();await env.DB.batch([
          env.DB.prepare("INSERT INTO messages(id,type,title,instance_model,instance_session_id,instance_project,instance_source,user_id) VALUES (?,'message','Pinned','test','test','test','test',?)").bind(id,f.userId),
          env.DB.prepare("INSERT INTO message_blocks(message_id,position,kind,artifact_id,artifact_version) VALUES (?,0,'artifact',?,1)").bind(id,f.artifactId),
        ]);}
      }
      return env.DB.batch(statements);
    });
    await publishArtifact({...env,DB},{...f,html:'<p>Two</p>'});
    expect(await loadArtifactVersionContent(env,f.artifactId,1)).toBe('<p>Original</p>');
    expect(await loadArtifactVersionContent(env,f.artifactId,2)).toBe('<p>Two</p>');
    expect((await attempts(f.userId)).results).toHaveLength(0);
  });

  it('persists a retired prune manifest without refund when R2 deletion fails',async()=>{
    const f=await fixture(),first=(await listArtifactVersions(env,f.artifactId))[0],meter=ledger(1);
    const DOCS=proxy(env.DOCS,{delete:async()=>{throw new Error('R2 unavailable');}});
    expect((await publishArtifact({...env,DOCS},{...f,html:'<p>Two</p>'})).version).toBe(2);
    expect(await loadArtifactVersionContent(env,f.artifactId,1)).toBeNull();
    expect(await env.DOCS.head(first.r2_key)).not.toBeNull();
    expect((await attempts(f.userId)).results).toMatchObject([{r2_key:first.r2_key,state:'retired'}]);
    expect(meter.releases.size).toBe(0);
  });

  it('retains prune objects and exact refund evidence after an ambiguous unlink',async()=>{
    const f=await fixture(),first=(await listArtifactVersions(env,f.artifactId))[0],meter=ledger(1);
    const DB=interceptBatch(isPrune,async statements=>{await env.DB.batch(statements);throw new Error('unlink response lost');});
    expect((await publishArtifact({...env,DB},{...f,html:'<p>Two</p>'})).version).toBe(2);
    expect(await env.DOCS.head(first.r2_key)).not.toBeNull();
    expect((await attempts(f.userId)).results).toMatchObject([{r2_key:first.r2_key,state:'retired'}]);
    expect(meter.releases.size).toBe(0);
  });

  it('does not delete a personal artifact after a concurrent publication',async()=>{
    const f=await fixture();let raced=false;
    const DB=interceptBatch(sql=>sql.startsWith('INSERT INTO governed_content_cleanup'),async statements=>{
      if(!raced){raced=true;await publishArtifact(env,{...f,html:'<p>Concurrent</p>'});}
      return env.DB.batch(statements);
    });
    expect(await deleteArtifact({...env,DB},f.artifactId,f.userId)).toBe(false);
    expect(await loadArtifactVersionContent(env,f.artifactId,1)).toBe('<p>Original</p>');
    expect(await loadArtifactVersionContent(env,f.artifactId,2)).toBe('<p>Concurrent</p>');
  });

  it('keeps a personal deletion manifest and bytes after a lost D1 response, then cleans once',async()=>{
    const f=await fixture(),first=(await listArtifactVersions(env,f.artifactId))[0],meter=ledger();
    const DB=interceptBatch(sql=>sql.startsWith('INSERT INTO governed_content_cleanup'),async statements=>{await env.DB.batch(statements);throw new Error('delete response lost');});
    await expect(deleteArtifact({...env,DB},f.artifactId,f.userId)).rejects.toThrow('delete response lost');
    expect(await getArtifactById(env,f.artifactId)).toBeNull();expect(await env.DOCS.head(first.r2_key)).not.toBeNull();
    const cleanup=await env.DB.prepare('SELECT id FROM governed_content_cleanup WHERE resource_id=?').bind(f.artifactId).first<{id:string}>();
    expect(cleanup).not.toBeNull();expect(meter.releases.size).toBe(0);
    expect((await runGovernedContentCleanup(env,cleanup!.id)).completed).toBe(1);
    expect(await env.DOCS.head(first.r2_key)).toBeNull();
    expect(meter.releases.size).toBe(2);
    await runGovernedContentCleanup(env,cleanup!.id);expect(meter.releases.size).toBe(2);
  });

  it('preserves cleanup evidence after personal R2 deletion fails',async()=>{
    const f=await fixture(),first=(await listArtifactVersions(env,f.artifactId))[0],meter=ledger();
    const DOCS=proxy(env.DOCS,{delete:async()=>{throw new Error('R2 unavailable');}});
    expect(await deleteArtifact({...env,DOCS},f.artifactId,f.userId)).toBe(true);
    expect(await getArtifactById(env,f.artifactId)).toBeNull();expect(await env.DOCS.head(first.r2_key)).not.toBeNull();
    const row=await env.DB.prepare('SELECT object_keys,storage_bytes FROM governed_content_cleanup WHERE resource_id=?').bind(f.artifactId).first<{object_keys:string;storage_bytes:number}>();
    expect(JSON.parse(row!.object_keys)).toContain(first.r2_key);expect(row!.storage_bytes).toBe(first.size);
    expect(meter.releases.size).toBe(0);
    expect(await env.DB.prepare("SELECT action FROM audit_log WHERE action='delete_artifact' AND user_id=?").bind(f.userId).first()).not.toBeNull();
  });

  it('refuses to pin a version already pruned from its valid numeric range',async()=>{
    const f=await fixture();ledger(1);
    await publishArtifact(env,{...f,html:'<p>Two</p>'});
    expect(await patchArtifact(env,f.artifactId,f.userId,{sharedVersion:1})).toBeNull();
    expect((await getArtifactById(env,f.artifactId))!.shared_version).toBeNull();
    expect((await patchArtifact(env,f.artifactId,f.userId,{sharedVersion:2}))!.shared_version).toBe(2);
  });

  it('refuses a shared pin when pruning wins immediately before its update',async()=>{
    const f=await fixture();await publishArtifact(env,{...f,html:'<p>Two</p>'});
    const DB=beforePatch(()=>env.DB.prepare('DELETE FROM artifact_versions WHERE artifact_id=? AND version=1').bind(f.artifactId).run());
    expect(await patchArtifact({...env,DB},f.artifactId,f.userId,{sharedVersion:1})).toBeNull();
    expect((await getArtifactById(env,f.artifactId))!.shared_version).toBeNull();
  });

  it('refuses a stale public patch after a personal artifact moves into a team',async()=>{
    const f=await fixture(),team=crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO teams(id,slug,name,owner_user_id) VALUES (?,?,'Target',?)").bind(team,team,f.userId),
      env.DB.prepare("INSERT INTO team_memberships(team_id,user_id,role) VALUES (?,?,'owner')").bind(team,f.userId),
    ]);
    const DB=beforePatch(()=>env.DB.prepare('UPDATE artifacts SET team_id=? WHERE id=?').bind(team,f.artifactId).run());
    expect(await patchArtifact({...env,DB},f.artifactId,f.userId,{visibility:'public'})).toBeNull();
    expect(await getArtifactById(env,f.artifactId)).toMatchObject({team_id:team,visibility:'private'});
  });

  it('rolls back the complete message when a block target is pruned after precheck',async()=>{
    const f=await fixture();await publishArtifact(env,{...f,html:'<p>Two</p>'});
    const id=crypto.randomUUID();
    const DB=interceptBatch(sql=>sql.startsWith('INSERT INTO messages'),async statements=>{
      await env.DB.prepare('DELETE FROM artifact_versions WHERE artifact_id=? AND version=1').bind(f.artifactId).run();
      return env.DB.batch(statements);
    });
    installEditionHooks({contentStoreStatements:(_env,input)=>[env.DB.prepare("INSERT INTO audit_log(action,instance_id,details,user_id) VALUES ('native-store-test',?,?,?)").bind(input.id,input.kind,input.userId)]});
    const input:CreateMessageInput={id,userId:f.userId,type:'message',title:'Atomic blocks',body:null,
      instance:{model:'test',session_id:'pin-race',project:'test',source:'test'},
      blocks:[{type:'markdown',markdown:'Must also roll back'},{type:'artifact',artifact_id:f.artifactId,version:1,summary:'Stale version'}],
    };
    await expect(createMessage({...env,DB},input)).rejects.toThrow('artifact version no longer available; refresh and retry');
    expect(await env.DB.prepare('SELECT id FROM messages WHERE id=?').bind(id).first()).toBeNull();
    expect((await env.DB.prepare('SELECT 1 FROM message_blocks WHERE message_id=?').bind(id).all()).results).toHaveLength(0);
    expect(await env.DB.prepare("SELECT 1 FROM audit_log WHERE action='post_message' AND instance_id='pin-race' AND user_id=?").bind(f.userId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM audit_log WHERE action='native-store-test' AND instance_id=?").bind(id).first()).toBeNull();
    const surviving={...input,blocks:[{type:'artifact' as const,artifact_id:f.artifactId,version:2,summary:'Current version'}]};
    await createMessage(env,surviving);
    expect(await env.DB.prepare("SELECT 1 FROM audit_log WHERE action='native-store-test' AND instance_id=?").bind(id).first()).not.toBeNull();
    const uncertain=new Error('ambiguous D1 response');
    const unavailable=proxy(env.DB,{batch:async()=>{throw uncertain;}});
    await expect(createMessage({...env,DB:unavailable},{...surviving,id:crypto.randomUUID()})).rejects.toBe(uncertain);
  });
});
