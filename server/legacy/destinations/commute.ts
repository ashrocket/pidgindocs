import type { Env } from "../types";
import { decryptValue } from "../crypto";
import type { EncryptedValue } from "../crypto";
import {
  buildCommuteResearchPrompt,
  buildCommuteScriptPrompt,
  buildCommuteTranscript,
  DEFAULT_COMMUTE_SCRIPT_MODEL,
  DEFAULT_COMMUTE_SPEECH_INSTRUCTIONS,
  htmlToText,
  normalizeGeneratedTranscript,
} from "../commute/script";
import { saveCommuteBriefing } from "../commute/store";
import type {
  CommuteConfig,
  MessageDestination,
  MessageEnvelope,
} from "./types";
import { getDestinationConfigValue } from "./store";

const textEncoder = new TextEncoder();

function utf8Size(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function getTranscriptKey(messageId: string): string {
  return `commute/${messageId}/briefing.txt`;
}

function getAudioKey(messageId: string, provider: "openai" | "elevenlabs" | "gemini"): string {
  const ext = provider === "gemini" ? "wav" : "mp3";
  return `commute/${messageId}/briefing.${ext}`;
}

function getMetadataKey(messageId: string): string {
  return `commute/${messageId}/briefing.json`;
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

interface GeneratedTranscriptResult {
  transcript: string;
  scriptModel: string;
  source: "openai-script" | "heuristic";
  researchNotes?: string;
  warning?: string;
}

async function readDocumentText(
  env: Env,
  envelope: MessageEnvelope
): Promise<string> {
  const parts: string[] = [];

  if (envelope.payload.body) {
    parts.push(envelope.payload.body);
  }

  if (envelope.docKey) {
    const doc = await env.DOCS.get(envelope.docKey);
    if (doc) {
      const html = await doc.text();
      const converted = htmlToText(html);
      if (converted) {
        parts.push(converted);
      }
    }
  }

  return parts.join("\n\n").trim();
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

async function generateTranscript(
  config: CommuteConfig,
  envelope: MessageEnvelope,
  sourceText: string,
  minutes: number
): Promise<GeneratedTranscriptResult> {
  const fallback = buildCommuteTranscript({
    title: envelope.payload.title,
    body: sourceText,
    minutes,
    description: envelope.payload.body || undefined,
  });
  const scriptModel = config.script_model || DEFAULT_COMMUTE_SCRIPT_MODEL;

  try {
    let researchNotes: string | undefined;
    let warning: string | undefined;
    try {
      const researchResp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.openai_api_key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: scriptModel,
          temperature: 0.3,
          messages: [
            {
              role: "system",
              content:
                "You extract evidence for private commute briefings. Return plain text only and preserve uncertainty.",
            },
            {
              role: "user",
              content: buildCommuteResearchPrompt({
                title: envelope.payload.title,
                body: sourceText,
                minutes,
                description: envelope.payload.body || undefined,
              }),
            },
          ],
        }),
      });

      if (!researchResp.ok) {
        const text = await researchResp.text();
        throw new Error(`openai research ${researchResp.status}: ${text.slice(0, 160)}`);
      }

      const researchData = (await researchResp.json()) as OpenAIChatCompletionResponse;
      researchNotes = readChatCompletionText(researchData) || undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warning = `research pass skipped: ${message}`;
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
              "You write private commute briefings as spoken scripts. Return plain text only, optimized for narration.",
          },
          {
            role: "user",
            content: buildCommuteScriptPrompt({
              title: envelope.payload.title,
              body: sourceText,
              minutes,
              description: envelope.payload.body || undefined,
              researchNotes,
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
    const rawTranscript = readChatCompletionText(data);
    const transcript = normalizeGeneratedTranscript(
      rawTranscript || "",
      envelope.payload.title
    );

    if (!transcript) {
      throw new Error("openai script returned empty content");
    }

    return {
      transcript,
      scriptModel,
      source: "openai-script",
      researchNotes,
      warning,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      transcript: fallback,
      scriptModel,
      source: "heuristic",
      researchNotes: undefined,
      warning: `script generation fell back to extractor: ${message}`,
    };
  }
}

function resolvedTtsProvider(config: CommuteConfig): "openai" | "elevenlabs" | "gemini" {
  return config.tts_provider === "elevenlabs" || config.tts_provider === "gemini" ? config.tts_provider : "openai";
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
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `${instructions}

Read the following script naturally and faithfully.

${transcript}`,
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

    const data = await resp.json() as {
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

export const commuteDestination: MessageDestination<CommuteConfig> = {
  name: "commute",

  async loadConfig(env: Env) {
    return getDestinationConfigValue<CommuteConfig>(env, "commute");
  },

  supports(envelope: MessageEnvelope): boolean {
    return envelope.payload.type === "document";
  },

  async deliver(env: Env, envelope: MessageEnvelope, config: CommuteConfig) {
    // Resolve potentially-encrypted API keys to plain strings
    const encKey = env.COMMUTE_ENCRYPTION_KEY;
    const resolveKey = async (val: string | EncryptedValue | undefined): Promise<string | undefined> => {
      if (!val) return undefined;
      if (typeof val === "string") return val;
      if (!encKey) throw new Error("COMMUTE_ENCRYPTION_KEY required to decrypt commute config");
      return decryptValue(val, encKey, "COMMUTE_ENCRYPTION_KEY");
    };
    const resolvedConfig = {
      ...config,
      openai_api_key: (await resolveKey(config.openai_api_key)) ?? "",
      elevenlabs_api_key: await resolveKey(config.elevenlabs_api_key),
      gemini_api_key: await resolveKey(config.gemini_api_key),
    };
    // Use resolvedConfig for all key accesses below
    config = resolvedConfig as CommuteConfig & { openai_api_key: string; elevenlabs_api_key?: string; gemini_api_key?: string };

    const sourceText = await readDocumentText(env, envelope);
    if (!sourceText) {
      throw new Error("commute briefings need a document body or HTML source");
    }

    const minutes = Math.min(Math.max(config.minutes || 3, 1), 10);
    const transcriptResult = await generateTranscript(
      config,
      envelope,
      sourceText,
      minutes
    );
    const transcript = transcriptResult.transcript;
    const provider = resolvedTtsProvider(config);
    const transcriptKey = getTranscriptKey(envelope.id);
    const metadataKey = getMetadataKey(envelope.id);
    const audioContentType = resolvedAudioContentType(config);
    const baseMetadata = {
      source_message_id: envelope.id,
      title: envelope.payload.title,
      generated_at: new Date().toISOString(),
      provider: provider,
      voice: resolvedVoice(config),
      model: resolvedModel(config),
      script_model: transcriptResult.scriptModel,
      transcript_source: transcriptResult.source,
      research_notes: transcriptResult.researchNotes || null,
      speech_instructions:
        config.speech_instructions?.trim() || DEFAULT_COMMUTE_SPEECH_INSTRUCTIONS,
      minutes,
      transcript_key: transcriptKey,
      warning: transcriptResult.warning || null,
    };

    let audio: ArrayBuffer | null = null;
    let audioKey: string | null = null;
    let status = "ready";
    let speechError: string | null = null;
    try {
      audio = await synthesizeAudio(config, transcript);
      audioKey = getAudioKey(envelope.id, provider);
    } catch (err) {
      status = "transcript_only";
      speechError = err instanceof Error ? err.message : String(err);
    }

    const metadata = JSON.stringify(
      {
        ...baseMetadata,
        audio_key: audioKey,
        status,
        ...(speechError ? { error: speechError } : {}),
      },
      null,
      2
    );
    const transcriptSize = utf8Size(transcript);
    const audioSize = audio?.byteLength ?? 0;
    const metadataSize = utf8Size(metadata);
    const writtenKeys: string[] = [];
    try {
      await env.DOCS.put(transcriptKey, transcript, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
        customMetadata: {
          kind: "commute-transcript",
          source_message_id: envelope.id,
        },
      });
      writtenKeys.push(transcriptKey);
      if (audio && audioKey) {
        await env.DOCS.put(audioKey, audio, {
          httpMetadata: { contentType: audioContentType },
          customMetadata: {
            kind: "commute-audio",
            source_message_id: envelope.id,
          },
        });
        writtenKeys.push(audioKey);
      }
      await env.DOCS.put(metadataKey, metadata, {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
      writtenKeys.push(metadataKey);
      await saveCommuteBriefing(env, {
        source_message_id: envelope.id,
        title: envelope.payload.title,
        transcript_key: transcriptKey,
        audio_key: audioKey,
        metadata_key: metadataKey,
        provider: provider,
        voice: resolvedVoice(config),
        model: resolvedModel(config),
        minutes,
        status,
        error: speechError,
        transcript_size: transcriptSize,
        audio_size: audioSize,
        metadata_size: metadataSize,
      });
    } catch (err) {
      await Promise.allSettled(writtenKeys.map((key) => env.DOCS.delete(key)));
      throw err;
    }

    return status === "ready"
      ? `generated commute briefing audio (${audioKey}; provider=${provider}; script=${transcriptResult.source})`
      : `generated commute transcript only (${speechError}; provider=${provider}; script=${transcriptResult.source})`;
  },
};
