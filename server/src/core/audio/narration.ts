import { assertTenantWritable, UsageRefused, releaseEditionUsage, reserveEditionUsage, editionAccountLimits } from "../edition-hooks";
import { decryptValue } from "../crypto";
import type { EncryptedValue } from "../crypto";
import { getDestinationConfigValue } from "../destinations/store";
import type { CommuteConfig } from "../destinations/types";
import { callAnthropic } from "../enhance/anthropic";
import { IMPORT_TIER } from "../enhance/prompts";
import { resolveTier } from "../ai/tiers";
import type { Env, EnhanceJob } from "../types";
import { ELEVENLABS_BITRATE, synthesizeElevenLabs } from "./elevenlabs";
import { audioKeys, getAudioRow, type AudioMode, type AudioRow } from "./store";
import { countWords, scriptToSpeechText, trimToSentenceBoundary } from "./text";

// Narration: a document becomes audio.
//   - A document that reads in 3 minutes or less is read aloud as written.
//   - A longer one is summarized into a script of at most 3 minutes, and the
//     summary is read aloud.
// The work runs in the ENHANCE_QUEUE consumer, which has minutes of wall time.

/** Speaking pace used to estimate how long a text reads aloud. */
export const NARRATION_WORDS_PER_MINUTE = 155;
/** A document that reads in this many seconds or less is read in full. */
export const FULL_NARRATION_MAX_SECONDS = 180;
/** Words the summary should have (about 163 seconds). */
export const SUMMARY_TARGET_WORDS = 420;
/** The summary is asked again for this many words if it is too long. */
export const SUMMARY_RETRY_TARGET_WORDS = 350;
/** No script is longer than this: FULL_NARRATION_MAX_SECONDS at the speaking pace. */
export const MAX_SCRIPT_WORDS = 465;
/** Characters of source text one narration accepts. */
export const MAX_SOURCE_CHARS = 400_000;
export const AUDIO_SUMMARY_MODEL = resolveTier(IMPORT_TIER).model;
export const DEFAULT_ELEVENLABS_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
// Eleven v4: the highest-quality ElevenLabs speech model (10,000 characters per request;
// narration scripts stay under 3 minutes, about 3,000 characters).
export const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_v4";

const SUMMARY_MAX_TOKENS = 1500;
const MAX_ATTEMPT_KEY = 20;

export function estimateSeconds(words: number): number {
  return Math.round((words / NARRATION_WORDS_PER_MINUTE) * 60);
}

// Decided on the exact reading time, not the rounded seconds, so 466 words
// (180.4 seconds) is long even though it rounds to 180.
export function isFullLength(words: number): boolean {
  return (words / NARRATION_WORDS_PER_MINUTE) * 60 <= FULL_NARRATION_MAX_SECONDS;
}

// The reading time decides: 3 minutes or less is read in full, longer is
// summarized. A mode the caller asks for is only a hint and never overrides this.
export function planNarration(words: number): { mode: AudioMode; estimatedSeconds: number } {
  return { mode: isFullLength(words) ? "full" : "summary", estimatedSeconds: estimateSeconds(words) };
}

export function summarySystemPrompt(targetWords: number): string {
  return [
    "You write spoken audio overviews of documents. A voice will read your text aloud to a listener, so write for the ear.",
    "Write plain prose only. Do not use markdown, headings, bullet points, numbered lists, tables, URLs, code or emoji.",
    "Use short sentences. Spell out symbols and abbreviations a voice might misread.",
    "Open with one sentence that says what the document is and who it is for.",
    "Then give the main points in the order the document gives them.",
    "End with the single most important takeaway.",
    "Do not add facts that are not in the document. Do not mention these rules.",
    `Write about ${targetWords} words. Never write more than ${MAX_SCRIPT_WORDS} words.`,
  ].join("\n");
}

// Thrown for a failure that a retry cannot fix.
export class AudioJobError extends Error {
  readonly permanent = true;
}

function summaryRequest(title: string, source: string): string {
  return `Title: ${title}\n\nDocument:\n${source}`;
}

// The summary script. One retry asks for a shorter text; if that is still too
// long, it is cut at the last sentence end inside the limit.
export async function summarizeForAudio(env: Env, title: string, source: string): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new AudioJobError("This server cannot summarize long documents. Add ANTHROPIC_API_KEY.");
  }
  const ask = async (target: number): Promise<string> => {
    await assertTenantWritable(env);
    return scriptToSpeechText(
      await callAnthropic(env, {
        model: AUDIO_SUMMARY_MODEL,
        system: summarySystemPrompt(target),
        user: summaryRequest(title, source),
        maxTokens: SUMMARY_MAX_TOKENS,
      })
    );
  };
  let script = await ask(SUMMARY_TARGET_WORDS);
  if (countWords(script) > MAX_SCRIPT_WORDS) script = await ask(SUMMARY_RETRY_TARGET_WORDS);
  if (countWords(script) > MAX_SCRIPT_WORDS) script = trimToSentenceBoundary(script, MAX_SCRIPT_WORDS);
  return script;
}

interface SpeechSettings {
  apiKey: string | null;
  voiceId: string;
  modelId: string;
}

// Key order: the server secret, then the key saved in Setup (the commute config).
export async function resolveSpeechSettings(env: Env, requestedVoice: string | null): Promise<SpeechSettings> {
  let config: CommuteConfig | null = null;
  try {
    config = await getDestinationConfigValue<CommuteConfig>(env, "commute");
  } catch (err) {
    console.error("audio: commute config unreadable", err);
  }

  let apiKey: string | null = env.ELEVENLABS_API_KEY?.trim() || null;
  if (!apiKey && config?.elevenlabs_api_key) {
    const stored = config.elevenlabs_api_key as string | EncryptedValue;
    try {
      if (typeof stored === "string") apiKey = stored.trim() || null;
      else if (env.COMMUTE_ENCRYPTION_KEY) {
        apiKey = (await decryptValue(stored, env.COMMUTE_ENCRYPTION_KEY, "COMMUTE_ENCRYPTION_KEY")).trim() || null;
      }
    } catch (err) {
      console.error("audio: could not read the saved ElevenLabs key", err);
    }
  }

  return {
    apiKey,
    voiceId:
      requestedVoice || env.ELEVENLABS_VOICE_ID?.trim() || config?.elevenlabs_voice_id?.trim() || DEFAULT_ELEVENLABS_VOICE_ID,
    modelId:
      env.ELEVENLABS_MODEL_ID?.trim() || config?.elevenlabs_model?.trim() || DEFAULT_ELEVENLABS_MODEL_ID,
  };
}

export const NO_ELEVENLABS_KEY_MESSAGE =
  "No ElevenLabs key. Add ELEVENLABS_API_KEY to the server or an ElevenLabs key in Setup.";

const encoder = new TextEncoder();

function permanentOrRetry(err: unknown): never {
  if (err instanceof UsageRefused && err.status !== 503) throw new AudioJobError(err.message);
  throw err;
}

type AudioJob = Extract<EnhanceJob, { kind: "audio" }>;

export async function processAudioJob(env: Env, job: AudioJob, attempt: number): Promise<void> {
  await assertTenantWritable(env);
  const row = await getAudioRow(env, job.userId, job.audioId);
  // Gone (deleted) or already done: a redelivered job does nothing.
  if (!row || row.status !== "processing" || row.kind !== "narration") return;
  if (!row.source_key) throw new AudioJobError("The document has no readable text");

  const sourceObject = await env.DOCS.get(row.source_key);
  const source = sourceObject ? (await sourceObject.text()).trim() : "";
  if (!source) throw new AudioJobError("The document has no readable text");

  const keys = audioKeys(row.id, "mp3");
  const sourceWords = row.source_words ?? countWords(source);
  const mode: AudioMode = row.mode ?? planNarration(sourceWords).mode;

  // A retry reuses a script that an earlier delivery already wrote.
  let script: string | null = null;
  const earlier = await env.DOCS.get(keys.transcript);
  if (earlier) script = (await earlier.text()).trim() || null;
  if (!script) {
    script = mode === "full" ? source : await summarizeForAudio(env, row.title, source);
    if (!script.trim()) throw new AudioJobError("The document has no readable text");
    await assertTenantWritable(env);
    await env.DOCS.put(keys.transcript, script, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { kind: "audio-transcript", audio_id: row.id },
    });
  }
  const scriptWords = countWords(script);
  const scriptBytes = encoder.encode(script).byteLength;

  const settings = await resolveSpeechSettings(env, row.voice);
  if (!settings.apiKey) {
    await finishNarration(env, row, attempt, {
      status: "transcript_only",
      error: NO_ELEVENLABS_KEY_MESSAGE,
      scriptWords,
      mode,
      scriptBytes,
      audio: null,
      settings,
    });
    return;
  }

  await assertTenantWritable(env);
  const audio = await synthesizeElevenLabs({
    apiKey: settings.apiKey,
    voiceId: settings.voiceId,
    modelId: settings.modelId,
    text: script,
  });
  await finishNarration(env, row, attempt, {
    status: "ready",
    error: null,
    scriptWords,
    mode,
    scriptBytes,
    audio,
    settings,
  });
}

interface NarrationResult {
  status: "ready" | "transcript_only";
  error: string | null;
  scriptWords: number;
  mode: AudioMode;
  scriptBytes: number;
  audio: ArrayBuffer | null;
  settings: SpeechSettings;
}

async function finishNarration(env: Env, row: AudioRow, attempt: number, result: NarrationResult): Promise<void> {
  const keys = audioKeys(row.id, "mp3");
  // Concurrent queue deliveries must never clean up one another's output.
  const audioKey = result.audio ? `audio/${row.id}/audio-${crypto.randomUUID()}.mp3` : null;
  const reservationKey = `audio:${row.id}:storage:out:${Math.min(attempt, MAX_ATTEMPT_KEY)}:${crypto.randomUUID()}`;
  const audioBytes = result.audio?.byteLength ?? 0;
  const outputBytes = audioBytes + result.scriptBytes;

  let reserved = false;
  const written: string[] = [];
  try {
    await assertTenantWritable(env);
    const account = await editionAccountLimits(env, row.user_id);
    if (account && Math.max(audioBytes, result.scriptBytes) > account.max_upload_bytes) {
      throw new UsageRefused(
        `The audio is larger than the ${account.max_upload_bytes}-byte hosted upload limit.`,
        413,
        "storage_bytes"
      );
    }
    const usage = await reserveEditionUsage(
      env,
      row.user_id,
      "storage_bytes",
      outputBytes,
      reservationKey
    );
    reserved = usage.managed;

    if (result.audio) {
      await assertTenantWritable(env);
      await env.DOCS.put(audioKey!, result.audio, {
        httpMetadata: { contentType: "audio/mpeg" },
        customMetadata: { kind: "audio-narration", audio_id: row.id },
      });
      written.push(audioKey!);
    }

    await assertTenantWritable(env);
    const update = await env.DB.prepare(
      `UPDATE audio_items SET status = ?, error = ?, mode = ?, mime = ?, size_bytes = ?, duration_seconds = ?,
         script_words = ?, provider = ?, voice = ?, model = ?, audio_key = ?, transcript_key = ?,
         storage_bytes = storage_bytes + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND user_id = ? AND status = 'processing'`
    )
      .bind(
        result.status,
        result.error,
        result.mode,
        result.audio ? "audio/mpeg" : null,
        result.audio ? audioBytes : null,
        result.audio ? Math.round((audioBytes * 8) / ELEVENLABS_BITRATE) : null,
        result.scriptWords,
        result.audio ? "elevenlabs" : null,
        result.audio ? result.settings.voiceId : row.voice,
        result.audio ? result.settings.modelId : null,
        audioKey,
        keys.transcript,
        outputBytes,
        row.id,
        row.user_id
      )
      .run();
    if ((update.meta?.changes ?? 0) === 0) {
      // Another delivery may have finished or access may have ended. Only an
      // actually deleted item permits cleanup of shared source/transcript keys.
      await Promise.allSettled(written.map((key) => env.DOCS.delete(key)));
      if (!await getAudioRow(env, row.user_id, row.id)) {
        await Promise.allSettled([keys.transcript, keys.source].map((key) => env.DOCS.delete(key)));
      }
      if (reserved) {
        await releaseEditionUsage(env, row.user_id, "storage_bytes", outputBytes, `${reservationKey}:gone`)
          .catch((e) => console.error("audio storage release failed", e));
      }
    }
  } catch (err) {
    await Promise.allSettled(written.map((key) => env.DOCS.delete(key)));
    if (reserved) {
      await releaseEditionUsage(
        env,
        row.user_id,
        "storage_bytes",
        outputBytes,
        `${reservationKey}:rollback`
      ).catch((e) => console.error("audio storage rollback failed", e));
    }
    permanentOrRetry(err);
  }
}

// Paid access ending while narration runs may update only this existing job's
// failure metadata. The submitted document and earlier attempt artifacts stay.
export async function markAudioAccessDenied(env: Env, job: AudioJob, reason: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE audio_items SET status = 'failed', error = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND user_id = ? AND status = 'processing'`
  )
    .bind(reason.slice(0, 300), job.audioId, job.userId)
    .run();
}

// Last step of a job that cannot succeed: record why, and give back the AI action.
export async function markAudioFailed(env: Env, job: AudioJob, reason: string): Promise<void> {
  const keys = audioKeys(job.audioId, "mp3");
  const result = await env.DB.prepare(
    `UPDATE audio_items SET status = 'failed', error = ?, transcript_key = NULL,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND user_id = ? AND status = 'processing'`
  )
    .bind(reason.slice(0, 300), job.audioId, job.userId)
    .run();
  if ((result.meta?.changes ?? 0) === 0) return;
  await env.DOCS.delete(keys.transcript).catch(() => {});
  await releaseEditionUsage(env, job.userId, "ai_actions", 1, `audio:${job.audioId}:ai:release`).catch((e) =>
    console.error("audio ai release failed", e)
  );
}
