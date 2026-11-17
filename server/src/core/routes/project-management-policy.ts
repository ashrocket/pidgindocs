import { resolveCallerUserId, unauthorized } from "../middleware";
import { json } from "../utils";
import { PROJECT_MANAGEMENT_TEMPLATE, readProjectManagementPolicy, saveProjectManagementPolicy,
  userCanManageProjectPolicy, userCanReadProjectPolicy } from "../project-management-policy";
import type { Env } from "../types";

const MAX_POLICY_BYTES = 16_384;

export async function handleProjectManagementPolicy(request: Request, env: Env, projectId: string): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  if (!await userCanReadProjectPolicy(env, projectId, userId)) return json({ ok: false, error: "project not found" }, 404);
  const canManage = await userCanManageProjectPolicy(env, projectId, userId);
  if (request.method === "GET") {
    const policy = await readProjectManagementPolicy(env, projectId);
    const response = json({ ok: true, data: {
      policy: policy && (canManage || policy.enabled) ? policy : null,
      version: policy && (canManage || policy.enabled) ? policy.version : 0,
      can_manage: canManage,
      ...(canManage ? { template: PROJECT_MANAGEMENT_TEMPLATE } : {}),
    } });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
  if (request.method !== "PUT") return json({ ok: false, error: "method not allowed" }, 405);
  if (!canManage) return json({ ok: false, error: "forbidden" }, 403);
  let body: unknown;
  try { body = await request.json(); } catch { return json({ ok: false, error: "invalid JSON body" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "invalid policy" }, 400);
  const input = body as Record<string, unknown>;
  if (typeof input.enabled !== "boolean" || typeof input.version !== "number" ||
      !Number.isSafeInteger(input.version) || input.version < 0 || typeof input.body !== "string") {
    return json({ ok: false, error: "invalid policy" }, 400);
  }
  const content = input.body.replace(/\r\n?/g, "\n").trim();
  if (new TextEncoder().encode(content).byteLength > MAX_POLICY_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content) ||
      (input.enabled && content.length < 40)) {
    return json({ ok: false, error: "policy must be 40–16384 bytes of plain text when enabled" }, 400);
  }
  const result = await saveProjectManagementPolicy(env, {
    projectId, userId, expectedVersion: input.version, enabled: input.enabled, body: content,
  });
  if (result.conflict) return json({ ok: false, error: "policy changed; reload before saving" }, 409);
  if (!result.policy) return json({ ok: false, error: "project not found" }, 404);
  const response = json({ ok: true, data: { policy: result.policy } });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
