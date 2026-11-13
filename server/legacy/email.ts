import { EmailMessage } from "cloudflare:email";
import type { Env } from "./types";
import { theme } from "./web/theme";
import { htmlToPlainText } from "./html-text";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripHtml(value: string): string {
  return htmlToPlainText(value);
}

// Header values land straight in raw MIME text below; caller-supplied CR/LF
// could otherwise inject extra headers.
function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

function mimeMessage(opts: {
  from: string;
  to: string;
  subject: string;
  html: string;
}): string {
  const boundary = `pidgin-${crypto.randomUUID()}`;
  const text = stripHtml(opts.html);
  const lines = [
    `From: ${headerSafe(opts.from)}`,
    `To: ${headerSafe(opts.to)}`,
    `Subject: ${headerSafe(opts.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    opts.html,
    "",
    `--${boundary}--`,
    "",
  ];

  return lines.join("\r\n");
}

export function mailFrom(env: Env): string {
  return env.RESEND_FROM || env.MAIL_FROM || "PidginDocs <pidgindocs@pidgindocs.example.workers.dev>";
}

export function mailFromAddress(env: Env): string {
  const sender = mailFrom(env).trim();
  const match = sender.match(/<([^>]+)>/);
  return (match ? match[1] : sender).trim();
}

export function mailFromDomain(env: Env): string | null {
  const address = mailFromAddress(env);
  const atIndex = address.lastIndexOf("@");
  if (atIndex === -1 || atIndex === address.length - 1) {
    return null;
  }
  return address.slice(atIndex + 1).toLowerCase();
}

export async function sendOwnerEmail(
  env: Env,
  subject: string,
  html: string,
  to = env.OWNER_EMAIL
): Promise<void> {
  if (!to) {
    throw new Error("OWNER_EMAIL is not configured");
  }

  const from = mailFrom(env);
  if (env.RESEND_API_KEY) {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to,
        subject,
        html,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Resend ${resp.status}: ${text.slice(0, 200)}`);
    }
    return;
  }

  if (!env.MAIL) {
    throw new Error("No mail provider is configured");
  }

  const message = new EmailMessage(from, to, mimeMessage({ from, to, subject, html }));
  await env.MAIL.send(message);
}

export function mailDeliveryErrorMessage(env: Env, err: unknown): string {
  const rawMessage = err instanceof Error ? err.message : String(err);
  if (rawMessage.startsWith("Resend ")) {
    return rawMessage;
  }

  // Local dev: Cloudflare email binding doesn't actually send emails
  if (rawMessage.includes("invalid message-id") || rawMessage.includes("not implemented")) {
    if (env.ENVIRONMENT === "development") {
      return "Email sending is not available in local development. Set RESEND_API_KEY in .dev.vars, or use the magic link token from server logs.";
    }
    return "Email delivery failed (message-id error). Check Cloudflare Email Routing configuration.";
  }

  if (rawMessage !== "internal server error") {
    return rawMessage;
  }

  const sender = mailFromAddress(env);
  const domain = mailFromDomain(env);
  const domainHint = domain ? ` on ${domain}` : "";

  return `Cloudflare send_email is configured, but Email Routing still needs a verified destination address and a matching custom address/routing rule for ${sender}${domainHint}`;
}

const ENVELOPE_SVG = `<svg width="64" height="50" viewBox="0 0 64 50" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="4" y="14" width="56" height="36" rx="3" fill="${theme.primary}"/>
  <path d="M4 14 L32 2 L60 14" fill="#3D4A22"/>
  <rect x="14" y="20" width="36" height="26" rx="2" fill="${theme.paper}"/>
  <rect x="19" y="27" width="26" height="2" rx="1" fill="${theme.line}"/>
  <rect x="19" y="33" width="20" height="2" rx="1" fill="${theme.line}"/>
  <rect x="19" y="39" width="14" height="2" rx="1" fill="${theme.line}"/>
  <path d="M4 50 L26 34" stroke="#3D4A22" stroke-width="1" stroke-linecap="round"/>
  <path d="M60 50 L38 34" stroke="#3D4A22" stroke-width="1" stroke-linecap="round"/>
</svg>`;

export function emailWrapper(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:32px 16px;background:${theme.line};font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:480px;margin:0 auto;background:${theme.paper};border-radius:6px;overflow:hidden;">
  <div style="text-align:center;padding:40px 32px 20px;">
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:normal;color:${theme.ink};letter-spacing:-0.3px;margin-top:8px;line-height:1;">PidginDocs</div>
  </div>
  <div style="height:1px;background:${theme.line};margin:0 32px 32px;"></div>
  ${content}
  <div style="background:#F0E1CF;padding:14px 40px;text-align:center;border-top:1px solid ${theme.line};">
    <p style="font-size:11px;color:${theme.dim};margin:0;letter-spacing:0.3px;">PidginDocs &middot; self-hosted by you</p>
  </div>
</div>
</body>
</html>`;
}

export function loginEmailHtml(magicLink: string, code?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body style="margin:0;background:#FEFCF7;color:#102335;font-family:Arial,sans-serif"><div style="max-width:480px;margin:0 auto;padding:48px 28px"><p style="font-family:Georgia,serif;font-size:25px;margin:0 0 36px">PidginDocs</p><h1 style="font-family:Georgia,serif;font-weight:normal;font-size:30px;margin:0 0 20px">Sign in to PidginDocs</h1><p style="font-size:16px;line-height:1.6">Use this link to sign in. It expires in 5 minutes.</p><p style="margin:28px 0"><a href="${escapeHtml(magicLink)}" style="background:#191b1c;color:#fff;font-size:16px;padding:14px 24px;border-radius:8px;text-decoration:none;display:inline-block">Sign in</a></p>${code ? `<p style="font-size:15px;line-height:1.6">If you started in another browser or device, enter this code there:</p><p style="font-size:28px;letter-spacing:4px;font-weight:bold">${escapeHtml(code.slice(0,4))} ${escapeHtml(code.slice(4))}</p>` : ""}<p style="font-size:13px;line-height:1.6;color:#405A77;margin-top:32px">If you did not request this email, you can ignore it.</p></div></body></html>`;
}
