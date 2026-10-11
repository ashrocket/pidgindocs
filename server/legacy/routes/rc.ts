import type { Env } from "../types";
import { verifyApiKey, verifySession, resolveApiKeyUser } from "../middleware";
import { json } from "../utils";

export interface RcCommand {
  id: string;
  type: "browser" | "visual" | "eval";
  action: string;
  params?: Record<string, unknown>;
  status: "pending" | "running" | "done" | "error";
  created_at: string;
}

interface RcResult {
  id: string;
  result?: unknown;
  error?: string;
  status: "done" | "error";
  completed_at: string;
}

const TTL = 600; // 10 minutes

async function authCheck(request: Request, env: Env): Promise<boolean> {
  if (verifyApiKey(request.headers, env.API_KEY)) return true;
  // Post-cutover, the master API_KEY isn't used day-to-day — accept a per-user
  // key belonging to the owner, matching the MCP + OAuth auth model. Scoped to
  // the owner because the rc queue is a single global KV key.
  const apiUser = await resolveApiKeyUser(request.headers, env);
  if (apiUser && apiUser.email.toLowerCase() === env.OWNER_EMAIL?.toLowerCase()) return true;
  // The session fallback must carry the same owner-only restriction as the API-key
  // branch above — this is a single global queue, not per-user. Without this check,
  // any other active user's browser session could poll/submit into the owner's
  // remote-control relay (steal pending commands, forge results, or enqueue new
  // "eval"/"browser" commands the owner's relay client would then execute).
  const session = await verifySession(request.headers, env.SESSIONS);
  return !!session && session.toLowerCase() === env.OWNER_EMAIL?.toLowerCase();
}

async function getQueue(env: Env): Promise<string[]> {
  const raw = await env.SESSIONS.get("rc:queue");
  return raw ? (JSON.parse(raw) as string[]) : [];
}

async function putQueue(env: Env, queue: string[]): Promise<void> {
  await env.SESSIONS.put("rc:queue", JSON.stringify(queue), { expirationTtl: TTL });
}

export async function handleRcCommand(request: Request, env: Env): Promise<Response> {
  if (!(await authCheck(request, env))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }

  const action = typeof body.action === "string" ? body.action.trim() : "";
  if (!action) {
    return json({ ok: false, error: "action required" }, 400);
  }

  const id = crypto.randomUUID();
  const command: RcCommand = {
    id,
    type:
      typeof body.type === "string" && ["browser", "visual", "eval"].includes(body.type)
        ? (body.type as RcCommand["type"])
        : "browser",
    action,
    params:
      body.params && typeof body.params === "object" && !Array.isArray(body.params)
        ? (body.params as Record<string, unknown>)
        : undefined,
    status: "pending",
    created_at: new Date().toISOString(),
  };

  await env.SESSIONS.put(`rc:cmd:${id}`, JSON.stringify(command), { expirationTtl: TTL });

  const queue = await getQueue(env);
  queue.push(id);
  await putQueue(env, queue);

  return json({ ok: true, data: { id } });
}

export async function handleRcPoll(request: Request, env: Env): Promise<Response> {
  if (!(await authCheck(request, env))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const queue = await getQueue(env);
  if (queue.length === 0) {
    return json({ ok: true, data: { command: null } });
  }

  // Walk queue to find a valid pending command
  let command: RcCommand | null = null;
  let remaining = queue;

  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    const raw = await env.SESSIONS.get(`rc:cmd:${id}`);
    if (!raw) continue; // expired

    const cmd = JSON.parse(raw) as RcCommand;
    if (cmd.status !== "pending") continue;

    cmd.status = "running";
    await env.SESSIONS.put(`rc:cmd:${id}`, JSON.stringify(cmd), { expirationTtl: TTL });
    remaining = [...queue.slice(0, i), ...queue.slice(i + 1)];
    command = cmd;
    break;
  }

  await putQueue(env, remaining);
  return json({ ok: true, data: { command } });
}

export async function handleRcSubmitResult(request: Request, env: Env, id: string): Promise<Response> {
  if (!(await authCheck(request, env))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }

  const result: RcResult = {
    id,
    result: body.result,
    error: typeof body.error === "string" ? body.error : undefined,
    status: body.error ? "error" : "done",
    completed_at: new Date().toISOString(),
  };

  await env.SESSIONS.put(`rc:result:${id}`, JSON.stringify(result), { expirationTtl: TTL });

  // Update command status
  const cmdRaw = await env.SESSIONS.get(`rc:cmd:${id}`);
  if (cmdRaw) {
    const cmd = JSON.parse(cmdRaw) as RcCommand;
    cmd.status = result.status;
    await env.SESSIONS.put(`rc:cmd:${id}`, JSON.stringify(cmd), { expirationTtl: TTL });
  }

  return json({ ok: true, data: {} });
}

export async function handleRcGetResult(request: Request, env: Env, id: string): Promise<Response> {
  if (!(await authCheck(request, env))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const resultRaw = await env.SESSIONS.get(`rc:result:${id}`);
  if (resultRaw) {
    return json({ ok: true, data: JSON.parse(resultRaw) as RcResult });
  }

  const cmdRaw = await env.SESSIONS.get(`rc:cmd:${id}`);
  if (!cmdRaw) {
    return json({ ok: false, error: "not found" }, 404);
  }

  const cmd = JSON.parse(cmdRaw) as RcCommand;
  return json({ ok: true, data: { id, status: cmd.status } });
}

export async function handleRcStatus(request: Request, env: Env): Promise<Response> {
  if (!(await authCheck(request, env))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const queue = await getQueue(env);
  return json({ ok: true, data: { pending: queue.length, queue } });
}
