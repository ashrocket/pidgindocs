// The one ElevenLabs text-to-speech call. The audio narration pipeline, the
// commute briefing destination and the playlist briefing all use it.

export interface ElevenLabsSpeechInput {
  apiKey: string;
  voiceId: string;
  modelId: string;
  text: string;
}

export const ELEVENLABS_OUTPUT_FORMAT = "mp3_44100_128";
// mp3_44100_128 is 128 kbit/s.
export const ELEVENLABS_BITRATE = 128000;

export async function synthesizeElevenLabs(input: ElevenLabsSpeechInput): Promise<ArrayBuffer> {
  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      input.voiceId
    )}?output_format=${ELEVENLABS_OUTPUT_FORMAT}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": input.apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        model_id: input.modelId,
        text: input.text,
      }),
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`elevenlabs speech ${resp.status}: ${text.slice(0, 160)}`);
  }

  return resp.arrayBuffer();
}
