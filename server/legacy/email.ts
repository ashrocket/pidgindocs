import { EmailMessage } from "cloudflare:email";
import type { Env } from "./types";
import { theme } from "./web/theme";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
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

export function loginEmailHtml(magicLink: string): string {
  const content = `
  <div style="padding:0 40px 32px;text-align:center;">
    ${ENVELOPE_SVG}
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:bold;color:${theme.ink};margin:16px 0 10px;">Sign in to PidginDocs</div>
    <p style="font-size:15px;color:${theme.muted};line-height:1.6;margin:0 0 28px;">Tap below to sign in. This link expires in 5&nbsp;minutes.</p>
    <a href="${escapeHtml(magicLink)}" style="background:${theme.primary};color:${theme.paper};font-size:15px;font-weight:500;letter-spacing:0.2px;padding:14px 40px;border-radius:6px;text-decoration:none;display:inline-block;">Sign in to PidginDocs</a>
    <p style="font-size:12px;color:${theme.dim};line-height:1.5;margin:24px 0 0;">If you didn&rsquo;t request this, you can safely ignore this email.</p>
  </div>`;
  return emailWrapper(content);
}
