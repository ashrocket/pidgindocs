import type { ApiResponse } from "./types";

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key",
    "Access-Control-Expose-Headers": "X-Unread-Count, X-Has-More, X-Offset, X-PidginDocs-Board-Trust",
  };
}

export function json<T>(body: ApiResponse<T>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

/**
 * Run best-effort follow-up work after the response when an ExecutionContext
 * is available; inline otherwise (tests and callers without one). Callers
 * attach their own .catch — this helper doesn't swallow rejections.
 */
export async function deferOrAwait(
  ctx: ExecutionContext | undefined,
  work: Promise<unknown>
): Promise<void> {
  if (ctx) {
    ctx.waitUntil(work);
    return;
  }
  await work;
}
