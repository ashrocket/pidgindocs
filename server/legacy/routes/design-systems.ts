import type { Env } from "../types";
import { json } from "../utils";
import { resolveCallerUserId, unauthorized } from "../middleware";
import { validateDesignSystem } from "../documents/design-system";
import {
  deleteDesignSystem,
  getDesignSystem,
  isReservedDesignSystemName,
  isValidDesignSystemName,
  listDesignSystems,
  putDesignSystem,
} from "../design-systems";

export async function handleListDesignSystems(request: Request, env: Env): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  const systems = await listDesignSystems(env, userId);
  return json({ ok: true, data: { design_systems: systems } });
}

export async function handleGetDesignSystem(request: Request, env: Env, name: string): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  const system = await getDesignSystem(env, userId, name);
  if (!system) return json({ ok: false, error: `design system "${name}" not found` }, 404);
  return json({
    ok: true,
    data: {
      design_system: {
        name: system.name,
        display_name: system.displayName,
        description: system.description,
        voice: system.voice,
        source: system.source,
        tokens: system.tokens,
        css: system.css,
      },
    },
  });
}

export async function handlePutDesignSystem(request: Request, env: Env, name: string): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  let body: { display_name?: string; description?: string; tokens?: unknown; css?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  const errors = validateDesignSystem({ tokens: body.tokens, css: body.css });
  if (errors.length) return json({ ok: false, error: errors.join("; ") }, 400);

  try {
    const summary = await putDesignSystem(env, userId, {
      name,
      displayName: body.display_name,
      description: body.description,
      tokens: body.tokens as Record<string, unknown>,
      css: body.css,
    });
    return json({ ok: true, data: { design_system: summary } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "save failed";
    return json({ ok: false, error: message }, 400);
  }
}

export async function handleDeleteDesignSystem(request: Request, env: Env, name: string): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  if (isReservedDesignSystemName(name)) {
    return json({ ok: false, error: `"${name}" is built-in and cannot be deleted` }, 400);
  }
  const deleted = await deleteDesignSystem(env, userId, name);
  if (!deleted) return json({ ok: false, error: `design system "${name}" not found` }, 404);
  return json({ ok: true, data: { name, deleted: true } });
}

export async function handleImportDesignSystem(request: Request, env: Env): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  let body: { name?: string; material?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const material = typeof body.material === "string" ? body.material.trim() : "";
  if (!name || !material) {
    return json({ ok: false, error: "name and material are required" }, 400);
  }
  if (!isValidDesignSystemName(name) || isReservedDesignSystemName(name)) {
    return json({ ok: false, error: "name must be kebab-case and not a built-in/reserved name" }, 400);
  }
  if (!env.ANTHROPIC_API_KEY) {
    return json({ ok: false, error: "design-system import requires ANTHROPIC_API_KEY on the server" }, 400);
  }
  await env.ENHANCE_QUEUE.send({ kind: "import", name, material, userId });
  return json({ ok: true, data: { name, status: "queued" } }, 202);
}
