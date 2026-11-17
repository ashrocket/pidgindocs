import type { StatementGuard } from "../member-access";
import type { Env } from "../types";
import { editionSlug } from "../wire-names";

/**
 * Team events (migration 0063). Every event row is written by a statement
 * from emitEvent, appended to the SAME env.DB.batch as the change it records
 * and guarded by the SAME condition as that change, so a change that does not
 * happen (an invitation revoked between the read and the batch, a reply that
 * lost a race) leaves no event behind. Dispatch (inbox items, deferred
 * actions) runs after the batch: see dispatchEvents.
 *
 * Payloads carry ids and enum values only: never message text, post topics
 * or bodies, and never secrets.
 */
export const EVENT_TYPES = [
  "member.joined",
  "board.posted",
  "handoff.posted",
  "question.asked",
  "question.replied",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Event names are `^[a-z]+(\.[a-z_]+)+$`; a filter may also end in `.*`. */
export const EVENT_NAME = /^[a-z]+(\.[a-z_]+)+$/;

export const userRef = (userId: string) => `user:${userId}`;
export const agentRef = (agentId: string) => `agent:${agentId}`;
export const messageRef = (messageId: string) => `message:${messageId}`;

/** A payload value computed in SQL inside the batch (for example a seq assigned by an earlier statement). */
export interface SqlValue { sql: string; binds: unknown[] }
type PayloadValue = string | number | boolean | null | string[] | SqlValue;

export interface EventInput {
  /** Omit for a fresh random id; pass eventIdFor(...) for a fact that can happen only once. */
  id?: string;
  type: EventType;
  /** A team event. Exactly one of teamId and ownerUserId. */
  teamId?: string | null;
  /** A personal event, visible to this person only (their own inbox has no team). */
  ownerUserId?: string | null;
  actorRef: string | null;
  subjectRef?: string | null;
  projectId?: string | null;
  payload: Record<string, PayloadValue | undefined>;
}

export interface EmittedEvent { id: string; statement: D1PreparedStatement }

const isSql = (value: unknown): value is SqlValue =>
  !!value && typeof value === "object" && !Array.isArray(value) && typeof (value as SqlValue).sql === "string";

/**
 * A deterministic id for a fact that happens once (an invitation accepted, a
 * question answered, a post stored): retries and concurrent requests that
 * pass the same guard write one row, not two. UUID-shaped, from SHA-256.
 */
export async function eventIdFor(type: EventType, key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${editionSlug()}-event:${type}:${key}`)));
  digest[6] = (digest[6] & 0x0f) | 0x80; // version 8: name-based, custom hash
  digest[8] = (digest[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The INSERT for one event, to append to the batch that makes the change.
 * `guard` is the change's own condition (SQL plus binds); the row is also
 * written at most once per id.
 */
export function emitEvent(env: Pick<Env, "DB">, event: EventInput, guard?: StatementGuard): EmittedEvent {
  if ((event.teamId ? 1 : 0) + (event.ownerUserId ? 1 : 0) !== 1) {
    throw new Error("an event belongs to exactly one team or one person");
  }
  const id = event.id ?? crypto.randomUUID();
  const parts: string[] = [];
  const payloadBinds: unknown[] = [];
  for (const [key, value] of Object.entries(event.payload)) {
    if (value === undefined) continue;
    if (!/^[a-z_]+$/.test(key)) throw new Error(`invalid event payload key: ${key}`);
    parts.push(`'${key}'`);
    if (isSql(value)) {
      parts.push(value.sql);
      payloadBinds.push(...value.binds);
    } else if (Array.isArray(value) || typeof value === "boolean") {
      parts.push("json(?)");
      payloadBinds.push(JSON.stringify(value));
    } else {
      parts.push("?");
      payloadBinds.push(value);
    }
  }
  const statement = env.DB.prepare(
    `INSERT INTO events (id, team_id, owner_user_id, type, actor_ref, subject_ref, project_id, payload)
     SELECT ?, ?, ?, ?, ?, ?, ?, json_object(${parts.join(", ")})
     WHERE NOT EXISTS (SELECT 1 FROM events WHERE id = ?)${guard ? ` AND ${guard.sql}` : ""}`
  ).bind(
    id,
    event.teamId ?? null,
    event.ownerUserId ?? null,
    event.type,
    event.actorRef,
    event.subjectRef ?? null,
    event.projectId ?? null,
    ...payloadBinds,
    id,
    ...(guard?.binds ?? []),
  );
  return { id, statement };
}

/**
 * The lowercased, trimmed, valid, distinct addresses of a sign-in: the same
 * set applyPendingInvitations matches invitations against (the sign-in name
 * first, then other verified directory addresses of the account).
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function signInEmails(email: string, alternateEmails: Array<string | null | undefined> = []): string[] {
  return [...new Set([email, ...alternateEmails]
    .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
    .filter((value) => EMAIL.test(value)))];
}

/**
 * A first sign-in's default membership (`INSERT OR IGNORE ... 'member'`) with
 * its member.joined event. The event comes first in the batch, guarded by the
 * insert's own condition (no membership yet), so it is recorded only when the
 * insert adds the membership: a returning member never records another.
 * Run the statements as one batch; dispatch `eventId` once sign-in is done.
 */
export function defaultMembershipStatements(env: Pick<Env, "DB">, input: {
  teamId: string; userId: string; emails: string[];
}): { statements: D1PreparedStatement[]; eventId: string } {
  const joined = emitEvent(env, {
    type: "member.joined",
    teamId: input.teamId,
    actorRef: userRef(input.userId),
    subjectRef: userRef(input.userId),
    payload: { user_id: input.userId, emails: input.emails, role: "member", via: "default_membership" },
  }, {
    sql: "NOT EXISTS (SELECT 1 FROM team_memberships WHERE team_id = ? AND user_id = ?)",
    binds: [input.teamId, input.userId],
  });
  return {
    eventId: joined.id,
    statements: [
      joined.statement,
      env.DB.prepare("INSERT OR IGNORE INTO team_memberships (team_id,user_id,role) VALUES (?,?,'member')").bind(input.teamId, input.userId),
    ],
  };
}
