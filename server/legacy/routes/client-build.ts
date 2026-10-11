import { Env } from "../types";
import { json } from "../utils";
import { resolveApiKeyUser, resolveCallerUserId, verifyApiKey, unauthorized } from "../middleware";

interface ClientBuildRow {
  platform: string;
  latest_build: number;
  latest_version: string | null;
  updated_at: string;
}

// GET /api/client-build?platform=ios — any authenticated caller (the apps use
// their session). Fields are null until the deploy script's first report.
export async function handleGetClientBuild(request: Request, env: Env): Promise<Response> {
  const callerUserId = await resolveCallerUserId(request, env);
  if (!callerUserId) return unauthorized();

  const platform = new URL(request.url).searchParams.get("platform") || "ios";
  const row = await env.DB.prepare(
    "SELECT platform, latest_build, latest_version, updated_at FROM client_builds WHERE platform = ?"
  ).bind(platform).first<ClientBuildRow>();

  return json({
    ok: true,
    data: {
      platform,
      latest_build: row?.latest_build ?? null,
      latest_version: row?.latest_version ?? null,
      updated_at: row?.updated_at ?? null,
    },
  });
}

// POST /api/client-build — deploy credential only: the value is server-wide,
// so only the owner's release tooling may set it. Post-cutover the master
// API_KEY isn't used day-to-day, so (matching rc.ts) the OWNER's per-user
// key is also accepted; other tenants' keys are not.
export async function handlePostClientBuild(request: Request, env: Env): Promise<Response> {
  let authorized = verifyApiKey(request.headers, env.API_KEY);
  if (!authorized) {
    const apiUser = await resolveApiKeyUser(request.headers, env);
    authorized = !!apiUser && apiUser.email.toLowerCase() === env.OWNER_EMAIL?.toLowerCase();
  }
  if (!authorized) return unauthorized();

  let body: { platform?: unknown; build?: unknown; version?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  const platform = typeof body.platform === "string" && body.platform.trim() ? body.platform.trim() : null;
  const build = typeof body.build === "number" ? body.build : parseInt(String(body.build), 10);
  if (!platform || !Number.isInteger(build) || build <= 0) {
    return json({ ok: false, error: '"platform" and a positive integer "build" are required' }, 400);
  }
  const version = typeof body.version === "string" && body.version.trim() ? body.version.trim() : null;

  await env.DB.prepare(
    `INSERT INTO client_builds (platform, latest_build, latest_version, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(platform) DO UPDATE SET
       latest_build = excluded.latest_build,
       latest_version = excluded.latest_version,
       updated_at = excluded.updated_at`
  ).bind(platform, build, version).run();

  return json({ ok: true, data: { platform, latest_build: build, latest_version: version } });
}
