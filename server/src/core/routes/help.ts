import { editionOnHelpOpened, editionProductName, editionPublicSite, editionSelectedSpace } from "../edition-hooks";
import { resolveAgentCredential } from "../agent-board";
import {
  absoluteHelpResult,
  askHelp,
  HELP_QUESTION_MAX_CHARS,
  HelpAskError,
  searchHelpArticles,
  type HelpActor,
  type HelpAskResult,
} from "../help/assistant";
import { HELP_CORPUS_VERSION } from "../help/corpus";
import { resolveApiKeyUser, resolveSessionUserId } from "../middleware";
import type { Env } from "../types";
import { json } from "../utils";
import { listTeams } from "../workspace";
import { resolveOAuthUser } from "./oauth";

// Help API. Not on the public site (404 there).
//   POST /api/help/ask       {question, locale?, team_id?}
//     A signed-in session (any team role, viewers included) with a same-origin
//     request, or a Bearer API key / OAuth token (no Origin needed), or an
//     Agent credential. Answers come from the product's help articles.
//   GET  /api/help/articles?q=   Lexical article search, no AI and no sign-in.

function respond(body: Record<string, unknown>, status = 200, retryAfter?: number): Response {
  const response = json(body as { ok: true; data: unknown }, status);
  response.headers.set("Cache-Control", "private, no-store");
  if (retryAfter) response.headers.set("Retry-After", String(retryAfter));
  return response;
}

const fail = (status: number, error: string, extra: Record<string, unknown> = {}, retryAfter?: number) =>
  respond({ ok: false, error, ...extra }, status, retryAfter);

function sameOrigin(request: Request, env: Env): boolean {
  try { return new URL(request.headers.get("Origin") || "").origin === new URL(env.WORKER_URL).origin; }
  catch { return false; }
}

/** A HelpAskError as its 400 or 429; anything else (storage, limiter) is logged and answered with a generic 500. */
export function helpErrorResponse(error: unknown): Response {
  if (error instanceof HelpAskError) {
    return fail(error.status, error.message, error.limit ? { limit: error.limit } : {}, error.retryAfter);
  }
  console.error("help api: ask failed", error instanceof Error ? error.message : String(error));
  return fail(500, `${editionProductName()} help could not answer just now. Try again, or browse the help articles.`);
}

/**
 * The team whose daily help cap a user's question counts toward: team_id when
 * given (must be one of the user's teams), else the selected workspace
 * (cookie preference), else the user's first team, else none.
 */
export async function helpTeamForUser(request: Request | null, env: Env, userId: string, teamId?: unknown): Promise<string | null | Response> {
  const teams = await listTeams(env, userId);
  if (teamId !== undefined && teamId !== null && teamId !== "") {
    if (typeof teamId !== "string") return fail(400, "team_id must be a string");
    return teams.some((team) => team.id === teamId) ? teamId : fail(403, "forbidden");
  }
  const team = request ? await editionSelectedSpace(request, userId, teams) : teams[0] ?? null;
  return team?.id ?? null;
}

/** The help actor for an Agent credential: the agent and its team. */
export async function resolveHelpAgent(env: Env, headers: Headers): Promise<HelpActor | null> {
  const agent = await resolveAgentCredential(headers, env);
  if (!agent) return null;
  const row = await env.DB.prepare("SELECT team_id FROM agent_identities WHERE id = ?").bind(agent.agentId).first<{ team_id: string }>();
  return row ? { kind: "agent", agentId: agent.agentId, teamId: row.team_id } : null;
}

async function handleAsk(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  let actorUserId: string | null = null;
  let agent: HelpActor | null = null;
  if (auth.startsWith("Agent ")) {
    agent = await resolveHelpAgent(env, request.headers);
    if (!agent) return fail(401, "invalid agent credential");
  } else if (auth.startsWith("Bearer ")) {
    const user = await resolveApiKeyUser(request.headers, env) ?? await resolveOAuthUser(request.headers, env);
    if (!user) return fail(401, "unauthorized");
    actorUserId = user.userId;
  } else {
    // Cookie or "Authorization: Session <token>" sessions are origin-checked.
    actorUserId = await resolveSessionUserId(request, env);
    if (!actorUserId) return fail(401, "unauthorized");
    if (!sameOrigin(request, env)) return fail(403, "invalid origin");
  }

  let body: unknown;
  try { body = await request.json(); } catch { return fail(400, "invalid JSON body"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "JSON object body required");
  const input = body as Record<string, unknown>;
  if (input.locale !== undefined && input.locale !== null && typeof input.locale !== "string") return fail(400, "locale must be a string");

  let actor: HelpActor;
  if (agent) {
    actor = agent;
  } else {
    const teamId = await helpTeamForUser(auth.startsWith("Bearer ") ? null : request, env, actorUserId!, input.team_id);
    if (teamId instanceof Response) return teamId;
    actor = { kind: "user", userId: actorUserId!, teamId };
  }

  let result: HelpAskResult;
  try {
    result = await askHelp(env, { question: input.question, locale: input.locale as string | undefined, actor });
  } catch (error) {
    return helpErrorResponse(error);
  }
  // Only an accepted question (not a 400, 401, 403 or 429) marks Help opened, for the team it counts toward.
  if (actor.kind === "user" && actor.teamId) await editionOnHelpOpened(env, { teamId: actor.teamId, userId: actor.userId });
  // Cookie sessions (the web app) get same-site links; any Authorization header (apps, API keys, OAuth, agents) gets absolute ones.
  return respond({ ok: true, data: auth ? absoluteHelpResult(result, env.WORKER_URL) : result });
}

function handleArticles(request: Request): Response {
  const query = new URL(request.url).searchParams.get("q") ?? "";
  if (Array.from(query).length > HELP_QUESTION_MAX_CHARS) return fail(400, `q must be at most ${HELP_QUESTION_MAX_CHARS} characters`);
  const response = respond({ ok: true, data: { version: HELP_CORPUS_VERSION, articles: searchHelpArticles(query) } });
  response.headers.set("Cache-Control", "public, max-age=300");
  return response;
}

export async function handleHelpApi(request: Request, env: Env): Promise<Response> {
  if (editionPublicSite(env)) return fail(404, "not found");
  const path = new URL(request.url).pathname;
  if (path === "/api/help/ask") {
    if (request.method !== "POST") return fail(405, "method not allowed");
    try { return await handleAsk(request, env); } catch (error) { return helpErrorResponse(error); }
  }
  if (path === "/api/help/articles") {
    return request.method === "GET" ? handleArticles(request) : fail(405, "method not allowed");
  }
  return fail(404, "not found");
}
