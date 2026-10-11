import { Env } from "../types";
import { json } from "../utils";
import { verifyApiKey, unauthorized } from "../middleware";
import { theme } from "../web/theme";

const DEFAULT_TTL = 7200; // 2 hours
const MAX_TTL = 86400;    // 24 hours
const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB

export async function handlePostPreview(request: Request, env: Env): Promise<Response> {
  if (!verifyApiKey(request.headers, env.API_KEY)) return unauthorized();

  let body: { html?: string; title?: string; ttl?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  const { html, title, ttl } = body;
  if (!html || typeof html !== "string") {
    return json({ ok: false, error: "html required" }, 400);
  }
  if (html.length > MAX_HTML_BYTES) {
    return json({ ok: false, error: "html exceeds 2 MB limit" }, 413);
  }

  const id = crypto.randomUUID();
  const expirySeconds = Math.min(typeof ttl === "number" && ttl > 0 ? ttl : DEFAULT_TTL, MAX_TTL);
  const expiresAt = new Date(Date.now() + expirySeconds * 1000).toISOString();

  await env.SESSIONS.put(
    `preview:${id}`,
    JSON.stringify({ html, title: title || "Preview", createdAt: new Date().toISOString() }),
    { expirationTtl: expirySeconds }
  );

  const workerUrl = env.WORKER_URL || new URL(request.url).origin;
  const url = `${workerUrl}/preview/${id}`;

  return json({ ok: true, data: { id, url, expiresAt } });
}

export async function handleGetPreview(request: Request, env: Env, id: string): Promise<Response> {
  const raw = await env.SESSIONS.get(`preview:${id}`);
  if (!raw) {
    return new Response(notFoundPage(), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  let stored: { html: string; title: string };
  try {
    stored = JSON.parse(raw) as typeof stored;
  } catch {
    return new Response(notFoundPage(), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return new Response(stored.html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Preview-Title": encodeURIComponent(stored.title),
    },
  });
}

function notFoundPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Preview not found · PidginDocs</title></head>
<body style="margin:0;padding:60px 20px;background:#F0E1CF;font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;text-align:center;">
  <div style="font-family:Georgia,serif;font-size:28px;color:${theme.ink};margin-bottom:8px;">PidginDocs</div>
  <div style="font-size:15px;color:${theme.muted};">This preview has expired or doesn't exist.</div>
</body>
</html>`;
}
