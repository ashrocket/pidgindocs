import type { Env } from "../types";
import { sha256Hex } from "../auth-utils";
import { isEntraUser, resolveSessionUserId } from "../middleware";
import { createKeyForUser } from "./keys";
import { checkRateLimit } from "../ratelimit";
import { editionLoginPage, editionAccountActiveSql, editionProductName, editionTableNames, editionPublicSite } from "../edition-hooks";
import { deviceCodePattern, deviceCodeStart } from "../wire-names";
import { appPath, basePath } from "../base-path";

const EXPIRES_IN = 600;
const POLL_INTERVAL = 5;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const now = () => Math.floor(Date.now() / 1000);

function reply(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json", "Cache-Control": "no-store", "Pragma": "no-cache",
  } });
}

function html(content: string, status = 200): Response {
  // Browser form POSTs send Origin: null under no-referrer, which our
  // same-origin approval check correctly rejects. Keep referrers local.
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect ${editionProductName()} CLI</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#eaf2f2;color:#183c3c;font:16px/1.6 system-ui,sans-serif}main{width:100%;max-width:520px;background:#fff;border:1px solid #c6d9d6;border-radius:20px;padding:36px;box-shadow:0 18px 60px #2c636214}h1{font-size:28px;line-height:1.2;margin:0 0 18px}p{color:#465f5d}label{display:block;font-weight:650;margin:24px 0 8px}input{width:100%;padding:12px;font:inherit;letter-spacing:.1em;text-transform:uppercase;border:1px solid #88aaa5;border-radius:8px}button{margin-top:16px;padding:12px 18px;border:0;border-radius:8px;background:#2c6362;color:#fff;font:inherit;font-weight:650;cursor:pointer}button.secondary{background:#fff;color:#2c6362;border:1px solid #2c6362;margin-right:8px}button:focus-visible,input:focus-visible{outline:3px solid #d9b88f;outline-offset:3px}code{font-size:24px;letter-spacing:.08em;color:#183c3c}.error{color:#9a2d2d}small{display:block;margin-top:22px;color:#526c69}@media(max-width:480px){main{padding:26px}}</style></head><body><main>${content}</main></body></html>`, {
    status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "same-origin", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" },
  });
}

function sessionToken(request: Request): string {
  return request.headers.get("Cookie")?.match(/(?:^|;\s*)session=([^;]+)/)?.[1] || "";
}

async function nativeSession(request: Request, env: Env): Promise<{ token: string; userId: string } | null> {
  const authorization = request.headers.get("Authorization") || "";
  if (!/^Session [A-Za-z0-9._-]+$/.test(authorization)) return null;
  // Resolve this header alone. A cookie in a shared URLSession must never
  // change which account approves the request.
  const sessionRequest = new Request(request.url, { headers: { Authorization: authorization } });
  const userId = await resolveSessionUserId(sessionRequest, env);
  return userId ? { token: authorization.slice(8), userId } : null;
}

function normalizedCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-9]/g, "");
}

function userCode(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, value => CODE_ALPHABET[value & 31]).join("");
}

function origin(request: Request, env: Env): string {
  return new URL(env.WORKER_URL || request.url).origin;
}

// The address a person opens: the origin, and for a path deployment (BASE_PATH=/alice) the prefix too.
function appRoot(request: Request, env: Env): string {
  return origin(request, env) + basePath(env);
}

export async function handleDeviceLoginStart(request: Request, env: Env): Promise<Response> {
  const tables = editionTableNames();
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!await checkRateLimit(env, `device-start:${ip}`, 10, 3600)) return reply({ error: "slow_down" }, 429);
  const deviceCode = deviceCodeStart() + crypto.randomUUID() + crypto.randomUUID();
  const code = userCode();
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM ${tables.deviceLogins} WHERE expires_at<=?`).bind(timestamp),
    env.DB.prepare(`INSERT INTO ${tables.deviceLogins}(device_hash,user_code_hash,expires_at) VALUES (?,?,?)`)
      .bind(await sha256Hex(deviceCode), await sha256Hex(code), timestamp + EXPIRES_IN),
  ]);
  return reply({ device_code: deviceCode, user_code: `${code.slice(0, 5)}-${code.slice(5)}`, verification_uri: `${appRoot(request, env)}/auth/device`, expires_in: EXPIRES_IN, interval: POLL_INTERVAL });
}

export async function handleDeviceLoginPage(request: Request, env: Env): Promise<Response> {
  const tables = editionTableNames();
  const url = new URL(request.url);
  const code = normalizedCode(url.searchParams.get("user_code") || "");
  if (!url.searchParams.has("user_code")) return html(`<h1>Connect ${editionProductName()} CLI</h1><p>Enter the code shown in your terminal.</p><form method="get" action="${appPath(env, "/auth/device")}"><label for="code">Device code</label><input id="code" name="user_code" autocomplete="off" required maxlength="11"><button type="submit">Continue</button></form><small>Only approve a login you started yourself.</small>`);
  if (!new RegExp(`^[${CODE_ALPHABET}]{10}$`).test(code)) return html(`<h1>Code not found</h1><p class="error">Check the code in your terminal and try again.</p><a href="${appPath(env, "/auth/device")}">Enter another code</a>`, 400);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!await checkRateLimit(env, `device-lookup:${ip}`, 15, 600)) return html('<h1>Too many attempts</h1><p>Try again later.</p>', 429);
  const codeHash = await sha256Hex(code);
  const row = await env.DB.prepare(`SELECT status FROM ${tables.deviceLogins} WHERE user_code_hash=? AND expires_at>?`)
    .bind(codeHash, now()).first<{ status: string }>();
  if (!row || row.status !== "pending") return html('<h1>Code unavailable</h1><p class="error">This code expired or was already used. Start again in your terminal.</p>', 400);
  const userId = await resolveSessionUserId(request, env);
  if (!userId) {
    const next = `/auth/device?user_code=${encodeURIComponent(code)}`;
    if (editionPublicSite(env)) return Response.redirect(`${origin(request, env)}/signin?next=${encodeURIComponent(next)}`, 302);
    return editionLoginPage(env, undefined, next);
  }
  const session = sessionToken(request);
  if (!session) return reply({ error: "login_required" }, 401);
  const csrf = crypto.randomUUID() + crypto.randomUUID();
  await env.DB.prepare(`UPDATE ${tables.deviceLogins} SET csrf_hash=?,session_hash=? WHERE user_code_hash=? AND status='pending' AND expires_at>?`)
    .bind(await sha256Hex(csrf), await sha256Hex(session), codeHash, now()).run();
  const displayCode = `${code.slice(0, 5)}-${code.slice(5)}`;
  return html(`<h1>Allow ${editionProductName()} CLI access?</h1><p>Confirm that this code matches the terminal where you started login:</p><p><code>${displayCode}</code></p><p>${editionProductName()} CLI will receive an API key for your account. It can read and publish content using your permissions. You can revoke it from your account's API keys.</p><form method="post" action="${appPath(env, "/auth/device")}"><input type="hidden" name="user_code" value="${code}"><input type="hidden" name="csrf" value="${csrf}"><button class="secondary" name="decision" value="deny" type="submit">Deny</button><button name="decision" value="allow" type="submit">Allow access</button></form><small>Only approve if you started this login and the codes match.</small>`);
}

export async function handleDeviceLoginDecision(request: Request, env: Env): Promise<Response> {
  const tables = editionTableNames();
  if (request.headers.get("Origin") !== origin(request, env)) return html('<h1>Invalid request</h1>', 403);
  const userId = await resolveSessionUserId(request, env);
  const session = sessionToken(request);
  if (!userId || !session) return html('<h1>Sign in required</h1>', 401);
  let form: FormData;
  try { form = await request.formData(); } catch { return html('<h1>Invalid request</h1>', 400); }
  const code = normalizedCode(String(form.get("user_code") || ""));
  const csrf = form.get("csrf"), decision = form.get("decision");
  if (![...form.keys()].every(key => ["user_code", "csrf", "decision"].includes(key)) ||
    !new RegExp(`^[${CODE_ALPHABET}]{10}$`).test(code) || typeof csrf !== "string" ||
    (decision !== "allow" && decision !== "deny")) return html('<h1>Invalid request</h1>', 400);
  const claimed = await env.DB.prepare(`UPDATE ${tables.deviceLogins} SET status=?,user_id=?,csrf_hash=NULL,session_hash=NULL
    WHERE user_code_hash=? AND csrf_hash=? AND session_hash=? AND status='pending' AND expires_at>?
    RETURNING device_hash`)
    .bind(decision === "allow" ? "approved" : "denied", userId, await sha256Hex(code), await sha256Hex(csrf), await sha256Hex(session), now()).first();
  if (!claimed) return html('<h1>Code unavailable</h1><p>This code expired or was already used. Start again in your terminal.</p>', 400);
  return html(decision === "allow"
    ? '<h1>Access approved</h1><p>You can return to your terminal. The login will finish there.</p>'
    : '<h1>Connection denied</h1><p>The terminal will not receive access.</p>');
}

// The Mac app already owns a human session. These JSON endpoints let it
// approve a CLI code without requiring a separate browser cookie. Both the
// short-lived approval token and the app session must match at decision time.
export async function handleNativeDeviceLoginInspect(request: Request, env: Env): Promise<Response> {
  const tables = editionTableNames();
  const session = await nativeSession(request, env);
  if (!session) return reply({ error: "login_required" }, 401);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!await checkRateLimit(env, `device-lookup:${ip}`, 15, 600)) return reply({ error: "slow_down" }, 429);
  let body: unknown;
  try { body = await request.json(); } catch { return reply({ error: "invalid_request" }, 400); }
  const input = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).user_code : null;
  if (typeof input !== "string" || input.length > 20) return reply({ error: "invalid_request" }, 400);
  const code = normalizedCode(input);
  if (!new RegExp(`^[${CODE_ALPHABET}]{10}$`).test(code)) return reply({ error: "invalid_code" }, 400);
  const codeHash = await sha256Hex(code), timestamp = now();
  const row = await env.DB.prepare(`SELECT status,expires_at FROM ${tables.deviceLogins} WHERE user_code_hash=? AND expires_at>?`)
    .bind(codeHash, timestamp).first<{ status: string; expires_at: number }>();
  if (!row || row.status !== "pending") return reply({ error: "expired_token" }, 400);
  const approvalToken = crypto.randomUUID() + crypto.randomUUID();
  const updated = await env.DB.prepare(`UPDATE ${tables.deviceLogins} SET csrf_hash=?,session_hash=? WHERE user_code_hash=? AND status='pending' AND expires_at>? RETURNING device_hash`)
    .bind(await sha256Hex(approvalToken), await sha256Hex(session.token), codeHash, timestamp).first();
  if (!updated) return reply({ error: "expired_token" }, 400);
  return reply({ ok: true, data: { user_code: `${code.slice(0, 5)}-${code.slice(5)}`, approval_token: approvalToken, expires_in: row.expires_at - timestamp } });
}

export async function handleNativeDeviceLoginDecision(request: Request, env: Env): Promise<Response> {
  const tables = editionTableNames();
  const session = await nativeSession(request, env);
  if (!session) return reply({ error: "login_required" }, 401);
  let body: unknown;
  try { body = await request.json(); } catch { return reply({ error: "invalid_request" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ error: "invalid_request" }, 400);
  const { user_code: input, approval_token: approvalToken, decision } = body as Record<string, unknown>;
  if (typeof input !== "string" || input.length > 20 || typeof approvalToken !== "string" ||
    approvalToken.length !== 72 || (decision !== "allow" && decision !== "deny")) return reply({ error: "invalid_request" }, 400);
  const code = normalizedCode(input);
  if (!new RegExp(`^[${CODE_ALPHABET}]{10}$`).test(code)) return reply({ error: "invalid_request" }, 400);
  const status = decision === "allow" ? "approved" : "denied";
  const claimed = await env.DB.prepare(`UPDATE ${tables.deviceLogins} SET status=?,user_id=?,csrf_hash=NULL,session_hash=NULL
    WHERE user_code_hash=? AND csrf_hash=? AND session_hash=? AND status='pending' AND expires_at>?
    RETURNING device_hash`)
    .bind(status, session.userId, await sha256Hex(code), await sha256Hex(approvalToken), await sha256Hex(session.token), now()).first();
  if (!claimed) return reply({ error: "expired_token" }, 400);
  return reply({ ok: true, data: { status } });
}

export async function handleDeviceLoginPoll(request: Request, env: Env): Promise<Response> {
  const tables = editionTableNames();
  let form: FormData;
  try { form = await request.formData(); } catch { return reply({ error: "invalid_request" }, 400); }
  const deviceCode = form.get("device_code");
  if (typeof deviceCode !== "string") return reply({ error: "invalid_request" }, 400);
  if (!deviceCodePattern().test(deviceCode)) return reply({ error: "invalid_request" }, 400);
  const hash = await sha256Hex(deviceCode), timestamp = now();
  const row = await env.DB.prepare(`SELECT status,user_id,last_poll_at FROM ${tables.deviceLogins} WHERE device_hash=? AND expires_at>?`)
    .bind(hash, timestamp).first<{ status: string; user_id: string | null; last_poll_at: number }>();
  if (!row) return reply({ error: "expired_token" }, 400);
  if (row.last_poll_at > timestamp - POLL_INTERVAL) return reply({ error: "slow_down" }, 400);
  const polled = await env.DB.prepare(`UPDATE ${tables.deviceLogins} SET last_poll_at=? WHERE device_hash=? AND last_poll_at<=? AND expires_at>? RETURNING status`)
    .bind(timestamp, hash, timestamp - POLL_INTERVAL, timestamp).first();
  if (!polled) return reply({ error: "slow_down" }, 400);
  if (row.status === "pending") return reply({ error: "authorization_pending" }, 400);
  const claimed = await env.DB.prepare(`DELETE FROM ${tables.deviceLogins} WHERE device_hash=? AND status=? AND expires_at>? RETURNING user_id`)
    .bind(hash, row.status, timestamp).first<{ user_id: string | null }>();
  if (!claimed) return reply({ error: "expired_token" }, 400);
  if (row.status === "denied") return reply({ error: "access_denied" }, 400);
  const user = await env.DB.prepare(`SELECT id FROM users WHERE id=? AND status='active' AND ${editionAccountActiveSql()}`)
    .bind(claimed.user_id).first<{ id: string }>();
  if (!user || !await isEntraUser(env, user.id)) return reply({ error: "access_denied" }, 400);
  const key = await createKeyForUser(env, user.id, `${editionProductName()} CLI device login`);
  if ("error" in key) return reply({ error: key.error === "limit" ? "key_limit" : "slow_down" }, key.error === "limit" ? 409 : 429);
  return reply({ ok: true, data: key });
}
