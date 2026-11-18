import { EmailMessage } from "cloudflare:email";
import type { Env } from "./types";
import { editionProductIdentity, editionProductName } from "./edition-hooks";
import { theme } from "./web/theme";
import { editionSlug } from "./wire-names";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
    .replace(/&#39;/g, "'")
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
  text?: string;
  replyTo?: string;
}): string {
  const boundary = `${editionSlug()}-${crypto.randomUUID()}`;
  const text = opts.text ?? stripHtml(opts.html);
  const lines = [
    `From: ${headerSafe(opts.from)}`,
    `To: ${headerSafe(opts.to)}`,
    ...(opts.replyTo ? [`Reply-To: ${headerSafe(opts.replyTo)}`] : []),
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
  // The deployment configures the sender (an edition's provisioner can set RESEND_FROM for every tenant);
  // the edition's product identity supplies the fallback, so core carries no private host.
  // A display name that reads "Pidgin" shows the edition's product name instead.
  return (env.RESEND_FROM || env.MAIL_FROM || editionProductIdentity().mailFrom)
    .replace(/^Pidgin\s*</i, () => `${editionProductName()} <`);
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

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

// Throws on failure; Resend errors start with "Resend <status>:". The MAIL
// binding returns no message id.
export async function sendEmail(env: Env, input: SendEmailInput): Promise<{ id?: string }> {
  const { to, subject, html, text, replyTo } = input;
  const from = mailFrom(env);
  if (env.RESEND_API_KEY) {
    const payload: Record<string, unknown> = { from, to, subject, html };
    if (text) payload.text = text;
    if (replyTo) payload.reply_to = replyTo;
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Resend ${resp.status}: ${errText.slice(0, 200)}`);
    }
    const result = (await resp.json().catch(() => null)) as { id?: unknown } | null;
    return typeof result?.id === "string" ? { id: result.id.slice(0, 200) } : {};
  }

  if (!env.MAIL) {
    throw new Error("No mail provider is configured");
  }

  const message = new EmailMessage(from, to, mimeMessage({ from, to, subject, html, text, replyTo }));
  await env.MAIL.send(message);
  return {};
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
  await sendEmail(env, { to, subject, html });
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
  <path d="M4 14 L32 2 L60 14" fill="${theme.primaryDeep}"/>
  <rect x="14" y="20" width="36" height="26" rx="2" fill="${theme.paper}"/>
  <rect x="19" y="27" width="26" height="2" rx="1" fill="${theme.line}"/>
  <rect x="19" y="33" width="20" height="2" rx="1" fill="${theme.line}"/>
  <rect x="19" y="39" width="14" height="2" rx="1" fill="${theme.line}"/>
  <path d="M4 50 L26 34" stroke="${theme.primaryDeep}" stroke-width="1" stroke-linecap="round"/>
  <path d="M60 50 L38 34" stroke="${theme.primaryDeep}" stroke-width="1" stroke-linecap="round"/>
</svg>`;

const EMAIL_FONT = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";

export interface EmailWrapperOptions {
  lang?: string;
  // Inbox preview line; hidden in the message body.
  preheader?: string;
  taglineInFooter?: boolean;
}

export function emailWrapper(content: string, options: EmailWrapperOptions = {}): string {
  const lang = options.lang && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(options.lang) ? options.lang : "en";
  const preheader = options.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;">${escapeHtml(options.preheader)}</div>`
    : "";
  return `<!DOCTYPE html>
<html lang="${lang}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:32px 16px;background:${theme.sand};font-family:${EMAIL_FONT};color:${theme.ink};">
${preheader}<div style="max-width:520px;margin:0 auto;background:${theme.paper};border:1px solid ${theme.line};border-radius:16px;overflow:hidden;">
  <div style="padding:32px 40px 20px;">
    <div style="font-size:26px;font-weight:750;letter-spacing:-1px;color:${theme.ink};line-height:1;">${editionProductName()}</div>
    ${options.taglineInFooter ? "" : '<div style="font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:' + theme.primary + ';margin-top:8px;">Development, together</div>'}
  </div>
  <div style="height:1px;background:${theme.borderLight};margin:0 40px 28px;"></div>
  ${content}
  <div style="background:${theme.surface};padding:16px 40px;border-top:1px solid ${theme.borderLight};">
    ${options.taglineInFooter ? `<p style="font-size:12px;color:${theme.dim};margin:0 0 6px;">${lang === "ru" ? "Разработка вместе" : "Development, together"}</p>` : ""}
    <p style="font-size:12px;color:${theme.dim};margin:0;line-height:1.5;">${lang === "ru" ? `${editionProductName()} &middot; общее пространство для людей и их агентов` : `${editionProductName()} &middot; a shared home for people and their agents`}</p>
  </div>
</div>
</body>
</html>`;
}

export function loginEmailHtml(magicLink: string): string {
  const content = `
  <div style="padding:0 40px 32px;text-align:center;">
    ${ENVELOPE_SVG}
    <div style="font-size:20px;font-weight:700;letter-spacing:-0.4px;color:${theme.ink};margin:16px 0 10px;">Sign in to ${editionProductName()}</div>
    <p style="font-size:15px;color:${theme.muted};line-height:1.6;margin:0 0 28px;">Tap below to sign in. This link expires in 5&nbsp;minutes.</p>
    <a href="${escapeHtml(magicLink)}" style="background:${theme.primary};color:${theme.paper};font-size:15px;font-weight:500;letter-spacing:0.2px;padding:14px 40px;border-radius:10px;text-decoration:none;display:inline-block;">Sign in to ${editionProductName()}</a>
    <p style="font-size:12px;color:${theme.dim};line-height:1.5;margin:24px 0 0;">If you didn&rsquo;t request this, you can safely ignore this email.</p>
  </div>`;
  return emailWrapper(content);
}
