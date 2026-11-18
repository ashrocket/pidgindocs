import type { Env } from "../types";
import { resolveSessionUserId, unauthorized } from "../middleware";
import { json } from "../utils";

/** Maximum notes one user may keep in one team, archived notes included. */
export const MAX_NOTES_PER_USER_TEAM = 2000;
export const MAX_NOTE_BODY = 20000;
export const MAX_NOTE_TITLE = 160;
export const MAX_NOTE_QUERY = 100;
export const MAX_NOTE_LIST = 100;
const PREVIEW_CHARS = 280;

export class NoteInputError extends Error {}

type NoteKind = "paste" | "idea";

type NoteRow = {
  id: string; team_id: string; kind: NoteKind; title: string; body: string;
  pinned: number; archived_at: string | null; created_at: string; updated_at: string;
};

const NOTE_COLUMNS = "id,team_id,kind,title,body,pinned,archived_at,created_at,updated_at";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NoteInputError("Expected an object.");
  return value as Record<string, unknown>;
}

function mutationOriginAllowed(request: Request, env: Env): boolean {
  if (request.headers.has("Authorization")) return true; // Bearer auth is verified separately.
  try { return new URL(request.headers.get("Origin") || "").origin === new URL(env.WORKER_URL).origin; }
  catch { return false; }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try { return object(await request.json()); }
  catch { throw new NoteInputError("Invalid JSON body."); }
}

function teamIdOf(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(value)) throw new NoteInputError("team_id is required and must be a valid id.");
  return value;
}

function kindOf(value: unknown): NoteKind {
  if (value !== "paste" && value !== "idea") throw new NoteInputError("kind must be paste or idea.");
  return value;
}

// Optional client-generated id so a retried create (lost response, timeout) cannot duplicate a note.
function newIdOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(value)) throw new NoteInputError("id must be a UUID.");
  return value.toLowerCase();
}

function titleOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new NoteInputError("title must be text.");
  const title = value.trim();
  if (title.length > MAX_NOTE_TITLE) throw new NoteInputError(`title must be 0–${MAX_NOTE_TITLE} characters.`);
  return title;
}

// Pastes keep their whitespace: the body is validated but never trimmed.
function bodyOf(value: unknown): string {
  if (typeof value !== "string") throw new NoteInputError("body is required and must be text.");
  if (value.length < 1 || value.length > MAX_NOTE_BODY || !/\S/.test(value)) {
    throw new NoteInputError(`body must be 1–${MAX_NOTE_BODY} characters and contain more than whitespace.`);
  }
  return value;
}

function flagOf(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new NoteInputError(`${name} must be true or false.`);
  return value;
}

function toNote(row: NoteRow) {
  return {
    id: row.id, team_id: row.team_id, kind: row.kind, title: row.title, body: row.body,
    pinned: row.pinned === 1, archived: row.archived_at !== null,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

function toListItem(row: NoteRow) {
  const { body, ...rest } = toNote(row);
  const preview = Array.from(body.replace(/\s+/g, " ").trim()).slice(0, PREVIEW_CHARS).join("");
  return { ...rest, preview, body_length: body.length };
}

async function isTeamMember(env: Env, teamId: string, userId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS member FROM team_memberships WHERE team_id=? AND user_id=?")
    .bind(teamId, userId).first();
  return !!row;
}

const forbidden = () => json({ ok: false, error: "forbidden" }, 403);
const notFound = () => json({ ok: false, error: "not found" }, 404);

// A note is reachable only by its owner AND only while they are still a member of its team, so
// removing someone from a team locks them out of their notes there. The rows stay until the team
// is deleted (or the person is re-added).
const STILL_MEMBER = `EXISTS (SELECT 1 FROM team_memberships m
  WHERE m.team_id=personal_notes.team_id AND m.user_id=personal_notes.user_id)`;

async function loadNote(env: Env, id: string, userId: string): Promise<NoteRow | null> {
  return env.DB.prepare(`SELECT ${NOTE_COLUMNS} FROM personal_notes WHERE id=? AND user_id=? AND ${STILL_MEMBER}`)
    .bind(id, userId).first<NoteRow>();
}

async function listNotes(request: Request, env: Env, userId: string): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const teamId = teamIdOf(params.get("team_id"));
  const kind = params.get("kind") ?? "all";
  if (kind !== "all" && kind !== "paste" && kind !== "idea") throw new NoteInputError("kind must be all, paste, or idea.");
  const archived = params.get("archived") ?? "0";
  if (archived !== "0" && archived !== "1") throw new NoteInputError("archived must be 0 or 1.");
  const q = (params.get("q") ?? "").trim();
  if (q.length > MAX_NOTE_QUERY) throw new NoteInputError(`q must be at most ${MAX_NOTE_QUERY} characters.`);
  const rawLimit = params.get("limit");
  let limit = MAX_NOTE_LIST;
  if (rawLimit !== null) {
    if (!/^\d{1,4}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > MAX_NOTE_LIST) {
      throw new NoteInputError(`limit must be 1–${MAX_NOTE_LIST}.`);
    }
    limit = Number(rawLimit);
  }
  if (!await isTeamMember(env, teamId, userId)) return forbidden();

  const where = ["user_id=?", "team_id=?", archived === "1" ? "archived_at IS NOT NULL" : "archived_at IS NULL"];
  const binds: unknown[] = [userId, teamId];
  if (kind !== "all") { where.push("kind=?"); binds.push(kind); }
  if (q) {
    // instr() is a literal substring test, so % and _ need no escaping.
    where.push("(instr(lower(title),lower(?))>0 OR instr(lower(body),lower(?))>0)");
    binds.push(q, q);
  }
  const rows = await env.DB.prepare(`SELECT ${NOTE_COLUMNS} FROM personal_notes WHERE ${where.join(" AND ")}
    ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ?`).bind(...binds, limit + 1).all<NoteRow>();
  const has_more = rows.results.length > limit;
  return json({ ok: true, data: { notes: rows.results.slice(0, limit).map(toListItem), has_more } });
}

async function createNote(request: Request, env: Env, userId: string): Promise<Response> {
  const input = await readJson(request);
  const teamId = teamIdOf(input.team_id);
  const kind = kindOf(input.kind);
  const title = titleOf(input.title);
  const body = bodyOf(input.body);
  const requestedId = newIdOf(input.id);
  if (!await isTeamMember(env, teamId, userId)) return forbidden();

  // Retry of an earlier create: update that note in place (so an edited retry still saves the
  // edit) and answer 200. An id owned by someone else, or another team, is a plain conflict.
  if (requestedId) {
    const existing = await loadNote(env, requestedId, userId);
    if (existing) {
      if (existing.team_id !== teamId) return json({ ok: false, error: "conflict" }, 409);
      if (existing.kind !== kind || existing.title !== title || existing.body !== body) {
        await env.DB.prepare(`UPDATE personal_notes SET kind=?,title=?,body=?,updated_at=datetime('now')
          WHERE id=? AND user_id=? AND ${STILL_MEMBER}`).bind(kind, title, body, requestedId, userId).run();
      }
      const row = await loadNote(env, requestedId, userId);
      return row ? json({ ok: true, data: { note: toNote(row) } }) : notFound();
    }
  }

  const id = requestedId ?? crypto.randomUUID();
  let result: D1Result;
  try {
    // The limit check and insert are one statement, so concurrent creates cannot overshoot it.
    result = await env.DB.prepare(`INSERT INTO personal_notes(id,team_id,user_id,kind,title,body)
      SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM personal_notes WHERE user_id=? AND team_id=?) < ?`)
      .bind(id, teamId, userId, kind, title, body, userId, teamId, MAX_NOTES_PER_USER_TEAM).run();
  } catch (error) {
    if (!String(error).includes("UNIQUE constraint failed")) throw error;
    // Either a concurrent retry of our own create won the race, or the id belongs to someone else.
    const mine = await loadNote(env, id, userId);
    return mine && mine.team_id === teamId ? json({ ok: true, data: { note: toNote(mine) } }) : json({ ok: false, error: "conflict" }, 409);
  }
  if (!result.meta.changes) return json({ ok: false, error: "Note limit reached." }, 409);
  const row = await loadNote(env, id, userId);
  return row ? json({ ok: true, data: { note: toNote(row) } }, 201) : notFound();
}

async function patchNote(request: Request, env: Env, userId: string, id: string): Promise<Response> {
  if (!await loadNote(env, id, userId)) return notFound();
  const input = await readJson(request);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (input.title !== undefined) { sets.push("title=?"); binds.push(titleOf(input.title)); }
  if (input.body !== undefined) { sets.push("body=?"); binds.push(bodyOf(input.body)); }
  if (input.kind !== undefined) { sets.push("kind=?"); binds.push(kindOf(input.kind)); }
  if (input.pinned !== undefined) { sets.push("pinned=?"); binds.push(flagOf(input.pinned, "pinned") ? 1 : 0); }
  if (input.archived !== undefined) {
    sets.push(flagOf(input.archived, "archived") ? "archived_at=COALESCE(archived_at,datetime('now'))" : "archived_at=NULL");
  }
  if (!sets.length) throw new NoteInputError("Provide at least one of title, body, kind, pinned, or archived.");
  const result = await env.DB.prepare(`UPDATE personal_notes SET ${sets.join(",")},updated_at=datetime('now')
    WHERE id=? AND user_id=? AND ${STILL_MEMBER}`).bind(...binds, id, userId).run();
  if (!result.meta.changes) return notFound();
  const row = await loadNote(env, id, userId);
  return row ? json({ ok: true, data: { note: toNote(row) } }) : notFound();
}

async function deleteNote(env: Env, userId: string, id: string): Promise<Response> {
  const result = await env.DB.prepare(`DELETE FROM personal_notes WHERE id=? AND user_id=? AND ${STILL_MEMBER}`)
    .bind(id, userId).run();
  return result.meta.changes ? json({ ok: true, data: { id } }) : notFound();
}

export async function handleNotes(request: Request, env: Env): Promise<Response> {
  // Session-only: pastes can hold secrets, so a bot or leaked API key must never read them.
  const userId = await resolveSessionUserId(request, env);
  if (!userId) return unauthorized();
  const path = new URL(request.url).pathname;
  const method = request.method;
  if (method !== "GET" && !mutationOriginAllowed(request, env)) return json({ ok: false, error: "invalid origin" }, 403);
  try {
    if (path === "/api/notes") {
      if (method === "GET") return await listNotes(request, env, userId);
      if (method === "POST") return await createNote(request, env, userId);
      return notFound();
    }
    const match = path.match(/^\/api\/notes\/([a-f0-9-]{36})$/);
    if (!match) return notFound();
    const id = match[1];
    if (method === "GET") {
      const row = await loadNote(env, id, userId);
      return row ? json({ ok: true, data: { note: toNote(row) } }) : notFound();
    }
    if (method === "PATCH") return await patchNote(request, env, userId, id);
    if (method === "DELETE") return await deleteNote(env, userId, id);
    return notFound();
  } catch (error) {
    if (error instanceof NoteInputError) return json({ ok: false, error: error.message }, 400);
    throw error;
  }
}
