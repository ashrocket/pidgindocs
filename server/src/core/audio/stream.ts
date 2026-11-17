import type { Env } from "../types";
import { corsHeaders, json } from "../utils";

// Streams one R2 object as audio, with HTTP byte ranges. Safari and iPhone
// will not play an audio file unless the server answers Range requests.

export interface ParsedRange {
  start: number;
  end: number; // inclusive
}

// One range only. A header the server cannot read, or with several ranges, is
// ignored and the whole file is sent (RFC 9110, 14.2). "unsatisfiable" is a 416.
export function parseRange(header: string | null, size: number): ParsedRange | "unsatisfiable" | null {
  if (!header) return null;
  const match = header.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return null;
  const [, first, last] = match;
  if (first === "" && last === "") return null;
  if (first === "") {
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (!Number.isSafeInteger(start) || start >= size) return "unsatisfiable";
  if (!Number.isSafeInteger(end) || end < start) return null;
  return { start, end };
}

function audioHeaders(contentType: string, extra: Record<string, string>): Headers {
  const headers = new Headers({
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    ...corsHeaders(),
    ...extra,
  });
  headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
  return headers;
}

export async function streamAudioObject(
  request: Request,
  env: Env,
  key: string,
  fallbackType = "audio/mpeg"
): Promise<Response> {
  const head = await env.DOCS.head(key);
  if (!head) return json({ ok: false, error: "audio not found" }, 404);
  const size = head.size;
  const contentType = head.httpMetadata?.contentType || fallbackType;
  const isHead = request.method === "HEAD";

  const range = parseRange(request.headers.get("Range"), size);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: audioHeaders(contentType, { "Content-Range": `bytes */${size}` }),
    });
  }

  if (range) {
    const length = range.end - range.start + 1;
    const headers = audioHeaders(contentType, {
      "Content-Length": String(length),
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
    });
    if (isHead) return new Response(null, { status: 206, headers });
    const object = await env.DOCS.get(key, { range: { offset: range.start, length } });
    if (!object || !("body" in object) || !object.body) return json({ ok: false, error: "audio not found" }, 404);
    return new Response(object.body, { status: 206, headers });
  }

  const headers = audioHeaders(contentType, { "Content-Length": String(size) });
  if (isHead) return new Response(null, { status: 200, headers });
  const object = await env.DOCS.get(key);
  if (!object || !("body" in object) || !object.body) return json({ ok: false, error: "audio not found" }, 404);
  return new Response(object.body, { status: 200, headers });
}
