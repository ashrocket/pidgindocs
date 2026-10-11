import type { Env } from "../types";
import { decryptValue } from "../crypto";
import { getDestinationConfigValue } from "../destinations/store";
import type {
  ChatChannel,
  ChatDeliveryResult,
  ChatMessageRow,
  Conversation,
  MatrixChatConfig,
  ResolvedMatrixConfig,
} from "./types";

export const MATRIX_CONFIG_NAME = "matrix_chat";

// Matrix caps the whole event at 65536 bytes; body + formatted_body both
// derive from the markdown source, so capping the source well below half
// keeps the event comfortably under the limit.
const MATRIX_MAX_SOURCE_BYTES = 24000;

// ---------------------------------------------------------------------------
// Config

export async function loadMatrixConfig(env: Env): Promise<MatrixChatConfig | null> {
  const config = await getDestinationConfigValue<MatrixChatConfig>(env, MATRIX_CONFIG_NAME);
  if (!config?.homeserver_url || !config.access_token || !config.bot_mxid || !config.owner_mxid) {
    return null;
  }
  return config;
}

export async function loadResolvedMatrixConfig(env: Env): Promise<ResolvedMatrixConfig | null> {
  const config = await loadMatrixConfig(env);
  if (!config) return null;
  if (!env.MATRIX_ENCRYPTION_KEY) {
    console.error("[chat:matrix] MATRIX_ENCRYPTION_KEY not set — cannot decrypt access token");
    return null;
  }
  try {
    const access_token = await decryptValue(
      config.access_token,
      env.MATRIX_ENCRYPTION_KEY,
      "MATRIX_ENCRYPTION_KEY"
    );
    return { ...config, access_token };
  } catch (err) {
    console.error("[chat:matrix] unable to decrypt access token", err);
    return null;
  }
}

// Merge a partial update (last_error) into the stored config without touching
// the encrypted blob. A single json_set UPDATE keeps this atomic — a
// read-modify-write here could clobber a concurrently re-saved config
// (including its encrypted token) with stale data.
export async function patchMatrixConfig(
  env: Env,
  patch: Partial<Pick<MatrixChatConfig, "last_error">>
): Promise<void> {
  const entries = Object.entries(patch);
  if (entries.length === 0) return;
  // Keys come from the typed union above, never from input.
  const setters = entries.map(([key]) => `'$.${key}', json(?)`).join(", ");
  await env.DB.prepare(
    `UPDATE destination_configs SET value = json_set(value, ${setters}), updated_at = datetime('now')
     WHERE name = ?`
  )
    .bind(...entries.map(([, v]) => JSON.stringify(v ?? null)), MATRIX_CONFIG_NAME)
    .run();
}

// ---------------------------------------------------------------------------
// Client-Server API (raw fetch — no SDK; the surface we need is ~5 endpoints)

export class MatrixApiError extends Error {
  status: number;
  errcode: string | null;

  constructor(status: number, detail: string) {
    let errcode: string | null = null;
    try {
      const parsed = JSON.parse(detail) as { errcode?: string };
      if (typeof parsed.errcode === "string") errcode = parsed.errcode;
    } catch {
      // non-JSON error body
    }
    super(`matrix request failed (${status}${errcode ? ` ${errcode}` : ""}): ${detail}`);
    this.status = status;
    this.errcode = errcode;
  }
}

export async function matrixRequest<T>(
  config: ResolvedMatrixConfig,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${config.homeserver_url.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.access_token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    throw new MatrixApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Outbound: markdown → org.matrix.custom.html

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Converts the markdown subset PidginDocs messages actually use into the HTML
// Element renders. Same protected-span technique as toGChatText: stashed
// spans are delimited by NUL (\u0000) and SOH (\u0001) — bytes real chat text
// never contains. Block spans ("B") swallow their adjacent newlines when
// newlines become <br/>; inline spans ("F") leave line structure intact.
export function toMatrixHtml(markdown: string): string {
  const protectedSpans: string[] = [];
  const stash = (span: string, kind: "F" | "B" = "F"): string => {
    protectedSpans.push(span);
    return `\u0000${kind}${protectedSpans.length - 1}\u0001`;
  };

  let text = escapeHtml(markdown);

  // Code first, then links (converted and immediately protected), then bare
  // URLs — emphasis rewrites must never touch code or URL bodies.
  text = text.replace(/```(?:[^\n`]*)\n?([\s\S]*?)```|`([^`\n]+)`/g, (_m, fenced, inline) =>
    inline !== undefined
      ? stash(`<code>${inline}</code>`)
      : stash(`<pre><code>${(fenced as string).replace(/\n$/, "")}</code></pre>`, "B")
  );
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) =>
    stash(`<a href="${url}">${label}</a>`)
  );
  text = text.replace(/https?:\/\/[^\s<>|]+/g, (url) => stash(`<a href="${url}">${url}</a>`));

  text = text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w_])_([^_\n]+)_(?=[^\w_]|$)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/^(#{1,6})\s+(.+)$/gm, (_, hashes: string, line: string) => {
      const level = hashes.length;
      return stash(`<h${level}>${line}</h${level}>`, "B");
    });

  // Block elements carry their own breaks; remaining newlines become <br/>.
  text = text
    .replace(/\n?(\u0000B\d+\u0001)\n?/g, "$1")
    .replace(/\n/g, "<br/>");

  // Restore protected spans; loop because a link label can itself contain a
  // stashed code span.
  for (let i = 0; i < 3 && text.includes("\u0000"); i++) {
    text = text.replace(/\u0000[FB](\d+)\u0001/g, (_, n) => protectedSpans[Number(n)] ?? "");
  }
  return text;
}

function truncateSource(markdown: string): string {
  const encoded = new TextEncoder().encode(markdown);
  if (encoded.length <= MATRIX_MAX_SOURCE_BYTES) return markdown;
  // Back off to a UTF-8 codepoint boundary so the cut never yields U+FFFD.
  let cut = MATRIX_MAX_SOURCE_BYTES - 3;
  while (cut > 0 && (encoded[cut] & 0xc0) === 0x80) cut--;
  return new TextDecoder().decode(encoded.slice(0, cut)) + "...";
}

// The room name already carries the conversation title (unlike gchat's flat
// DM), so first sends need no title prefix.
function formatOutbound(message: ChatMessageRow): string {
  if (message.sender === "user") {
    // Cross-channel echo of the user's own reply from another surface.
    return `_you, via ${message.channel ?? "app"}:_ ${message.body}`;
  }
  if (message.sender === "system") {
    return `_${message.body}_`;
  }
  return message.body;
}

// ---------------------------------------------------------------------------
// Outbound channel

interface CreateRoomResponse {
  room_id?: string;
}

interface SendEventResponse {
  event_id?: string;
}

export async function sendMatrixMessage(
  config: ResolvedMatrixConfig,
  roomId: string,
  markdown: string,
  txnId: string,
  msgtype: "m.text" | "m.notice" = "m.text"
): Promise<string> {
  const body = truncateSource(markdown);
  const sent = await matrixRequest<SendEventResponse>(
    config,
    "PUT",
    // txnId = chat_message id — Matrix-side idempotency for free.
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
    {
      msgtype,
      body,
      format: "org.matrix.custom.html",
      formatted_body: toMatrixHtml(body),
    }
  );
  return sent.event_id ?? "";
}

export const matrixChannel: ChatChannel<ResolvedMatrixConfig> = {
  name: "matrix",

  loadConfig: loadResolvedMatrixConfig,

  async deliver(
    _env: Env,
    conversation: Conversation,
    message: ChatMessageRow,
    config: ResolvedMatrixConfig,
    binding: string | null
  ): Promise<ChatDeliveryResult> {
    let roomId = binding;
    if (!roomId) {
      const created = await matrixRequest<CreateRoomResponse>(
        config,
        "POST",
        "/_matrix/client/v3/createRoom",
        {
          name: conversation.title,
          is_direct: true,
          invite: [config.owner_mxid],
          preset: "trusted_private_chat",
        }
      );
      if (!created.room_id) throw new Error("matrix createRoom returned no room_id");
      roomId = created.room_id;
    }
    const eventId = await sendMatrixMessage(config, roomId, formatOutbound(message), message.id);
    return { eventId, binding: roomId };
  },
};

// ---------------------------------------------------------------------------
// Sync-loop wake-up (fan-out pings the DO whenever an agent sends into a
// Matrix-bound conversation, so the inbound loop is hot when a reply is
// likely). Best-effort: delivery already succeeded.

export async function pingMatrixSyncDO(env: Env): Promise<void> {
  const ns = env.MATRIX_SYNC;
  if (!ns) return;
  try {
    const stub = ns.get(ns.idFromName("matrix-sync"));
    await stub.fetch("https://matrix-sync/ping", { method: "POST" });
  } catch (err) {
    console.error("[chat:matrix] sync ping failed", err);
  }
}
