import { Env } from "../types";
import { json } from "../utils";
import { resolveApiKeyUser, resolveCallerUserId, unauthorized } from "../middleware";

interface RegisterPayload {
  instance_id: string;
  model: string;
  project: string;
  working_on?: string;
  source: string;
}

export async function handleRegister(
  request: Request,
  env: Env
): Promise<Response> {
  const authedUser = await resolveApiKeyUser(request.headers, env);
  if (!authedUser) return unauthorized();

  let payload: RegisterPayload;
  try {
    payload = (await request.json()) as RegisterPayload;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  if (!payload.instance_id || !payload.model || !payload.project || !payload.source) {
    return json({ ok: false, error: "missing required fields" }, 400);
  }

  // Remove instances that haven't sent a heartbeat in 24h (stale cleanup on register)
  await env.DB.prepare(
    `DELETE FROM instances WHERE last_heartbeat < datetime('now', '-24 hours')`
  ).run();

  await env.DB.prepare(
    `INSERT INTO instances (instance_id, model, project, working_on, source, user_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(instance_id) DO UPDATE SET
       model = excluded.model,
       project = excluded.project,
       working_on = excluded.working_on,
       source = excluded.source,
       user_id = excluded.user_id,
       last_heartbeat = datetime('now')`
  )
    .bind(
      payload.instance_id,
      payload.model,
      payload.project,
      payload.working_on || null,
      payload.source,
      authedUser.userId
    )
    .run();

  await env.DB.prepare(
    `INSERT INTO audit_log (action, instance_id, details, user_id) VALUES (?, ?, ?, ?)`
  )
    .bind("register", payload.instance_id, `${payload.model} on ${payload.project}`, authedUser.userId)
    .run();

  return json({ ok: true, data: { instance_id: payload.instance_id } }, 201);
}

export async function handleGetRegistry(
  request: Request,
  env: Env
): Promise<Response> {
  const authedUser = await resolveApiKeyUser(request.headers, env);
  if (!authedUser) return unauthorized();

  const result = await env.DB.prepare(
    "SELECT * FROM instances WHERE user_id = ? ORDER BY last_heartbeat DESC"
  ).bind(authedUser.userId).all<{ instance_id: string; model: string; project: string; working_on: string | null; source: string; registered_at: string; last_heartbeat: string }>();

  const now = new Date().getTime();
  const instances = result.results.map((inst) => {
    const heartbeatAge = now - new Date(inst.last_heartbeat).getTime();
    return {
      ...inst,
      status: heartbeatAge < 5 * 60 * 1000 ? "live" : "stale",
    };
  });

  return json({ ok: true, data: instances });
}

export async function handleHeartbeat(
  request: Request,
  env: Env,
  instanceId: string
): Promise<Response> {
  // Scope to the caller's user_id: an instance is heartbeated by the same
  // identity that registered it, so resolve that id and only refresh a row we
  // own. instance_id is globally unique and re-registrable across tenants, so
  // without this a foreign id could refresh another user's instance.
  const authedUser = await resolveApiKeyUser(request.headers, env);
  if (!authedUser) return unauthorized();

  let working_on: string | null = null;
  try {
    const body = (await request.json()) as { working_on?: string };
    working_on = body.working_on ?? null;
  } catch {
    // body is optional for heartbeat
  }

  const result = await env.DB.prepare(
    `UPDATE instances SET last_heartbeat = datetime('now'), working_on = COALESCE(?, working_on)
     WHERE instance_id = ? AND user_id = ?`
  )
    .bind(working_on, instanceId, authedUser.userId)
    .run();

  if (result.meta.changes === 0) {
    return json({ ok: false, error: "instance not found" }, 404);
  }

  return json({ ok: true, data: { instance_id: instanceId, heartbeat: new Date().toISOString() } });
}

export async function handleGetInstance(
  request: Request,
  env: Env,
  instanceId: string
): Promise<Response> {
  // Dual-auth (web session OR API key); resolve to the caller's user_id and
  // scope the lookup so a foreign instance_id resolves to no row (404) rather
  // than leaking another tenant's instance metadata.
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  const row = await env.DB.prepare(
    "SELECT instance_id, model, project, working_on, source, registered_at, last_heartbeat FROM instances WHERE instance_id = ? AND user_id = ?"
  ).bind(instanceId, userId).first<{
    instance_id: string; model: string; project: string; working_on: string | null;
    source: string; registered_at: string; last_heartbeat: string;
  }>();

  if (!row) {
    return json({ ok: false, error: "instance not found" }, 404);
  }

  const heartbeatAge = Date.now() - new Date(row.last_heartbeat).getTime();
  return json({ ok: true, data: { ...row, status: heartbeatAge < 5 * 60 * 1000 ? "live" : "stale" } });
}

export async function handleDeregister(
  request: Request,
  env: Env,
  instanceId: string
): Promise<Response> {
  const authedUser = await resolveApiKeyUser(request.headers, env);
  if (!authedUser) return unauthorized();

  await env.DB.prepare(
    "DELETE FROM instances WHERE instance_id = ? AND user_id = ?"
  ).bind(instanceId, authedUser.userId).run();

  await env.DB.prepare(
    `INSERT INTO audit_log (action, instance_id, details, user_id) VALUES (?, ?, ?, ?)`
  ).bind("deregister", instanceId, "Session ended", authedUser.userId).run();

  return json({ ok: true, data: { removed: instanceId } });
}
