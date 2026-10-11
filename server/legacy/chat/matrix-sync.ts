import type { Env } from "../types";
import type { ResolvedMatrixConfig } from "./types";
import { MatrixApiError, matrixRequest, sendMatrixMessage } from "./matrix";
import { ingestUserMessage } from "./ingest";

// The smallest server-side filter that still yields message events + invites:
// no presence, no typing/receipts, no state, small timeline windows. With
// limit 20 a burst larger than the window drops the oldest events — an
// accepted tradeoff for a single-owner relay.
const SYNC_FILTER = JSON.stringify({
  presence: { types: [] },
  account_data: { types: [] },
  room: {
    state: { types: [] },
    ephemeral: { types: [] },
    account_data: { types: [] },
    timeline: { types: ["m.room.message"], limit: 20 },
  },
});

export const SYNC_TIMEOUT_MS = 20000;

interface MatrixTimelineEvent {
  type?: string;
  sender?: string;
  event_id?: string;
  state_key?: string;
  content?: { msgtype?: string; body?: unknown; membership?: string };
}

export interface MatrixSyncResponse {
  next_batch?: string;
  rooms?: {
    join?: Record<string, { timeline?: { events?: MatrixTimelineEvent[] } }>;
    invite?: Record<string, { invite_state?: { events?: MatrixTimelineEvent[] } }>;
  };
}

export interface SyncStepSummary {
  nextBatch: string;
  stored: number;
  rejected: number;
  joined: number;
}

export type SyncStepResult =
  | ({ ok: true } & SyncStepSummary)
  // resetCursor: the homeserver rejected our since token (400) — retry with
  // a fresh initial sync instead of spinning on the same dead cursor.
  | { ok: false; fatal: boolean; resetCursor: boolean; error: string };

async function audit(env: Env, action: string, details: string): Promise<void> {
  await env.DB.prepare("INSERT INTO audit_log (action, details) VALUES (?, ?)")
    .bind(action, details)
    .run()
    .catch(() => {});
}

// Process one /sync response body. Exported separately from runSyncStep so
// tests can drive it with fixture payloads and no Durable Object shell.
export async function processSyncResponse(
  env: Env,
  config: ResolvedMatrixConfig,
  sync: MatrixSyncResponse
): Promise<Omit<SyncStepSummary, "nextBatch">> {
  let stored = 0;
  let rejected = 0;
  let joined = 0;

  // Invites: auto-accept only from the owner. Anything else is audited and
  // left pending — never joined, never acted on.
  for (const [roomId, room] of Object.entries(sync.rooms?.invite ?? {})) {
    const invite = (room.invite_state?.events ?? []).find(
      (ev) =>
        ev.type === "m.room.member" &&
        ev.state_key === config.bot_mxid &&
        ev.content?.membership === "invite"
    );
    if (!invite) continue;
    if (invite.sender === config.owner_mxid) {
      try {
        await matrixRequest(config, "POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {});
        joined++;
        await audit(env, "chat_matrix_joined", `joined ${roomId} on invite from ${invite.sender}`);
      } catch (err) {
        console.error(`[chat:matrix] failed to join ${roomId}`, err);
      }
    } else {
      rejected++;
      await audit(
        env,
        "chat_matrix_rejected",
        `ignored invite to ${roomId} from ${invite.sender ?? "unknown"}`
      );
    }
  }

  for (const [roomId, room] of Object.entries(sync.rooms?.join ?? {})) {
    for (const event of room.timeline?.events ?? []) {
      if (event.type !== "m.room.message" || event.state_key !== undefined) continue;
      const sender = event.sender ?? "";
      // Loop prevention: never ingest the bot's own messages.
      if (sender === config.bot_mxid) continue;
      const body = typeof event.content?.body === "string" ? event.content.body.trim() : "";
      if (!body || !event.event_id) continue;

      // Single-sender allowlist: /sync arrives over our own authenticated
      // connection, so the homeserver vouches for `sender` — the check is
      // pure equality against the configured owner.
      if (sender !== config.owner_mxid) {
        rejected++;
        await audit(
          env,
          "chat_matrix_rejected",
          `dropped message from ${sender || "unknown"} in ${roomId}`
        );
        continue;
      }

      const outcome = await ingestUserMessage(env, {
        channel: "matrix",
        externalConversationId: roomId,
        externalEventId: event.event_id,
        senderIdentity: sender,
        body,
      });
      if (outcome.result === "stored") {
        stored++;
      } else if (
        outcome.result === "conversation_closed" ||
        outcome.result === "unknown_conversation"
      ) {
        // Mirror the gchat sync-reply UX: tell the owner their reply went
        // nowhere. m.notice so clients render it as bot chatter.
        const note =
          outcome.result === "conversation_closed"
            ? `"${outcome.conversation?.title ?? "This conversation"}" is closed — this message wasn't relayed.`
            : "This room isn't linked to an open Claude conversation — this message wasn't relayed.";
        await sendMatrixMessage(config, roomId, note, crypto.randomUUID(), "m.notice").catch((err) =>
          console.error("[chat:matrix] failed to send not-relayed notice", err)
        );
      }
      // "duplicate" needs no action: redelivery of an already-stored event.
    }
  }

  return { stored, rejected, joined };
}

// One long-poll iteration: GET /sync, process, return the new cursor.
export async function runSyncStep(
  env: Env,
  config: ResolvedMatrixConfig,
  since: string | null
): Promise<SyncStepResult> {
  try {
    const params = new URLSearchParams({
      timeout: String(SYNC_TIMEOUT_MS),
      filter: SYNC_FILTER,
    });
    if (since) params.set("since", since);
    const sync = await matrixRequest<MatrixSyncResponse>(
      config,
      "GET",
      `/_matrix/client/v3/sync?${params.toString()}`
    );
    if (!sync.next_batch) {
      return { ok: false, fatal: false, resetCursor: false, error: "sync response missing next_batch" };
    }
    const summary = await processSyncResponse(env, config, sync);
    return { ok: true, nextBatch: sync.next_batch, ...summary };
  } catch (err) {
    // A dead token never comes back on its own — stop looping instead of
    // retry-spinning; the config route pings the DO awake after a re-save.
    const fatal =
      err instanceof MatrixApiError &&
      (err.errcode === "M_UNKNOWN_TOKEN" || err.status === 401);
    const resetCursor = err instanceof MatrixApiError && err.status === 400 && Boolean(since);
    return {
      ok: false,
      fatal,
      resetCursor,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Adaptive cadence (cost control)

export const HOT_WINDOW_MS = 30 * 60 * 1000;
export const IDLE_POLL_DELAY_MS = 60 * 1000;

// D1 datetime('now') strings are UTC without a timezone suffix.
function parseD1Timestamp(value: string): number {
  const iso = value.includes("T") ? value : value.replace(" ", "T");
  return Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
}

// null = go idle (no alarm — the fan-out ping wakes us); 0 = re-alarm
// immediately (continuous long-poll while a conversation is hot).
export function decideNextAlarmDelay(
  latestOpenActivityAt: string | null,
  nowMs: number
): number | null {
  if (!latestOpenActivityAt) return null;
  const activityMs = parseD1Timestamp(latestOpenActivityAt);
  if (Number.isFinite(activityMs) && nowMs - activityMs < HOT_WINDOW_MS) return 0;
  return IDLE_POLL_DELAY_MS;
}

// Most recent activity across open Matrix-bound conversations, or null.
export async function latestOpenMatrixActivity(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT c.last_activity_at AS last_activity_at
     FROM conversations c
     JOIN conversation_channels cc ON cc.conversation_id = c.id
     WHERE cc.channel = 'matrix' AND c.status = 'open'
     ORDER BY c.last_activity_at DESC LIMIT 1`
  ).first<{ last_activity_at: string }>();
  return row?.last_activity_at ?? null;
}
