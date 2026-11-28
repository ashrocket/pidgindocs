import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchSpec, runOnce, validateConfig } from './agent-assignments.mjs';

async function fixture(target='local') {
  const stateDir=await mkdtemp(join(tmpdir(),'audio-agent-runner-'));
  const config={url:'https://example.test/alice',credential:'Agent private-test-token',target,connectionId:'22222222-2222-4222-8222-222222222222',cwd:stateDir,stateDir,cloudEnvironment:target==='cloud'?'env-test':undefined};
  const task={id:'11111111-1111-4111-8111-111111111111',audio_id:'aud_test',audio_title:'Overview',text:'Inspect the migration. $(touch NEVER) `uname`',playback_seconds:12,status:'queued'};
  const calls=[];let phase='queued';
  const fetchImpl=async (url,options)=>{
    assert.equal(options.headers.Authorization,config.credential);
    assert.ok(url.startsWith(config.url+'/api/'));assert.equal(options.redirect,'error');
    const body=options.body?JSON.parse(options.body):undefined;calls.push({url,body});
    let data={};
    if(url.endsWith('/agent-runtimes')){assert.equal(body.connection_id,config.connectionId);assert.equal(body.execution_ref,target==='cloud'?config.cloudEnvironment:config.cwd);data={runtime:{id:'runtime'}};}
    else if(url.includes('/assignments?'))data={items:phase==='queued'?[task]:[]};
    else if(url.endsWith('/claim')){assert.equal(phase,'queued');phase='claimed';data={assignment:task,lease_token:'private-lease'};}
    else if(url.endsWith('/update')){phase=body.action==='complete'?'completed':body.action==='dispatch'?'dispatched':phase;data={assignment:{...task,status:phase}};}
    return new Response(JSON.stringify({ok:true,data}),{headers:{'Content-Type':'application/json'}});
  };
  return {config,task,calls,fetchImpl,phase:()=>phase};
}

test('local execution receives reply only as stdin and persists completion without exposing its lease',async()=>{
  const f=await fixture();let launched=0;
  const execute=async(binary,args,options)=>{
    launched++;assert.equal(f.phase(),'dispatched');assert.equal(binary,'codex');
    assert.ok(args.includes('--worktree'));assert.ok(args.includes('workspace-write'));
    assert.ok(!args.some(arg=>arg.includes('$(touch')));assert.match(options.stdin,/\$\(touch NEVER\)/);
    await writeFile(args[args.indexOf('--output-last-message')+1],'Migration checked. Tests passed.');
    return {code:0,stdout:'{"type":"thread.started","thread_id":"real-session"}\n'};
  };
  const result=await runOnce(f.config,{fetchImpl:f.fetchImpl,execute});
  assert.equal(result.status,'completed');assert.equal(result.session_ref,'codex-local:real-session');
  assert.doesNotMatch(JSON.stringify(result),/private-/);
  assert.equal(f.calls.find(c=>c.body?.action==='complete').body.result,'Migration checked. Tests passed.');
  await runOnce(f.config,{fetchImpl:f.fetchImpl,execute});assert.equal(launched,1);
});

test('cloud submits to the explicit environment and keeps dispatched distinct from completed',async()=>{
  const f=await fixture('cloud');let launches=0;
  const execute=async(_binary,args)=>{launches++;assert.deepEqual(args.slice(0,5),['cloud','exec','--env','env-test','--']);return {code:0,stdout:'https://chatgpt.com/codex/tasks/task_test123\n'};};
  const result=await runOnce(f.config,{fetchImpl:f.fetchImpl,execute});
  assert.equal(result.status,'dispatched');assert.equal(result.session_ref,'codex-cloud:task_test123');
  assert.ok(!f.calls.some(c=>c.body?.action==='complete'));
  await runOnce(f.config,{fetchImpl:f.fetchImpl,execute});assert.equal(launches,1);
});

test('lost dispatch acknowledgement never causes an automatic launch or duplicate submission',async()=>{
  const f=await fixture();let launches=0,fail=true;
  const fetchImpl=async(url,options)=>{const response=await f.fetchImpl(url,options);if(fail&&JSON.parse(options.body??'{}').action==='dispatch'){fail=false;throw new Error('lost acknowledgement');}return response;};
  const execute=async()=>{launches++;throw new Error('must not launch');};
  await assert.rejects(runOnce(f.config,{fetchImpl,execute}),/lost acknowledgement/);
  const result=await runOnce(f.config,{fetchImpl,execute});
  assert.equal(launches,0);assert.equal(result.recovered[0].status,'dispatch_request');
});

test('lost completion acknowledgement reuses the saved result, without running Codex again',async()=>{
  const f=await fixture();let launches=0,fail=true;
  const fetchImpl=async(url,options)=>{const response=await f.fetchImpl(url,options);if(fail&&JSON.parse(options.body??'{}').action==='complete'){fail=false;throw new Error('lost completion');}return response;};
  const execute=async(_binary,args)=>{launches++;await writeFile(args[args.indexOf('--output-last-message')+1],'Verified result');return {code:0,stdout:''};};
  await assert.rejects(runOnce(f.config,{fetchImpl,execute}),/lost completion/);
  const result=await runOnce(f.config,{fetchImpl,execute});assert.equal(launches,1);assert.equal(result.recovered[0].status,'completed');
});

test('refuses ambiguous cloud routing, insecure hosts, and cross-deployment journal reuse',async()=>{
  const f=await fixture();
  assert.throws(()=>validateConfig({...f.config,target:'cloud'}),/environment/);
  assert.throws(()=>validateConfig({...f.config,url:'http://public.example.test'}),/HTTPS/);
  await runOnce(f.config,{fetchImpl:async()=>new Response(JSON.stringify({ok:true,data:{runtime:{id:'rt'},items:[]}}))});
  await assert.rejects(runOnce({...f.config,url:'https://another.example.test'},{fetchImpl:f.fetchImpl}),/separate state directory/);
  const meta=JSON.parse(await readFile(join(f.config.stateDir,'connection.json'),'utf8'));assert.ok(!JSON.stringify(meta).includes('private-test-token'));
});
