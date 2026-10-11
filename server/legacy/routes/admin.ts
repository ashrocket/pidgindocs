import type { Env } from "../types";
import { json } from "../utils";
import { resolveAdminUser } from "../middleware";
import { createInviteCode } from "../invites";

// Write/DDL/transaction keywords plus load_extension (SELECT-prefixed RCE vector).
const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|begin|commit|rollback|truncate|load_extension)\b/i;

/** True only for a single read-only SELECT with no stacking, comments, or DML/DDL. */
export function isReadOnlySelect(sql: string): boolean {
  const trimmed = sql.trim().replace(/;\s*$/, ""); // allow one trailing semicolon
  if (!trimmed) return false;
  if (trimmed.includes(";")) return false;          // no statement stacking
  if (/--|\/\*|\*\//.test(trimmed)) return false;    // no comments
  if (!/^select\b/i.test(trimmed)) return false;     // must start with SELECT (no WITH)
  if (FORBIDDEN.test(trimmed)) return false;         // no write/DDL keywords anywhere
  return true;
}

async function requireAdmin(request: Request, env: Env) {
  return resolveAdminUser(request.headers, env);
}
const forbid = () => json({ ok: false, error: "admin only" }, 403);

const SQL_MAX_ROWS = 1000;

export async function handleAdminUsers(request: Request, env: Env): Promise<Response> {
  if (!(await requireAdmin(request, env))) return forbid();
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.email, u.status, u.invited_by, u.created_at,
            (SELECT count(*) FROM messages m WHERE m.user_id = u.id) AS message_count,
            (SELECT count(*) FROM instances i WHERE i.user_id = u.id) AS instance_count
       FROM users u ORDER BY u.created_at`
  ).all();
  return json({ ok: true, data: results });
}

export async function handleAdminUser(request: Request, env: Env, id: string): Promise<Response> {
  if (!(await requireAdmin(request, env))) return forbid();
  const row = await env.DB.prepare("SELECT id, email, status, invited_by, created_at FROM users WHERE id = ?").bind(id).first();
  if (!row) return json({ ok: false, error: "not found" }, 404);
  return json({ ok: true, data: row });
}

export async function handleAdminMessages(request: Request, env: Env): Promise<Response> {
  if (!(await requireAdmin(request, env))) return forbid();
  const url = new URL(request.url);
  const conds: string[] = []; const binds: (string | number)[] = [];
  const userId = url.searchParams.get("user_id");
  const type = url.searchParams.get("type");
  if (userId) { conds.push("user_id = ?"); binds.push(userId); }
  if (type) { conds.push("type = ?"); binds.push(type); }
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const { results } = await env.DB.prepare(
    `SELECT id, user_id, type, title, created_at, read_at, reply FROM messages ${where} ORDER BY created_at DESC LIMIT ?`
  ).bind(...binds, limit).all();
  return json({ ok: true, data: results });
}

export async function handleAdminStats(request: Request, env: Env): Promise<Response> {
  if (!(await requireAdmin(request, env))) return forbid();
  const row = await env.DB.prepare(
    `SELECT (SELECT count(*) FROM users) AS users,
            (SELECT count(*) FROM messages) AS messages,
            (SELECT count(*) FROM device_tokens) AS devices,
            (SELECT count(*) FROM instances) AS instances`
  ).first();
  return json({ ok: true, data: row });
}

export async function handleAdminSuspend(request: Request, env: Env, id: string, status: "suspended" | "active"): Promise<Response> {
  if (!(await requireAdmin(request, env))) return forbid();
  const res = await env.DB.prepare("UPDATE users SET status = ? WHERE id = ?").bind(status, id).run();
  if (!res.meta.changes) return json({ ok: false, error: "not found" }, 404);
  return json({ ok: true, data: { id, status } });
}

export async function handleAdminSql(request: Request, env: Env): Promise<Response> {
  if (!(await requireAdmin(request, env))) return forbid();
  let sql = "";
  try { ({ sql } = (await request.json()) as { sql: string }); } catch { return json({ ok: false, error: "invalid JSON body" }, 400); }
  if (typeof sql !== "string" || !isReadOnlySelect(sql)) return json({ ok: false, error: "only a single read-only SELECT is allowed" }, 400);
  const { results } = await env.DB.prepare(sql).all();
  const capped = Array.isArray(results) ? results.slice(0, SQL_MAX_ROWS) : results;
  return json({ ok: true, data: capped });
}

export async function handleAdminInvite(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (!admin) return forbid();
  // Mirror /admin/users/invite-code: single-use code stored the same way the
  // /join redemption path reads it (createInviteCode owns the KV key + payload).
  const code = await createInviteCode(env, admin.email);
  return json({ ok: true, data: { code } });
}
