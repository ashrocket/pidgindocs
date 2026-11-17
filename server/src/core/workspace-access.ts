import { restrictedContentTeams } from "./content-policy";
import { assertTenantWritable, editionAccessError, editionProductName, editionPublicSite } from "./edition-hooks";
import type { Env, WorkspaceResourceType } from "./types";
import { contentAccessSql, messageReadSql, artifactReadSql } from "./document-rbac";
export { messageReadSql, artifactReadSql, messageEditSql, artifactEditSql } from "./document-rbac";

export class WorkspaceAccessError extends Error {}

export type Sharing = "private" | "shared";

/** A row the read check can judge. `sharing` is required so every SELECT that
 * feeds the check has to fetch it; a missing value means private. Message rows
 * also pass `type`: only documents are private by default, while posts,
 * questions and statuses are always team-wide. */
export interface ReadableResource {
  id: string;
  user_id: string | null;
  team_id?: string | null;
  sharing: string | null | undefined;
  type?: string | null;
  doc_slug?: string | null;
}

export function parseSharing(value: unknown): Sharing | undefined {
  return value === "private" || value === "shared" ? value : undefined;
}

/** Whether a team-scoped row is readable by every member, not just its owner. */
export function isSharedWithTeam(resource: Pick<ReadableResource, "sharing" | "type">): boolean {
  return resource.sharing === "shared" || (typeof resource.type === "string" && resource.type !== "document");
}

/** Unscoped resources remain private. A team is an ACL, not a display label:
 * private team items are readable by their owner, shared ones by every member.
 * Membership is checked live, including for the original author after removal. */
export async function canReadResource(
  env: Env, userId: string | null, resource: ReadableResource
): Promise<boolean> {
  if (!userId) return false;
  // Read the canonical row for both personal and team parents: a personal
  // message can contain an older team artifact snapshot whose source access
  // was later revoked. Caller-supplied metadata cannot bypass that boundary.
  if (!resource.id) return false;
  const rows = (await env.DB.prepare(`SELECT id, ${messageReadSql("messages")} AS allowed FROM messages WHERE id=? AND team_id IS ?
    UNION ALL SELECT id, ${artifactReadSql("artifacts")} AS allowed FROM artifacts WHERE id=? AND team_id IS ?`)
    .bind(userId, userId, resource.id, resource.team_id ?? null, userId, userId, resource.id, resource.team_id ?? null).all<{id:string;allowed:number}>()).results;
  return rows.length === 1 && rows[0].allowed === 1;
}

/** New governed content is a private draft until an administrator assigns its
 * roles. The migration also fences inserts to close activation/publish races. */
export async function assertGovernedDraft(env: Env, teamId: string | null | undefined, sharing: Sharing): Promise<void> {
  if (teamId && sharing === "shared" && await restrictedContentTeams(env, teamId)) {
    throw new WorkspaceAccessError("Use Access controls to share governed documents.");
  }
}

export async function assertWorkspacePublishScope(
  env: Env, userId: string | null | undefined, teamId?: string | null, projectId?: string | null
): Promise<void> {
  if (editionPublicSite(env) && !teamId) {
    throw new WorkspaceAccessError(`Choose a team before creating content in ${editionProductName()}.`);
  }
  // Before the unscoped early return: private content is product content too. The ACL checks below still run.
  await assertTenantWritable(env);
  if (!teamId && !projectId) return;
  if (!userId || !teamId) throw new WorkspaceAccessError("team_id is required for a channel");
  const membership = await env.DB.prepare(
    "SELECT role FROM team_memberships WHERE team_id = ? AND user_id = ?"
  ).bind(teamId, userId).first<{ role: string }>();
  if (!membership || !["owner", "admin", "member"].includes(membership.role)) {
    throw new WorkspaceAccessError("team publishing requires membership with write access");
  }
  const denied = await editionAccessError(env, { teamId });
  if (denied) throw new WorkspaceAccessError(denied);
  // Work boards hold agent board posts only, so they can be deleted after archiving.
  if (projectId && !await env.DB.prepare(
    "SELECT id FROM projects WHERE id = ? AND team_id = ? AND archived_at IS NULL AND board_kind <> 'work'"
  ).bind(projectId, teamId).first()) {
    const work = await env.DB.prepare("SELECT 1 AS work FROM projects WHERE id = ? AND board_kind = 'work'").bind(projectId).first();
    throw new WorkspaceAccessError(work
      ? "work boards hold agent board posts only; publish to its parent project"
      : "project is archived or does not belong to this team");
  }
}

/** The team an item is shared into: the one given, otherwise the caller's only
 * team. Personal (teamless) items cannot be shared without one. */
export async function resolveSharingTeam(env: Env, userId: string, teamId?: string | null): Promise<string> {
  if (teamId) return teamId;
  const rows = (await env.DB.prepare(
    "SELECT team_id FROM team_memberships WHERE user_id = ? AND role IN ('owner', 'admin', 'member') LIMIT 2"
  ).bind(userId).all<{ team_id: string }>()).results ?? [];
  if (rows.length === 1) return rows[0].team_id;
  throw new WorkspaceAccessError(rows.length
    ? "Choose the team to share with (team_id)."
    : "Sharing needs a team, and you are not a member of one.");
}

export async function canEditResource(env: Env, userId: string, resource: ReadableResource,
  kind: "document" | "artifact" = "document"): Promise<boolean> {
  const table = kind === "document" ? "messages" : "artifacts";
  return !!await env.DB.prepare(`SELECT id FROM ${table} WHERE id=? AND ${contentAccessSql(table, kind, "edit")}`)
    .bind(resource.id, userId, userId).first();
}

export async function getWorkspaceResource(
  env: Env, resourceType: WorkspaceResourceType, resourceId: string
): Promise<{ id: string; user_id: string | null; team_id: string | null; project_id: string | null; sharing: string; type: string | null; doc_slug: string | null } | null> {
  const table = resourceType === "artifact" ? "artifacts" : "messages";
  const typeClause = resourceType === "document" || resourceType === "decision_memo"
    ? " AND type = 'document'" : resourceType === "message" ? " AND type != 'document'" : "";
  const columns = table === "artifacts" ? "NULL AS type, NULL AS doc_slug" : "type, doc_slug";
  return env.DB.prepare(`SELECT id, user_id, team_id, project_id, sharing, ${columns} FROM ${table} WHERE id = ?${typeClause}`)
    .bind(resourceId).first();
}

export async function loadTeamMessageForState(env: Env, userId: string, messageId: string) {
  const row = await env.DB.prepare("SELECT id, user_id, team_id, sharing, type FROM messages WHERE id = ?")
    .bind(messageId).first<{ id: string; user_id: string | null; team_id: string | null; sharing: string; type: string }>();
  if (!row) return null;
  if (!await canReadResource(env, userId, row)) return false;
  return row.team_id ? row : null;
}

export async function setTeamMessageState(env: Env, userId: string, messageId: string,
  state: { read?: boolean; archived?: boolean; dismissAction?: string | null; pinned?: boolean }
): Promise<void> {
  const columns: string[] = [], values: (string | number | null)[] = [];
  if (state.read !== undefined) { columns.push("read", "read_at"); values.push(state.read ? 1 : 0, state.read ? new Date().toISOString() : null); }
  if (state.archived !== undefined) { columns.push("archived_at", "dismiss_action"); values.push(state.archived ? new Date().toISOString() : null, state.archived ? state.dismissAction || "archive" : null); }
  if (state.pinned !== undefined) { columns.push("pinned"); values.push(state.pinned ? 1 : 0); }
  await env.DB.prepare(`INSERT INTO message_user_state (message_id, user_id, ${columns.join(", ")})
    VALUES (?, ?, ${columns.map(() => "?").join(", ")})
    ON CONFLICT(message_id, user_id) DO UPDATE SET ${columns.map(c => `${c}=excluded.${c}`).join(", ")}`)
    .bind(messageId, userId, ...values).run();
}

export async function applyTeamMessageState(env: Env, userId: string, row: Record<string, unknown>) {
  if (!row.team_id) return row;
  const state = await env.DB.prepare("SELECT read, read_at, archived_at, dismiss_action, pinned FROM message_user_state WHERE message_id = ? AND user_id = ?")
    .bind(String(row.id), userId).first();
  return { ...row, read: 0, read_at: null, archived_at: null, dismiss_action: null, pinned: 0, expires_at: null, ...state };
}
