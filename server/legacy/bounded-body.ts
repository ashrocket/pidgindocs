// Read incrementally: Content-Length is an early hint, never the size authority.
export class BodyTooLargeError extends Error {}
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
export async function boundedForm(request: Request, limit = 16_384): Promise<URLSearchParams> {
  const contentType = request.headers.get("Content-Type")?.split(";")[0].trim();
  if (contentType !== "application/x-www-form-urlencoded") throw new Error("invalid form content type");
  return new URLSearchParams(await boundedText(request, limit));
}
// Cookies may authenticate writes only from this instance. Header credentials
// remain usable by native/CLI clients that do not send Origin.
export function allowsCredentialWrite(request: Request): boolean {
  const auth = request.headers.get("Authorization");
  if (auth && !/^(Bearer|Session) \S+$/.test(auth)) return false;
  const origin = request.headers.get("Origin");
  if (origin) return origin === new URL(request.url).origin;
  return /^(Bearer|Session) \S+$/.test(request.headers.get("Authorization") || "");
}
