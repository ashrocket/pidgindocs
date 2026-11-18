import { getDocumentRecord, loadDocumentText, sourceMarkdownKey } from "../documents";
import type { Env } from "../types";
import { editionProductIdentity, editionAccountLimits, UsageRefused, releaseEditionUsage, reserveEditionUsage } from "../edition-hooks";
import {
  AudioFormatError,
  checkDeclaredAudio,
  detectFetchedAudio,
  EXTENSION_BY_MIME,
  MAX_RAW_UPLOAD_BYTES,
  MAX_UNSIZED_UPLOAD_BYTES,
  SNIFF_BYTES,
  wavDurationSeconds,
} from "./formats";
import { MAX_SOURCE_CHARS, planNarration } from "./narration";
import {
  audioKeys,
  cleanAudioTitle,
  deleteAudioRow,
  getAudioRow,
  getLegacyBriefing,
  insertAudioRow,
  isLegacyAudioId,
  LEGACY_ID_PREFIX,
  newAudioId,
  serializeAudioRowLinked,
  updateAudioRow,
  type AudioItem,
  type AudioRow,
} from "./store";
import { countWords, detectDocumentFormat, documentToSpeechText, type DocumentFormat } from "./text";

// Audio use cases shared by the HTTP routes and the MCP tools.

export class AudioInputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const VOICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;

export function parseVoice(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !VOICE_ID.test(value.trim())) {
    throw new AudioInputError("voice must be an ElevenLabs voice id");
  }
  return value.trim();
}

// ---------------- upload ----------------

type UploadSource =
  | { kind: "declared"; type: string }
  | { kind: "fetched"; type: string };

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

async function readHead(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<{ chunks: Uint8Array[]; total: number; done: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  while (total < SNIFF_BYTES) {
    const next = await reader.read();
    if (next.done) {
      done = true;
      break;
    }
    chunks.push(next.value);
    total += next.value.byteLength;
  }
  return { chunks, total, done };
}

export interface UploadInput {
  title: unknown;
  body: ReadableStream<Uint8Array> | null;
  /** Bytes in the body when the sender said. Null buffers the body (25 MB limit). */
  length: number | null;
  source: UploadSource;
  maxBytes?: number;
}

// Stores an audio file. With a known length the body streams straight into R2
// and is never held in memory. The first bytes are checked before anything is written.
export async function storeAudioUpload(env: Env, userId: string, input: UploadInput): Promise<AudioItem> {
  const maxBytes = input.maxBytes ?? MAX_RAW_UPLOAD_BYTES;
  const length = input.length;
  if (length !== null && length > maxBytes) {
    throw new AudioInputError(`The file is larger than ${Math.round(maxBytes / 1048576)} MB.`, 413);
  }
  if (length === 0 || !input.body) throw new AudioInputError("The upload has no audio data");

  const account = await editionAccountLimits(env, userId);
  if (account && length !== null && length > account.max_upload_bytes) {
    throw new UsageRefused(`The file is larger than the ${account.max_upload_bytes}-byte hosted upload limit.`, 413, "storage_bytes");
  }

  const reader = input.body.getReader();
  let head: { chunks: Uint8Array[]; total: number; done: boolean };
  try {
    head = await readHead(reader);
  } catch {
    throw new AudioInputError("The upload could not be read");
  }
  const first = concat(head.chunks, head.total);
  let mime: string;
  try {
    mime =
      input.source.kind === "declared"
        ? checkDeclaredAudio(input.source.type, first.subarray(0, SNIFF_BYTES))
        : detectFetchedAudio(input.source.type, first.subarray(0, SNIFF_BYTES));
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (err instanceof AudioFormatError) throw new AudioInputError(err.message, 415);
    throw err;
  }

  const id = newAudioId();
  const ext = EXTENSION_BY_MIME[mime] ?? "bin";
  const audioKey = audioKeys(id, ext).audio;
  const httpMetadata = { contentType: mime };
  const customMetadata = { kind: "audio-upload", audio_id: id };
  let storedBytes: number;

  if (length !== null) {
    storedBytes = length;
    let reserved = false;
    try {
      reserved = (await reserveEditionUsage(env, userId, "storage_bytes", length, `audio:${id}:storage`)).managed;
    } catch (err) {
      await reader.cancel().catch(() => {});
      throw err;
    }
    const fixed = new FixedLengthStream(length);
    const pump = (async () => {
      const writer = fixed.writable.getWriter();
      try {
        for (const chunk of head.chunks) await writer.write(chunk);
        if (!head.done) {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            await writer.write(next.value);
          }
        }
        await writer.close();
      } catch (err) {
        await writer.abort(err).catch(() => {});
        throw err;
      }
    })();
    try {
      await Promise.all([pump, env.DOCS.put(audioKey, fixed.readable, { httpMetadata, customMetadata })]);
    } catch {
      await reader.cancel().catch(() => {});
      await env.DOCS.delete(audioKey).catch(() => {});
      if (reserved) await releaseEditionUsage(env, userId, "storage_bytes", length, `audio:${id}:storage:rollback`).catch(() => {});
      throw new AudioInputError("The upload ended early or did not match its Content-Length");
    }
  } else {
    const chunks = [...head.chunks];
    let total = head.total;
    if (!head.done) {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > MAX_UNSIZED_UPLOAD_BYTES) {
          await reader.cancel().catch(() => {});
          throw new AudioInputError(
            `The file is larger than ${MAX_UNSIZED_UPLOAD_BYTES / 1048576} MB. Send a Content-Length header to upload up to ${MAX_RAW_UPLOAD_BYTES / 1048576} MB.`,
            413
          );
        }
        chunks.push(next.value);
      }
    }
    storedBytes = total;
    if (account && total > account.max_upload_bytes) {
      throw new UsageRefused(`The file is larger than the ${account.max_upload_bytes}-byte hosted upload limit.`, 413, "storage_bytes");
    }
    const reserved = (await reserveEditionUsage(env, userId, "storage_bytes", total, `audio:${id}:storage`)).managed;
    try {
      await env.DOCS.put(audioKey, concat(chunks, total), { httpMetadata, customMetadata });
    } catch (err) {
      if (reserved) await releaseEditionUsage(env, userId, "storage_bytes", total, `audio:${id}:storage:rollback`).catch(() => {});
      throw err;
    }
  }

  try {
    await insertAudioRow(env, {
      id,
      user_id: userId,
      title: cleanAudioTitle(input.title),
      kind: "upload",
      status: "ready",
      mime,
      size_bytes: storedBytes,
      duration_seconds: wavDurationSeconds(first, storedBytes),
      audio_key: audioKey,
      storage_bytes: storedBytes,
    });
  } catch (err) {
    await env.DOCS.delete(audioKey).catch(() => {});
    await releaseEditionUsage(env, userId, "storage_bytes", storedBytes, `audio:${id}:storage:rollback`).catch(() => {});
    throw err;
  }
  const row = await getAudioRow(env, userId, id);
  if (!row) throw new Error("audio row missing after insert");
  return serializeAudioRowLinked(env, row);
}

// ---------------- fetch by URL ----------------

function blockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host.includes(":") || /^[\d.]+$/.test(host)) return true;
  return host === "localhost" || /\.(?:local|localhost|internal|lan|home|corp|intranet)$/.test(host);
}

function checkFetchUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AudioInputError("audio_url must be a full https URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new AudioInputError("audio_url must be an https URL without a user name or port");
  }
  if (blockedHost(url.hostname)) throw new AudioInputError("audio_url must point to a public host");
  return url;
}

export async function storeAudioFromUrl(env: Env, userId: string, rawUrl: string, title: unknown): Promise<AudioItem> {
  let url = checkFetchUrl(rawUrl);
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let response: Response | null = null;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      response = await fetch(url.toString(), {
        redirect: "manual",
        signal,
        headers: { Accept: "audio/*", "User-Agent": editionProductIdentity().userAgent },
      });
      if (response.status >= 300 && response.status < 400 && response.headers.get("Location")) {
        await response.body?.cancel().catch(() => {});
        if (hop === MAX_REDIRECTS) throw new AudioInputError("audio_url redirects too many times");
        url = checkFetchUrl(new URL(response.headers.get("Location") as string, url).toString());
        continue;
      }
      break;
    }
  } catch (err) {
    if (err instanceof AudioInputError) throw err;
    throw new AudioInputError("The server could not fetch audio_url in time", 502);
  }
  if (!response || !response.ok || !response.body) {
    await response?.body?.cancel().catch(() => {});
    throw new AudioInputError(`audio_url answered with status ${response?.status ?? "none"}`, 502);
  }

  const encoded = response.headers.get("Content-Encoding");
  const declaredLength = Number(response.headers.get("Content-Length"));
  const length = !encoded && Number.isSafeInteger(declaredLength) && declaredLength > 0 ? declaredLength : null;
  const fromPath = decodeURIComponent(url.pathname.split("/").pop() ?? "").replace(/\.[A-Za-z0-9]{1,5}$/, "");
  try {
    return await storeAudioUpload(env, userId, {
      title: typeof title === "string" && title.trim() ? title : fromPath,
      body: response.body,
      length,
      source: { kind: "fetched", type: response.headers.get("Content-Type") ?? "" },
    });
  } catch (err) {
    await response.body.cancel().catch(() => {});
    throw err;
  }
}

// ---------------- narration ----------------

export interface NarrationInput {
  title: unknown;
  /** The document itself. */
  document?: string;
  format?: DocumentFormat;
  /** An existing document (message) of this user. */
  documentId?: string;
  voice?: string | null;
}

export async function createNarration(env: Env, userId: string, input: NarrationInput): Promise<AudioItem> {
  let raw = input.document ?? "";
  let format: DocumentFormat | undefined = input.format;
  let title = typeof input.title === "string" && input.title.trim() ? input.title : "";
  let sourceMessageId: string | null = null;

  if (input.documentId) {
    const record = await getDocumentRecord(env, input.documentId, userId);
    if (!record) throw new AudioInputError("document not found", 404);
    const markdown = await loadDocumentText(env, sourceMarkdownKey(record.doc_key));
    if (markdown !== null) {
      raw = markdown;
      format = "markdown";
    } else {
      raw = (await loadDocumentText(env, record.doc_key)) ?? "";
      format = "html";
    }
    sourceMessageId = record.id;
    if (!title) title = record.title;
  }

  if (raw.length > MAX_SOURCE_CHARS * 4) {
    throw new AudioInputError(`The document is too long. The limit is ${MAX_SOURCE_CHARS} characters.`, 413);
  }
  const text = documentToSpeechText(raw, format ?? detectDocumentFormat(raw));
  if (!text) throw new AudioInputError("The document has no readable text");
  if (text.length > MAX_SOURCE_CHARS) {
    throw new AudioInputError(`The document is too long. The limit is ${MAX_SOURCE_CHARS} characters.`, 413);
  }

  const words = countWords(text);
  const plan = planNarration(words);
  const id = newAudioId();
  const keys = audioKeys(id, "mp3");
  const sourceBytes = new TextEncoder().encode(text).byteLength;

  const account = await editionAccountLimits(env, userId);
  if (account && sourceBytes > account.max_upload_bytes) {
    throw new UsageRefused(`The document is larger than the ${account.max_upload_bytes}-byte hosted upload limit.`, 413, "storage_bytes");
  }

  // One narration is one assisted action, even though it makes two provider calls.
  await reserveEditionUsage(env, userId, "ai_actions", 1, `audio:${id}:ai`);
  let storageReserved = false;
  let stored = false;
  try {
    storageReserved = (await reserveEditionUsage(env, userId, "storage_bytes", sourceBytes, `audio:${id}:storage:source`)).managed;
    await env.DOCS.put(keys.source, text, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { kind: "audio-source", audio_id: id },
    });
    stored = true;
    await insertAudioRow(env, {
      id,
      user_id: userId,
      title: cleanAudioTitle(title),
      kind: "narration",
      mode: plan.mode,
      status: "processing",
      estimated_seconds: plan.estimatedSeconds,
      source_words: words,
      voice: input.voice ?? null,
      source_message_id: sourceMessageId,
      source_key: keys.source,
      storage_bytes: storageReserved ? sourceBytes : 0,
    });
    await env.ENHANCE_QUEUE.send({ kind: "audio", audioId: id, userId });
  } catch (err) {
    await env.DB.prepare("DELETE FROM audio_items WHERE id = ? AND user_id = ?").bind(id, userId).run().catch(() => {});
    if (stored) await env.DOCS.delete(keys.source).catch(() => {});
    if (storageReserved) {
      await releaseEditionUsage(env, userId, "storage_bytes", sourceBytes, `audio:${id}:storage:source:rollback`).catch(() => {});
    }
    await releaseEditionUsage(env, userId, "ai_actions", 1, `audio:${id}:ai:rollback`).catch(() => {});
    throw err;
  }

  const row = await getAudioRow(env, userId, id);
  if (!row) throw new Error("audio row missing after insert");
  return serializeAudioRowLinked(env, row);
}

// ---------------- read, rename, delete ----------------

export type AudioLookup =
  | { legacy: false; row: AudioRow; item: AudioItem }
  | { legacy: true; item: AudioItem; audioKey: string | null; transcriptKey: string };

/** `mint` is false for stream and transcript reads, which don't hand out the link. */
export async function lookupAudio(env: Env, userId: string, id: string, mint = true): Promise<AudioLookup | null> {
  if (isLegacyAudioId(id)) {
    const found = await getLegacyBriefing(env, userId, id.slice(LEGACY_ID_PREFIX.length));
    return found ? { legacy: true, item: found.item, audioKey: found.audio_key, transcriptKey: found.transcript_key } : null;
  }
  const row = await getAudioRow(env, userId, id);
  return row ? { legacy: false, row, item: await serializeAudioRowLinked(env, row, mint) } : null;
}

export async function renameAudio(env: Env, userId: string, id: string, title: unknown): Promise<AudioItem | null> {
  if (isLegacyAudioId(id)) throw new AudioInputError("Briefings take their title from the source document");
  if (typeof title !== "string" || !title.trim()) throw new AudioInputError("title must be a non-empty string");
  const row = await getAudioRow(env, userId, id);
  if (!row) return null;
  await updateAudioRow(env, userId, id, { title: cleanAudioTitle(title) });
  const next = await getAudioRow(env, userId, id);
  return next ? serializeAudioRowLinked(env, next) : null;
}

// Removes the item, its R2 objects and its favorite. A briefing (id "commute:...")
// belongs to its source document, so it is not deleted here.
export async function deleteAudio(env: Env, userId: string, id: string): Promise<boolean> {
  if (isLegacyAudioId(id)) throw new AudioInputError("Delete the source document instead");
  const row = await getAudioRow(env, userId, id);
  if (!row) return false;
  await Promise.all(
    [row.audio_key, row.transcript_key, row.source_key, ...Object.values(audioKeys(id, "mp3"))]
      .filter((key): key is string => Boolean(key))
      .map((key) => env.DOCS.delete(key).catch(() => {}))
  );
  await deleteAudioRow(env, userId, id);
  if (row.storage_bytes > 0) {
    await releaseEditionUsage(env, userId, "storage_bytes", row.storage_bytes, `audio:${id}:storage:delete`).catch((err) =>
      console.error("audio storage release failed", err)
    );
  }
  return true;
}
