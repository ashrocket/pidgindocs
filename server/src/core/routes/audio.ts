import { editionRecordBytesUp, UsageRefused } from "../edition-hooks";
import { resolveCallerUserId, unauthorized } from "../middleware";
import { MAX_MULTIPART_UPLOAD_BYTES, MAX_RAW_UPLOAD_BYTES, plainType } from "../audio/formats";
import {
  AudioInputError,
  createNarration,
  deleteAudio,
  lookupAudio,
  parseVoice,
  renameAudio,
  storeAudioFromUrl,
  storeAudioUpload,
} from "../audio/service";
import { AudioCursorError, isValidAudioId, listAudioItems } from "../audio/store";
import { streamAudioObject } from "../audio/stream";
import type { DocumentFormat } from "../audio/text";
import type { Env } from "../types";
import { json } from "../utils";

// Audio API. Auth is the same as the other signed-in /api routes: session
// cookie, "Authorization: Session <token>", or a Bearer API key.
// Bodies use the { ok, data } / { ok: false, error } envelope.

const MAX_JSON_BYTES = 3 * 1024 * 1024;
// Multipart framing around the file and the other fields.
const MULTIPART_OVERHEAD_BYTES = 256 * 1024;

function fail(error: string, status: number): Response {
  return json({ ok: false, error }, status);
}

function mapError(err: unknown): Response {
  if (err instanceof AudioInputError) return fail(err.message, err.status);
  if (err instanceof UsageRefused) return fail(err.message, err.status);
  throw err;
}

function parseFormat(value: unknown): DocumentFormat | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "markdown" || value === "html" || value === "text") return value;
  throw new AudioInputError('format must be "markdown", "html" or "text"');
}

// The mode is a hint. The reading time decides: 3 minutes or less is read in
// full, longer is summarized. It is checked so a typo is not silent.
function checkMode(value: unknown): void {
  if (value === undefined || value === null || value === "") return;
  if (value !== "auto" && value !== "full" && value !== "summary") {
    throw new AudioInputError('mode must be "auto", "full" or "summary"');
  }
}

function rawTitle(request: Request, url: URL): string {
  const fromQuery = url.searchParams.get("title");
  if (fromQuery) return fromQuery;
  const header = request.headers.get("X-Audio-Title");
  if (!header) return "";
  try {
    return decodeURIComponent(header);
  } catch {
    return header;
  }
}

function contentLength(request: Request): number | null {
  const raw = request.headers.get("Content-Length");
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function created(audio: unknown, status: number): Response {
  return json({ ok: true, data: { audio } }, status);
}

export async function handlePostAudio(request: Request, env: Env): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  const url = new URL(request.url);
  const type = plainType(request.headers.get("Content-Type"));
  const length = contentLength(request);

  try {
    if (type === "application/json") {
      if (length !== null && length > MAX_JSON_BYTES) throw new AudioInputError("The request body is too large", 413);
      let body: Record<string, unknown>;
      try {
        const parsed = JSON.parse(await request.text());
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        body = parsed as Record<string, unknown>;
      } catch {
        throw new AudioInputError("invalid JSON body");
      }
      checkMode(body.mode);
      const inputs = (["document", "document_id", "audio_url"] as const).filter(
        (key) => body[key] !== undefined && body[key] !== null && body[key] !== ""
      );
      if (inputs.length !== 1) {
        throw new AudioInputError("Send exactly one of document, document_id or audio_url");
      }
      for (const key of inputs) {
        if (typeof body[key] !== "string") throw new AudioInputError(`${key} must be a string`);
      }
      if (body.title !== undefined && body.title !== null && typeof body.title !== "string") {
        throw new AudioInputError("title must be a string");
      }
      if (inputs[0] === "audio_url") {
        return created(await storeAudioFromUrl(env, userId, body.audio_url as string, body.title), 201);
      }
      const audio = await createNarration(env, userId, {
        title: body.title,
        document: inputs[0] === "document" ? (body.document as string) : undefined,
        documentId: inputs[0] === "document_id" ? (body.document_id as string) : undefined,
        format: parseFormat(body.format),
        voice: parseVoice(body.voice),
      });
      return created(audio, 202);
    }

    if (type === "multipart/form-data") {
      if (length !== null && length > MAX_MULTIPART_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES) {
        throw new AudioInputError(`A form upload can hold ${MAX_MULTIPART_UPLOAD_BYTES / 1048576} MB. Send larger audio as a raw body.`, 413);
      }
      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        throw new AudioInputError("invalid form data");
      }
      checkMode(form.get("mode"));
      const file = form.get("file");
      const documentField = form.get("document") ?? form.get("text");
      const hasFile = file !== null && typeof file !== "string";
      const hasDocument = typeof documentField === "string" && documentField.trim() !== "";
      if (hasFile === hasDocument) throw new AudioInputError("Send either file or document (or text)");
      const title = form.get("title");
      if (hasFile) {
        const upload = file as File;
        if (upload.size > MAX_MULTIPART_UPLOAD_BYTES) {
          throw new AudioInputError(`A form upload can hold ${MAX_MULTIPART_UPLOAD_BYTES / 1048576} MB. Send larger audio as a raw body.`, 413);
        }
        const audio = await storeAudioUpload(env, userId, {
          title: typeof title === "string" && title.trim() ? title : upload.name.replace(/\.[A-Za-z0-9]{1,5}$/, ""),
          body: upload.stream(),
          length: upload.size,
          source: { kind: "declared", type: upload.type },
          maxBytes: MAX_MULTIPART_UPLOAD_BYTES,
        });
        if (length === null) await editionRecordBytesUp(env, upload.size).catch(() => {});
        return created(audio, 201);
      }
      const audio = await createNarration(env, userId, {
        title: typeof title === "string" ? title : "",
        document: documentField as string,
        format: parseFormat(form.get("format")),
        voice: parseVoice(form.get("voice")),
      });
      return created(audio, 202);
    }

    if (type.startsWith("audio/") || type === "application/octet-stream" || type === "") {
      const audio = await storeAudioUpload(env, userId, {
        title: rawTitle(request, url),
        body: request.body,
        length,
        source: { kind: "declared", type },
        maxBytes: MAX_RAW_UPLOAD_BYTES,
      });
      // No Content-Length: the meter could not count this upload, so report what was stored.
      if (length === null) await editionRecordBytesUp(env, audio.size_bytes ?? 0).catch(() => {});
      return created(audio, 201);
    }

    if (type === "text/markdown" || type === "text/html" || type === "text/plain") {
      if (length !== null && length > MAX_JSON_BYTES) throw new AudioInputError("The request body is too large", 413);
      checkMode(url.searchParams.get("mode"));
      const audio = await createNarration(env, userId, {
        title: rawTitle(request, url),
        document: await request.text(),
        format: type === "text/html" ? "html" : type === "text/plain" ? "text" : "markdown",
        voice: parseVoice(url.searchParams.get("voice")),
      });
      return created(audio, 202);
    }

    throw new AudioInputError(
      "Send audio (audio/mpeg, audio/mp4 or audio/wav), multipart/form-data, or application/json. Use MP3, M4A, or WAV — Safari and iPhone can't play other audio",
      415
    );
  } catch (err) {
    return mapError(err);
  }
}

export async function handleListAudio(request: Request, env: Env): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  const url = new URL(request.url);
  const rawLimit = Number.parseInt(url.searchParams.get("limit") || "50", 10);
  const limit = Number.isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 100);
  try {
    const page = await listAudioItems(env, userId, { limit, cursor: url.searchParams.get("cursor") });
    return json({ ok: true, data: page });
  } catch (err) {
    if (err instanceof AudioCursorError) return fail(err.message, 400);
    throw err;
  }
}

function decodeAudioId(raw: string): string | null {
  try {
    const id = decodeURIComponent(raw);
    return isValidAudioId(id) ? id : null;
  } catch {
    return null;
  }
}

export async function handleGetAudio(request: Request, env: Env, rawId: string): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  const id = decodeAudioId(rawId);
  const found = id ? await lookupAudio(env, userId, id) : null;
  if (!found) return fail("audio not found", 404);
  return json({ ok: true, data: { audio: found.item } });
}

export async function handlePatchAudio(request: Request, env: Env, rawId: string): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  const id = decodeAudioId(rawId);
  if (!id) return fail("audio not found", 404);
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return fail("invalid JSON body", 400);
  }
  try {
    const audio = await renameAudio(env, userId, id, (body as { title?: unknown } | null)?.title);
    return audio ? json({ ok: true, data: { audio } }) : fail("audio not found", 404);
  } catch (err) {
    return mapError(err);
  }
}

export async function handleDeleteAudio(request: Request, env: Env, rawId: string): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  const id = decodeAudioId(rawId);
  if (!id) return fail("audio not found", 404);
  try {
    return (await deleteAudio(env, userId, id)) ? json({ ok: true, data: { ok: true } }) : fail("audio not found", 404);
  } catch (err) {
    return mapError(err);
  }
}

export async function handleAudioStream(request: Request, env: Env, rawId: string): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  const id = decodeAudioId(rawId);
  const found = id ? await lookupAudio(env, userId, id) : null;
  if (!found) return fail("audio not found", 404);
  const key = found.legacy ? found.audioKey : found.row.audio_key;
  if (!key) return fail("audio not found", 404);
  return streamAudioObject(request, env, key, found.item.mime ?? "audio/mpeg");
}

export async function handleAudioTranscript(request: Request, env: Env, rawId: string): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  const id = decodeAudioId(rawId);
  const found = id ? await lookupAudio(env, userId, id) : null;
  if (!found) return fail("audio not found", 404);
  const key = found.legacy ? found.transcriptKey : found.row.transcript_key;
  if (!key || !found.item.transcript_url) return fail("transcript not found", 404);
  const object = await env.DOCS.get(key);
  if (!object) return fail("transcript not found", 404);
  return new Response(await object.text(), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
