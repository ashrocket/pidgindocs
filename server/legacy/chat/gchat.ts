import type { Env } from "../types";
import { decryptValue } from "../crypto";
import { getDestinationConfigValue } from "../destinations/store";
import type {
  ChatChannel,
  ChatDeliveryResult,
  ChatMessageRow,
  Conversation,
  GChatConfig,
  GServiceAccountKey,
  ResolvedGChatConfig,
} from "./types";

export const GCHAT_CONFIG_NAME = "gchat_chat";
export const GCHAT_SYSTEM_ISSUER = "chat@system.gserviceaccount.com";

const CHAT_API_BASE = "https://chat.googleapis.com/v1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHAT_BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
// JWKS for the two bearer-token modes Google Chat can be configured with:
// "Project Number" audience → self-signed JWT from chat@system (its own keys);
// "HTTP endpoint URL" audience → a Google ID token (standard OAuth2 certs).
const GCHAT_SYSTEM_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com";
const GOOGLE_OAUTH_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ID_TOKEN_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

// Chat rejects messages over 32,000 bytes (text + cards combined).
const GCHAT_MAX_TEXT_BYTES = 31000;

// ---------------------------------------------------------------------------
// Config

export async function loadGChatConfig(env: Env): Promise<GChatConfig | null> {
  const config = await getDestinationConfigValue<GChatConfig>(env, GCHAT_CONFIG_NAME);
  if (!config?.project_number || !config.service_account_key || !config.owner_email) {
    return null;
  }
  return config;
}

async function loadResolvedGChatConfig(env: Env): Promise<ResolvedGChatConfig | null> {
  const config = await loadGChatConfig(env);
  if (!config) return null;
  if (!env.GCHAT_ENCRYPTION_KEY) {
    console.error("[chat:gchat] GCHAT_ENCRYPTION_KEY not set — cannot decrypt service account key");
    return null;
  }
  try {
    const keyJson = await decryptValue(
      config.service_account_key,
      env.GCHAT_ENCRYPTION_KEY,
      "GCHAT_ENCRYPTION_KEY"
    );
    const service_account_key = JSON.parse(keyJson) as GServiceAccountKey;
    if (!service_account_key.client_email || !service_account_key.private_key) {
      console.error("[chat:gchat] service account key is missing client_email/private_key");
      return null;
    }
    return { ...config, service_account_key };
  } catch (err) {
    console.error("[chat:gchat] unable to decrypt service account key", err);
    return null;
  }
}

// Merge a partial update (dm_space, owner_user_name) into the stored config
// without touching the encrypted blob. A single json_set UPDATE keeps this
// atomic — a read-modify-write here could clobber a concurrently re-saved
// config (including its encrypted key) with stale data.
export async function patchGChatConfig(
  env: Env,
  patch: Partial<Pick<GChatConfig, "dm_space" | "owner_user_name">>
): Promise<void> {
  const entries = Object.entries(patch);
  if (entries.length === 0) return;
  // Keys come from the typed union above, never from input.
  const setters = entries.map(([key]) => `'$.${key}', json(?)`).join(", ");
  await env.DB.prepare(
    `UPDATE destination_configs SET value = json_set(value, ${setters}), updated_at = datetime('now')
     WHERE name = ?`
  )
    .bind(...entries.map(([, v]) => JSON.stringify(v ?? null)), GCHAT_CONFIG_NAME)
    .run();
}

// ---------------------------------------------------------------------------
// base64url helpers (module-local by codebase convention — auth/jwt-verify.ts
// keeps its copies private)

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function textToB64url(text: string): string {
  return bytesToB64url(new TextEncoder().encode(text));
}

function b64urlToBytes(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodeJwtSection(section: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(section))) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Outbound: service-account access token (chat.bot scope)

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

async function signRs256Jwt(
  claims: Record<string, unknown>,
  privateKeyPem: string
): Promise<string> {
  const header = textToB64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = textToB64url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;

  const pemContents = privateKeyPem.replace(
    /-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n|\r/g,
    ""
  );
  const keyData = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${bytesToB64url(new Uint8Array(signature))}`;
}

export async function getGChatAccessToken(
  env: Env,
  key: GServiceAccountKey
): Promise<string> {
  const cacheKey = `gchat-token:${key.client_email}`;
  const cached = await env.SESSIONS.get(cacheKey);
  if (cached) return cached;

  const tokenUri = key.token_uri || TOKEN_URL;
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signRs256Jwt(
    { iss: key.client_email, scope: CHAT_BOT_SCOPE, aud: tokenUri, iat: now, exp: now + 3600 },
    key.private_key
  );

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`gchat token mint failed (${res.status}): ${detail}`);
  }
  const token = (await res.json()) as TokenResponse;
  if (!token.access_token) throw new Error("gchat token mint returned no access_token");

  const ttl = Math.max((token.expires_in ?? 3600) - 60, 60);
  await env.SESSIONS.put(cacheKey, token.access_token, { expirationTtl: ttl });
  return token.access_token;
}

// ---------------------------------------------------------------------------
// Outbound: text conversion + send

// Google Chat's `text` field uses Chat's own markup, not Markdown:
// *bold*  _italic_  ~strike~  `code`  ``` fences  <url|text> links.
export function toGChatText(markdown: string): string {
  // Protected spans are stashed behind tokens delimited by NUL (\u0000) and
  // SOH (\u0001) — bytes real chat text never contains. Every token starts
  // with NUL and ends with SOH, so no concatenation of tokens and literal
  // text can synthesize another token (a bare trailing NUL next to a capital
  // letter, or a heading wrapping bold, previously corrupted output).
  const protectedSpans: string[] = [];
  const stash = (span: string): string => {
    protectedSpans.push(span);
    return `\u0000F${protectedSpans.length - 1}\u0001`;
  };
  const BOLD_OPEN = "\u0000B\u0001";
  const BOLD_CLOSE = "\u0000E\u0001";

  // Code first, then links (converted and immediately protected), then bare
  // URLs — emphasis rewrites must never touch URL bodies (__init__.py etc.).
  let text = markdown.replace(/```[\s\S]*?```|`[^`\n]+`/g, stash);
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label, url) => stash(`<${url}|${label}>`)
  );
  text = text.replace(/https?:\/\/[^\s<>|]+/g, stash);

  text = text
    // bold: **x** / __x__ -> placeholder so single-* italic conversion can run
    .replace(/\*\*([^*]+)\*\*/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`)
    .replace(/__([^_]+)__/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`)
    // italic: *x* -> _x_ (Chat renders _x_ as italic)
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, "$1_$2_")
    // strikethrough: ~~x~~ -> ~x~
    .replace(/~~([^~]+)~~/g, "~$1~")
    // headings -> bold lines; inner bold markers are dropped (the whole line
    // is bold anyway) so placeholders never nest
    .replace(
      /^#{1,6}\s+(.+)$/gm,
      (_, line: string) =>
        `${BOLD_OPEN}${line.replace(/\u0000B\u0001|\u0000E\u0001/g, "")}${BOLD_CLOSE}`
    )
    // bold placeholders -> Chat bold
    .replace(/\u0000B\u0001([\s\S]*?)\u0000E\u0001/g, "*$1*");

  // Restore protected spans; loop because a link label can itself contain a
  // stashed code span.
  for (let i = 0; i < 3 && text.includes("\u0000F"); i++) {
    text = text.replace(/\u0000F(\d+)\u0001/g, (_, n) => protectedSpans[Number(n)] ?? "");
  }

  const encoded = new TextEncoder().encode(text);
  if (encoded.length > GCHAT_MAX_TEXT_BYTES) {
    // Back off to a UTF-8 codepoint boundary so the cut never yields U+FFFD
    // and "..." keeps the total inside the cap.
    let cut = GCHAT_MAX_TEXT_BYTES - 3;
    while (cut > 0 && (encoded[cut] & 0xc0) === 0x80) cut--;
    text = new TextDecoder().decode(encoded.slice(0, cut)) + "...";
  }
  return text;
}

function formatOutbound(conversation: Conversation, message: ChatMessageRow, firstSend: boolean): string {
  const body = toGChatText(message.body);
  if (firstSend) {
    return `*${conversation.title}*\n\n${body}`;
  }
  if (message.sender === "user") {
    // Cross-channel echo of the user's own reply from another surface.
    return `_you, via ${message.channel ?? "app"}:_ ${body}`;
  }
  if (message.sender === "system") {
    return `_${body}_`;
  }
  return body;
}

interface GChatSentMessage {
  name?: string;
  thread?: { name?: string };
}

export const gchatChannel: ChatChannel<ResolvedGChatConfig> = {
  name: "gchat",

  loadConfig: loadResolvedGChatConfig,

  async deliver(
    env: Env,
    conversation: Conversation,
    message: ChatMessageRow,
    config: ResolvedGChatConfig,
    binding: string | null
  ): Promise<ChatDeliveryResult> {
    if (!config.dm_space) {
      throw new Error(
        "gchat DM space not established — message the PidginDocs app in Google Chat once to create it"
      );
    }
    const token = await getGChatAccessToken(env, config.service_account_key);
    const url =
      `${CHAT_API_BASE}/${config.dm_space}/messages` +
      `?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: formatOutbound(conversation, message, binding === null),
        // In threaded spaces this groups the conversation into one thread; in
        // flat DMs Google falls back to a plain message, which is fine.
        thread: { threadKey: conversation.id },
      }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      throw new Error(`gchat send failed (${res.status}): ${detail}`);
    }
    const sent = (await res.json()) as GChatSentMessage;
    return {
      eventId: sent.name ?? "",
      // Flat DMs give every message a synthetic per-message thread, or none —
      // bind a stable synthetic id in that case so inbound space-level
      // fallback (findLatestOpenConversationInSpace) still works.
      binding: sent.thread?.name ?? `${config.dm_space}#${conversation.id}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Inbound: webhook bearer-token verification

interface Jwks {
  keys: Array<JsonWebKey & { kid?: string }>;
}

// NOT auth/jwks.ts's fetchJwks: that caches by host only, and both Google
// JWKS endpoints live on www.googleapis.com — sharing its cache key would
// poison the Sign-In key cache. Cache by full URL here.
async function fetchJwksByUrl(env: Env, url: string): Promise<Jwks> {
  const cacheKey = `jwks-url:${url}`;
  const cached = await env.SESSIONS.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as Jwks;
    } catch {
      // fall through and refetch
    }
  }
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`failed to fetch JWKS (${res.status})`);
  const jwks = (await res.json()) as Jwks;
  await env.SESSIONS.put(cacheKey, JSON.stringify(jwks), { expirationTtl: 6 * 60 * 60 });
  return jwks;
}

async function verifyRs256Signature(
  headerB64: string,
  payloadB64: string,
  signatureB64: string,
  jwks: Jwks,
  kid: string | undefined
): Promise<boolean> {
  const jwk =
    jwks.keys.find((k) => k.kid === kid) ??
    (jwks.keys.length === 1 && !kid ? jwks.keys[0] : undefined);
  if (!jwk) return false;
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  return await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    b64urlToBytes(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
}

// Verifies the Authorization bearer on a Google Chat interaction event.
// Supports both "Authentication Audience" modes the Chat app can be
// configured with:
//   - Project Number: self-signed JWT, iss = chat@system…, aud = project number
//   - HTTP endpoint URL: Google ID token, email = chat@system…, aud = webhook URL
export async function verifyGChatBearer(
  headers: Headers,
  env: Env,
  config: Pick<GChatConfig, "project_number">,
  now = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  const auth = headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  const token = auth.slice(7);
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodeJwtSection(headerB64);
    claims = decodeJwtSection(payloadB64);
  } catch {
    return false;
  }
  if (header.alg !== "RS256") return false;

  const iss = typeof claims.iss === "string" ? claims.iss : "";
  let jwksUrl: string;
  const allowedAudiences: string[] = [];
  if (iss === GCHAT_SYSTEM_ISSUER) {
    jwksUrl = GCHAT_SYSTEM_JWKS_URL;
    allowedAudiences.push(config.project_number);
  } else if (GOOGLE_ID_TOKEN_ISSUERS.includes(iss)) {
    if (claims.email !== GCHAT_SYSTEM_ISSUER) return false;
    jwksUrl = GOOGLE_OAUTH_JWKS_URL;
    const webhookUrl = `${env.WORKER_URL.replace(/\/$/, "")}/api/chat/gchat/events`;
    allowedAudiences.push(webhookUrl, `${webhookUrl}/`);
  } else {
    return false;
  }

  const audClaim = claims.aud;
  const tokenAudiences = Array.isArray(audClaim)
    ? audClaim.filter((a): a is string => typeof a === "string")
    : typeof audClaim === "string"
      ? [audClaim]
      : [];
  if (!tokenAudiences.some((a) => allowedAudiences.includes(a))) return false;

  const skew = 60;
  if (typeof claims.exp !== "number" || claims.exp + skew < now) return false;

  try {
    const jwks = await fetchJwksByUrl(env, jwksUrl);
    const kid = typeof header.kid === "string" ? header.kid : undefined;
    return await verifyRs256Signature(headerB64, payloadB64, signatureB64, jwks, kid);
  } catch (err) {
    console.error("[chat:gchat] bearer verification failed", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Inbound: event normalization (legacy Chat-app envelope + the newer
// Workspace-add-on envelope with the `chat` wrapper — both are live in 2026)

export interface NormalizedGChatEvent {
  kind: "MESSAGE" | "ADDED_TO_SPACE" | "REMOVED_FROM_SPACE" | "OTHER";
  isAddonEnvelope: boolean;
  space: { name: string; spaceType: string } | null;
  user: { name: string; email: string | null; displayName: string | null; type: string | null } | null;
  message: {
    name: string;
    text: string;
    threadName: string | null;
    threadKey: string | null;
  } | null;
}

interface RawUser {
  name?: string;
  email?: string;
  displayName?: string;
  type?: string;
}

interface RawSpace {
  name?: string;
  spaceType?: string;
  type?: string;
}

interface RawMessage {
  name?: string;
  text?: string;
  argumentText?: string;
  thread?: { name?: string; threadKey?: string };
  space?: RawSpace;
  sender?: RawUser;
}

function normalizeUser(user: RawUser | undefined): NormalizedGChatEvent["user"] {
  if (!user?.name) return null;
  return {
    name: user.name,
    email: user.email ?? null,
    displayName: user.displayName ?? null,
    type: user.type ?? null,
  };
}

function normalizeSpace(space: RawSpace | undefined): NormalizedGChatEvent["space"] {
  if (!space?.name) return null;
  // Legacy events use type: "DM" | "ROOM"; current ones use spaceType.
  const spaceType = space.spaceType ?? (space.type === "DM" ? "DIRECT_MESSAGE" : space.type ?? "");
  return { name: space.name, spaceType };
}

function normalizeMessage(message: RawMessage | undefined): NormalizedGChatEvent["message"] {
  if (!message?.name) return null;
  return {
    name: message.name,
    text: (message.argumentText ?? message.text ?? "").trim(),
    threadName: message.thread?.name ?? null,
    threadKey: message.thread?.threadKey ?? null,
  };
}

export function normalizeGChatEvent(body: Record<string, unknown>): NormalizedGChatEvent {
  const chat = body.chat as
    | {
        user?: RawUser;
        messagePayload?: { message?: RawMessage; space?: RawSpace };
        addedToSpacePayload?: { space?: RawSpace };
        removedFromSpacePayload?: { space?: RawSpace };
      }
    | undefined;

  if (chat) {
    if (chat.messagePayload) {
      const message = normalizeMessage(chat.messagePayload.message);
      return {
        kind: "MESSAGE",
        isAddonEnvelope: true,
        space: normalizeSpace(chat.messagePayload.space ?? chat.messagePayload.message?.space),
        user: normalizeUser(chat.user ?? chat.messagePayload.message?.sender),
        message,
      };
    }
    if (chat.addedToSpacePayload) {
      return {
        kind: "ADDED_TO_SPACE",
        isAddonEnvelope: true,
        space: normalizeSpace(chat.addedToSpacePayload.space),
        user: normalizeUser(chat.user),
        message: null,
      };
    }
    if (chat.removedFromSpacePayload) {
      return {
        kind: "REMOVED_FROM_SPACE",
        isAddonEnvelope: true,
        space: normalizeSpace(chat.removedFromSpacePayload.space),
        user: normalizeUser(chat.user),
        message: null,
      };
    }
    return { kind: "OTHER", isAddonEnvelope: true, space: null, user: normalizeUser(chat.user), message: null };
  }

  const type = typeof body.type === "string" ? body.type : "";
  const message = normalizeMessage(body.message as RawMessage | undefined);
  const kind =
    type === "MESSAGE" || type === "ADDED_TO_SPACE" || type === "REMOVED_FROM_SPACE"
      ? type
      : "OTHER";
  return {
    kind,
    isAddonEnvelope: false,
    space: normalizeSpace(
      (body.space as RawSpace | undefined) ?? (body.message as RawMessage | undefined)?.space
    ),
    user: normalizeUser(
      (body.user as RawUser | undefined) ?? (body.message as RawMessage | undefined)?.sender
    ),
    message,
  };
}

// Synchronous text reply in whichever envelope the event arrived with.
export function gchatSyncReply(event: NormalizedGChatEvent, text: string): Record<string, unknown> {
  if (event.isAddonEnvelope) {
    return {
      hostAppDataAction: {
        chatDataAction: { createMessageAction: { message: { text } } },
      },
    };
  }
  return { text };
}
