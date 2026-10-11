import { json } from "../utils";
import { resolveCallerUserId, unauthorized } from "../middleware";
import {
  JevError,
  LibraryAnswerError,
  LibrarySearchInputError,
  LibrarySearchUnavailableError,
  parseSearchInput,
  prepareLibraryIndex,
  runLibraryAsk,
  runLibrarySearch,
} from "../jevbox/service";
import { FilingInputError, parseFilingInput, suggestFiling } from "../jevbox/filing";
import { LibraryInputError } from "../library";
import type { Env } from "../types";

// Jevbox library search (JEV routing + passage scoring) and cited answers.
//   GET  /api/library/search/index   index state, no work
//   POST /api/library/search/index   index a batch of new/changed items
//   POST /api/library/search         { query, project_id?, tag_id?, items?, limit? }
//   POST /api/library/ask            { question, project_id?, tag_id?, items? }
//   POST /api/library/suggest        { items?, apply?, min_confidence? } JEV filing

const MAX_INDEX_BUDGET = 80;

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof LibrarySearchInputError || err instanceof FilingInputError || err instanceof LibraryInputError) {
    return json({ ok: false, error: err.message }, 400);
  }
  if (err instanceof LibrarySearchUnavailableError) return json({ ok: false, error: err.message }, 409);
  if (err instanceof JevError) {
    console.error("jev error", err.status, err.message);
    return json({ ok: false, error: err.message }, err.status);
  }
  if (err instanceof LibraryAnswerError) return json({ ok: false, error: err.message }, 502);
  throw err;
}

export async function handleGetLibraryIndex(request: Request, env: Env): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  return json({ ok: true, data: { index: await prepareLibraryIndex(env, userId, 0) } });
}

export async function handlePrepareLibraryIndex(request: Request, env: Env): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  const body = (await readBody(request)) ?? {};
  const budget = body.budget === undefined ? undefined : Number(body.budget);
  if (budget !== undefined && (!Number.isInteger(budget) || budget < 0 || budget > MAX_INDEX_BUDGET)) {
    return json({ ok: false, error: `budget must be an integer from 0 to ${MAX_INDEX_BUDGET}` }, 400);
  }
  return json({ ok: true, data: { index: await prepareLibraryIndex(env, userId, budget) } });
}

export async function handleLibrarySearch(request: Request, env: Env): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  const body = await readBody(request);
  if (!body) return json({ ok: false, error: "invalid JSON body" }, 400);
  try {
    return json({ ok: true, data: await runLibrarySearch(env, userId, parseSearchInput(body, "query")) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleLibraryAsk(request: Request, env: Env): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  const body = await readBody(request);
  if (!body) return json({ ok: false, error: "invalid JSON body" }, 400);
  try {
    return json({ ok: true, data: await runLibraryAsk(env, userId, parseSearchInput(body, "question")) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleSuggestFiling(request: Request, env: Env): Promise<Response> {
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  const body = (await readBody(request)) ?? {};
  try {
    return json({ ok: true, data: await suggestFiling(env, userId, parseFilingInput(body)) });
  } catch (err) {
    return errorResponse(err);
  }
}
