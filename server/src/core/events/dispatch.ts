import { TenantWriteRefused, assertTenantWritable, editionProductName, tenantWritable } from "../edition-hooks";
import { agentSponsorAccessSql } from "../agent-access";
import { createPersonBoardEntry } from "../agent-board";
import { sendPushNotification } from "../push/apns";
import type { Env } from "../types";
import { canAdminWorkspace, getWorkspaceMembership } from "../workspace";
import type { EventType } from "./emit";
import { publishEvents, streamName, streamOfEvent } from "./live";
import { eventResourceReadSql, type EventStream } from "./query";
import { logEventName } from "../wire-names";

/**
 * After the batch that recorded an event commits, the dispatcher acts on it:
 * it creates inbox items for the people the event concerns and fires the
 * armed deferred actions it matches. It is safe to run twice for one event
 * (a request's waitUntil and the sweeper can race): inbox items are unique
 * per person, event and kind (per person and action for the ones a deferred
 * action delivers), a deferred action is claimed with one conditional
 * UPDATE, and dispatched_at is set only after the work is done.
 * An event whose dispatch failed stays undispatched for the sweeper, and so
 * does one whose claimed action a paid tenant's denial handed back (it stays
 * unmarked while that action is armed and carries the event's id).
 * Once an event is marked dispatched, its stream's TeamEventsDO hears of it
 * (publishEvents), so waiting agents get it at once; the sweeper's
 * re-dispatch publishes too, and the object drops what it already sent.
 */

export interface EventRow {
  seq: number;
  id: string;
  team_id: string | null;
  owner_user_id: string | null;
  type: EventType;
  actor_ref: string | null;
  subject_ref: string | null;
  project_id: string | null;
  payload: string;
  created_at: string;
  dispatched_at: string | null;
}

type Payload = Record<string, unknown>;

/** A post created by a deferred action records events too; follow them this many hops, then leave the rest to the sweeper. */
const MAX_DEPTH = 3;
/** An undispatched event older than this is picked up again by the sweeper (and by later dispatcher passes). */
export const SWEEP_AFTER_SECONDS = 60;
/** Undispatched events older than this are given up on, so a permanently failing one is not retried forever. */
const ABANDON_AFTER_DAYS = 7;
/** Pushes for new inbox items per person per rolling hour; items past it are stored and listed, just not pushed. */
export const INBOX_PUSH_PER_HOUR = 20;
export const INBOX_PUSH_TYPE = "inbox_item";

const refId = (ref: string | null | undefined, kind: "user" | "agent"): string | null =>
  ref && ref.startsWith(`${kind}:`) ? ref.slice(kind.length + 1) : null;
const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const oneLine = (value: string, max: number) => value.replace(/\s+/g, " ").trim().slice(0, max);

function parsePayload(raw: string): Payload {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Payload : {};
  } catch {
    return {};
  }
}

/**
 * Runs dispatchEvents for these ids after the response when the request has
 * an ExecutionContext, inline otherwise (tests, and callers without one).
 * Never rejects: a failure leaves the events for the sweeper.
 */
export function scheduleDispatch(env: Env, ctx: ExecutionContext | undefined | null, ids: string[]): Promise<void> {
  if (!ids.length) return Promise.resolve();
  const work = dispatchEvents(env, ids).then(() => undefined, (error) => {
    console.error("event dispatch failed", error instanceof Error ? error.message : String(error));
  });
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(work);
    return Promise.resolve();
  }
  return work;
}

async function loadUndispatched(env: Env, ids: string[]): Promise<EventRow[]> {
  const { results } = await env.DB.prepare(`SELECT seq, id, team_id, owner_user_id, type, actor_ref, subject_ref, project_id,
      payload, created_at, dispatched_at
    FROM events WHERE id IN (SELECT value FROM json_each(?)) AND dispatched_at IS NULL ORDER BY seq`)
    .bind(JSON.stringify(ids)).all<EventRow>();
  return results ?? [];
}

const logDispatchPaused = (error: TenantWriteRefused) =>
  console.error(JSON.stringify({ event: logEventName("event_dispatch_paused"), status: error.status, reason: error.reason }));

export async function dispatchEvents(env: Env, ids: string[], options: { sweep?: boolean } = {}): Promise<{ dispatched: number }> {
  // Inbox items, pushes and deferred actions write product content. A paid tenant that may not write leaves its
  // events undispatched (checked before any action is claimed): the sweeper retries until they are abandoned.
  try { await assertTenantWritable(env); }
  catch (error) {
    if (!(error instanceof TenantWriteRefused)) throw error;
    logDispatchPaused(error);
    return { dispatched: 0 };
  }
  let queue = [...new Set(ids)];
  let dispatched = 0;
  for (let depth = 0; queue.length && depth <= MAX_DEPTH; depth += 1) {
    const next: string[] = [];
    // The newest dispatched seq per stream: one publish per stream and pass.
    const published = new Map<string, { stream: EventStream; seq: number }>();
    const flushPublished = () => Promise.all([...published.values()].map(({ stream, seq }) => publishEvents(env, stream, seq)));
    for (const row of await loadUndispatched(env, queue)) {
      try {
        next.push(...await handleEvent(env, row));
        // Not while an action claimed for this event is handed back (fireDeferredActions): a concurrent
        // dispatcher that skipped it as fired would otherwise mark the event done and the action never fires.
        const marked = await env.DB.prepare(`UPDATE events SET dispatched_at = datetime('now') WHERE id = ? AND dispatched_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM deferred_actions WHERE team_id = ? AND trigger_type = ? AND status = 'armed' AND fired_event_id = ?)`)
          .bind(row.id, row.team_id, row.type, row.id).run();
        if (marked.meta?.changes) {
          dispatched += 1;
          const stream = streamOfEvent(row);
          if (stream && (published.get(streamName(stream))?.seq ?? 0) < row.seq) published.set(streamName(stream), { stream, seq: row.seq });
        }
      } catch (error) {
        if (error instanceof TenantWriteRefused) {
          // The tenant lapsed (or the service blipped) mid-pass: stop, so later and swept events write nothing either.
          logDispatchPaused(error);
          await flushPublished();
          return { dispatched };
        }
        console.error("event dispatch failed", row.id, error instanceof Error ? error.message : String(error));
      }
    }
    await flushPublished();
    queue = next;
  }
  // The next dispatcher pass also picks up a few events an earlier one left behind
  // (a handful: each event costs several queries, and an invocation has a query budget).
  if (options.sweep !== false) dispatched += await sweepUndispatched(env, 5);
  return { dispatched };
}

/** Dispatches undispatched events older than SWEEP_AFTER_SECONDS, oldest first. */
export async function sweepUndispatched(env: Env, limit: number): Promise<number> {
  const { results } = await env.DB.prepare(`SELECT id FROM events WHERE dispatched_at IS NULL
      AND created_at <= datetime('now', ?) ORDER BY created_at, seq LIMIT ?`)
    .bind(`-${SWEEP_AFTER_SECONDS} seconds`, limit).all<{ id: string }>();
  const ids = (results ?? []).map((row) => row.id);
  return ids.length ? (await dispatchEvents(env, ids, { sweep: false })).dispatched : 0;
}

async function handleEvent(env: Env, row: EventRow): Promise<string[]> {
  // A personal event (a question in someone's own inbox) has no team: no team inbox items, no team actions.
  if (!row.team_id) return [];
  const payload = parsePayload(row.payload);
  await deliverInboxItems(env, row, payload);
  return await fireDeferredActions(env, row, payload);
}

// ── Inbox items ─────────────────────────────────────────────────────────────

async function userName(env: Env, userId: string | null): Promise<string> {
  if (!userId) return "Someone";
  const row = await env.DB.prepare(`SELECT COALESCE(
      (SELECT display_name FROM entra_identities WHERE user_id = u.id AND display_name IS NOT NULL AND display_name <> '' LIMIT 1),
      (SELECT display_name FROM google_identities WHERE user_id = u.id AND display_name IS NOT NULL AND display_name <> '' LIMIT 1),
      u.email) AS name FROM users u WHERE u.id = ?`).bind(userId).first<{ name: string | null }>();
  return row?.name ? oneLine(row.name, 100) : "Someone";
}

async function authorName(env: Env, agentId: string | null): Promise<string> {
  if (!agentId) return "Someone";
  const row = await env.DB.prepare("SELECT name FROM agent_identities WHERE id = ?").bind(agentId).first<{ name: string }>();
  return row?.name ? oneLine(row.name, 100) : "Someone";
}

interface BoardInfo { name: string; link: string }

async function boardInfo(env: Env, projectId: string | null): Promise<BoardInfo | null> {
  if (!projectId) return null;
  const row = await env.DB.prepare("SELECT name, board_kind, parent_project_id FROM projects WHERE id = ?").bind(projectId)
    .first<{ name: string; board_kind: string; parent_project_id: string | null }>();
  if (!row) return null;
  // A work board opens inside its parent's board view.
  const link = row.board_kind === "work" && row.parent_project_id
    ? `/workspace?project=${encodeURIComponent(row.parent_project_id)}&view=board&board=${encodeURIComponent(projectId)}`
    : `/workspace?project=${encodeURIComponent(projectId)}&view=board`;
  return { name: oneLine(row.name, 80), link };
}

/** A short, plain-text account of an event for an inbox item, with where it leads. */
export async function describeEvent(env: Env, row: EventRow, payload: Payload): Promise<{ title: string; body: string | null; link: string | null }> {
  switch (row.type) {
    case "member.joined": {
      const [name, team] = await Promise.all([
        userName(env, refId(row.subject_ref, "user")),
        row.team_id ? env.DB.prepare("SELECT name FROM teams WHERE id = ?").bind(row.team_id).first<{ name: string }>() : null,
      ]);
      return { title: oneLine(`${name} joined ${team?.name ?? "your team"}`, 140), body: null, link: "/people" };
    }
    case "board.posted":
    case "handoff.posted": {
      const [board, author] = await Promise.all([boardInfo(env, row.project_id), authorName(env, text(payload.agent_id))]);
      // Never the topic of a post an admin took down (board reads hide it too).
      const topic = text(payload.entry_id)
        ? (await env.DB.prepare(`SELECT topic FROM agent_board_entries e WHERE e.id = ?
            AND NOT EXISTS (SELECT 1 FROM agent_board_moderation m WHERE m.entry_id = e.id)`)
          .bind(payload.entry_id).first<{ topic: string }>())?.topic
        : null;
      const what = row.type === "handoff.posted" ? "Handoff" : "Post";
      // Link to the post itself; the workspace focuses it in either mode.
      const seq = Number(payload.seq);
      const link = board ? (Number.isSafeInteger(seq) && seq > 0 ? `${board.link}&post=${seq}` : board.link) : null;
      const addressed = row.subject_ref ? " for you" : "";
      return {
        title: oneLine(`${what}${addressed} · ${board?.name ?? "a board"}`, 140),
        body: topic ? oneLine(`${author}: ${topic}`, 200) : null,
        link,
      };
    }
    case "question.asked":
    case "question.replied": {
      const messageId = text(payload.message_id);
      const message = messageId
        ? await env.DB.prepare("SELECT title FROM messages WHERE id = ?").bind(messageId).first<{ title: string }>()
        : null;
      const title = row.type === "question.replied"
        ? `${await userName(env, text(payload.replied_by_user_id))} answered your question`
        : "New question";
      return { title: oneLine(title, 140), body: message?.title ? oneLine(message.title, 200) : null, link: messageId ? `/messages/${messageId}` : null };
    }
    default:
      return { title: row.type, body: null, link: null };
  }
}

export interface InboxItemInput {
  teamId: string;
  userId: string;
  kind: "event" | "system";
  eventId: string;
  /** Set for the item a deferred action delivers: it is unique per person and action, not per event. */
  deferredActionId?: string | null;
  title: string;
  body: string | null;
  link: string | null;
  push: boolean;
}

/**
 * Stores one inbox item for a current, active member of the team, once per
 * person, event and kind (or, with deferredActionId, once per person and
 * action), and pushes it within INBOX_PUSH_PER_HOUR. Returns whether the
 * person is a member (an item for a non-member is never stored).
 */
export async function createInboxItem(env: Env, input: InboxItemInput): Promise<{ member: boolean; created: boolean }> {
  // Dispatch can cross a paid-period boundary after its pass-level check. Check again at the actual write.
  await assertTenantWritable(env);
  const id = crypto.randomUUID().replace(/-/g, "");
  const member = "EXISTS (SELECT 1 FROM team_memberships tm JOIN users u ON u.id = tm.user_id AND u.status = 'active' WHERE tm.team_id = ? AND tm.user_id = ?)";
  // Use the same source contract as inbox/event reads. In particular, legacy
  // questions that embed governed artifacts cannot deliver cached titles.
  const sourceReadable = `EXISTS (SELECT 1 FROM events inbox_event WHERE inbox_event.id = ?
    AND inbox_event.team_id = ? AND ${eventResourceReadSql("inbox_event")})`;
  const deliveryAllowed = `${member} AND ${sourceReadable}`;
  const deliveryBinds = [input.teamId, input.userId, input.eventId, input.teamId, input.userId, input.userId];
  const [check, insert] = await env.DB.batch([
    env.DB.prepare(`SELECT ${member} AS member`).bind(input.teamId, input.userId),
    env.DB.prepare(`INSERT OR IGNORE INTO inbox_items (id, team_id, user_id, kind, event_id, deferred_action_id, title, body, link)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${deliveryAllowed}`)
      .bind(id, input.teamId, input.userId, input.kind, input.eventId, input.deferredActionId ?? null, oneLine(input.title, 140),
        input.body ? input.body.slice(0, 500) : null, input.link, ...deliveryBinds),
  ]);
  const isMember = !!(check.results?.[0] as { member?: number } | undefined)?.member;
  const created = (insert.meta?.changes ?? 0) > 0;
  // Only the request that stored the item pushes it, so a second dispatch never pushes twice.
  if (created && input.push) {
    try {
      const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM inbox_items WHERE user_id = ? AND created_at >= datetime('now', '-1 hour')")
        .bind(input.userId).first<{ n: number }>();
      // A central outage or lapse after insertion must not send a new notification.
      if ((recent?.n ?? 0) <= INBOX_PUSH_PER_HOUR && await tenantWritable(env)) {
        // Activation, membership changes or source revocation can happen after
        // insertion. Recheck immediately before handing the title to APNs.
        const allowed = await env.DB.prepare(`SELECT 1 AS allowed WHERE ${deliveryAllowed}`)
          .bind(...deliveryBinds).first();
        if (allowed) await sendPushNotification(env, oneLine(input.title, 120), oneLine(input.body ?? "", 180), id, INBOX_PUSH_TYPE, input.userId);
      }
    } catch (error) {
      console.error("inbox push failed", id, error instanceof Error ? error.message : String(error));
    }
  }
  return { member: isMember, created };
}

/**
 * Who hears about an event in their inbox:
 * - member.joined through an invitation: whoever invited them, when the
 *   person's own sign-in applied it.
 * - question.replied: the person whose question it is, when someone else answered.
 * - handoff.posted addressed to a person: that person, unless they posted it
 *   themselves. The board post already pushed them, so this item does not push again.
 */
async function deliverInboxItems(env: Env, row: EventRow, payload: Payload): Promise<void> {
  const teamId = row.team_id!;
  const recipients: Array<{ userId: string; push: boolean }> = [];
  if (row.type === "member.joined") {
    // Not when the inviter applied it themselves (inviting someone who could already sign in).
    const inviter = text(payload.invited_by_user_id);
    if (inviter && text(payload.invitation_id) && inviter !== refId(row.subject_ref, "user") && inviter !== refId(row.actor_ref, "user")) {
      recipients.push({ userId: inviter, push: true });
    }
  } else if (row.type === "question.replied") {
    const asker = text(payload.asker_user_id);
    if (asker && asker !== text(payload.replied_by_user_id)) recipients.push({ userId: asker, push: true });
  } else if (row.type === "handoff.posted") {
    // As for its push (boardPostRecipient): a person addressing themselves hears nothing.
    const addressee = refId(row.subject_ref, "user");
    const self = payload.author_kind === "person" && addressee === text(payload.sponsor_user_id);
    if (addressee && !self) recipients.push({ userId: addressee, push: false });
  }
  if (!recipients.length) return;
  const description = await describeEvent(env, row, payload);
  for (const recipient of recipients) {
    await createInboxItem(env, { teamId, userId: recipient.userId, kind: "event", eventId: row.id, ...description, push: recipient.push });
  }
}

// ── Deferred actions ────────────────────────────────────────────────────────

export interface DeferredActionRow {
  id: string;
  team_id: string;
  created_by_user_id: string;
  trigger_type: string;
  trigger_match: string;
  action: string;
  status: string;
  expires_at: string;
  created_at: string;
}

export interface TriggerMatch { email?: string; user_id?: string; project_id?: string }

export type DeferredAction =
  | { kind: "notify_user"; user_id?: string; title: string; body?: string }
  | { kind: "post_board_entry"; project_id: string; post_kind: "h" | "n" | "b"; topic: string; body: string; reference?: string; to: string };

/**
 * Whether an event satisfies a trigger. email: one of the addresses the
 * joining person signed in with (the same set invitations are matched
 * against). user_id: the person the event is about or addressed to (its
 * subject). project_id: the board or project it happened on.
 */
export function triggerMatches(match: TriggerMatch, row: Pick<EventRow, "subject_ref" | "project_id">, payload: Payload): boolean {
  const keys = Object.keys(match);
  if (!keys.length) return false;
  if (match.email !== undefined) {
    const emails = Array.isArray(payload.emails) ? payload.emails.filter((value): value is string => typeof value === "string") : [];
    if (!emails.map((value) => value.trim().toLowerCase()).includes(match.email.trim().toLowerCase())) return false;
  }
  if (match.user_id !== undefined && row.subject_ref !== `user:${match.user_id}`) return false;
  if (match.project_id !== undefined && row.project_id !== match.project_id) return false;
  return true;
}

/** A person or an agent: what a post addressed to "subject" needs the event to name. */
const ADDRESSABLE = /^(user|agent):./;

/**
 * Whether an action can run for an event its trigger matched: a post
 * addressed to "subject" needs an event that names a person or an agent.
 * Otherwise it is not a match, and the action stays armed for the next event.
 */
export function actionApplies(action: DeferredAction, row: Pick<EventRow, "subject_ref">): boolean {
  return !(action.kind === "post_board_entry" && action.to === "subject" && !ADDRESSABLE.test(row.subject_ref ?? ""));
}

function parseJson<T>(raw: string): T | null {
  try { return JSON.parse(raw) as T; } catch { return null; }
}

/** Armed actions read per query; pages continue until one comes back short. */
const ACTION_PAGE = 100;

async function fireDeferredActions(env: Env, row: EventRow, payload: Payload): Promise<string[]> {
  // The trigger is matched in SQL (each key a wildcard when absent) as well as by
  // triggerMatches, so a page holds candidates only and older actions waiting for
  // something else never crowd out a newer one that matches. Every page is read.
  // An action fires only for events recorded after it was set up (armed_after_seq), never once it expired.
  const emails = (Array.isArray(payload.emails) ? payload.emails : [])
    .filter((value): value is string => typeof value === "string").map((value) => value.trim().toLowerCase());
  const addressable = ADDRESSABLE.test(row.subject_ref ?? "") ? 1 : 0;
  const produced: string[] = [];
  let after: { created_at: string; id: string } | null = null;
  for (;;) {
    const { results }: D1Result<DeferredActionRow> = await env.DB.prepare(`SELECT id, team_id, created_by_user_id, trigger_type,
        trigger_match, action, status, expires_at, created_at
      FROM deferred_actions
      WHERE team_id = ? AND trigger_type = ? AND status = 'armed' AND datetime(expires_at) > datetime('now')
        AND armed_after_seq < ?
        AND (json_extract(trigger_match, '$.email') IS NULL
          OR lower(trim(json_extract(trigger_match, '$.email'))) IN (SELECT value FROM json_each(?)))
        AND (json_extract(trigger_match, '$.user_id') IS NULL OR 'user:' || json_extract(trigger_match, '$.user_id') = ?)
        AND (json_extract(trigger_match, '$.project_id') IS NULL OR json_extract(trigger_match, '$.project_id') = ?)
        AND (? = 1 OR json_extract(action, '$.to') IS NOT 'subject')
        AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))
      ORDER BY created_at, id LIMIT ?`)
      .bind(row.team_id, row.type, row.seq, JSON.stringify(emails), row.subject_ref, row.project_id, addressable,
        after?.created_at ?? null, after?.created_at ?? null, after?.created_at ?? null, after?.id ?? null, ACTION_PAGE)
      .all<DeferredActionRow>();
    const page: DeferredActionRow[] = results ?? [];
    for (const deferred of page) {
      const match = parseJson<TriggerMatch>(deferred.trigger_match);
      const action = parseJson<DeferredAction>(deferred.action);
      if (!match || !action || !triggerMatches(match, row, payload) || !actionApplies(action, row)) continue;
      // The claim: only one dispatcher, once, and not after it expired.
      const claimed = await env.DB.prepare(`UPDATE deferred_actions SET status = 'fired', fired_event_id = ?, fired_at = datetime('now')
        WHERE id = ? AND status = 'armed' AND datetime(expires_at) > datetime('now') RETURNING id`)
        .bind(row.id, deferred.id).first<{ id: string }>();
      if (!claimed) continue;
      try {
        produced.push(...await runDeferredAction(env, deferred, action, row, payload));
      } catch (error) {
        if (error instanceof TenantWriteRefused) {
          // A lapse or central blip between the pass-level check and the write is not the action's failure. In one
          // batch: hand the claim back, keeping fired_event_id so no dispatcher marks this event while it is armed,
          // and un-mark the event in case a concurrent dispatcher already did. The sweeper retries; redispatch is
          // idempotent (inbox items are unique, fired actions are skipped, posts carry a clientMessageId).
          await env.DB.batch([
            env.DB.prepare("UPDATE deferred_actions SET status = 'armed', fired_at = NULL WHERE id = ? AND status = 'fired'").bind(deferred.id),
            env.DB.prepare("UPDATE events SET dispatched_at = NULL WHERE id = ?").bind(row.id),
          ]);
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        await env.DB.prepare("UPDATE deferred_actions SET status = 'failed', error = ? WHERE id = ?")
          .bind(message.slice(0, 300), deferred.id).run();
      }
    }
    if (page.length < ACTION_PAGE) break;
    const last = page[page.length - 1];
    after = { created_at: last.created_at, id: last.id };
  }
  return produced;
}

/**
 * Whether the person who set an action up could still act themselves: the
 * same account rules as their own requests (resolveCallerCredential) and as
 * an agent key's sponsor: an active account, no lapsed hosted access and, on
 * an Entra-only site, an identity that can still sign in here.
 */
async function creatorCanAct(env: Env, userId: string): Promise<boolean> {
  return !!await env.DB.prepare(`SELECT 1 AS ok FROM users owner WHERE owner.id = ? AND owner.status = 'active'
    AND ${agentSponsorAccessSql(env)}`).bind(userId).first();
}

async function runDeferredAction(env: Env, deferred: DeferredActionRow, action: DeferredAction, row: EventRow, payload: Payload): Promise<string[]> {
  const creator = deferred.created_by_user_id;
  // A suspended creator, or one whose access lapsed, no longer acts through what they set up earlier.
  if (!await creatorCanAct(env, creator)) throw new Error(`whoever set this up can no longer use ${editionProductName()}`);
  if (action.kind === "notify_user") {
    // The creator's authority is checked again now, as it would be if they acted themselves.
    const role = (await getWorkspaceMembership(env, deferred.team_id, creator))?.role ?? null;
    if (!role) throw new Error("whoever set this up is no longer a member of this team");
    const target = action.user_id ?? creator;
    if (target !== creator && !canAdminWorkspace(role)) throw new Error("only owners and admins can notify someone else");
    const description = await describeEvent(env, row, payload);
    // Keyed on the action, so another action notifying the same person about the same event delivers its own item.
    const result = await createInboxItem(env, {
      teamId: deferred.team_id, userId: target, kind: "system", eventId: row.id, deferredActionId: deferred.id,
      title: action.title, body: action.body ?? description.title, link: description.link, push: true,
    });
    if (!result.member) throw new Error("that person is no longer a member of this team");
    return [];
  }
  if (action.kind === "post_board_entry") {
    const to = action.to === "subject" ? row.subject_ref : action.to;
    // actionApplies already kept an event that names no one from claiming a "subject" post.
    if (!to || !ADDRESSABLE.test(to)) throw new Error("the event names no one to address the post to");
    // Posted as the person who set it up, through the same path as their own
    // web post: their current role, the board's state and the recipient's
    // membership are all checked now. The action id makes a retry idempotent.
    const events: string[] = [];
    await createPersonBoardEntry(env, {
      userId: creator,
      projectId: action.project_id,
      post: { kind: action.post_kind, topic: action.topic, body: action.body, reference: action.reference ?? null, to },
      clientMessageId: `deferred:${deferred.id}`,
      events,
    });
    return events;
  }
  throw new Error("unknown action");
}

/**
 * Daily (cron): dispatches events left undispatched, gives up on ones that
 * failed for a week, expires deferred actions past expires_at, and prunes
 * old events (90 days), usage counters (35 days), used or expired tickets and
 * dismissed inbox items (90 days).
 */
export async function runEventsLifecycle(env: Env): Promise<{ dispatched: number; expired: number; pruned: number }> {
  // Stragglers are rare; 50 keeps the nightly run well inside an invocation's query budget.
  const dispatched = await sweepUndispatched(env, 50);
  const [abandoned, expired, events, usage, tickets, inbox] = await env.DB.batch([
    env.DB.prepare(`UPDATE events SET dispatched_at = datetime('now') WHERE dispatched_at IS NULL
      AND created_at <= datetime('now', '-${ABANDON_AFTER_DAYS} days')`),
    env.DB.prepare(`UPDATE deferred_actions SET status = 'expired' WHERE status = 'armed' AND datetime(expires_at) <= datetime('now')`),
    env.DB.prepare(`DELETE FROM events WHERE seq IN (SELECT seq FROM events WHERE created_at <= datetime('now', '-90 days')
      ORDER BY seq LIMIT 5000)`),
    env.DB.prepare("DELETE FROM event_usage WHERE day < date('now', '-35 days')"),
    env.DB.prepare("DELETE FROM event_tickets WHERE datetime(expires_at) <= datetime('now', '-1 day')"),
    env.DB.prepare("DELETE FROM inbox_items WHERE dismissed_at IS NOT NULL AND datetime(dismissed_at) <= datetime('now', '-90 days')"),
  ]);
  if (abandoned.meta?.changes) console.error(`events: gave up dispatching ${abandoned.meta.changes} events older than ${ABANDON_AFTER_DAYS} days`);
  return {
    dispatched,
    expired: expired.meta?.changes ?? 0,
    pruned: (events.meta?.changes ?? 0) + (usage.meta?.changes ?? 0) + (tickets.meta?.changes ?? 0) + (inbox.meta?.changes ?? 0),
  };
}
