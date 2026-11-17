import { contentPolicy } from "../content-policy";
import { issueArtifactRuntimeToken, resolveArtifactRuntimeUser } from "../artifacts/runtime-auth";
import { artifactEditSql, assertWorkspacePublishScope, canReadResource, messageReadSql, parseSharing, WorkspaceAccessError, type Sharing } from "../workspace-access";
import { setResourceSharing, SharingError } from "../workspace";
import type { Env } from "../types";
import { editionAccountLimits, editionWireFormat, UsageRefused, releaseEditionUsage, reserveEditionUsage, editionWorkspaceSignInOnly } from "../edition-hooks";
import { json } from "../utils";
import { resolveCallerUserId, unauthorized, isEntraUser } from "../middleware";
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
import { basePath } from "../base-path";
import { callAnthropic } from "../enhance/anthropic";
import { runTier, AiAllowanceSpentError, AiTierError } from "../ai/run";

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
  sharing?: string;
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
      sharing: body.sharing == null ? undefined : body.sharing as Sharing,
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
          artifact: serializeArtifact(env, result.artifact, userId),
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
    if (err instanceof UsageRefused) {
      return json({ ok: false, error: err.message }, err.status);
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
    teamId: url.searchParams.get("team_id") || undefined,
    projectId: url.searchParams.get("project_id") || undefined,
    libraryProject: url.searchParams.get("library_project") || undefined,
    libraryTag: url.searchParams.get("library_tag") || undefined,
  });

  return json({
    ok: true,
    data: {
      artifacts: page.artifacts.map((a) => serializeArtifact(env, a, userId)),
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
  if (!row || !await canReadResource(env, userId, row)) {
    return json({ ok: false, error: "artifact not found" }, 404);
  }
  const versions = await listArtifactVersions(env, id);
  return json({
    ok: true,
    data: {
      artifact: serializeArtifact(env, row, userId),
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
    sharing?: string;
    team_id?: string;
    project_id?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  try {
    // Sharing is a standalone action; reject mixed patches before any side effect.
    if (body.sharing !== undefined) {
      const sharing = parseSharing(body.sharing);
      if (!sharing || Object.keys(body).some(key => !["sharing", "team_id", "project_id"].includes(key))) return json({ ok: false, error: "invalid request" }, 400);
      try {
        await setResourceSharing(env, { actorId: userId, resourceType: "artifact", resourceId: id, sharing, teamId: body.team_id, projectId: body.project_id });
        return json({ ok: true, data: { artifact: serializeArtifact(env, (await getArtifactById(env, id))!, userId) } });
      } catch (error) {
        if (error instanceof SharingError) return json({ ok: false, error: error.message }, error.status);
        throw error;
      }
    }
    const row = await patchArtifact(env, id, userId, {
      title: body.title,
      description: body.description,
      visibility: body.visibility,
      sharedVersion: body.shared_version,
      designSystem: body.design_system,
    });
    if (!row) return json({ ok: false, error: "artifact not found" }, 404);
    return json({ ok: true, data: { artifact: serializeArtifact(env, row, userId) } });
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
  if (!row || !await canReadResource(env, userId, row)) {
    return json({ ok: false, error: "artifact not found" }, 404);
  }

  if (row.team_id && row.sharing !== "shared") return json({ ok: false, error: "Publish to team before sharing this private artifact link." }, 409);
  if (row.team_id || row.visibility === "public" || editionWorkspaceSignInOnly(env)) {
    return json({ ok: true, data: { url: artifactUrl(env, id), expires_at: null, requires_login: !!row.team_id || editionWorkspaceSignInOnly(env) } });
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
     WHERE b.message_id = ? AND b.artifact_id = ? AND ${messageReadSql("m")} LIMIT 1`
  )
    .bind(body.message_id, body.artifact_id, userId, userId)
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
  if (await canReadResource(env, callerUserId, row)) return { row, isOwner };
  if (!row.team_id && row.visibility === "public" && (!editionWorkspaceSignInOnly(env) || callerUserId)) return { row, isOwner: false };
  if (row.team_id || editionWorkspaceSignInOnly(env)) {
    return callerUserId ? json({ ok: false, error: "artifact not found" }, 404) : unauthorized();
  }

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
        env.DOC_SHARE_SECRET ?? env.API_KEY,
        url.searchParams.get("viewer") || undefined
      ))
    ) {
      return json({ ok: false, error: "artifact not found" }, 404);
    }

    const association = await env.DB.prepare(
      `SELECT a.* FROM message_blocks b
       JOIN messages m ON m.id = b.message_id
       JOIN artifacts a ON a.id = b.artifact_id
       WHERE b.message_id = ? AND b.artifact_id = ? AND b.artifact_version = ?
         AND (m.user_id = a.user_id OR a.team_id IS NOT NULL)
       LIMIT 1`
    )
      .bind(messageId, id, version)
      .first<ArtifactRow>();
    if (!association) return json({ ok: false, error: "artifact not found" }, 404);
    row = association;
    const message = await env.DB.prepare("SELECT id, user_id, team_id, sharing, type FROM messages WHERE id = ?").bind(messageId)
      .first<{ id: string; user_id: string; team_id: string | null; sharing: string; type: string }>();
    if (row.team_id || message?.team_id || editionWorkspaceSignInOnly(env)) {
      const viewer = url.searchParams.get("viewer");
      if (!viewer || !message || !await canReadResource(env, viewer, row) || !await canReadResource(env, viewer, message)) {
        return json({ ok: false, error: "artifact not found" }, 404);
      }
      const active = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND status = 'active'").bind(viewer).first();
      if (!active || !await isEntraUser(env, viewer)) return json({ ok: false, error: "artifact not found" }, 404);
    }
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
  let version = embedVersion ?? (isOwner || row.team_id ? row.current_version : effectiveVersion);
  if (vParam) {
    const requested = parseInt(vParam, 10);
    if (isNaN(requested) || requested < 1) {
      return json({ ok: false, error: "invalid version" }, 400);
    }
    if (isEmbed && requested !== embedVersion) {
      return json({ ok: false, error: "artifact not found" }, 404);
    }
    if (!isEmbed && !isOwner && !row.team_id && requested !== effectiveVersion) {
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

  const runtimeViewer = hasCapabilities ? await resolveCallerUserId(request, env) : null;
  const runtimeToken = runtimeViewer ? await issueArtifactRuntimeToken(env, id, runtimeViewer) : undefined;
  const wrapped = wrapArtifactHtml({
    content,
    title: row.title,
    favicon: row.favicon,
    artifactId: id,
    sourceKind: row.source_kind,
    hasCapabilities,
    runtimeToken,
    // The runtime reads its API from this root, so a base-path deployment adds its prefix.
    runtimeOrigin: url.origin + basePath(env),
    base: basePath(env),
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

  const wrappedBytes = new TextEncoder().encode(wrapped).byteLength;
  try {
    await reserveEditionUsage(
      env,
      row.user_id,
      "transfer_bytes",
      wrappedBytes,
      `artifact:${id}:v${version}:transfer:${crypto.randomUUID()}`
    );
  } catch (error) {
    if (error instanceof UsageRefused) {
      return json({ ok: false, error: error.message }, error.status);
    }
    throw error;
  }

  const isPinned = Boolean(vParam);
  const isPublic = row.visibility === "public";
  return new Response(wrapped, {
    headers: {
      // The exact size, so an edition's transfer meter can count the download without reading the body.
      "Content-Length": String(wrappedBytes),
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": artifactCsp(
        hasCapabilities,
        isEmbed ? new URL(env.WORKER_URL).origin : "'none'",
        url.origin + basePath(env),
        id
      ),
      "Referrer-Policy": "no-referrer",
      // Latest must stay fresh (artifacts update in place). A pinned version's
      // CONTENT is immutable, but the served page is not: the artifact-level
      // design_system (and the style it names) can change under it, so pinned
      // responses get a bounded max-age instead of a day.
      "Cache-Control": hasCapabilities || row.team_id || editionWorkspaceSignInOnly(env) ? "private, no-store" : isEmbed
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
//
// The renderers come from jsDelivr once and are then served from R2. Each is
// pinned to a SHA-384 digest: a download that does not match is refused and
// never stored, and a stored copy that does not match is deleted and fetched
// again. The R2 key carries the digest, so a copy stored before pinning (or
// under an earlier digest) is never served.

type PinnedAsset = { name: string; url: string; sha384: string; r2Key: string };

async function sha384Base64(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-384", bytes));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function pinnedKey(name: string, version: string, sha384: string): string {
  // The digest in URL-safe form; 16 characters are plenty to tell versions apart.
  const tag = sha384.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 16);
  return `assets/${name}-${version}-${tag}.js`;
}

const SCRIPT_HEADERS = {
  "Content-Type": "text/javascript",
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Cache-Control": "public, max-age=604800, immutable",
};

function assetUnavailable(name: string): Response {
  return new Response(`// ${name} unavailable`, {
    status: 503,
    headers: { "Content-Type": "text/javascript", "Cache-Control": "no-store" },
  });
}

/** The asset's verified bytes from R2, else from its pinned URL; null when neither matches the digest. */
async function loadPinnedAsset(env: Env, asset: PinnedAsset): Promise<ArrayBuffer | null> {
  const cached = await env.DOCS.get(asset.r2Key);
  if (cached) {
    const bytes = await cached.arrayBuffer();
    if (await sha384Base64(bytes) === asset.sha384) return bytes;
    console.error(`[assets] stored ${asset.name} failed its integrity check; deleting it`);
    await env.DOCS.delete(asset.r2Key).catch(() => {});
  }
  const upstream = await fetch(asset.url);
  if (!upstream.ok) return null;
  const bytes = await upstream.arrayBuffer();
  if (await sha384Base64(bytes) !== asset.sha384) {
    console.error(`[assets] ${asset.url} does not match its pinned SHA-384; not serving or storing it`);
    return null;
  }
  await env.DOCS.put(asset.r2Key, bytes, { httpMetadata: { contentType: "text/javascript" } }).catch(() => {});
  return bytes;
}

async function servePinnedAsset(env: Env, asset: PinnedAsset): Promise<Response> {
  const bytes = await loadPinnedAsset(env, asset);
  return bytes ? new Response(bytes, { headers: SCRIPT_HEADERS }) : assetUnavailable(asset.name);
}

const MERMAID_VERSION = "11.4.1";
// SHA-384 of dist/mermaid.min.js in the npm tarball mermaid-11.4.1.tgz;
// jsDelivr serves the same bytes. Bumping MERMAID_VERSION means re-deriving it
// from the npm tarball, not from the CDN.
const MERMAID_SHA384 = "rbtjAdnIQE/aQJGEgXrVUlMibdfTSa4PQju4HDhN3sR2PmaKFzhEafuePsl9H/9I";
// jsDelivr, not cdnjs: Workers cannot fetch Cloudflare-owned hosts (cdnjs
// returns errors when requested from inside the Workers runtime).
export const MERMAID_ASSET: PinnedAsset = {
  name: "mermaid",
  url: `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js`,
  sha384: MERMAID_SHA384,
  r2Key: pinnedKey("mermaid", MERMAID_VERSION, MERMAID_SHA384),
};

// GET /a/assets/mermaid.js — R2-cached copy of the mermaid renderer.
// Bundling ~3 MB of mermaid into the worker would blow the script size cap,
// so it's fetched once from jsDelivr, checked against its digest and pinned
// in R2; artifacts and documents load it same-origin, keeping the
// zero-external-hosts CSP honest.
export async function handleArtifactMermaid(_request: Request, env: Env): Promise<Response> {
  return await servePinnedAsset(env, MERMAID_ASSET);
}

const CUELUME_VERSION = "0.1.2";
// The +esm transform bundles cuelume (zero-dep) into one self-contained ES
// module; document effects load it lazily via dynamic import() only after
// the reader opts into sound. jsDelivr builds that bundle itself (the npm
// package is several files), so this digest pins the bundle jsDelivr served
// on 2026-11-12, which matched the copy a tenant had stored. If jsDelivr
// rebuilds it, the check fails closed: documents lose sound, nothing else.
const CUELUME_SHA384 = "+kZ/TMu27/TAgV7nGR+ri7fkNRI54KnOtBadqaPWSzgi37e2CTBdNht0F95/Tfrn";
export const CUELUME_ASSET: PinnedAsset = {
  name: "cuelume",
  url: `https://cdn.jsdelivr.net/npm/cuelume@${CUELUME_VERSION}/+esm`,
  sha384: CUELUME_SHA384,
  r2Key: pinnedKey("cuelume", CUELUME_VERSION, CUELUME_SHA384),
};

// GET /a/assets/cuelume.js — R2-cached copy of the cuelume interaction-sound
// synth (~5 kB, MIT). Same pattern as mermaid: fetched once from jsDelivr,
// checked, pinned in R2, served same-origin so documents stay external-host-free.
export async function handleCuelumeAsset(_request: Request, env: Env): Promise<Response> {
  return await servePinnedAsset(env, CUELUME_ASSET);
}

// GET /a/assets/runtime.js — window.pidgin runtime for capability-declaring
// artifacts. Parity with window.claude: complete() proxies inference through
// the server, storage is the per-artifact 20 MB text KV.
// Built at each request: the credential scheme and the second global name come from the edition.
function runtimeScript(): string {
  const { artifactAuthScheme, runtimeGlobalAlias } = editionWireFormat();
  const alias = /^[A-Za-z_$][\w$]*$/.test(runtimeGlobalAlias) ? `window.${runtimeGlobalAlias} = ` : "";
  return `(function () {
  var script = document.currentScript;
  var artifactId = script && script.dataset.artifactId;
  if (!artifactId) return;
  var token = script.dataset.runtimeToken;
  var origin = script.dataset.runtimeOrigin;
  var base = origin + '/api/artifacts/' + artifactId + '/rt';
  function call(path, body) {
    if (!token) return Promise.reject(new Error('Sign in and reopen this artifact to use its connected features.'));
    return fetch(base + path, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', 'Authorization': '${artifactAuthScheme} ' + token },
      body: JSON.stringify(body || {})
    }).then(function (res) { return res.json(); }).then(function (data) {
      if (!data.ok) throw new Error(data.error || 'runtime call failed');
      return data.data;
    });
  }
  ${alias}window.pidgin = {
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
}

export function handleArtifactRuntimeScript(): Response {
  return new Response(runtimeScript(), {
    headers: {
      "Content-Type": "text/javascript",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

/**
 * The three same-origin scripts, for GET /a/assets/mermaid.js, cuelume.js and runtime.js, or null for any other
 * request. Public share pages load them, so the Solo Worker and the apex Worker (for a name that no Solo
 * Worker owns) serve them with this one function.
 */
export async function artifactAssetResponse(request: Request, env: Env, path: string): Promise<Response | null> {
  if (request.method !== "GET") return null;
  if (path === "/a/assets/mermaid.js") return await handleArtifactMermaid(request, env);
  if (path === "/a/assets/cuelume.js") return await handleCuelumeAsset(request, env);
  if (path === "/a/assets/runtime.js") return handleArtifactRuntimeScript();
  return null;
}

/** The answer to any request under /a/assets/: the script, or the router's final not-found answer. */
export async function artifactAssetAnswer(request: Request, env: Env, path: string): Promise<Response> {
  return await artifactAssetResponse(request, env, path) ?? json({ ok: false, error: "not found" }, 404);
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
  const userId = await resolveArtifactRuntimeUser(request, env, id);
  if (!userId) return unauthorized("This artifact connection expired. Reopen the artifact to continue.");

  const row = await getArtifactById(env, id);
  // Same 404-flavored message for missing and foreign — no existence leak,
  // mirrors authorizeArtifactViewer. Capability artifacts can never be public
  // (enforced at publish time), so in practice this is owner-only, but the
  // visibility check is kept for parity with the other artifact routes.
  if (!row || (!await canReadResource(env, userId, row) && (row.team_id || row.visibility !== "public"))) {
    return json({ ok: false, error: "artifact not found" }, 404);
  }
  const caps = capabilitiesOf(row);
  if (!caps.complete) {
    return json({ ok: false, error: "this artifact does not declare the complete capability" }, 403);
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

  try {
    await reserveEditionUsage(
      env,
      row.user_id,
      "ai_actions",
      1,
      `artifact:${id}:complete:${crypto.randomUUID()}`
    );
  } catch (error) {
    if (error instanceof UsageRefused) {
      return json({ ok: false, error: error.message }, error.status);
    }
    throw error;
  }

  // The claude-fast tier answers by default, and falls back to workers-fast on a 429, a 5xx,
  // a timeout or a missing key. Every hop is metered at its own price. It uses the server's
  // ANTHROPIC_API_KEY, which is the customer's own key on a customer's server.
  // A model the artifact declares itself keeps the direct call it had before.
  let completion: string;
  let servedTier: string | null = null;
  let fellBack = false;
  if (typeof caps.model === "string") {
    const model = caps.model;
    if (!env.ANTHROPIC_API_KEY) {
      return json({ ok: false, error: "ANTHROPIC_API_KEY is not configured on the server" }, 503);
    }
    // callAnthropic checks the allowance and records usage; it reports a provider error by message only.
    try {
      completion = await callAnthropic(env, { model, user: body.prompt.slice(0, 100_000), maxTokens: 4096 });
    } catch (error) {
      if (error instanceof AiAllowanceSpentError) return json({ ok: false, error: error.message }, 429);
      const message = error instanceof Error ? error.message : String(error);
      const provider = /^Anthropic API error (\d+): ([\s\S]*)$/.exec(message);
      return json({ ok: false, error: `completion failed (${provider ? provider[1] : 502}): ${(provider ? provider[2] : message).slice(0, 300)}` }, 502);
    }
  } else {
    try {
      const answer = await runTier(env, "claude-fast", { user: body.prompt.slice(0, 100_000), maxTokens: 4096 });
      completion = answer.text;
      servedTier = answer.tier;
      fellBack = answer.fellBack;
    } catch (error) {
      if (error instanceof AiAllowanceSpentError) return json({ ok: false, error: error.message }, 429);
      if (error instanceof AiTierError) return json({ ok: false, error: `completion failed (${error.status}): ${error.message.slice(0, 300)}` }, 502);
      throw error;
    }
  }
  return json({ ok: true, data: { completion, tier: servedTier, fell_back: fellBack } });
}

// POST /api/artifacts/:id/rt/storage — {op: get|set|delete|list, key?, value?,
// mode: personal|shared}. Personal rows are scoped per viewer, shared rows are
// one namespace all viewers read; governed writes require artifact edit access.
export async function handleArtifactRuntimeStorage(
  request: Request,
  env: Env,
  id: string
): Promise<Response> {
  const userId = await resolveArtifactRuntimeUser(request, env, id);
  if (!userId) return unauthorized("This artifact connection expired. Reopen the artifact to continue.");

  const row = await getArtifactById(env, id);
  // Same ownership/visibility gate as rt/complete — without it, any signed-in
  // user of the deployment who knows (or guesses) another user's private
  // artifact id can read/write its storage, "shared" scope included.
  if (!row || (!await canReadResource(env, userId, row) && (row.team_id || row.visibility !== "public"))) {
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
  // Check governance in SQL even for a legacy request: activation or grant
  // revocation between authorization and mutation must not leave a write open.
  const sharedWriteAccess = mode === "shared" ? `EXISTS (SELECT 1 FROM artifacts storage_artifact
    WHERE storage_artifact.id = ? AND (${contentPolicy().unrestrictedTeamSql("storage_artifact.team_id")}
      OR ${artifactEditSql("storage_artifact")}))` : "1";
  const sharedWriteBinds = mode === "shared" ? [id, userId, userId] : [];
  const writeDenied = () => json({ ok: false, error: "team shared storage requires write access" }, 403);
  if (mode === "shared" && (body.op === "set" || body.op === "delete")) {
    try {
      if (row.team_id) await assertWorkspacePublishScope(env, userId, row.team_id, row.project_id);
      const allowed = await env.DB.prepare(`SELECT ${sharedWriteAccess} AS allowed`)
        .bind(...sharedWriteBinds).first<{ allowed: number }>();
      if (!allowed?.allowed) return writeDenied();
    } catch { return writeDenied(); }
  }

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
      const [usage, prior] = await Promise.all([
        env.DB.prepare(
          "SELECT COALESCE(SUM(LENGTH(CAST(value AS BLOB))), 0) as total FROM artifact_storage WHERE artifact_id = ? AND NOT (scope = ? AND key = ?)"
        )
          .bind(id, scope, body.key)
          .first<{ total: number }>(),
        env.DB.prepare(
          "SELECT LENGTH(CAST(value AS BLOB)) AS bytes FROM artifact_storage WHERE artifact_id = ? AND scope = ? AND key = ?"
        )
          .bind(id, scope, body.key)
          .first<{ bytes: number }>(),
      ]);
      if ((usage?.total ?? 0) + valueBytes > MAX_STORAGE_BYTES) {
        return json({ ok: false, error: "artifact storage limit exceeded (20 MB)" }, 413);
      }
      const hosted = await editionAccountLimits(env, row.user_id);
      if (hosted && valueBytes > hosted.max_upload_bytes) {
        return json({ ok: false, error: "hosted per-upload limit exceeded" }, 413);
      }
      const priorBytes = Number(prior?.bytes || 0);
      const delta = valueBytes - priorBytes;
      const operationId = crypto.randomUUID();
      let reserved = false;
      try {
        if (delta > 0) {
          const reservation = await reserveEditionUsage(
            env,
            row.user_id,
            "storage_bytes",
            delta,
            `artifact-storage:${operationId}:add`
          );
          reserved = reservation.managed;
        }
        const stored = await env.DB.prepare(
          `INSERT INTO artifact_storage (artifact_id, scope, key, value, updated_at)
           SELECT ?, ?, ?, ?, datetime('now') WHERE ${sharedWriteAccess}
           ON CONFLICT(artifact_id, scope, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
        )
          .bind(id, scope, body.key, body.value, ...sharedWriteBinds)
          .run();
        if (!stored.meta.changes) throw new WorkspaceAccessError("Shared storage edit permission changed");
      } catch (error) {
        if (reserved && delta > 0) {
          await releaseEditionUsage(
            env,
            row.user_id,
            "storage_bytes",
            delta,
            `artifact-storage:${operationId}:rollback`
          ).catch(() => {});
        }
        if (error instanceof UsageRefused) {
          return json({ ok: false, error: error.message }, error.status);
        }
        if (error instanceof WorkspaceAccessError) return writeDenied();
        throw error;
      }
      if (delta < 0) {
        await releaseEditionUsage(
          env,
          row.user_id,
          "storage_bytes",
          -delta,
          `artifact-storage:${operationId}:shrink`
        ).catch((error) => console.error("hosted runtime storage release failed", error));
      }
      return json({ ok: true, data: { stored: true } });
    }
    case "delete": {
      if (!body.key) return json({ ok: false, error: '"key" is required' }, 400);
      const prior = await env.DB.prepare(
        "SELECT LENGTH(CAST(value AS BLOB)) AS bytes FROM artifact_storage WHERE artifact_id = ? AND scope = ? AND key = ?"
      )
        .bind(id, scope, body.key)
        .first<{ bytes: number }>();
      const [permission, deleted] = await env.DB.batch([
        env.DB.prepare(`SELECT ${sharedWriteAccess} AS allowed`).bind(...sharedWriteBinds),
        env.DB.prepare(`DELETE FROM artifact_storage WHERE artifact_id = ? AND scope = ? AND key = ? AND ${sharedWriteAccess}`)
          .bind(id, scope, body.key, ...sharedWriteBinds),
      ]);
      if (!(permission.results?.[0] as { allowed: number } | undefined)?.allowed) return writeDenied();
      const priorBytes = Number(prior?.bytes || 0);
      if (deleted.meta.changes && priorBytes > 0) {
        await releaseEditionUsage(
          env,
          row.user_id,
          "storage_bytes",
          priorBytes,
          `artifact-storage:${crypto.randomUUID()}:delete`
        ).catch((error) => console.error("hosted runtime storage release failed", error));
      }
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
