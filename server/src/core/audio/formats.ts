// Accepted audio formats and magic-byte checks.
//
// The product plays audio in Safari and on iPhone, so it accepts only formats both
// play: MP3, M4A/AAC and WAV. A declared type is not enough. The first bytes of
// the file must also match, so a mislabeled file is rejected.

export type AudioFormat = "mp3" | "m4a" | "aac" | "wav";

export const MAX_RAW_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_MULTIPART_UPLOAD_BYTES = 25 * 1024 * 1024;
// A raw body without Content-Length is buffered, so it gets the multipart cap.
export const MAX_UNSIZED_UPLOAD_BYTES = MAX_MULTIPART_UPLOAD_BYTES;
// Bytes read first: enough to tell the formats apart and to read a WAV header.
export const SNIFF_BYTES = 44;

export class AudioFormatError extends Error {
  readonly status = 415;
}

const DECLARED: Record<string, { formats: AudioFormat[]; mime: string }> = {
  "audio/mpeg": { formats: ["mp3"], mime: "audio/mpeg" },
  "audio/mp3": { formats: ["mp3"], mime: "audio/mpeg" },
  "audio/mp4": { formats: ["m4a"], mime: "audio/mp4" },
  "audio/x-m4a": { formats: ["m4a"], mime: "audio/mp4" },
  "audio/m4a": { formats: ["m4a"], mime: "audio/mp4" },
  "audio/aac": { formats: ["aac", "m4a"], mime: "audio/aac" },
  "audio/wav": { formats: ["wav"], mime: "audio/wav" },
  "audio/x-wav": { formats: ["wav"], mime: "audio/wav" },
  "audio/wave": { formats: ["wav"], mime: "audio/wav" },
};

const MIME_BY_FORMAT: Record<AudioFormat, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
};

export const EXTENSION_BY_MIME: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
};

export function plainType(value: string | null | undefined): string {
  return (value ?? "").split(";")[0].trim().toLowerCase();
}

export function unsupportedTypeMessage(type: string): string {
  const shown = type && type.length <= 60 ? type.replace(/[^\w./+-]/g, "") : "";
  return `Use MP3, M4A, or WAV — Safari and iPhone can't play ${shown || "this file type"}`;
}

export function sniffAudioFormat(head: Uint8Array): AudioFormat | null {
  if (head.length >= 3 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return "mp3";
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    // The layer bits are 00 in an ADTS (raw AAC) frame and never 00 in MPEG audio.
    return (head[1] & 0x06) === 0 ? "aac" : "mp3";
  }
  if (head.length >= 8 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) return "m4a";
  if (
    head.length >= 12 &&
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
    head[8] === 0x57 && head[9] === 0x41 && head[10] === 0x56 && head[11] === 0x45
  ) {
    return "wav";
  }
  return null;
}

const GENERIC_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

// Checks a declared type against the first bytes. Returns the stored mime.
// A generic type (curl sends application/octet-stream for many extensions) is
// decided by the bytes alone. Any other non-audio type is rejected.
export function checkDeclaredAudio(declared: string, head: Uint8Array): string {
  const type = plainType(declared);
  if (GENERIC_TYPES.has(type)) return detectFetchedAudio(type, head);
  const accepted = DECLARED[type];
  if (!accepted) throw new AudioFormatError(unsupportedTypeMessage(type));
  const sniffed = sniffAudioFormat(head);
  if (!sniffed || !accepted.formats.includes(sniffed)) {
    throw new AudioFormatError(
      `The file is not really ${type}. Use MP3, M4A, or WAV — Safari and iPhone can't play other formats`
    );
  }
  return accepted.mime;
}

// For a file fetched by URL, where the server's content type is often generic.
// The bytes decide. A clearly wrong declared type still fails.
export function detectFetchedAudio(declared: string, head: Uint8Array): string {
  const type = plainType(declared);
  if (type && type.startsWith("audio/") && !DECLARED[type]) {
    throw new AudioFormatError(unsupportedTypeMessage(type));
  }
  const sniffed = sniffAudioFormat(head);
  if (!sniffed) throw new AudioFormatError(unsupportedTypeMessage(type));
  return MIME_BY_FORMAT[sniffed];
}

// WAV duration from the canonical 44-byte header. Other formats return null.
export function wavDurationSeconds(head: Uint8Array, totalBytes: number): number | null {
  if (head.length < 44 || sniffAudioFormat(head) !== "wav") return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const byteRate = view.getUint32(28, true);
  if (!byteRate) return null;
  return Math.round(Math.max(0, totalBytes - 44) / byteRate);
}
