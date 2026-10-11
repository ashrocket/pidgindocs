import type { Env } from "../types";
import { json } from "../utils";
import { resolveCallerUserId, unauthorized } from "../middleware";
import { loadLibraryPlacements } from "../library";
import { sendPushNotification } from "../push/apns";
import { checkRateLimit } from "../ratelimit";
import {
  ArtifactConflictError,
  ArtifactInputError,
  artifactUrl,
  deleteArtifact,
  getArtifactById,
  listArtifactVersions,
  listArtifacts,
  loadArtifactVersionContent,
  patchArtifact,
  publishArtifact,
  serializeArtifact,
  serializeArtifactVersion,
  signArtifactToken,
  verifyArtifactEmbedToken,
  verifyArtifactToken,
  type ArtifactRow,
} from "../artifacts/store";
import { artifactCsp, designSystemStyleBlock, wrapArtifactHtml } from "../artifacts/render";
import { getDesignSystem } from "../design-systems";
import { compileDesignSystem } from "../documents/design-system";

const ONE_HOUR_MS = 60 * 60 * 1000;

interface PublishBody {
  html?: string;
  markdown?: string;
  title?: string;
  description?: string;
  favicon?: string;
  label?: string;
  artifact_id?: string;
  source_path?: string;
  base_version?: number;
  force?: boolean;
  visibility?: "private" | "public";
  role?: "page" | "widget";
  capabilities?: Record<string, unknown> | null;
  design_system?: string | null;
  notify?: boolean;
  instance?: { session_id?: string; project?: string };
  team_id?: string;
  project_id?: string;
}

// POST /api/artifacts — publish a new artifact or a new version of an
// existing one (identity: artifact_id > (user, source_path) > new).
export async function handlePublishArtifact(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  let body: PublishBody;
  try {
    body = (await request.json()) as PublishBody;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  if (body.notify !== undefined && typeof body.notify !== "boolean") {
    return json({ ok: false, error: '"notify" must be a boolean' }, 400);
  }

  try {
    const result = await publishArtifact(env, {
      html: body.html,
      markdown: body.markdown,
      title: body.title,
      description: body.description,
      favicon: body.favicon,
      label: body.label,
      artifactId: body.artifact_id,
      sourcePath: body.source_path,
      baseVersion: typeof body.base_version === "number" ? body.base_version : undefined,
      force: body.force === true,
      visibility: body.visibility,
      role: body.role,
      capabilities: body.capabilities,
      designSystem: body.design_system,
      sessionId: body.instance?.session_id,
      project: body.instance?.project,
      teamId: body.team_id,
      projectId: body.project_id,
      userId,
    });

    // Omitted keeps legacy behavior; explicit false makes first-publish quiet
    // for child widgets; true forces a notification for any publish.
    const shouldPush = body.notify === true || (body.notify === undefined && result.created);
    if (shouldPush) {
      const pushTitle = result.created ? result.artifact.title : `${result.artifact.title} (v${result.version})`;
      const pushBody = result.artifact.description || (result.created ? "New artifact" : "Artifact updated");
      const push = sendPushNotification(env, pushTitle, pushBody, result.artifact.id, "artifact", userId)
        .catch(() => {});
      if (ctx) ctx.waitUntil(push);
      else await push;
    }

    return json(
      {
        ok: true,
        data: {
          id: result.artifact.id,
          url: artifactUrl(env, result.artifact.id),
          version: result.version,
          title: result.artifact.title,
          created: result.created,
          artifact: serializeArtifact(env, result.artifact),
        },
      },
      result.created ? 201 : 200
    );
  } catch (err) {
    if (err instanceof ArtifactConflictError) {
      return json({ ok: false, error: err.message }, 409);
    }
    if (err instanceof ArtifactInputError) {
      return json({ ok: false, error: err.message }, err.message === "artifact not found" ? 404 : 400);
    }
    throw err;
  }
}

// GET /api/artifacts?limit=&cursor=&q=&scope=
export async function handleListArtifacts(request: Request, env: Env): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  const url = new URL(request.url);
  const rawLimit = parseInt(url.searchParams.get("limit") || "25", 10);
  const scopeParam = url.searchParams.get("scope");
  const scope =
    scopeParam === "mine" || scopeParam === "shared" || scopeParam === "all" ? scopeParam : "mine";
  const roleParam = url.searchParams.get("role");
  const role =
    roleParam === "page" || roleParam === "widget" || roleParam === "all"
      ? roleParam
      : "page";

  const page = await listArtifacts(env, {
    userId,
    limit: Number.isNaN(rawLimit) ? 25 : rawLimit,
    cursor: url.searchParams.get("cursor") || undefined,
    q: url.searchParams.get("q") || undefined,
    scope,
    role,
    libraryProject: url.searchParams.get("library_project") || undefined,
    libraryTag: url.searchParams.get("library_tag") || undefined,
  });
  const placements = await loadLibraryPlacements(
    env,
    userId,
    page.artifacts.map((a) => ({ type: "artifact" as const, id: a.id }))
  );

  return json({
    ok: true,
    data: {
      artifacts: page.artifacts.map((a) => serializeArtifact(env, a, placements.get(`artifact:${a.id}`))),
      next_cursor: page.nextCursor,
      has_more: page.hasMore,
    },
  });
}

// GET /api/artifacts/:id — metadata + version history (owner-only).
export async function handleGetArtifactMeta(
  request: Request,
  env: Env,
  id: string
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  const row = await getArtifactById(env, id);
  if (!row || row.user_id !== userId) {
    return json({ ok: false, error: "artifact not found" }, 404);
  }
  const versions = await listArtifactVersions(env, id);
  const placements = await loadLibraryPlacements(env, userId, [{ type: "artifact", id }]);
  return json({
    ok: true,
    data: {
      artifact: serializeArtifact(env, row, placements.get(`artifact:${id}`)),
      versions: versions.map(serializeArtifactVersion),
    },
  });
}

// PATCH /api/artifacts/:id — visibility / shared_version / title / description.
export async function handlePatchArtifact(
  request: Request,
  env: Env,
  id: string
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  let body: {
    title?: string;
    description?: string | null;
    visibility?: "private" | "public";
    shared_version?: number | null;
    design_system?: string | null;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  try {
    const row = await patchArtifact(env, id, userId, {
      title: body.title,
      description: body.description,
      visibility: body.visibility,
      sharedVersion: body.shared_version,
      designSystem: body.design_system,
    });
    if (!row) return json({ ok: false, error: "artifact not found" }, 404);
    return json({ ok: true, data: { artifact: serializeArtifact(env, row) } });
  } catch (err) {
    if (err instanceof ArtifactInputError) {
      return json({ ok: false, error: err.message }, 400);
    }
    throw err;
  }
}

// DELETE /api/artifacts/:id — destructive: versions, storage, R2 objects.
export async function handleDeleteArtifact(
  request: Request,
  env: Env,
  id: string
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  const deleted = await deleteArtifact(env, id, userId);
  if (!deleted) return json({ ok: false, error: "artifact not found" }, 404);
  return json({ ok: true, data: { deleted: true } });
}

// POST /api/artifacts/:id/share — public artifacts return their page URL;
// private ones get a one-hour signed magic link (mirrors document sharing).
export async function handleShareArtifact(
  request: Request,
  env: Env,
  id: string
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();

  const row = await getArtifactById(env, id);
  if (!row || row.user_id !== userId) {
    return json({ ok: false, error: "artifact not found" }, 404);
  }

  if (row.visibility === "public") {
    return json({ ok: true, data: { url: artifactUrl(env, id), expires_at: null } });
  }

  const expiresAt = Date.now() + ONE_HOUR_MS;
  const token = await signArtifactToken(id, expiresAt, env.DOC_SHARE_SECRET ?? env.API_KEY);
  return json({
    ok: true,
    data: {
      url: `${artifactUrl(env, id)}?token=${token}&expires=${expiresAt}`,
      expires_at: Math.floor(expiresAt / 1000),
    },
  });
}

// POST /api/artifacts/telemetry — low-cardinality inline-widget health events.
// The message/artifact association and caller ownership are checked before the
// event is accepted, so arbitrary artifact ids cannot be used as a write sink.
export async function handleArtifactTelemetry(request: Request, env: Env): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  let body: {
    message_id?: string;
    artifact_id?: string;
    event?: "loaded" | "failed" | "opened_fullscreen";
    duration_ms?: number | null;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  if (
    !body.message_id ||
    !body.artifact_id ||
    !body.event ||
    !["loaded", "failed", "opened_fullscreen"].includes(body.event)
  ) {
    return json({ ok: false, error: "message_id, artifact_id, and valid event are required" }, 400);
  }
  const association = await env.DB.prepare(
    `SELECT 1 AS found FROM message_blocks b
     JOIN messages m ON m.id = b.message_id
     WHERE b.message_id = ? AND b.artifact_id = ? AND m.user_id = ? LIMIT 1`
  )
    .bind(body.message_id, body.artifact_id, userId)
    .first<{ found: number }>();
  if (!association) return json({ ok: false, error: "artifact block not found" }, 404);

  const duration =
    typeof body.duration_ms === "number" && Number.isFinite(body.duration_ms)
      ? Math.max(0, Math.min(300_000, Math.round(body.duration_ms)))
      : null;
  await env.DB.prepare(
    `INSERT INTO artifact_embed_events (user_id, message_id, artifact_id, event, duration_ms)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(userId, body.message_id, body.artifact_id, body.event, duration)
    .run();
  return json({ ok: true, data: { recorded: true } }, 202);
}

// Shared auth ladder for the page + runtime endpoints. Returns the row and
// whether the caller is the owner, or the error Response to send instead.
async function authorizeArtifactViewer(
  request: Request,
  env: Env,
  id: string
): Promise<{ row: ArtifactRow; isOwner: boolean } | Response> {
  const row = await getArtifactById(env, id);
  if (!row) return json({ ok: false, error: "artifact not found" }, 404);

  const callerUserId = await resolveCallerUserId(request, env);
  const isOwner = callerUserId !== null && callerUserId === row.user_id;
  if (row.visibility === "public" || isOwner) return { row, isOwner };

  // Signed magic link — anyone with the link may view (cross-user).
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const expires = url.searchParams.get("expires");
  if (token && expires) {
    const expiresNum = parseInt(expires, 10);
    if (
      !isNaN(expiresNum) &&
      (await verifyArtifactToken(id, expiresNum, token, env.DOC_SHARE_SECRET ?? env.API_KEY))
    ) {
      return { row, isOwner: false };
    }
  }

  // Same 404 for anonymous and foreign callers — no existence leak.
  if (!callerUserId) return unauthorized();
  return json({ ok: false, error: "artifact not found" }, 404);
}

// GET /a/:id[?v=N] — serve the wrapped page under the strict artifact CSP.
export async function handleServeArtifact(
  request: Request,
  env: Env,
  id: string
): Promise<Response> {
  const url = new URL(request.url);
  const isEmbed = url.searchParams.get("embed") === "1";
  let embedVersion: number | null = null;
  let embedNonce: string | null = null;
  let row: ArtifactRow;
  let isOwner = false;

  if (isEmbed) {
    const configuredEmbedOrigin = env.ARTIFACT_EMBED_ORIGIN;
    if (!configuredEmbedOrigin || url.origin !== new URL(configuredEmbedOrigin).origin) {
      return json({ ok: false, error: "artifact not found" }, 404);
    }

    const version = parseInt(url.searchParams.get("v") || "", 10);
    const messageId = url.searchParams.get("message") || "";
    const expires = parseInt(url.searchParams.get("expires") || "", 10);
    const token = url.searchParams.get("token") || "";
    embedNonce = url.searchParams.get("nonce") || "";
    if (
      !Number.isInteger(version) ||
      version < 1 ||
      !messageId ||
      !token ||
      !embedNonce ||
      !Number.isFinite(expires) ||
      !(await verifyArtifactEmbedToken(
        id,
        version,
        messageId,
        expires,
        token,
        env.DOC_SHARE_SECRET ?? env.API_KEY
      ))
    ) {
      return json({ ok: false, error: "artifact not found" }, 404);
    }

    const association = await env.DB.prepare(
      `SELECT a.* FROM message_blocks b
       JOIN messages m ON m.id = b.message_id
       JOIN artifacts a ON a.id = b.artifact_id
       WHERE b.message_id = ? AND b.artifact_id = ? AND b.artifact_version = ?
         AND m.user_id = a.user_id
       LIMIT 1`
    )
      .bind(messageId, id, version)
      .first<ArtifactRow>();
    if (!association) return json({ ok: false, error: "artifact not found" }, 404);
    row = association;
    embedVersion = version;
  } else {
    const authed = await authorizeArtifactViewer(request, env, id);
    if (authed instanceof Response) return authed;
    row = authed.row;
    isOwner = authed.isOwner;
  }

  const vParam = url.searchParams.get("v");
  // Non-owners see the pinned shared_version (or latest); the version picker
  // is an owner affordance.
  const effectiveVersion = row.shared_version ?? row.current_version;
  let version = embedVersion ?? (isOwner ? row.current_version : effectiveVersion);
  if (vParam) {
    const requested = parseInt(vParam, 10);
    if (isNaN(requested) || requested < 1) {
      return json({ ok: false, error: "invalid version" }, 400);
    }
    if (isEmbed && requested !== embedVersion) {
      return json({ ok: false, error: "artifact not found" }, 404);
    }
    if (!isEmbed && !isOwner && requested !== effectiveVersion) {
      return json({ ok: false, error: "artifact not found" }, 404);
    }
    version = requested;
  }

  const content = await loadArtifactVersionContent(env, id, version);
  if (content === null) {
    return json({ ok: false, error: "version not found (older versions are pruned)" }, 404);
  }

  // Server-backed runtime capabilities intentionally remain full-viewer only
  // in inline mode. Authored JavaScript and Mermaid continue to work.
  const hasCapabilities = Boolean(row.capabilities) && !isEmbed;

  // Declared design system → variable-override layer. Resolution is against
  // the OWNER's style stack (viewers may be anonymous share-link holders). A
  // style deleted since it was declared — or one whose stored tokens no
  // longer load or compile — degrades to the house defaults rather than 500.
  let designSystemCss: string | undefined;
  if (row.design_system) {
    try {
      const def = await getDesignSystem(env, row.user_id, row.design_system);
      if (def) designSystemCss = designSystemStyleBlock(compileDesignSystem(def));
    } catch {
      // deleted/corrupt/invalid stored style: serve unstyled
    }
  }

  const wrapped = wrapArtifactHtml({
    content,
    title: row.title,
    favicon: row.favicon,
    artifactId: id,
    sourceKind: row.source_kind,
    hasCapabilities,
    designSystemCss,
    embed:
      isEmbed && embedNonce
        ? {
            version,
            nonce: embedNonce,
            parentOrigin: new URL(env.WORKER_URL).origin,
          }
        : undefined,
  });

  const isPinned = Boolean(vParam);
  const isPublic = row.visibility === "public";
  return new Response(wrapped, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": artifactCsp(
        hasCapabilities,
        isEmbed ? new URL(env.WORKER_URL).origin : "'none'"
      ),
      "Referrer-Policy": "no-referrer",
      // Latest must stay fresh (artifacts update in place). A pinned version's
      // CONTENT is immutable, but the served page is not: the artifact-level
      // design_system (and the style it names) can change under it, so pinned
      // responses get a bounded max-age instead of a day.
      "Cache-Control": isEmbed
        ? "private, no-store"
        : isPinned
          ? isPublic
            ? "public, max-age=300"
            : "private, max-age=300"
          : isPublic
            ? "public, max-age=60"
            : "private, no-cache",
      "X-Artifact-Version": String(version),
    },
  });
}

// --- Same-origin assets (the CSP allows 'self' but no external hosts) ---

const MERMAID_VERSION = "11.4.1";
const MERMAID_R2_KEY = `assets/mermaid-${MERMAID_VERSION}.min.js`;
// jsDelivr, not cdnjs: Workers cannot fetch Cloudflare-owned hosts (cdnjs
// returns errors when requested from inside the Workers runtime).
const MERMAID_CDN_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js`;

// GET /a/assets/mermaid.js — R2-cached copy of the mermaid renderer.
// Bundling ~3 MB of mermaid into the worker would blow the script size cap,
// so it's fetched once from cdnjs and pinned in R2; artifacts load it
// same-origin, keeping the zero-external-hosts CSP honest.
export async function handleArtifactMermaid(_request: Request, env: Env): Promise<Response> {
  let source: string | null = null;
  const cached = await env.DOCS.get(MERMAID_R2_KEY);
  if (cached) {
    source = await cached.text();
  } else {
    const upstream = await fetch(MERMAID_CDN_URL);
    if (!upstream.ok) {
      return new Response("// mermaid unavailable", {
        status: 503,
        headers: { "Content-Type": "text/javascript" },
      });
    }
    source = await upstream.text();
    await env.DOCS.put(MERMAID_R2_KEY, source, {
      httpMetadata: { contentType: "text/javascript" },
    }).catch(() => {});
  }
  return new Response(source, {
    headers: {
      "Content-Type": "text/javascript",
      "Cache-Control": "public, max-age=604800, immutable",
    },
  });
}

const CUELUME_VERSION = "0.1.2";
const CUELUME_R2_KEY = `assets/cuelume-${CUELUME_VERSION}.esm.js`;
// The +esm transform bundles cuelume (zero-dep) into one self-contained ES
// module; document effects load it lazily via dynamic import() only after
// the reader opts into sound.
const CUELUME_CDN_URL = `https://cdn.jsdelivr.net/npm/cuelume@${CUELUME_VERSION}/+esm`;

// GET /a/assets/cuelume.js — R2-cached copy of the cuelume interaction-sound
// synth (~5 kB, MIT). Same pattern as mermaid: fetched once from jsDelivr,
// pinned in R2, served same-origin so documents stay external-host-free.
export async function handleCuelumeAsset(_request: Request, env: Env): Promise<Response> {
  let source: string | null = null;
  const cached = await env.DOCS.get(CUELUME_R2_KEY);
  if (cached) {
    source = await cached.text();
  } else {
    const upstream = await fetch(CUELUME_CDN_URL);
    if (!upstream.ok) {
      return new Response("// cuelume unavailable", {
        status: 503,
        headers: { "Content-Type": "text/javascript" },
      });
    }
    source = await upstream.text();
    await env.DOCS.put(CUELUME_R2_KEY, source, {
      httpMetadata: { contentType: "text/javascript" },
    }).catch(() => {});
  }
  return new Response(source, {
    headers: {
      "Content-Type": "text/javascript",
      "Cache-Control": "public, max-age=604800, immutable",
    },
  });
}

// GET /a/assets/runtime.js — window.pidgin runtime for capability-declaring
// artifacts. Parity with window.claude: complete() proxies inference through
// the server, storage is the per-artifact 20 MB text KV.
const RUNTIME_JS = `(function () {
  var script = document.currentScript;
  var artifactId = script && script.dataset.artifactId;
  if (!artifactId) return;
  var base = '/api/artifacts/' + artifactId + '/rt';
  function call(path, body) {
    return fetch(base + path, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (res) { return res.json(); }).then(function (data) {
      if (!data.ok) throw new Error(data.error || 'runtime call failed');
      return data.data;
    });
  }
  window.pidgin = {
    complete: function (prompt) {
      return call('/complete', { prompt: String(prompt) }).then(function (d) { return d.completion; });
    },
    storage: {
      get: function (key, mode) {
        return call('/storage', { op: 'get', key: key, mode: mode || 'personal' }).then(function (d) { return d.value; });
      },
      set: function (key, value, mode) {
        return call('/storage', { op: 'set', key: key, value: String(value), mode: mode || 'personal' }).then(function () { return true; });
      },
      delete: function (key, mode) {
        return call('/storage', { op: 'delete', key: key, mode: mode || 'personal' }).then(function () { return true; });
      },
      list: function (mode) {
        return call('/storage', { op: 'list', mode: mode || 'personal' }).then(function (d) { return d.keys; });
      }
    }
  };
})();
`;

export function handleArtifactRuntimeScript(): Response {
  return new Response(RUNTIME_JS, {
    headers: {
      "Content-Type": "text/javascript",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

// --- Runtime endpoints (phase 4) ---

const MAX_STORAGE_BYTES = 20 * 1024 * 1024; // 20 MB text per artifact

function capabilitiesOf(row: ArtifactRow): Record<string, unknown> {
  try {
    return row.capabilities ? (JSON.parse(row.capabilities) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// POST /api/artifacts/:id/rt/complete — window.pidgin.complete(prompt).
// Requires a signed-in viewer (session or API key); proxied through the
// server's ANTHROPIC_API_KEY so no key ever reaches the page.
export async function handleArtifactRuntimeComplete(
  request: Request,
  env: Env,
  id: string
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized("sign in to use this artifact's AI features");

  const row = await getArtifactById(env, id);
  // Same 404-flavored message for missing and foreign — no existence leak,
  // mirrors authorizeArtifactViewer. Capability artifacts can never be public
  // (enforced at publish time), so in practice this is owner-only, but the
  // visibility check is kept for parity with the other artifact routes.
  if (!row || (row.user_id !== userId && row.visibility !== "public")) {
    return json({ ok: false, error: "artifact not found" }, 404);
  }
  const caps = capabilitiesOf(row);
  if (!caps.complete) {
    return json({ ok: false, error: "this artifact does not declare the complete capability" }, 403);
  }
  if (!env.ANTHROPIC_API_KEY) {
    return json({ ok: false, error: "ANTHROPIC_API_KEY is not configured on the server" }, 503);
  }

  const allowed = await checkRateLimit(env, `artifact-rt:${userId}`, 60, 3600);
  if (!allowed) return json({ ok: false, error: "rate limit exceeded (60 completions/hour)" }, 429);

  let body: { prompt?: string };
  try {
    body = (await request.json()) as { prompt?: string };
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  if (!body.prompt || typeof body.prompt !== "string") {
    return json({ ok: false, error: '"prompt" is required' }, 400);
  }

  const model = typeof caps.model === "string" ? caps.model : "claude-haiku-4-5-20251001";
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: "user", content: body.prompt.slice(0, 100_000) }],
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return json({ ok: false, error: `completion failed (${response.status}): ${detail.slice(0, 300)}` }, 502);
  }
  const result = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
  const completion = (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  return json({ ok: true, data: { completion } });
}

// POST /api/artifacts/:id/rt/storage — {op: get|set|delete|list, key?, value?,
// mode: personal|shared}. Personal rows are scoped per viewer, shared rows are
// one namespace all viewers read and write.
export async function handleArtifactRuntimeStorage(
  request: Request,
  env: Env,
  id: string
): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized("sign in to use this artifact's storage");

  const row = await getArtifactById(env, id);
  // Same ownership/visibility gate as rt/complete — without it, any signed-in
  // user of the deployment who knows (or guesses) another user's private
  // artifact id can read/write its storage, "shared" scope included.
  if (!row || (row.user_id !== userId && row.visibility !== "public")) {
    return json({ ok: false, error: "artifact not found" }, 404);
  }
  const caps = capabilitiesOf(row);
  if (!caps.storage) {
    return json({ ok: false, error: "this artifact does not declare the storage capability" }, 403);
  }

  let body: { op?: string; key?: string; value?: string; mode?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  const mode = body.mode === "shared" ? "shared" : "personal";
  const scope = mode === "shared" ? "shared" : `user:${userId}`;

  switch (body.op) {
    case "get": {
      if (!body.key) return json({ ok: false, error: '"key" is required' }, 400);
      const item = await env.DB.prepare(
        "SELECT value FROM artifact_storage WHERE artifact_id = ? AND scope = ? AND key = ?"
      )
        .bind(id, scope, body.key)
        .first<{ value: string }>();
      return json({ ok: true, data: { value: item?.value ?? null } });
    }
    case "set": {
      if (!body.key) return json({ ok: false, error: '"key" is required' }, 400);
      if (typeof body.value !== "string") {
        return json({ ok: false, error: '"value" must be a string (text-only storage)' }, 400);
      }
      const valueBytes = new TextEncoder().encode(body.value).byteLength;
      const usage = await env.DB.prepare(
          "SELECT COALESCE(SUM(LENGTH(CAST(value AS BLOB))), 0) as total FROM artifact_storage WHERE artifact_id = ? AND NOT (scope = ? AND key = ?)"
        )
          .bind(id, scope, body.key)
          .first<{ total: number }>();
      if ((usage?.total ?? 0) + valueBytes > MAX_STORAGE_BYTES) {
        return json({ ok: false, error: "artifact storage limit exceeded (20 MB)" }, 413);
      }
      await env.DB.prepare(
        `INSERT INTO artifact_storage (artifact_id, scope, key, value, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(artifact_id, scope, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      )
        .bind(id, scope, body.key, body.value)
        .run();
      return json({ ok: true, data: { stored: true } });
    }
    case "delete": {
      if (!body.key) return json({ ok: false, error: '"key" is required' }, 400);
      await env.DB.prepare(
        "DELETE FROM artifact_storage WHERE artifact_id = ? AND scope = ? AND key = ?"
      )
        .bind(id, scope, body.key)
        .run();
      return json({ ok: true, data: { deleted: true } });
    }
    case "list": {
      const rows = await env.DB.prepare(
        "SELECT key, updated_at FROM artifact_storage WHERE artifact_id = ? AND scope = ? ORDER BY key"
      )
        .bind(id, scope)
        .all<{ key: string; updated_at: string }>();
      return json({ ok: true, data: { keys: (rows.results ?? []).map((r) => r.key) } });
    }
    default:
      return json({ ok: false, error: '"op" must be one of get, set, delete, list' }, 400);
  }
}
