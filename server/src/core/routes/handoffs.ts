import { editionAccessError } from "../edition-hooks";
import { resolveSessionUserId, unauthorized } from "../middleware";
import { getWorkspaceMembership } from "../workspace";
import type { ApiResponse, Env } from "../types";
import { json } from "../utils";

// Apply exactly the same visibility rule to the count, page and state writes.
// Modes change presentation; membership remains the authorization boundary.
const VISIBLE = `e.kind = 'h' AND NOT EXISTS (SELECT 1 FROM agent_board_moderation m WHERE m.entry_id = e.id)
  AND EXISTS (SELECT 1 FROM team_memberships tm WHERE tm.team_id = e.team_id AND tm.user_id = ?)`;

function response(data: ApiResponse, status = 200): Response {
  const result = json(data, status);
  result.headers.set("Cache-Control", "private, no-store");
  return result;
}

export async function handleListHandoffs(request: Request, env: Env): Promise<Response> {
  const userId = await resolveSessionUserId(request, env);
  if (!userId) return unauthorized();
  const params = new URL(request.url).searchParams;
  const teamId = params.get("team_id");
  if (!teamId) return response({ ok: false, error: "team_id is required" }, 400);
  if (!await getWorkspaceMembership(env, teamId, userId) || await editionAccessError(env, { teamId })) {
    return response({ ok: false, error: "not found" }, 404);
  }
  const filters = ["project_id", "owner_id", "agent_id"].map(key => params.get(key) || "");
  const [projectId, ownerId, agentId] = filters;
  const provider = params.has("provider") ? params.get("provider")! : null;
  const query = (params.get("q") || "").trim();
  const folder = params.get("folder") || "handoffs";
  if (filters.some(value => value && !/^[A-Za-z0-9_-]{1,80}$/.test(value)) ||
    (provider !== null && provider.length > 80) || query.length > 200 || !["handoffs", "archive"].includes(folder)) {
    return response({ ok: false, error: "invalid handoff filters" }, 400);
  }
  const before = params.has("before") ? Number(params.get("before")) : null;
  if (before !== null && (!Number.isSafeInteger(before) || before < 1)) {
    return response({ ok: false, error: "invalid cursor" }, 400);
  }
  // Historic sponsorship belongs to the post, with the known identity creator
  // only as the fallback for old rows. Revocation does not erase past work.
  const sponsorId = "COALESCE(e.user_id, a.created_by_user_id)";
  const sponsorName = `COALESCE((SELECT display_name FROM entra_identities WHERE user_id = u.id LIMIT 1),
    (SELECT display_name FROM google_identities WHERE user_id = u.id), u.email)`;
  const from = `agent_board_entries e
    JOIN projects p ON p.id = e.project_id AND p.team_id = e.team_id
    LEFT JOIN projects parent ON parent.id = p.parent_project_id AND parent.team_id = e.team_id
    JOIN agent_identities a ON a.id = e.agent_id AND a.team_id = e.team_id
    JOIN users u ON u.id = ${sponsorId}
    LEFT JOIN handoff_reads r ON r.entry_id = e.id AND r.user_id = ?
    LEFT JOIN handoff_archives ar ON ar.entry_id = e.id AND ar.user_id = ?`;
  const visibleScope = `e.team_id = ? AND ${VISIBLE}`;
  const conditions = [visibleScope];
  const binds: (string | number)[] = [userId, userId, teamId, userId];
  conditions.push(folder === "archive" ? "ar.entry_id IS NOT NULL" : "ar.entry_id IS NULL");
  // A project's handoffs include its work boards, including historical boards.
  if (projectId) { conditions.push("(e.project_id = ? OR p.parent_project_id = ?)"); binds.push(projectId, projectId); }
  if (ownerId) { conditions.push(`${sponsorId} = ?`); binds.push(ownerId); }
  if (agentId) { conditions.push("e.agent_id = ?"); binds.push(agentId); }
  if (provider !== null) { conditions.push("COALESCE(a.provider, '') = ?"); binds.push(provider); }
  if (query) {
    // Literal substring matching: % and _ never become SQL wildcards.
    conditions.push(`instr(lower(e.topic || char(10) || e.body || char(10) || COALESCE(e.reference, '') ||
      char(10) || p.name || char(10) || COALESCE(parent.name, '') || char(10) || a.name || char(10) || COALESCE(a.provider, '') ||
      char(10) || ${sponsorName} || char(10) || COALESCE(e.session_name, '') || char(10) || COALESCE(e.origin, '')), lower(?)) > 0`);
    binds.push(query);
  }
  const scope = conditions.join(" AND ");
  const statsQuery = env.DB.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN r.entry_id IS NULL THEN 1 ELSE 0 END), 0) AS unread
    FROM ${from} WHERE ${scope}`).bind(...binds);
  if (params.get("summary") === "1") {
    const stats = await statsQuery.first<{ total: number; unread: number }>();
    return response({ ok: true, data: stats });
  }
  const pageQuery = env.DB.prepare(`SELECT e.id, e.seq, e.project_id, p.name AS project_name, p.parent_project_id, parent.name AS parent_project_name,
    e.agent_id, a.name AS agent_name, a.provider AS agent_provider, ${sponsorId} AS sponsor_id,
    ${sponsorName} AS sponsor_name, e.topic, e.body, e.reference, e.created_at, e.session_name, e.model, e.origin,
    r.read_at, ar.archived_at FROM ${from} WHERE ${scope}${before !== null ? " AND e.seq < ?" : ""}
    ORDER BY e.seq DESC LIMIT 51`).bind(...binds, ...(before !== null ? [before] : []));
  const statements = [statsQuery, pageQuery];
  if (params.get("include_filters") === "1") {
    // Choices cover the whole visible workspace, independent of selected
    // filters/cursor. Moderated-only identities/sponsors never enter them.
    const visibleBinds = [userId, userId, teamId, userId];
    statements.push(
      env.DB.prepare(`SELECT id, team_id, slug, name, description, board_kind, pinned, archived_at, created_by_user_id, created_at, updated_at
        FROM projects WHERE team_id = ? AND board_kind <> 'work'
        AND EXISTS (SELECT 1 FROM team_memberships tm WHERE tm.team_id = projects.team_id AND tm.user_id = ?)
        ORDER BY archived_at IS NOT NULL, name COLLATE NOCASE, id`).bind(teamId, userId),
      env.DB.prepare(`SELECT DISTINCT ${sponsorId} AS id, ${sponsorName} AS name
        FROM ${from} WHERE ${visibleScope} ORDER BY name COLLATE NOCASE, id`).bind(...visibleBinds),
      env.DB.prepare(`SELECT DISTINCT a.id, a.name, COALESCE(a.provider, '') AS provider
        FROM ${from} WHERE ${visibleScope} ORDER BY a.name COLLATE NOCASE, a.id`).bind(...visibleBinds),
    );
  }
  // Transactional batch reads give page, full-set counts and choices the same
  // visibility snapshot. The cursor affects only the page, never the counts.
  const results = await env.DB.batch(statements);
  const stats = results[0].results[0] as unknown as { total: number; unread: number };
  const rows = results[1].results as unknown as { seq: number; read_at: string | null; archived_at: string | null }[];
  const entries = rows.slice(0, 50).map(row => ({ ...row, read: row.read_at !== null, archived: row.archived_at !== null }));
  const agents = results[4]?.results as { id: string; name: string; provider: string }[] | undefined;
  const choices = agents ? {
    projects: results[2].results,
    owners: results[3].results,
    agents,
    providers: [...new Set(agents.map(agent => agent.provider))].sort(),
  } : undefined;
  return response({ ok: true, data: { ...stats, entries,
    next_cursor: rows.length > 50 ? entries.at(-1)?.seq : null,
    ...(choices ? { filters: choices } : {}),
  } });
}

export async function handleSetHandoffRead(request: Request, env: Env, entryId: string): Promise<Response> {
  const userId = await resolveSessionUserId(request, env);
  if (!userId) return unauthorized();
  // Cookie-authenticated browser mutations require same-origin intent. Native
  // clients send an explicit Session header and do not have an Origin header.
  const origin = request.headers.get("Origin");
  if ((origin && origin !== new URL(request.url).origin) || (!origin && !request.headers.get("Authorization")?.startsWith("Session "))) {
    return response({ ok: false, error: "same-origin request required" }, 403);
  }
  let input: unknown;
  try { input = await request.json(); } catch { return response({ ok: false, error: "invalid JSON body" }, 400); }
  if (!input || typeof input !== "object" || !("read" in input) || typeof input.read !== "boolean") {
    return response({ ok: false, error: "read must be a boolean" }, 400);
  }
  const entry = await env.DB.prepare(`SELECT e.team_id FROM agent_board_entries e WHERE e.id = ? AND ${VISIBLE}`)
    .bind(entryId, userId).first<{ team_id: string }>();
  if (!entry || await editionAccessError(env, { teamId: entry.team_id })) return response({ ok: false, error: "not found" }, 404);
  if (input.read) {
    await env.DB.prepare(`INSERT INTO handoff_reads(entry_id, user_id)
      SELECT e.id, ? FROM agent_board_entries e WHERE e.id = ? AND ${VISIBLE}
      ON CONFLICT(entry_id, user_id) DO NOTHING`).bind(userId, entryId, userId).run();
  } else {
    await env.DB.prepare(`DELETE FROM handoff_reads WHERE entry_id = ? AND user_id = ?
      AND EXISTS (SELECT 1 FROM agent_board_entries e WHERE e.id = handoff_reads.entry_id AND ${VISIBLE})`)
      .bind(entryId, userId, userId).run();
  }
  return response({ ok: true, data: { id: entryId, read: input.read } });
}

export async function handleSetHandoffArchive(request: Request, env: Env, entryId: string): Promise<Response> {
  const userId = await resolveSessionUserId(request, env);
  if (!userId) return unauthorized();
  const origin = request.headers.get("Origin");
  if ((origin && origin !== new URL(request.url).origin) || (!origin && !request.headers.get("Authorization")?.startsWith("Session "))) {
    return response({ ok: false, error: "same-origin request required" }, 403);
  }
  let input: unknown;
  try { input = await request.json(); } catch { return response({ ok: false, error: "invalid JSON body" }, 400); }
  if (!input || typeof input !== "object" || !("archived" in input) || typeof input.archived !== "boolean") {
    return response({ ok: false, error: "archived must be a boolean" }, 400);
  }
  const entry = await env.DB.prepare(`SELECT e.team_id FROM agent_board_entries e WHERE e.id = ? AND ${VISIBLE}`)
    .bind(entryId, userId).first<{ team_id: string }>();
  if (!entry || await editionAccessError(env, { teamId: entry.team_id })) return response({ ok: false, error: "not found" }, 404);
  if (input.archived) {
    await env.DB.prepare(`INSERT INTO handoff_archives(entry_id, user_id)
      SELECT e.id, ? FROM agent_board_entries e WHERE e.id = ? AND ${VISIBLE}
      ON CONFLICT(entry_id, user_id) DO NOTHING`).bind(userId, entryId, userId).run();
  } else {
    await env.DB.prepare(`DELETE FROM handoff_archives WHERE entry_id = ? AND user_id = ?
      AND EXISTS (SELECT 1 FROM agent_board_entries e WHERE e.id = handoff_archives.entry_id AND ${VISIBLE})`)
      .bind(entryId, userId, userId).run();
  }
  return response({ ok: true, data: { id: entryId, archived: input.archived } });
}
