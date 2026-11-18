import { streamAudioObject } from "../audio/stream";
import { getCommuteSource } from "../commute/playlist";
import {
  getCommuteBriefing,
  getLatestCommuteBriefing,
  listCommuteBriefings,
  type CommuteSourceType,
} from "../commute/store";
import {
  resolveCallerUserId,
  unauthorized,
  verifyOwnerCredential,
  verifySession,
} from "../middleware";
import type { Env } from "../types";
import { json } from "../utils";
import { latestCommutePage } from "../web/index";
import { editionLoginPage } from "../edition-hooks";
import { withNavShell } from "../web/nav-shell";
import { theme } from "../web/theme";
import { basePath } from "../base-path";

async function resolveRequiredUserId(request: Request, env: Env): Promise<string | null> {
  return resolveCallerUserId(request, env);
}

async function commuteSourceTypeForUser(
  env: Env,
  userId: string
): Promise<CommuteSourceType> {
  const source = await getCommuteSource(env, userId);
  return source === "playlist" ? "playlist" : "document";
}

export async function handleGetCommuteBriefings(
  request: Request,
  env: Env
): Promise<Response> {
  const userId = await resolveRequiredUserId(request, env);
  if (!userId) return unauthorized();

  const url = new URL(request.url);
  const rawLimit = Number.parseInt(url.searchParams.get("limit") || "25", 10);
  const limit = Number.isNaN(rawLimit) ? 25 : Math.min(Math.max(rawLimit, 1), 100);
  const sourceParam = url.searchParams.get("source");
  const sourceType =
    sourceParam === "playlist" || sourceParam === "document" ? sourceParam : undefined;
  const items = await listCommuteBriefings(env, limit, { userId, sourceType });
  return json({ ok: true, data: items });
}

export async function handleGetCommuteTranscript(
  request: Request,
  env: Env,
  sourceMessageId: string
): Promise<Response> {
  const userId = await resolveRequiredUserId(request, env);
  if (!userId) return unauthorized();

  const briefing = await getCommuteBriefing(env, sourceMessageId, userId);
  if (!briefing) {
    return json({ ok: false, error: "commute briefing not found" }, 404);
  }

  const obj = await env.DOCS.get(briefing.transcript_key);
  if (!obj) {
    return json({ ok: false, error: "transcript not found" }, 404);
  }

  return new Response(await obj.text(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function handleGetCommuteAudio(
  request: Request,
  env: Env,
  sourceMessageId: string
): Promise<Response> {
  const userId = await resolveRequiredUserId(request, env);
  if (!userId) return unauthorized();

  const briefing = await getCommuteBriefing(env, sourceMessageId, userId);
  if (!briefing || !briefing.audio_key) {
    return json({ ok: false, error: "audio not found" }, 404);
  }

  // Same helper as /api/audio/:id/stream, so this route answers Range requests too.
  return streamAudioObject(request, env, briefing.audio_key, "audio/mpeg");
}

export async function handleGetLatestCommute(
  request: Request,
  env: Env
): Promise<Response> {
  const userId = await resolveRequiredUserId(request, env);
  if (!userId) return unauthorized();

  const sourceType = await commuteSourceTypeForUser(env, userId);
  const briefing = await getLatestCommuteBriefing(env, { userId, sourceType });
  if (!briefing) {
    return json({ ok: false, error: "no commute briefings found" }, 404);
  }

  return json({ ok: true, data: briefing });
}

export async function handleOpenLatestCommute(
  request: Request,
  env: Env
): Promise<Response> {
  const accept = request.headers.get("Accept") || "";
  const hasSession = await verifySession(request.headers, env.SESSIONS, env);
  const hasApiKey = await verifyOwnerCredential(request.headers, env);

  if (!hasSession && !hasApiKey) {
    return accept.includes("application/json") ? unauthorized() : await editionLoginPage(env);
  }

  const userId = await resolveRequiredUserId(request, env);
  if (!userId) {
    return accept.includes("application/json") ? unauthorized() : await editionLoginPage(env);
  }

  const sourceType = await commuteSourceTypeForUser(env, userId);
  const briefing = await getLatestCommuteBriefing(env, { userId, sourceType });
  if (accept.includes("application/json")) {
    if (!briefing) {
      return json({ ok: false, error: "no commute briefings found" }, 404);
    }
    const target = briefing.audio_key
      ? `/api/commute/${briefing.source_message_id}/audio`
      : `/api/commute/${briefing.source_message_id}/transcript`;
    return json({
      ok: true,
      data: {
        source_message_id: briefing.source_message_id,
        target,
        kind: briefing.audio_key ? "audio" : "transcript",
        source_type: briefing.source_type,
      },
    });
  }

  if (!briefing) {
    return withNavShell(latestCommutePage(null, undefined, basePath(env)), { accent: theme.primary, userId, base: basePath(env) });
  }

  let transcript: string | undefined;
  const obj = await env.DOCS.get(briefing.transcript_key);
  if (obj) {
    transcript = await obj.text();
  }

  return withNavShell(latestCommutePage(briefing, transcript, basePath(env)), { accent: theme.primary, userId, base: basePath(env) });
}
