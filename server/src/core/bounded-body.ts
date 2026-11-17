// Reads a request body up to a limit, and decides whether a credential may write.

export class BodyTooLargeError extends Error {}

/** Content-Length is an early hint, never the size authority: the stream is counted as it is read. */
export async function boundedText(input: Pick<Request, "body" | "headers">, limit: number): Promise<string> {
  const length = input.headers.get("Content-Length");
  if (length && /^\d+$/.test(length) && Number(length) > limit) throw new BodyTooLargeError("body too large");
  if (!input.body) return "";
  const reader = input.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); throw new BodyTooLargeError("body too large"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

/** A cookie may authenticate a write only from this server's own origin. Header credentials stay usable by native and command-line clients that send no Origin. */
export function allowsCredentialWrite(request: Request): boolean {
  const auth = request.headers.get("Authorization");
  if (auth && !/^(Bearer|Session) \S+$/.test(auth)) return false;
  const origin = request.headers.get("Origin");
  if (origin) return origin === new URL(request.url).origin;
  return /^(Bearer|Session) \S+$/.test(request.headers.get("Authorization") || "");
}
