import { decryptValue } from "../crypto";
import type { EncryptedValue } from "../crypto";
import type { CommuteConfig } from "../destinations/types";
import { getDestinationConfigValue } from "../destinations/store";
import { createMessage } from "../messages/store";
import type { Env } from "../types";
import {
  buildCommuteScriptPrompt,
  buildCommuteTranscript,
  DEFAULT_COMMUTE_SCRIPT_MODEL,
  DEFAULT_COMMUTE_SPEECH_INSTRUCTIONS,
  htmlToText,
  normalizeGeneratedTranscript,
} from "./script";
import { listPlaylistItems } from "./playlist";
import { saveCommuteBriefing } from "./store";

export interface PlaylistBriefingResult {
  source_message_id: string;
  title: string;
  transcript_key: string;
  audio_key: string | null;
  doc_count: number;
  doc_ids: string[];
}

interface OpenAIChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?:
        | string
        | Array<{ type?: string; text?: string; [key: string]: unknown }>
        | null;
    };
  }>;
}

function readChatCompletionText(
  payload: OpenAIChatCompletionResponse
): string | null {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return null;
  }

  return content
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

function resolvedTtsProvider(config: CommuteConfig): "openai" | "elevenlabs" | "gemini" {
  return config.tts_provider === "elevenlabs" || config.tts_provider === "gemini"
    ? config.tts_provider
    : "openai";
}

function resolvedVoice(config: CommuteConfig): string {
  const provider = resolvedTtsProvider(config);
  if (provider === "elevenlabs") {
    return config.elevenlabs_voice_id || "";
  }
  if (provider === "gemini") {
    return config.gemini_voice || "Kore";
  }
  return config.voice || "sage";
}

function resolvedModel(config: CommuteConfig): string {
  const provider = resolvedTtsProvider(config);
  if (provider === "elevenlabs") {
    return config.elevenlabs_model || "eleven_multilingual_v2";
  }
  if (provider === "gemini") {
    return config.gemini_model || "gemini-2.5-flash-preview-tts";
  }
  return config.model || "gpt-4o-mini-tts";
}

function resolvedAudioContentType(config: CommuteConfig): string {
  return resolvedTtsProvider(config) === "gemini" ? "audio/wav" : "audio/mpeg";
}

function pcmToWav(pcmBytes: Uint8Array, sampleRate = 24000, channels = 1): ArrayBuffer {
  const headerSize = 44;
  const buffer = new ArrayBuffer(headerSize + pcmBytes.byteLength);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + pcmBytes.byteLength, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, pcmBytes.byteLength, true);
  out.set(pcmBytes, headerSize);
  return buffer;
}

async function synthesizeAudio(
  config: CommuteConfig,
  transcript: string
): Promise<ArrayBuffer> {
  const provider = resolvedTtsProvider(config);

  if (provider === "elevenlabs") {
    if (!config.elevenlabs_api_key) {
      throw new Error("elevenlabs_api_key is required when tts_provider is elevenlabs");
    }
    if (!config.elevenlabs_voice_id) {
      throw new Error("elevenlabs_voice_id is required when tts_provider is elevenlabs");
    }

    const resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
        config.elevenlabs_voice_id
      )}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": config.elevenlabs_api_key as string,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          model_id: resolvedModel(config),
          text: transcript,
        }),
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`elevenlabs speech ${resp.status}: ${text.slice(0, 160)}`);
    }

    return resp.arrayBuffer();
  }

  if (provider === "gemini") {
    if (!config.gemini_api_key) {
      throw new Error("gemini_api_key is required when tts_provider is gemini");
    }

    const instructions =
      config.speech_instructions?.trim() || DEFAULT_COMMUTE_SPEECH_INSTRUCTIONS;
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        resolvedModel(config)
      )}:generateContent?key=${encodeURIComponent(config.gemini_api_key as string)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `${instructions}\n\nRead the following script naturally and faithfully.\n\n${transcript}`,
                },
              ],
            },
          ],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: resolvedVoice(config),
                },
              },
            },
          },
        }),
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`gemini speech ${resp.status}: ${text.slice(0, 160)}`);
    }

    const data = (await resp.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inlineData?: { data?: string };
          }>;
        };
      }>;
    };
    const b64 = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!b64) {
      throw new Error("gemini speech returned no audio data");
    }
    const pcm = Uint8Array.from(atob(b64), (char) => char.charCodeAt(0));
    return pcmToWav(pcm);
  }

  if (!config.openai_api_key) {
    throw new Error("openai_api_key is required when tts_provider is openai");
  }

  const instructions =
    config.speech_instructions?.trim() || DEFAULT_COMMUTE_SPEECH_INSTRUCTIONS;
  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openai_api_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: resolvedModel(config),
      voice: resolvedVoice(config),
      input: transcript,
      instructions,
      response_format: "mp3",
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`openai speech ${resp.status}: ${text.slice(0, 160)}`);
  }

  return resp.arrayBuffer();
}

async function resolveCommuteConfig(env: Env): Promise<CommuteConfig> {
  const rawConfig = await getDestinationConfigValue<CommuteConfig>(env, "commute");
  if (!rawConfig) {
    throw new Error("commute destination not configured");
  }

  const encKey = env.COMMUTE_ENCRYPTION_KEY;
  const resolveKey = async (
    value: string | EncryptedValue | undefined
  ): Promise<string | undefined> => {
    if (!value) return undefined;
    if (typeof value === "string") return value;
    if (!encKey) {
      throw new Error("COMMUTE_ENCRYPTION_KEY required to decrypt commute config");
    }
    return decryptValue(value, encKey, "COMMUTE_ENCRYPTION_KEY");
  };

  return {
    ...rawConfig,
    openai_api_key: (await resolveKey(rawConfig.openai_api_key)) ?? "",
    elevenlabs_api_key: await resolveKey(rawConfig.elevenlabs_api_key),
    gemini_api_key: await resolveKey(rawConfig.gemini_api_key),
  };
}

async function buildPlaylistTranscript(
  config: CommuteConfig,
  title: string,
  combinedText: string,
  docCount: number,
  minutes: number
): Promise<{ transcript: string; scriptModel: string; source: "openai-script" | "heuristic"; warning?: string }> {
  const scriptModel = config.script_model || DEFAULT_COMMUTE_SCRIPT_MODEL;

  try {
    if (!config.openai_api_key) {
      throw new Error("openai_api_key is not configured");
    }

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openai_api_key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: scriptModel,
        temperature: 0.8,
        messages: [
          {
            role: "system",
            content:
              "You write private commute briefings as spoken scripts. Return plain text only, optimized for narration. " +
              `Synthesize ${docCount} documents into a coherent overview. ` +
              "Weave together key themes, important findings, and actionable items instead of summarizing each document sequentially.",
          },
          {
            role: "user",
            content: buildCommuteScriptPrompt({
              title,
              body: combinedText,
              minutes,
            }),
          },
        ],
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`openai script ${resp.status}: ${text.slice(0, 160)}`);
    }

    const data = (await resp.json()) as OpenAIChatCompletionResponse;
    const transcript = normalizeGeneratedTranscript(
      readChatCompletionText(data) || "",
      title
    );
    if (!transcript) {
      throw new Error("openai script returned empty content");
    }
    return { transcript, scriptModel, source: "openai-script" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      transcript: buildCommuteTranscript({ title, body: combinedText, minutes }),
      scriptModel,
      source: "heuristic",
      warning: `script generation fell back to extractor: ${message}`,
    };
  }
}

export async function generatePlaylistBriefing(
  env: Env,
  userId: string
): Promise<PlaylistBriefingResult> {
  const items = await listPlaylistItems(env, userId);
  if (items.length === 0) {
    throw new Error("playlist is empty");
  }

  const config = await resolveCommuteConfig(env);
  const docIds: string[] = [];
  const docParts: string[] = [];

  for (const item of items) {
    const row = await env.DB.prepare(
      "SELECT doc_key FROM messages WHERE id = ? AND type = 'document' AND user_id = ?"
    )
      .bind(item.message_id, userId)
      .first<{ doc_key: string | null }>();

    if (!row?.doc_key) continue;

    const doc = await env.DOCS.get(row.doc_key);
    if (!doc) continue;

    const text = htmlToText(await doc.text());
    if (!text) continue;

    docIds.push(item.message_id);
    docParts.push(`Document: ${item.title}\n\n${text}`);
  }

  if (docParts.length === 0) {
    throw new Error("no readable documents found in playlist");
  }

  const combinedText = docParts.join("\n\n---\n\n");
  const minutes = Math.min(Math.max(config.minutes || 3, 1), 10);
  const title = `Playlist Briefing (${docIds.length} documents)`;
  const transcriptResult = await buildPlaylistTranscript(
    config,
    title,
    combinedText,
    docIds.length,
    minutes
  );
  const provider = resolvedTtsProvider(config);
  const timestamp = Date.now();
  const syntheticId = crypto.randomUUID();
  const keyPrefix = `commute/playlist-${userId}-${timestamp}`;
  const transcriptKey = `${keyPrefix}/briefing.txt`;
  const audioKey = `${keyPrefix}/briefing.${provider === "gemini" ? "wav" : "mp3"}`;
  const metadataKey = `${keyPrefix}/briefing.json`;

  await createMessage(env, {
    id: syntheticId,
    type: "document",
    title,
    body: `Playlist briefing synthesizing ${docIds.length} documents`,
    docKey: null,
    priority: "normal",
    isPublic: false,
    instance: {
      model: "pidgin-playlist",
      session_id: `playlist-${syntheticId}`,
      project: "pidgin",
      source: "playlist-briefing",
    },
    userId,
  });

  await env.DOCS.put(transcriptKey, transcriptResult.transcript, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
    customMetadata: {
      kind: "commute-transcript",
      source_message_id: syntheticId,
      source_type: "playlist",
    },
  });

  const baseMetadata = {
    source_message_id: syntheticId,
    title,
    generated_at: new Date().toISOString(),
    provider,
    voice: resolvedVoice(config),
    model: resolvedModel(config),
    script_model: transcriptResult.scriptModel,
    transcript_source: transcriptResult.source,
    speech_instructions:
      config.speech_instructions?.trim() || DEFAULT_COMMUTE_SPEECH_INSTRUCTIONS,
    source_type: "playlist",
    doc_count: docIds.length,
    doc_ids: docIds,
    minutes,
    transcript_key: transcriptKey,
    warning: transcriptResult.warning || null,
  };

  let finalAudioKey: string | null = null;
  try {
    const audio = await synthesizeAudio(config, transcriptResult.transcript);
    await env.DOCS.put(audioKey, audio, {
      httpMetadata: { contentType: resolvedAudioContentType(config) },
      customMetadata: {
        kind: "commute-audio",
        source_message_id: syntheticId,
        source_type: "playlist",
      },
    });
    finalAudioKey = audioKey;

    await env.DOCS.put(
      metadataKey,
      JSON.stringify({ ...baseMetadata, audio_key: audioKey, status: "ready" }, null, 2),
      { httpMetadata: { contentType: "application/json; charset=utf-8" } }
    );

    await saveCommuteBriefing(env, {
      source_message_id: syntheticId,
      title,
      transcript_key: transcriptKey,
      audio_key: finalAudioKey,
      metadata_key: metadataKey,
      provider,
      voice: resolvedVoice(config),
      model: resolvedModel(config),
      minutes,
      status: "ready",
      error: null,
      source_type: "playlist",
      playlist_doc_ids: JSON.stringify(docIds),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await env.DOCS.put(
      metadataKey,
      JSON.stringify(
        { ...baseMetadata, audio_key: null, status: "transcript_only", error: message },
        null,
        2
      ),
      { httpMetadata: { contentType: "application/json; charset=utf-8" } }
    );

    await saveCommuteBriefing(env, {
      source_message_id: syntheticId,
      title,
      transcript_key: transcriptKey,
      audio_key: null,
      metadata_key: metadataKey,
      provider,
      voice: resolvedVoice(config),
      model: resolvedModel(config),
      minutes,
      status: "transcript_only",
      error: message,
      source_type: "playlist",
      playlist_doc_ids: JSON.stringify(docIds),
    });
  }

  return {
    source_message_id: syntheticId,
    title,
    transcript_key: transcriptKey,
    audio_key: finalAudioKey,
    doc_count: docIds.length,
    doc_ids: docIds,
  };
}
