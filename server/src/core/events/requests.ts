import { canReadResource } from "../workspace-access";
import { resolveAgentCredential } from "../agent-board";
import { sha256Hex } from "../auth-utils";
import { resolveCallerCredential } from "../middleware";
import { resolveOAuthUser } from "../routes/oauth";
import { editionProductName, editionWireFormat } from "../edition-hooks";
import { clientToolName, HeaderPart, internalHeader } from "../wire-names";
import type { Env } from "../types";
import {
  deploymentKeyHashes,
  EVENTS_NOT_CONFIGURED,
  MAX_WAIT_SECONDS,
  streamHeader,
  streamName,
  teamEventsStub,
  TRUST_NOTE,
  type Viewer,
} from "./live";
import {
  EVENT_PAGE,
  EventQueryError,
  parseCursor,
  parseKinds,
  readStreamEvents,
  type EventFilter,
  type EventPrincipal,
  type EventStream,
} from "./query";

// The request side of live events: who is asking (with which credential),
// which stream they follow, and POST /api/events/wait (also the wait_for_events tool).

export const webCookieRefused = (): string => `The web sign-in cookie cannot follow live events: use an API key (Authorization: Bearer), an agent key (Authorization: Agent) or the ${editionProductName()} app's session.`;
export const WEB_COOKIE_CROSS_SITE = "The web sign-in cookie is accepted only from a request made by this site's own pages.";
/** The refusal for an OAuth token that asks for a socket ticket. Built at each call: the tool name shows the edition's prefix. */
export const oauthTicketRefused = (): string => `An OAuth token waits for events with ${clientToolName("pidgin_wait_for_events")} over MCP; a socket ticket needs an API key, an agent key or the ${editionProductName()} app's session.`;

/** web_cookie: the web sign-in cookie authenticated it (only a waiting request may). It then falls back to a plain page without the object. */
export type LiveCaller = { principal: EventPrincipal; viewer: Viewer; web_cookie?: true };

/** The credential kind a session token is checked as: tokens that start with the edition's token prefix are rows in entra_sessions/google_sessions, the rest are legacy KV. */
const sessionCredential = (token: string): "app_session" | "kv_session" => token.startsWith(editionWireFormat().tokenPrefix) ? "app_session" : "kv_session";

/**
 * A cookie request is the browser's own only when it names this site as its
 * origin, or says Sec-Fetch-Site: same-origin. A foreign Origin is refused
 * whatever else it says, and so is a cookie request with neither header.
 */
function sameSiteRequest(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin !== null) return origin === new URL(request.url).origin;
  return request.headers.get("Sec-Fetch-Site") === "same-origin";
}

/**
 * The caller of a live events request and the exact credential behind it, in
 * the order resolveEventPrincipal (GET /api/events) uses: an agent key (or an
 * OAuth token bound to an agent), then a session or API key, then a person's
 * OAuth token. `refused` when the web cookie authenticated it: page script on
 * the cookie's origin can cause a cookie request (see CallerCredential), so
 * a ticket, which is a credential of its own, never comes from the cookie.
 * A waiting request (allowWebCookie) takes the cookie when the request is
 * the site's own (sameSiteRequest) and refuses it, 403, when it is not.
 */
export async function resolveLiveCaller(request: Request, env: Env, options: { allowWebCookie?: boolean } = {}):
  Promise<LiveCaller | { refused: string } | null> {
  const authorization = request.headers.get("Authorization") ?? "";
  const agentAttempt = authorization.startsWith("Agent ");
  const agent = await resolveAgentCredential(request.headers, env);
  if (agent) {
    return {
      principal: { kind: "agent", agentId: agent.agentId },
      viewer: agentAttempt
        ? { principal_ref: `agent:${agent.agentId}`, credential: "agent_key", credential_hash: await sha256Hex(authorization.slice(6)) }
        : { principal_ref: `agent:${agent.agentId}`, credential: "oauth", credential_hash: null },
    };
  }
  if (agentAttempt) return null;
  const caller = await resolveCallerCredential(request, env);
  if (caller) {
    const principal: EventPrincipal = { kind: "user", userId: caller.userId, credential: caller.via };
    const principal_ref = `user:${caller.userId}`;
    if (caller.via === "web_cookie") {
      if (!options.allowWebCookie) return { refused: webCookieRefused() };
      if (!sameSiteRequest(request)) return { refused: WEB_COOKIE_CROSS_SITE };
      const token = request.headers.get("Cookie")?.match(/(?:^|;\s*)session=([^;]+)/)?.[1] ?? "";
      return { principal, web_cookie: true, viewer: { principal_ref, credential: sessionCredential(token), credential_hash: await sha256Hex(token) } };
    }
    if (caller.via === "app_session") {
      const token = authorization.slice(8);
      return { principal, viewer: { principal_ref, credential: sessionCredential(token), credential_hash: await sha256Hex(token) } };
    }
    const hash = await sha256Hex(authorization.slice(7));
    const deployment = (await deploymentKeyHashes(env)).has(hash);
    return { principal, viewer: { principal_ref, credential: deployment ? "deployment_key" : "api_key", credential_hash: hash } };
  }
  const oauth = await resolveOAuthUser(request.headers, env);
  if (!oauth) return null;
  return {
    principal: { kind: "user", userId: oauth.userId, credential: "oauth" },
    viewer: { principal_ref: `user:${oauth.userId}`, credential: "oauth", credential_hash: null },
  };
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface LiveRequest {
  team_id: string | null;
  message_id: string | null;
  filter: EventFilter;
  after: number | null;
  timeout_seconds: number;
  limit: number;
}

/**
 * A ticket's or waiting request's body: {team_id?, kinds?, project_id?,
 * message_id?, after?} and, to wait, {timeout? (seconds, at most 25), limit?}.
 * Throws EventQueryError.
 */
export function parseLiveRequest(body: unknown, wait: boolean): LiveRequest {
  if (body === null || body === undefined) body = {};
  if (typeof body !== "object" || Array.isArray(body)) throw new EventQueryError("the body must be a JSON object");
  const input = body as Record<string, unknown>;
  const allowed = ["team_id", "kinds", "project_id", "message_id", "after", ...(wait ? ["timeout", "limit"] : [])];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new EventQueryError(`unknown field: ${key}`);
  }
  const id = (field: string) => {
    const value = input[field];
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || !ID.test(value)) throw new EventQueryError(`${field} must be an id`);
    return value;
  };
  let timeout = MAX_WAIT_SECONDS;
  if (input.timeout !== undefined && input.timeout !== null) {
    if (typeof input.timeout !== "number" || !Number.isFinite(input.timeout) || input.timeout < 0) {
      throw new EventQueryError(`timeout must be 0 to ${MAX_WAIT_SECONDS} seconds`);
    }
    timeout = Math.min(input.timeout, MAX_WAIT_SECONDS);
  }
  const kinds = input.kinds === undefined || input.kinds === null ? []
    : Array.isArray(input.kinds) ? parseKinds(input.kinds as string[]) : parseKinds(String(input.kinds));
  return {
    team_id: id("team_id"),
    message_id: id("message_id"),
    filter: { kinds, project_id: id("project_id"), message_id: id("message_id") },
    after: input.after === undefined || input.after === null ? null : parseCursor(input.after, "after", 0, Number.MAX_SAFE_INTEGER),
    timeout_seconds: timeout,
    limit: parseCursor(input.limit, "limit", EVENT_PAGE.default, EVENT_PAGE.max) || EVENT_PAGE.default,
  };
}

/**
 * The one stream a request follows. An agent: its own team. A person: the
 * stream of message_id (its team, or their own inbox for a question in it),
 * else team_id (a team they belong to), else their own inbox. project_id
 * must be a board of that team. A miss is the same 404 whether the thing is
 * missing or not the caller's.
 */
export async function resolveStream(env: Env, principal: EventPrincipal, input: Pick<LiveRequest, "team_id" | "message_id" | "filter">):
  Promise<EventStream> {
  let stream: EventStream;
  if (principal.kind === "agent") {
    if (input.message_id) throw new EventQueryError("message_id is for people: an agent key cannot read messages");
    const agent = await env.DB.prepare("SELECT team_id FROM agent_identities WHERE id = ? AND status = 'active' AND kind = 'agent'")
      .bind(principal.agentId).first<{ team_id: string }>();
    if (!agent) throw new EventQueryError("unauthorized", 401);
    if (input.team_id && input.team_id !== agent.team_id) throw new EventQueryError("team not found", 404);
    stream = { teamId: agent.team_id };
  } else {
    const member = (teamId: string) => env.DB.prepare("SELECT 1 AS ok FROM team_memberships WHERE team_id = ? AND user_id = ?")
      .bind(teamId, principal.userId).first();
    if (input.message_id) {
      const message = await env.DB.prepare("SELECT id, team_id, user_id, sharing, type FROM messages WHERE id = ?").bind(input.message_id)
        .first<{ id: string; team_id: string | null; user_id: string; sharing: string; type: string }>();
      if (!message || !await canReadResource(env, principal.userId, message)) throw new EventQueryError("message not found", 404);
      stream = message.team_id ? { teamId: message.team_id } : { ownerUserId: principal.userId };
      if (input.team_id && input.team_id !== (stream.teamId ?? null)) throw new EventQueryError("message not found", 404);
    } else if (input.team_id) {
      if (!await member(input.team_id)) throw new EventQueryError("team not found", 404);
      stream = { teamId: input.team_id };
    } else {
      stream = { ownerUserId: principal.userId };
    }
  }
  if (input.filter.project_id) {
    if (stream.teamId === undefined) throw new EventQueryError("project_id needs team_id: your own inbox has no boards");
    const board = await env.DB.prepare("SELECT 1 AS ok FROM projects WHERE id = ? AND team_id = ?")
      .bind(input.filter.project_id, stream.teamId).first();
    if (!board) throw new EventQueryError("board not found", 404);
  }
  return stream;
}

/**
 * Waits for events after a cursor without polling: answered from D1 at once
 * when events after the cursor already match, otherwise held on the stream's
 * object until a matching event is published or the timeout passes (at most
 * 25 s). Returns the JSON body and status; next_cursor goes back as after.
 */
export async function waitForEvents(env: Env, caller: LiveCaller, body: unknown):
  Promise<{ status: number; body: Record<string, unknown> }> {
  let input: LiveRequest, stream: EventStream;
  try {
    input = parseLiveRequest(body, true);
    stream = await resolveStream(env, caller.principal, input);
  } catch (error) {
    if (error instanceof EventQueryError) return { status: error.status, body: { ok: false, error: error.message } };
    throw error;
  }
  const after = input.after ?? 0;
  const stub = teamEventsStub(env, streamName(stream));
  if (!stub) {
    // Without the object nothing can be held: answer from D1 at once. A page (web cookie) takes that as a plain
    // GET /api/events page, so it can call this unconditionally; an agent asked to wait is told it cannot.
    const first = await readStreamEvents(env, caller.principal, { stream, after, filter: input.filter, limit: input.limit });
    if (first.events.length || input.timeout_seconds === 0 || caller.web_cookie) {
      return { status: 200, body: { ok: true, data: { events: first.events, next_cursor: first.events.at(-1)?.seq ?? after,
        timed_out: !first.events.length, trust: TRUST_NOTE } } };
    }
    return { status: 503, body: { ok: false, error: EVENTS_NOT_CONFIGURED } };
  }
  const res = await stub.fetch("https://team-events.internal/wait", {
    method: "POST",
    headers: {
      [internalHeader(HeaderPart.Stream)]: streamHeader(stream),
      [internalHeader(HeaderPart.Viewer)]: JSON.stringify(caller.viewer),
      [internalHeader(HeaderPart.Filter)]: JSON.stringify(input.filter),
      [internalHeader(HeaderPart.After)]: String(after),
      [internalHeader(HeaderPart.TimeoutMs)]: String(Math.round(input.timeout_seconds * 1000)),
      [internalHeader(HeaderPart.Limit)]: String(input.limit),
    },
  });
  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  return data ? { status: res.status, body: data } : { status: 502, body: { ok: false, error: "waiting failed; try again" } };
}
