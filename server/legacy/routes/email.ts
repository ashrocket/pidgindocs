import { Env } from "../types";
import { json } from "../utils";
import { verifyApiKey, unauthorized } from "../middleware";
import { mailFrom } from "../email";

export async function handlePostEmail(request: Request, env: Env): Promise<Response> {
  if (!verifyApiKey(request.headers, env.API_KEY)) return unauthorized();

  let body: { to?: string; subject?: string; html?: string; text?: string; from?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  const { to, subject, html, text, from } = body;
  if (!to || !subject || !html) {
    return json({ ok: false, error: "to, subject, and html are required" }, 400);
  }

  if (!env.RESEND_API_KEY) {
    return json({ ok: false, error: "email service not configured" }, 503);
  }

  const sender = from || mailFrom(env);
  const resendBody: Record<string, unknown> = { from: sender, to: [to], subject, html };
  if (text) resendBody.text = text;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(resendBody),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    return json({ ok: false, error: `email delivery failed: ${errText.slice(0, 200)}` }, 502);
  }

  const result = (await resp.json()) as { id?: string };
  return json({ ok: true, data: { id: result.id } });
}
