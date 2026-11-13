// Pidgin core: Microsoft OIDC with PKCE and explicit account linking.
import { boundedText } from "../bounded-body";
import { createLocalJWKSet, decodeJwt, jwtVerify, type JSONWebKeySet } from "jose";
import type { Env } from "../types";
import { sha256Hex } from "../auth-utils";
import { checkRateLimit } from "../ratelimit";
import { SESSION_TTL_SECONDS, sessionMetadata, resolveSessionUserId } from "../middleware";
import { loginPage } from "../web/login";

const CALLBACK = "/auth/oauth/microsoft/web";
const COOKIE = "pidgin_ms_oauth";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clearCookie = `${COOKIE}=; Path=${CALLBACK}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
interface State { nonce:string; verifier:string; next:string; linkUserId?:string; linkSessionHash?:string; browserHash:string }
export interface MicrosoftDeps { fetch?:typeof fetch; now?:number }
function config(env:Env) {
  const tenant = env.MICROSOFT_TENANT_ID || "common";
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET || !(UUID.test(tenant) || ["common","organizations","consumers"].includes(tenant))) return null;
  const origin = new URL(env.WORKER_URL || "https://invalid.example").origin;
  return {tenant, client:env.MICROSOFT_CLIENT_ID, secret:env.MICROSOFT_CLIENT_SECRET, origin, redirect:origin+CALLBACK};
}
function safeNext(value:string|null, origin:string):string {
  try { const url = new URL(value || "/toc", origin); return url.origin === origin ? url.pathname+url.search+url.hash : "/toc"; } catch {return "/toc";}
}
const sessionToken = (request:Request) => request.headers.get("Cookie")?.match(/(?:^|;\s*)session=([^;]+)/)?.[1] || (request.headers.get("Authorization")?.startsWith("Session ") ? request.headers.get("Authorization")!.slice(8) : "");
const random = () => crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
async function challenge(verifier:string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}
export async function microsoftConnectPage(request:Request, env:Env):Promise<Response> {
  if (!config(env)) return loginPage(env,"Microsoft sign-in is not configured for this instance.");
  if (!await resolveSessionUserId(request,env)) return loginPage(env,undefined,"/auth/microsoft",{notice:"Sign in to your existing account, then connect Microsoft."});
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Microsoft · PidginDocs</title><style>body{font:16px/1.6 -apple-system,sans-serif;background:#FEFCF7;color:#102335;margin:0;padding:8vw}main{max-width:480px;margin:auto}h1{font:40px/1.1 Georgia,serif}button{font:inherit;background:#191b1c;color:white;border:0;border-radius:10px;padding:14px 24px;cursor:pointer}a{color:#1C5FC4}</style><main><h1>Connect Microsoft</h1><p>Use your Microsoft account to sign in to the PidginDocs account you are using now. Your documents and replies stay in this account.</p><form action="/auth/oauth/microsoft/link" method="POST"><button>Continue with Microsoft</button></form><p><a href="/toc">Back to your documents</a></p></main></html>`, {headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Content-Security-Policy":"frame-ancestors 'none'; base-uri 'none'; form-action 'self'","Referrer-Policy":"no-referrer"}});
}
export async function startMicrosoftLogin(request:Request, env:Env, link=false):Promise<Response> {
  const cfg=config(env);
  if (!cfg) return loginPage(env,"Microsoft sign-in is not configured for this instance.");
  const url=new URL(request.url);
  if (!await checkRateLimit(env,`microsoft:start:${request.headers.get("CF-Connecting-IP") || "unknown"}`,30,600)) return loginPage(env,"Too many sign-in attempts. Try again in a few minutes.");
  let linkUserId:string|null=null;
  if(link) {
    if(request.method !== "POST" || request.headers.get("Origin") !== cfg.origin) return new Response("Invalid connection request",{status:403});
    linkUserId=await resolveSessionUserId(request,env);
    if(!linkUserId) return loginPage(env,"Sign in first to connect Microsoft.","/auth/microsoft");
  }
  const state=random(), browser=random(), verifier=random(), nonce=random();
  const now=Math.floor(Date.now()/1000);
  const payload:State={nonce,verifier,next:link?"/toc":safeNext(url.searchParams.get("next"),cfg.origin),browserHash:await sha256Hex(browser),...(linkUserId?{linkUserId,linkSessionHash:await sha256Hex(sessionToken(request))}:{})};
  await env.DB.prepare("DELETE FROM oauth_login_states WHERE id IN (SELECT id FROM oauth_login_states WHERE expires_at <= ? LIMIT 100)").bind(now).run();
  await env.DB.prepare("INSERT INTO oauth_login_states (id,payload,expires_at) VALUES (?,?,?)").bind(await sha256Hex(state),JSON.stringify(payload),now+600).run();
  const authorize=new URL(`https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/authorize`);
  authorize.search=new URLSearchParams({client_id:cfg.client,response_type:"code",redirect_uri:cfg.redirect,response_mode:"query",scope:"openid profile",state,nonce,code_challenge:await challenge(verifier),code_challenge_method:"S256",prompt:"select_account"}).toString();
  return new Response(null,{status:302,headers:{Location:authorize.toString(),"Cache-Control":"no-store","Set-Cookie":`${COOKIE}=${browser}; Path=${CALLBACK}; HttpOnly; Secure; SameSite=Lax; Max-Age=600`}});
}

export async function finishMicrosoftLogin(request:Request, env:Env, deps:MicrosoftDeps={}):Promise<Response> {
  let returnTo:string|undefined;
  const fail=async(message:string) => { const response=await loginPage(env,message,returnTo);response.headers.append("Set-Cookie",clearCookie);return response; };
  const cfg=config(env);
  if(!cfg) return fail("Microsoft sign-in is not configured for this instance.");
  const url=new URL(request.url), state=url.searchParams.get("state")||"", code=url.searchParams.get("code");
  const browser=(request.headers.get("Cookie")||"").match(/(?:^|;\s*)pidgin_ms_oauth=([a-f0-9]{64})(?:;|$)/)?.[1];
  if(!/^[a-f0-9]{64}$/.test(state)||!browser) return fail("Your sign-in session expired. Start again.");
  const now=deps.now ?? Math.floor(Date.now()/1000);
  const stateId=await sha256Hex(state);
  const record=await env.DB.prepare("SELECT payload FROM oauth_login_states WHERE id = ? AND expires_at > ?").bind(stateId,now).first<{payload:string}>();
  if(!record) return fail("Your sign-in session expired. Start again.");
  const saved=JSON.parse(record.payload) as State;
  if(saved.browserHash !== await sha256Hex(browser)) return fail("Your sign-in session could not be verified. Start again.");
  returnTo=saved.next;
  const consumed=await env.DB.prepare("DELETE FROM oauth_login_states WHERE id = ? AND expires_at > ? RETURNING id").bind(stateId,now).first();
  if(!consumed) return fail("This sign-in has already been used. Start again.");
  if(!code || code.length > 8192 || url.searchParams.has("error")) return fail("Microsoft sign-in was cancelled. Choose a sign-in method to continue.");
  const get=deps.fetch || fetch;
  try {
    const exchanged=await get(`https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/token`,{method:"POST",redirect:"error",signal:AbortSignal.timeout(15_000),headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:cfg.client,client_secret:cfg.secret,grant_type:"authorization_code",code,redirect_uri:cfg.redirect,code_verifier:saved.verifier})});
    if(!exchanged.ok) return fail("Microsoft could not complete sign-in. Please try again.");
    const tokens=JSON.parse(await boundedText(exchanged, 65_536)) as {id_token?:string};
    if(typeof tokens.id_token !== "string" || tokens.id_token.length > 32_768) return fail("Microsoft did not return a sign-in token. Please try again.");
    // The unverified tenant selects only an allowlisted Microsoft issuer; it never authorizes a user.
    const tid=decodeJwt(tokens.id_token).tid;
    if(typeof tid !== "string" || !UUID.test(tid)) return fail("Microsoft returned an invalid tenant.");
    if(UUID.test(cfg.tenant) && tid.toLowerCase() !== cfg.tenant.toLowerCase()) return fail("Use the Microsoft account invited to this instance.");
    const personal="9188040d-6c67-4c5b-b112-36a304b66dad";
    if((cfg.tenant === "consumers" && tid !== personal)||(cfg.tenant === "organizations" && tid === personal)) return fail("Use a supported Microsoft account.");
    const issuer=`https://login.microsoftonline.com/${tid}/v2.0`;
    const keysResponse=await get(`https://login.microsoftonline.com/${tid}/discovery/v2.0/keys`,{redirect:"error",signal:AbortSignal.timeout(15_000)});
    if(!keysResponse.ok) return fail("Microsoft verification is temporarily unavailable. Try again.");
    const keys=JSON.parse(await boundedText(keysResponse, 262_144)) as JSONWebKeySet;
    const verified=await jwtVerify(tokens.id_token,createLocalJWKSet(keys),{issuer,audience:cfg.client,algorithms:["RS256"],requiredClaims:["exp","iat","sub","nonce","tid"],currentDate:new Date(now*1000)});
    const claims=verified.payload;
    if(claims.nonce !== saved.nonce || claims.tid !== tid || !claims.sub) return fail("Your Microsoft sign-in could not be verified. Start again.");
    let user=await env.DB.prepare("SELECT u.id,u.email FROM oauth_login_identities oi JOIN users u ON u.id = oi.user_id WHERE oi.issuer = ? AND oi.subject = ? AND u.status = 'active'").bind(issuer,claims.sub).first<{id:string;email:string}>();
    if(saved.linkUserId) {
      if(await resolveSessionUserId(request,env) !== saved.linkUserId || !saved.linkSessionHash || await sha256Hex(sessionToken(request)) !== saved.linkSessionHash) return fail("Sign in to your existing account again before connecting Microsoft.");
      if(user && user.id !== saved.linkUserId) return fail("This Microsoft account is connected to another account.");
      const active=await env.DB.prepare("SELECT id,email FROM users WHERE id = ? AND status = 'active'").bind(saved.linkUserId).first<{id:string;email:string}>();
      if(!active) return fail("Your account is no longer active.");
      await env.DB.prepare("INSERT INTO oauth_login_identities (issuer,subject,user_id) VALUES (?,?,?) ON CONFLICT(issuer,subject) DO NOTHING").bind(issuer,claims.sub,active.id).run();
      user=await env.DB.prepare("SELECT u.id,u.email FROM oauth_login_identities oi JOIN users u ON u.id = oi.user_id WHERE oi.issuer = ? AND oi.subject = ? AND u.status = 'active'").bind(issuer,claims.sub).first<{id:string;email:string}>();
      if(user?.id !== active.id) return fail("This Microsoft account is connected to another account.");
    }
    if(!user) return fail("Connect Microsoft to your existing account first. Use the Connect Microsoft link below.");
    await env.DB.prepare("INSERT INTO audit_log (action,details) VALUES (?,?)").bind(saved.linkUserId ? "identity_link" : "oauth_login",`microsoft ${saved.linkUserId ? "connection" : "sign-in"} for ${user.email}`).run();
    const session=crypto.randomUUID();
    await env.SESSIONS.put(`session:${session}`,user.email,{expirationTtl:SESSION_TTL_SECONDS,metadata:sessionMetadata()});
    const response=new Response(null,{status:302,headers:{Location:saved.next,"Cache-Control":"no-store"}});
    response.headers.append("Set-Cookie",clearCookie);
    response.headers.append("Set-Cookie",`session=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`);
    return response;
  } catch { return fail("Microsoft sign-in could not be verified. Please try again."); }
}
