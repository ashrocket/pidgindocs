import type { Env } from "../types";
import {
  authorizeViewers,
  CATCH_UP_LIMIT,
  DELIVERY_FAILED_CLOSE_CODE,
  eventsProtocol,
  FANOUT_READ_LIMIT,
  MAX_EVENTS_PER_DELIVERY,
  eventMatches,
  eventVisible,
  parseStreamHeader,
  principalOf,
  REAUTH_CLOSE_CODE,
  stampWaiting,
  streamHeader,
  TRUST_NOTE,
  viewerKey,
  type Authorization,
  type Viewer,
} from "./live";
import {
  EVENT_COLUMNS,
  eventView,
  readStreamEvents,
  type EventFilter,
  type EventPrincipal,
  type EventRowText,
  type EventStream,
  type EventView,
} from "./query";
import { HeaderPart, internalHeader } from "../wire-names";

// Open sockets one agent or person may hold on one stream, and on one stream
// in all. Extra upgrades are accepted and then closed with 1013 (try again
// later) so the client sees why. Only open sockets count: one the server is
// closing (expired, revoked) frees its slot at once.
export const MAX_SOCKETS_PER_PRINCIPAL = 10;
export const MAX_SOCKETS_PER_STREAM = 200;
// Waiting requests (POST /api/events/wait, pidgin_wait_for_events) held at once.
export const MAX_WAITERS_PER_PRINCIPAL = 10;
export const MAX_WAITERS_PER_STREAM = 200;
// While any socket is open, the alarm re-checks every socket's credential and
// access this often, so a revoked key's idle socket closes even when nothing
// is published, and reads D1 for events a lost publish never announced.
export const HEARTBEAT_MS = 60_000;
// While a person's socket waits on one question, re-stamp its last_poll_at
// this often, inside the phone's 15 s "live" window. This stamp is the one
// remaining idle cost of an open socket, and it stays so the status never
// flickers; only person sockets that follow one question have it.
export const LIVENESS_INTERVAL_MS = 10_000;
// When the alarm last ran the full credential re-check and catch-up (ms), kept in storage across hibernation.
const LAST_FULL_CHECK_KEY = "last_full_check";
const WS_OPEN = 1; // WebSocket.READY_STATE_OPEN

// Small on purpose: it stays well under the attachment size limit. The
// boards an agent may read are not kept here: they are read again from D1 on
// every publish (authorizeViewers), so a revoked grant stops delivery at the
// next event.
interface SocketAttachment {
  principal_ref: string;
  credential: Viewer["credential"];
  credential_hash: string | null;
  /** streamHeader() of the stream; the alarm needs it after the object wakes from hibernation. */
  stream: string;
  filter: EventFilter;
  /** The newest seq this socket has been sent or has had read past it: it gets only events after it. */
  cursor: number;
  expires_at: number;
}

interface Waiter {
  viewer: Viewer;
  principal: EventPrincipal;
  filter: EventFilter;
  after: number;
  cursor: number;
  limit: number;
  /** false while its first D1 read runs: publishes then leave it alone. */
  ready: boolean;
  finish: (status: number, body: Record<string, unknown>) => void;
}

const json = (body: Record<string, unknown>, status = 200) => Response.json(body, { status });

/** false when the frame could not be sent (the socket is closing or gone). Callers must not advance the socket's cursor past it. */
function send(ws: WebSocket, frame: unknown): boolean {
  try {
    ws.send(JSON.stringify(frame));
    return true;
  } catch {
    return false;
  }
}

/** A send that failed during connect: the client reconnects and catches up again. */
class DeliveryFailed extends Error {}

const attachmentOf = (ws: WebSocket) => ws.deserializeAttachment() as SocketAttachment | null;
const viewerOf = (att: SocketAttachment | Waiter): Viewer =>
  "viewer" in att ? att.viewer : { principal_ref: att.principal_ref, credential: att.credential, credential_hash: att.credential_hash };

function parseJsonHeader<T>(value: string | null): T | null {
  try { return JSON.parse(value ?? "") as T; } catch { return null; }
}

function validFilter(filter: EventFilter | null): filter is EventFilter {
  return !!filter && Array.isArray(filter.kinds) && filter.kinds.every((kind) => typeof kind === "string")
    && (filter.project_id === null || typeof filter.project_id === "string")
    && (filter.message_id === null || typeof filter.message_id === "string");
}

function validViewer(viewer: Viewer | null): viewer is Viewer {
  return !!viewer && typeof viewer.principal_ref === "string" && !!principalOf(viewer.principal_ref)
    && typeof viewer.credential === "string" && (viewer.credential_hash === null || typeof viewer.credential_hash === "string");
}

/**
 * One instance per stream: a team (idFromName(team_id)) or a person's own
 * inbox (idFromName("user:<id>")). Reached only from this Worker:
 *   /connect  a socket, after the Worker consumed a ticket for it
 *   /publish  the dispatcher: events up to seq are stored
 *   /wait     a held request, answered by the first matching event or its timeout
 *   /recheck  a credential or agent was revoked, or a member removed or signed out: check every socket now
 * Uses the WebSocket Hibernation API, so a waiting agent costs nothing while
 * nothing happens; "ping" gets an automatic "pong" without waking it.
 *
 * Events are never taken from the publish itself: each fanout reads the
 * stream from D1 after the lowest cursor, in seq order, so a socket gets
 * every event it may see exactly once and in order, even when two events'
 * publishes arrive out of order. Each socket's and waiter's credential and
 * access are checked again before anything is sent.
 */
export class TeamEventsDO {
  // Instance fields so a test can lower them on one object.
  maxSocketsPerPrincipal = MAX_SOCKETS_PER_PRINCIPAL;
  maxSocketsPerStream = MAX_SOCKETS_PER_STREAM;
  maxWaitersPerPrincipal = MAX_WAITERS_PER_PRINCIPAL;
  maxWaitersPerStream = MAX_WAITERS_PER_STREAM;
  // How a frame reaches a socket; a test replaces it to make a send fail.
  sendFrame: (ws: WebSocket, frame: unknown) => boolean = send;

  // Sockets still receiving catch-up: fanouts leave them alone, and each
  // asks for a fanout of its own once its catch-up is sent.
  private catchingUp = new Set<WebSocket>();
  private waiters = new Set<Waiter>();
  // The newest seq published to this object since it last woke.
  private latestPublished = 0;
  private fanoutRunning: Promise<void> | null = null;
  private fanoutAgain = false;
  // The next fanout pass reads even when every cursor is at the newest published seq (the alarm's catch-up:
  // a publish that was lost leaves nothing to compare against), and does not go on to the pass after a full page.
  private forceRead = false;
  private singlePass = false;
  // Sockets sent a resync in the current run of passes: the rest of the run leaves them to the client's paging.
  private resyncing = new Set<WebSocket>();
  // Sockets whose send failed in the current run: closed, and never read for again in it.
  private undeliverable = new Set<WebSocket>();
  private stream: EventStream | null = null;

  constructor(
    private state: DurableObjectState,
    private env: Env
  ) {
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const stream = parseStreamHeader(request.headers.get(internalHeader(HeaderPart.Stream)));
    if (!stream) return json({ ok: false, error: "bad stream" }, 400);
    this.stream = stream;
    if (url.pathname === "/connect") return this.connect(request, stream);
    if (request.method !== "POST") return json({ ok: false, error: "not found" }, 404);
    if (url.pathname === "/publish") return this.publish(request);
    if (url.pathname === "/wait") return this.wait(request, stream);
    if (url.pathname === "/recheck") {
      const closed = await this.check(stream, this.openSockets(), [...this.waiters].filter((waiter) => waiter.ready));
      await this.armAlarm();
      return json({ ok: true, data: { closed } });
    }
    return json({ ok: false, error: "not found" }, 404);
  }

  private openSockets(tag?: string): WebSocket[] {
    return this.state.getWebSockets(tag).filter((ws) => ws.readyState === WS_OPEN);
  }

  // ── Sockets ───────────────────────────────────────────────────────────────

  private async connect(request: Request, stream: EventStream): Promise<Response> {
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
      return json({ ok: false, error: "expected a WebSocket upgrade" }, 426);
    }
    const viewer = parseJsonHeader<Viewer>(request.headers.get(internalHeader(HeaderPart.Viewer)));
    const filter = parseJsonHeader<EventFilter>(request.headers.get(internalHeader(HeaderPart.Filter)));
    const afterHeader = request.headers.get(internalHeader(HeaderPart.After)) ?? "";
    const after = afterHeader === "" ? null : Number(afterHeader);
    const expiresAt = Number(request.headers.get(internalHeader(HeaderPart.ExpiresAt)));
    if (!validViewer(viewer) || !validFilter(filter) || !Number.isFinite(expiresAt)
      || (after !== null && !(Number.isSafeInteger(after) && after >= 0))) {
      return json({ ok: false, error: "bad connect request" }, 400);
    }
    const principal = principalOf(viewer.principal_ref)!;

    const [client, server] = Object.values(new WebSocketPair());
    const headers = { "Sec-WebSocket-Protocol": eventsProtocol() };
    const upgraded = () => new Response(null, { status: 101, webSocket: client, headers });
    const refuse = (code: number, reason: string) => {
      server.accept();
      server.close(code, reason);
      return upgraded();
    };

    // At the cap, first free the slots of this principal's sockets whose
    // credential no longer passes (a revoked key's), then count again. The
    // count and the accept below run with no await between them, so two
    // racing connects cannot both take the last slot.
    if (this.openSockets(viewer.principal_ref).length >= this.maxSocketsPerPrincipal) {
      await this.check(stream, this.openSockets(viewer.principal_ref), []);
    }
    if (this.openSockets(viewer.principal_ref).length >= this.maxSocketsPerPrincipal) {
      return refuse(1013, `at most ${this.maxSocketsPerPrincipal} event sockets per agent or person`);
    }
    if (this.openSockets().length >= this.maxSocketsPerStream) {
      return refuse(1013, `at most ${this.maxSocketsPerStream} event sockets per team`);
    }

    const attachment: SocketAttachment = {
      principal_ref: viewer.principal_ref,
      credential: viewer.credential,
      credential_hash: viewer.credential_hash,
      stream: streamHeader(stream),
      filter,
      cursor: after ?? 0,
      expires_at: expiresAt,
    };
    this.state.acceptWebSocket(server, [viewer.principal_ref]);
    server.serializeAttachment(attachment);
    this.catchingUp.add(server);

    // The socket is registered before catch-up reads D1, so an event stored
    // during the read is not missed: the fanout this socket asks for below
    // reads from the cursor catch-up ends at.
    // A frame that cannot be sent ends the connect: the cursor must not move past an event the client never got.
    const out = (frame: unknown) => { if (!this.sendFrame(server, frame)) throw new DeliveryFailed(); };
    try {
      out({
        type: "ready",
        protocol: eventsProtocol(),
        team_id: stream.teamId ?? null,
        filter,
        after,
        server_time: new Date().toISOString(),
        expires_at: new Date(expiresAt).toISOString(),
        trust: TRUST_NOTE,
      });
      let head: number;
      if (after === null) {
        head = await this.head(stream);
      } else {
        const catchUp = await readStreamEvents(this.env, principal, {
          stream, after, filter, limit: CATCH_UP_LIMIT, newest: true,
        });
        head = catchUp.head;
        if (catchUp.truncated) {
          out({ type: "catch_up_truncated", limit: CATCH_UP_LIMIT, after, oldest_seq: catchUp.events[0]?.seq ?? null });
        }
        for (const event of catchUp.events) out({ type: "event", event });
      }
      attachment.cursor = Math.max(after ?? 0, head);
      server.serializeAttachment(attachment);
      // Every event this socket may see up to cursor has now been sent (or named by catch_up_truncated).
      out({ type: "caught_up", cursor: attachment.cursor });
    } catch (err) {
      // The client sees the close and reconnects; catch-up runs again then.
      this.catchingUp.delete(server);
      if (err instanceof DeliveryFailed) {
        try { server.close(DELIVERY_FAILED_CLOSE_CODE, "delivery failed; reconnect from your last seq"); } catch { /* gone */ }
        return upgraded();
      }
      console.error("[team-events] connect failed", err instanceof Error ? err.message : String(err));
      try { server.close(1011, "connect failed; reconnect"); } catch { /* gone */ }
      return upgraded();
    }
    this.catchingUp.delete(server);
    if (this.latestPublished > attachment.cursor) this.requestFanout();

    // Best effort: liveness and the alarm never fail a socket that is already delivering.
    // The stamp is tried first and its failure does not stop the alarm from being armed.
    try {
      if (principal.kind === "user" && filter.message_id) {
        await stampWaiting(this.env, principal.userId, filter.message_id);
      }
    } catch (err) {
      console.error("[team-events] liveness failed", err instanceof Error ? err.message : String(err));
    }
    try {
      await this.armAlarm();
    } catch (err) {
      console.error("[team-events] alarm failed", err instanceof Error ? err.message : String(err));
    }
    return upgraded();
  }

  private async head(stream: EventStream): Promise<number> {
    const row = await this.env.DB.prepare(`SELECT COALESCE(MAX(seq), 0) AS head FROM events
      WHERE ${stream.teamId !== undefined ? "team_id" : "owner_user_id"} = ?`)
      .bind(stream.teamId ?? stream.ownerUserId).first<{ head: number }>();
    return row?.head ?? 0;
  }

  // ── Publish and fanout ────────────────────────────────────────────────────

  private async publish(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { seq?: unknown } | null;
    const seq = Number(body?.seq);
    if (!Number.isSafeInteger(seq) || seq < 0) return json({ ok: false, error: "bad publish" }, 400);
    this.latestPublished = Math.max(this.latestPublished, seq);
    if (!this.openSockets().length && !this.waiters.size) return json({ ok: true, data: { listeners: 0 } });
    this.requestFanout();
    await this.fanoutRunning;
    return json({ ok: true, data: { listeners: this.openSockets().length + this.waiters.size } });
  }

  // One fanout at a time, so every socket gets events in seq order; a request
  // made while one runs makes it run once more.
  private requestFanout(): void {
    if (this.fanoutRunning) {
      this.fanoutAgain = true;
      return;
    }
    this.fanoutRunning = (async () => {
      try {
        do {
          this.fanoutAgain = false;
          await this.fanout();
        } while (this.fanoutAgain);
      } catch (err) {
        console.error("[team-events] fanout failed", err instanceof Error ? err.message : String(err));
      } finally {
        this.fanoutRunning = null;
        this.resyncing.clear();
        this.undeliverable.clear();
      }
    })();
  }

  private async fanout(): Promise<void> {
    // Taken first: a pass that returns early has still used up the request that set them.
    const force = this.forceRead, single = this.singlePass;
    this.forceRead = this.singlePass = false;
    const stream = this.stream;
    if (!stream) return;
    const now = Date.now();
    const sockets: Array<[WebSocket, SocketAttachment]> = [];
    for (const ws of this.openSockets()) {
      if (this.catchingUp.has(ws) || this.undeliverable.has(ws)) continue;
      const att = attachmentOf(ws);
      if (!att) continue;
      // Past its maximum age (the alarm has not run yet): nothing more until it reconnects.
      if (att.expires_at <= now) { this.closeForReauth(ws, "socket expired; reauthenticate"); continue; }
      sockets.push([ws, att]);
    }
    const waiters = [...this.waiters].filter((waiter) => waiter.ready);
    const cursors = [...sockets.map(([, att]) => att.cursor), ...waiters.map((waiter) => waiter.cursor)];
    if (!cursors.length) return;
    const from = Math.min(...cursors);
    // A publish at or below every cursor is a repeat (the sweeper, a retry): nothing to read.
    // The alarm's catch-up reads anyway: the publish that would have named a newer seq may have been lost.
    if (!force && this.latestPublished && this.latestPublished <= from) return;

    // One bounded read of the stream after the lowest cursor, not filtered: sockets filter differently. A full
    // page means more may follow, and the next pass reads them (an alarm's single pass leaves them for later).
    const { results } = await this.env.DB.prepare(`SELECT ${EVENT_COLUMNS} FROM events e
      WHERE ${stream.teamId !== undefined ? "e.team_id" : "e.owner_user_id"} = ? AND e.seq > ? ORDER BY e.seq LIMIT ?`)
      .bind(stream.teamId ?? stream.ownerUserId, from, FANOUT_READ_LIMIT).all<EventRowText>();
    const rows = (results ?? []).map(eventView);
    if (rows.length === FANOUT_READ_LIMIT && !single) {
      this.fanoutAgain = true;
      this.forceRead = true;
    }
    if (!rows.length) return;
    const scannedTo = rows[rows.length - 1].seq;
    const pending = (cursor: number, filter: EventFilter) => rows.filter((row) => row.seq > cursor && eventMatches(filter, row));

    // Only those with something to receive are checked; the heartbeat checks the rest.
    const candidates = new Map<string, Viewer>();
    for (const [, att] of sockets) if (pending(att.cursor, att.filter).length) candidates.set(viewerKey(viewerOf(att)), viewerOf(att));
    for (const waiter of waiters) if (pending(waiter.cursor, waiter.filter).length) candidates.set(viewerKey(waiter.viewer), waiter.viewer);
    const auth: Authorization = candidates.size
      ? await authorizeViewers(this.env, stream, [...candidates.values()], rows)
      : { ok: new Set(), readable: new Map() };

    for (const [ws, att] of sockets) {
      if (ws.readyState !== WS_OPEN) continue;
      const matching = this.resyncing.has(ws) ? [] : pending(att.cursor, att.filter);
      if (matching.length) {
        if (!auth.ok.has(viewerKey(viewerOf(att)))) {
          this.closeForReauth(ws, "credential or access revoked; reauthenticate");
          continue;
        }
        const principal = principalOf(att.principal_ref)!;
        const readable = auth.readable.get(principal.kind === "agent" ? principal.agentId : `user:${principal.userId}`);
        const visible = matching.filter((event) => eventVisible(principal, readable, event));
        // The cursor moves only past events that were sent: a send that fails closes the socket where it stands.
        let sentTo = att.cursor;
        let failed = false;
        for (const event of visible.slice(0, MAX_EVENTS_PER_DELIVERY)) {
          if (!this.sendFrame(ws, { type: "event", event })) { failed = true; break; }
          sentTo = event.seq;
        }
        if (!failed && visible.length > MAX_EVENTS_PER_DELIVERY) {
          // The rest is for the client to page: GET /api/events?after=<sentTo>. Nothing more goes out this run.
          failed = !this.sendFrame(ws, { type: "resync", after: sentTo });
          this.resyncing.add(ws);
        }
        if (failed) {
          this.setCursor(ws, sentTo);
          this.undeliverable.add(ws);
          this.closeForDeliveryFailure(ws);
          continue;
        }
      }
      this.setCursor(ws, Math.max(att.cursor, scannedTo));
    }
    for (const waiter of waiters) {
      if (!this.waiters.has(waiter)) continue;
      const matching = pending(waiter.cursor, waiter.filter);
      if (matching.length) {
        if (!auth.ok.has(viewerKey(waiter.viewer))) {
          waiter.finish(401, { ok: false, error: "credential or access revoked; reauthenticate" });
          continue;
        }
        const readable = auth.readable.get(waiter.principal.kind === "agent" ? waiter.principal.agentId : `user:${waiter.principal.userId}`);
        const events = matching.filter((event) => eventVisible(waiter.principal, readable, event)).slice(0, waiter.limit);
        if (events.length) {
          waiter.finish(200, { ok: true, data: { events, next_cursor: events[events.length - 1].seq, timed_out: false, trust: TRUST_NOTE } });
          continue;
        }
      }
      waiter.cursor = Math.max(waiter.cursor, scannedTo);
    }
  }

  // ── Waiting requests ──────────────────────────────────────────────────────

  private async wait(request: Request, stream: EventStream): Promise<Response> {
    const viewer = parseJsonHeader<Viewer>(request.headers.get(internalHeader(HeaderPart.Viewer)));
    const filter = parseJsonHeader<EventFilter>(request.headers.get(internalHeader(HeaderPart.Filter)));
    const after = Number(request.headers.get(internalHeader(HeaderPart.After)));
    const timeoutMs = Number(request.headers.get(internalHeader(HeaderPart.TimeoutMs)));
    const limit = Number(request.headers.get(internalHeader(HeaderPart.Limit)));
    if (!validViewer(viewer) || !validFilter(filter) || !Number.isSafeInteger(after) || after < 0
      || !Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      return json({ ok: false, error: "bad wait request" }, 400);
    }
    const mine = [...this.waiters].filter((waiter) => waiter.viewer.principal_ref === viewer.principal_ref).length;
    if (mine >= this.maxWaitersPerPrincipal || this.waiters.size >= this.maxWaitersPerStream) {
      return json({ ok: false, error: "too many waiting requests; wait for one to return", limit: "events_wait" }, 429);
    }
    const principal = principalOf(viewer.principal_ref)!;
    return new Promise<Response>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const waiter: Waiter = {
        viewer, principal, filter, after, cursor: after, limit, ready: false,
        finish: (status, body) => {
          if (finished) return;
          finished = true;
          if (timer) clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(json(body, status));
        },
      };
      this.waiters.add(waiter);
      const timedOut = () => waiter.finish(200, { ok: true, data: { events: [], next_cursor: after, timed_out: true, trust: TRUST_NOTE } });
      // Registered before the read, as a socket is before its catch-up.
      (async () => {
        try {
          const first = await readStreamEvents(this.env, principal, { stream, after, filter, limit });
          if (first.events.length) {
            waiter.finish(200, { ok: true, data: { events: first.events, next_cursor: first.events[first.events.length - 1].seq, timed_out: false, trust: TRUST_NOTE } });
            return;
          }
          if (timeoutMs <= 0) { timedOut(); return; }
          waiter.cursor = Math.max(after, first.head);
          waiter.ready = true;
          timer = setTimeout(timedOut, timeoutMs);
          if (principal.kind === "user" && filter.message_id) {
            await stampWaiting(this.env, principal.userId, filter.message_id).catch(() => undefined);
          }
          if (this.latestPublished > waiter.cursor) this.requestFanout();
        } catch (err) {
          console.error("[team-events] wait failed", err instanceof Error ? err.message : String(err));
          waiter.finish(500, { ok: false, error: "waiting failed; try again" });
        }
      })();
    });
  }

  // ── Checks, heartbeat and lifecycle ───────────────────────────────────────

  /**
   * Closes, with REAUTH_CLOSE_CODE, every socket here that is past its
   * maximum age or whose credential or access no longer passes, and answers
   * such waiting requests with 401. Returns how many sockets it closed.
   */
  private async check(stream: EventStream, sockets: WebSocket[], waiters: Waiter[]): Promise<number> {
    const now = Date.now();
    let closed = 0;
    const live: Array<[WebSocket, SocketAttachment]> = [];
    for (const ws of sockets) {
      const att = attachmentOf(ws);
      if (!att) continue;
      if (att.expires_at <= now) { this.closeForReauth(ws, "socket expired; reauthenticate"); closed++; continue; }
      live.push([ws, att]);
    }
    if (!live.length && !waiters.length) return closed;
    const auth = await authorizeViewers(this.env, stream, [...live.map(([, att]) => viewerOf(att)), ...waiters.map((waiter) => waiter.viewer)]);
    for (const [ws, att] of live) {
      if (auth.ok.has(viewerKey(viewerOf(att)))) continue;
      this.closeForReauth(ws, "credential or access revoked; reauthenticate");
      closed++;
    }
    for (const waiter of waiters) {
      if (!auth.ok.has(viewerKey(waiter.viewer))) waiter.finish(401, { ok: false, error: "credential or access revoked; reauthenticate" });
    }
    return closed;
  }

  async alarm(): Promise<void> {
    const sockets = this.openSockets();
    const stream = this.stream ?? parseStreamHeader(sockets.map(attachmentOf).find(Boolean)?.stream ?? null);
    if (stream && sockets.length) {
      this.stream = stream;
      // The alarm may run every 10 s for a liveness stamp; the credential re-check and the D1 catch-up run
      // at most once per HEARTBEAT_MS (sooner only when a socket has passed its maximum age).
      const now = Date.now();
      const lastFull = (await this.state.storage.get<number>(LAST_FULL_CHECK_KEY)) ?? 0;
      const expired = sockets.some((ws) => (attachmentOf(ws)?.expires_at ?? Infinity) <= now);
      if (now - lastFull >= HEARTBEAT_MS || expired) {
        await this.state.storage.put(LAST_FULL_CHECK_KEY, now);
        await this.check(stream, sockets, []);
        // A publish can be lost (the dispatcher retries once): each open socket is brought up to date from D1,
        // one bounded pass, so a lost publish is recovered within one heartbeat.
        await this.catchUp();
      }
      for (const ws of this.openSockets()) {
        const att = attachmentOf(ws);
        const principal = att ? principalOf(att.principal_ref) : null;
        if (att?.filter.message_id && principal?.kind === "user") {
          await stampWaiting(this.env, principal.userId, att.filter.message_id)
            .catch((err) => console.error("[team-events] liveness stamp failed", err instanceof Error ? err.message : String(err)));
        }
      }
    }
    // No open socket left: no alarm until the next connect.
    const next = this.nextAlarmAt();
    if (next !== null) await this.state.storage.setAlarm(next);
  }

  private async catchUp(): Promise<void> {
    this.forceRead = true;
    this.singlePass = true;
    this.requestFanout();
    await this.fanoutRunning;
  }

  // The earliest time an open socket needs the alarm: its maximum age, the
  // next heartbeat check (which also catches it up), or (a person waiting on
  // one question) the next liveness stamp. null when no socket is open, so an
  // object with no sockets never wakes for nothing.
  private nextAlarmAt(): number | null {
    const now = Date.now();
    let next: number | null = null;
    for (const ws of this.openSockets()) {
      const att = attachmentOf(ws);
      if (!att) continue;
      let due = Math.min(att.expires_at, now + HEARTBEAT_MS);
      if (att.filter.message_id && att.principal_ref.startsWith("user:")) due = Math.min(due, now + LIVENESS_INTERVAL_MS);
      next = next === null ? due : Math.min(next, due);
    }
    return next;
  }

  // Moves the alarm earlier if a socket needs it sooner.
  private async armAlarm(): Promise<void> {
    const next = this.nextAlarmAt();
    if (next === null) return;
    const current = await this.state.storage.getAlarm();
    if (current === null || current > next) await this.state.storage.setAlarm(next);
  }

  // The socket's attachment is read again, not taken from before the awaits: it may have been written meanwhile.
  private setCursor(ws: WebSocket, cursor: number): void {
    const att = attachmentOf(ws);
    if (!att) return;
    att.cursor = cursor;
    try { ws.serializeAttachment(att); } catch { /* closing */ }
  }

  private closeForDeliveryFailure(ws: WebSocket): void {
    this.catchingUp.delete(ws);
    try { ws.close(DELIVERY_FAILED_CLOSE_CODE, "delivery failed; reconnect from your last seq"); } catch { /* already closing */ }
  }

  private closeForReauth(ws: WebSocket, reason: string): void {
    this.catchingUp.delete(ws);
    try { ws.close(REAUTH_CLOSE_CODE, reason); } catch { /* already closing */ }
  }

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // Clients only listen. "ping" is answered by the auto-response.
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.catchingUp.delete(ws);
    try {
      ws.close(code, reason);
    } catch {
      try { ws.close(); } catch { /* already closed */ }
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.catchingUp.delete(ws);
  }
}
