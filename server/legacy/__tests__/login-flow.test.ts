import { verifyProviderIdToken } from "../auth/oauth-login";
import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import type { Env } from "../types";
import { handleLogin, handleVerify, handleVerifyCode } from "../routes/auth";
import { loginPage } from "../web/login";
import { startMicrosoftLogin, finishMicrosoftLogin } from "../auth/microsoft";
import { sha256Hex } from "../auth-utils";
import { loginEmailHtml } from "../email";

const deliveries = vi.hoisted(() => [] as Array<{html:string; email:string}>);
vi.mock("../email", async importOriginal => ({...await importOriginal<typeof import("../email")>(), sendOwnerEmail:vi.fn(async (_env:unknown,_subject:string,html:string,email:string) => {deliveries.push({html,email});})}));
const origin="https://pidgindocs.example.workers.dev";
const env={...bindings, OWNER_EMAIL:"owner@example.com",WORKER_URL:origin,MICROSOFT_CLIENT_ID:"client-id",MICROSOFT_CLIENT_SECRET:"test-secret"} as unknown as Env & {TEST_MIGRATIONS:D1Migration[]};
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
async function user(){const id=crypto.randomUUID();const email=`${id}@example.com`;await env.DB.prepare("INSERT INTO users (id,email,status) VALUES (?,?,'active')").bind(id,email).run();return {id,email};}
const proofs = new Map<string,string>();
async function issue(email:string){const response=await handleLogin(new Request(origin+"/auth/login",{method:"POST",body:JSON.stringify({email,next:"/toc"})}),env);const body=await response.json() as any;expect(response.status).toBe(200);proofs.set(body.data.challenge,response.headers.get("Set-Cookie")!.split(";")[0]);const mail=deliveries.at(-1)!;const code=mail.html.match(/font-weight:bold">(\d{4}) (\d{4})/)!.slice(1).join("");const token=mail.html.match(/token=([a-f0-9-]+)/)![1];return {challenge:body.data.challenge,code,token,cookie:response.headers.get("Set-Cookie")!.split(";")[0]};}
function verifyCode(email:string,challenge:string,code:string){return handleVerifyCode(new Request(origin+"/auth/verify-code",{method:"POST",headers:{Origin:origin,Cookie:proofs.get(challenge)||""},body:new URLSearchParams({email,challenge,code,next:"/toc"})}),env);}

describe("email sign-in",()=>{
  it("renders the selected providers and accessible email states without Apple",async()=>{const text=await(await loginPage({...env,GOOGLE_WEB_CLIENT_ID:"google-id",APPLE_WEB_SERVICE_ID:"apple"})).text();expect(text).toContain("Continue with Microsoft");expect(text).toContain('data-text="continue_with"');expect(text).not.toContain("appleid");expect(text).toContain('for="email"');expect(text).toContain("grid-template-columns");const sent=await(await loginPage(env,undefined,"/toc",{email:'<x>@example.com',challenge:"c"})).text();expect(sent).toContain("Send email again");expect(sent).toContain("Change email address");expect(sent).toContain("&lt;x&gt;");expect(sent).toContain('autocomplete="one-time-code"');});
  it("lets a different browser use the code and consumes the link too",async()=>{const u=await user(), flow=await issue(u.email);const response=await verifyCode(u.email,flow.challenge,flow.code);expect(response.status).toBe(302);expect(response.headers.get("location")).toBe(origin+"/toc");expect(response.headers.get("set-cookie")).toContain("HttpOnly");expect((await handleVerify(new Request(origin+`/auth/verify?token=${flow.token}`),env)).status).toBe(401);});
  it("consumes a code when its link is used and rejects an expired challenge",async()=>{const u=await user(),flow=await issue(u.email);expect((await handleVerify(new Request(origin+`/auth/verify?token=${flow.token}`,{headers:{Cookie:flow.cookie}}),env)).status).toBe(302);expect(await(await verifyCode(u.email,flow.challenge,flow.code)).text()).toContain("expired or reached");const expired=await issue(u.email);await env.DB.prepare("UPDATE login_challenges SET expires_at = 0 WHERE id = ?").bind(expired.challenge).run();expect((await handleVerify(new Request(origin+`/auth/verify?token=${expired.token}`),env)).status).toBe(401);});
  it("shows a code in another browser without consuming it, and supports explicit continuation",async()=>{
    const u=await user(),flow=await issue(u.email);
    const handoff=await handleVerify(new Request(origin+`/auth/verify?token=${flow.token}`),env);
    expect(handoff.status).toBe(200);expect(handoff.headers.get("set-cookie")).toBeNull();
    const html=await handoff.text();expect(html).toContain("Return to your<br>sign-in tab");expect(html).toContain(flow.code.slice(0,4)+" "+flow.code.slice(4));
    expect((await verifyCode(u.email,flow.challenge,flow.code)).status).toBe(302);
    const another=await issue(u.email);
    const mismatch=await handleVerify(new Request(origin+`/auth/verify?token=${another.token}`,{headers:{Cookie:`pidgin_email_${another.challenge}=wrong`}}),env);
    expect(await mismatch.text()).toContain("Return to your<br>sign-in tab");
    const denied=await handleVerify(new Request(origin+"/auth/verify",{method:"POST",headers:{Origin:"https://attacker.example"},body:new URLSearchParams({token:another.token})}),env);expect(denied.status).toBe(403);
    const manual=await handleVerify(new Request(origin+"/auth/verify",{method:"POST",headers:{Origin:origin},body:new URLSearchParams({token:another.token})}),env);expect(manual.status).toBe(302);
    expect((await handleVerify(new Request(origin+`/auth/verify?token=${another.token}`),env)).status).toBe(401);
  });
  it("rejects code submission from another origin or without the initiating browser",async()=>{
    const u=await user(),flow=await issue(u.email);
    const missing=await handleVerifyCode(new Request(origin+"/auth/verify-code",{method:"POST",headers:{Origin:origin},body:new URLSearchParams({email:u.email,challenge:flow.challenge,code:flow.code})}),env);
    expect(await missing.text()).toContain("Use the browser where you requested");
    const cross=await handleVerifyCode(new Request(origin+"/auth/verify-code",{method:"POST",headers:{Origin:"https://attacker.example",Cookie:flow.cookie},body:new URLSearchParams({email:u.email,challenge:flow.challenge,code:flow.code})}),env);expect(cross.status).toBe(403);
    expect((await verifyCode(u.email,flow.challenge,flow.code)).status).toBe(302);
  });
  it("returns the same challenge shape for unknown addresses without sending email",async()=>{
    const before=deliveries.length;
    const response=await handleLogin(new Request(origin+"/auth/login",{method:"POST",body:JSON.stringify({email:`unknown-${crypto.randomUUID()}@example.com`})}),env);
    expect(response.status).toBe(200);expect(response.headers.get("Set-Cookie")).toContain("pidgin_email_");
    const body=await response.json() as any;expect(body.data.challenge).toMatch(/^[0-9a-f-]{36}$/);expect(deliveries.length).toBe(before);
  });
  it("bounds retries and binds a code to its challenge",async()=>{const u=await user(),flow=await issue(u.email);const bad=flow.code === "00000000"?"11111111":"00000000";for(let i=0;i<5;i++)expect(await(await verifyCode(u.email,flow.challenge,bad)).text()).toContain("does not match");expect(await(await verifyCode(u.email,flow.challenge,flow.code)).text()).toContain("attempt limit");});
  it("caps requests across changing email addresses from one client",async()=>{
    for(let i=0;i<30;i++) {
      const response=await handleLogin(new Request(origin+"/auth/login",{method:"POST",headers:{"CF-Connecting-IP":"192.0.2.42"},body:JSON.stringify({email:`flood-${i}@example.com`})}),env);
      expect(response.status).toBe(200);
    }
    const before=await env.DB.prepare("SELECT COUNT(*) AS count FROM login_challenges").first<{count:number}>();
    const blocked=await handleLogin(new Request(origin+"/auth/login",{method:"POST",headers:{"CF-Connecting-IP":"192.0.2.42"},body:JSON.stringify({email:"flood-final@example.com"})}),env);
    expect(blocked.status).toBe(429);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM login_challenges").first()).toEqual(before);
  });
  it("keeps linked email sign-in on the canonical account",async()=>{const u=await user(),alias=`alias-${u.id}@example.com`;await env.DB.prepare("INSERT INTO user_identities (email,user_id,provider) VALUES (?,?,'google')").bind(alias,u.id).run();const flow=await issue(alias);expect(deliveries.at(-1)?.email).toBe(alias);const response=await verifyCode(alias,flow.challenge,flow.code);const session=response.headers.get("set-cookie")!.match(/session=([^;]+)/)![1];expect(await env.SESSIONS.get(`session:${session}`)).toBe(u.email);});
  it("keeps email content simple and escapes link values",()=>{expect(loginEmailHtml('https://example.test/?x="bad"',"12345678")).toContain("1234 5678");expect(loginEmailHtml('https://example.test/?x="bad"')).toContain("&quot;");});
});

const tenant="11111111-2222-3333-4444-555555555555",issuer=`https://login.microsoftonline.com/${tenant}/v2.0`;
async function microsoftFlow(userId?:string){const response=await startMicrosoftLogin(new Request(origin+"/auth/oauth/microsoft/start?next=https://evil.example"),env);expect(response.status).toBe(302);const authorize=new URL(response.headers.get("location")!);expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");const state=authorize.searchParams.get("state")!;const browser=response.headers.get("set-cookie")!.split(";")[0];const row=await env.DB.prepare("SELECT payload FROM oauth_login_states WHERE id = ?").bind(await sha256Hex(state)).first<{payload:string}>();const payload=JSON.parse(row!.payload);if(userId)await env.DB.prepare("INSERT INTO oauth_login_identities (issuer,subject,user_id) VALUES (?,?,?)").bind(issuer,payload.nonce,userId).run();return {state,browser,payload};}
async function tokenFetch(flow:Awaited<ReturnType<typeof microsoftFlow>>,claims:Record<string,unknown>={}, options:{audience?:string;issuer?:string;expired?:boolean}={}){const pair=await generateKeyPair("RS256");const jwk=await exportJWK(pair.publicKey);jwk.kid="test";jwk.alg="RS256";const token=await new SignJWT({tid:tenant,nonce:flow.payload.nonce,...claims}).setProtectedHeader({alg:"RS256",kid:"test"}).setIssuer(options.issuer || issuer).setAudience(options.audience || env.MICROSOFT_CLIENT_ID!).setSubject(flow.payload.nonce).setIssuedAt().setExpirationTime(options.expired ? "-1m" : "5m").sign(pair.privateKey);return vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{if(String(input).endsWith("/token")){expect(String(init?.body)).toContain(`code_verifier=${flow.payload.verifier}`);return Response.json({id_token:token});}return Response.json({keys:[jwk]});}) as unknown as typeof fetch;}
function callback(flow:Awaited<ReturnType<typeof microsoftFlow>>){return new Request(origin+`/auth/oauth/microsoft/web?state=${flow.state}&code=code`,{headers:{Cookie:flow.browser}});}
describe("Microsoft OIDC",()=>{
  it("verifies PKCE, signature, issuer, audience and nonce before canonical login",async()=>{const u=await user(),flow=await microsoftFlow(u.id);const response=await finishMicrosoftLogin(callback(flow),env,{fetch:await tokenFetch(flow)});expect(response.status).toBe(302);expect(response.headers.get("location")).toBe("/toc");const session=response.headers.get("set-cookie")!.match(/(?:^|, )session=([^;]+)/)![1];expect(await env.SESSIONS.get(`session:${session}`)).toBe(u.email);expect(await(await finishMicrosoftLogin(callback(flow),env)).text()).toContain("session expired");});
  it("does not trust Microsoft email claims to attach an account",async()=>{const u=await user(),flow=await microsoftFlow();const response=await finishMicrosoftLogin(callback(flow),env,{fetch:await tokenFetch(flow,{email:u.email,preferred_username:u.email})});expect(response.headers.get("set-cookie")).not.toMatch(/(?:^|, )session=/);expect(await response.text()).toContain("Connect Microsoft to your existing account first");});
  it("rejects wrong nonce and missing browser binding",async()=>{const u=await user(),flow=await microsoftFlow(u.id);expect(await(await finishMicrosoftLogin(callback(flow),env,{fetch:await tokenFetch(flow,{nonce:"wrong"})})).text()).toContain("could not be verified");const another=await microsoftFlow(u.id);expect(await(await finishMicrosoftLogin(new Request(origin+`/auth/oauth/microsoft/web?state=${another.state}&code=x`),env)).text()).toContain("session expired");});
  it("rejects wrong issuer, audience, tenant and expiry",async()=>{
    for(const options of [{issuer:"https://attacker.example"},{audience:"different-client"},{expired:true}]) {
      const u=await user(),flow=await microsoftFlow(u.id);
      const response=await finishMicrosoftLogin(callback(flow),env,{fetch:await tokenFetch(flow,{},options)});
      expect(response.headers.get("set-cookie")).not.toMatch(/(?:^|, )session=/);
      expect(await response.text()).toContain("could not be verified");
    }
    const flow=await microsoftFlow();
    expect(await(await finishMicrosoftLogin(callback(flow),{...env,MICROSOFT_TENANT_ID:"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"},{fetch:await tokenFetch(flow)})).text()).toContain("invited to this instance");
  });
  it("requires a same-origin signed-in request to connect Microsoft",async()=>{
    const denied=await startMicrosoftLogin(new Request(origin+"/auth/oauth/microsoft/link",{method:"POST",headers:{Origin:"https://attacker.example"}}),env,true);
    expect(denied.status).toBe(403);
    const u=await user(),session=crypto.randomUUID();await env.SESSIONS.put(`session:${session}`,u.email);
    const response=await startMicrosoftLogin(new Request(origin+"/auth/oauth/microsoft/link",{method:"POST",headers:{Origin:origin,Cookie:`session=${session}`}}),env,true);
    expect(response.status).toBe(302);
    const state=new URL(response.headers.get("location")!).searchParams.get("state")!;
    const row=await env.DB.prepare("SELECT payload FROM oauth_login_states WHERE id = ?").bind(await sha256Hex(state)).first<{payload:string}>();
    const flow={state,browser:response.headers.get("set-cookie")!.split(";")[0]+`; session=${session}`,payload:JSON.parse(row!.payload)};
    expect(flow.payload.linkUserId).toBe(u.id);
    const linked=await finishMicrosoftLogin(callback(flow),env,{fetch:await tokenFetch(flow)});
    expect(linked.status).toBe(302);
    const identity=await env.DB.prepare("SELECT user_id FROM oauth_login_identities WHERE issuer = ? AND subject = ?").bind(issuer,flow.payload.nonce).first<{user_id:string}>();
    expect(identity?.user_id).toBe(u.id);
  });

  it("cancels a Microsoft connection after its initiating session changes",async()=>{
    const u=await user(),session=crypto.randomUUID(),replacement=crypto.randomUUID();
    await env.SESSIONS.put(`session:${session}`,u.email);await env.SESSIONS.put(`session:${replacement}`,u.email);
    const response=await startMicrosoftLogin(new Request(origin+"/auth/oauth/microsoft/link",{method:"POST",headers:{Origin:origin,Cookie:`session=${session}`}}),env,true);
    const state=new URL(response.headers.get("location")!).searchParams.get("state")!;
    const row=await env.DB.prepare("SELECT payload FROM oauth_login_states WHERE id = ?").bind(await sha256Hex(state)).first<{payload:string}>();
    const flow={state,browser:response.headers.get("set-cookie")!.split(";")[0]+`; session=${replacement}`,payload:JSON.parse(row!.payload)};
    const denied=await finishMicrosoftLogin(callback(flow),env,{fetch:await tokenFetch(flow)});
    expect(await denied.text()).toContain("Sign in to your existing account again");
    expect(await env.DB.prepare("SELECT user_id FROM oauth_login_identities WHERE issuer = ? AND subject = ?").bind(issuer,flow.payload.nonce).first()).toBeNull();
  });

});

describe("bounded and single-use sign-in proofs",()=>{
  it("only one concurrent email link/code redemption mints a session",async()=>{
    const u=await user(),flow=await issue(u.email);
    const results=await Promise.all([
      handleVerify(new Request(origin+`/auth/verify?token=${flow.token}`,{headers:{Cookie:flow.cookie}}),env),
      handleVerify(new Request(origin+`/auth/verify?token=${flow.token}`,{headers:{Cookie:flow.cookie}}),env),
    ]);
    expect(results.map(r=>r.status).sort()).toEqual([302,401]);
  });
  it("legacy invitation proofs cannot mint twice even if KV retains the token",async()=>{
    const u=await user(),token=crypto.randomUUID();await env.SESSIONS.put(`magic:${token}`,JSON.stringify({email:u.email,next:"/toc"}));
    const stale={...env,SESSIONS:new Proxy(env.SESSIONS,{get(target,prop:string){if(prop==="delete")return async()=>{};const value=(target as any)[prop];return typeof value === "function"?value.bind(target):value;}})};
    const responses=await Promise.all([handleVerify(new Request(origin+`/auth/verify?token=${token}`),stale),handleVerify(new Request(origin+`/auth/verify?token=${token}`),stale)]);
    expect(responses.filter(r=>Boolean(r.headers.get("Set-Cookie")))).toHaveLength(1);
  });
  it("rejects oversized streamed sign-in bodies before allocating a challenge",async()=>{
    const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(16_384));c.enqueue(new Uint8Array(1));c.close();}});
    const result=await handleLogin(new Request(origin+"/auth/login",{method:"POST",body:stream}),env);expect(result.status).toBe(400);
  });
  it("does not follow provider redirects or consume unbounded token responses",async()=>{
    const u=await user(),flow=await microsoftFlow(u.id);
    const exchange=vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{expect(init?.redirect).toBe("error");expect(init?.signal).toBeDefined();return new Response("x".repeat(65_537),{headers:{"Content-Type":"application/json"}});}) as unknown as typeof fetch;
    const denied=await finishMicrosoftLogin(callback(flow),env,{fetch:exchange});expect(denied.headers.get("Set-Cookie")).not.toMatch(/(?:^|, )session=/);expect(await denied.text()).toContain("could not be verified");
  });
  it("only one concurrent Microsoft callback exchanges its code",async()=>{
    const u=await user(),flow=await microsoftFlow(u.id),get=await tokenFetch(flow);
    const responses=await Promise.all([finishMicrosoftLogin(callback(flow),env,{fetch:get}),finishMicrosoftLogin(callback(flow),env,{fetch:get})]);
    expect(responses.filter(r=>r.status===302)).toHaveLength(1);expect(get).toHaveBeenCalledTimes(2); // one token request and one JWKS request
  });
});

it("atomically consumes Google assertions even across concurrent KV readers",async()=>{
  const u=await user(),pair=await generateKeyPair("RS256"),jwk=await exportJWK(pair.publicKey);jwk.kid="google-test";jwk.alg="RS256";
  const nonce=crypto.randomUUID(),token=await new SignJWT({email:u.email,email_verified:true,nonce:await sha256Hex(nonce)})
    .setProtectedHeader({alg:"RS256",kid:jwk.kid}).setIssuer("https://accounts.google.com").setAudience("google-test").setSubject(u.id).setIssuedAt().setExpirationTime("5m").sign(pair.privateKey);
  const target={...env,GOOGLE_WEB_CLIENT_ID:"google-test"};const deps={fetchJwks:async()=>({keys:[{...jwk,kty:"RSA"}]})};
  const results=await Promise.all([verifyProviderIdToken(target,"google",token,nonce,deps),verifyProviderIdToken(target,"google",token,nonce,deps)]);
  expect(results.filter(r=>r.ok)).toHaveLength(1);expect(results.filter(r=>!r.ok)).toHaveLength(1);
});
