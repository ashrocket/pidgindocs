import { sha256Hex } from "./auth-utils";
import { canAdminWorkspace, canReadWorkspace, getProjectById, getWorkspaceMembership } from "./workspace";
import type {
  AgentBoardEntry,
  AgentBoardKind,
  AgentBoardPrincipal,
  AgentIdentity,
  AgentProjectGrant,
  AgentProjectPermission,
  AgentSessionMetadata,
  Env,
} from "./types";

export const AGENT_BOARD_PROTOCOL = "pb1";
export const AGENT_BOARD_MEDIA_TYPE = "application/vnd.pidgin.board+json; charset=utf-8";
export const AGENT_BOARD_KINDS: AgentBoardKind[] = ["s", "c", "h", "d", "b", "n"];
export const AGENT_BOARD_LIMITS = {
  topic: 80,
  body: 1200,
  reference: 240,
  page: 100,
} as const;

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/;

export class AgentBoardInputError extends Error {}
export class AgentBoardConflictError extends Error {}

export interface AgentIdentityWithGrants extends AgentIdentity {
  grants: Array<AgentProjectGrant & { project_slug: string; project_name: string }>;
}

export interface CreateAgentIdentityResult {
  agent: AgentIdentity;
  grants: AgentProjectGrant[];
  key: string;
  key_prefix: string;
}

export interface AgentBoardPage {
  entries: AgentBoardEntry[];
  nextCursor: number;
}

export interface AgentBoardPost {
  kind: AgentBoardKind;
  topic: string;
  body: string;
  reference: string | null;
  session: AgentSessionMetadata | null;
}

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/['"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-") || "agent"
  );
}

function randomHex(bytesLength: number): string {
  const bytes = new Uint8Array(bytesLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function generateAgentBoardKey(): string {
  return `pidgin_abk_${randomHex(32)}`;
}

function cleanField(value: unknown, name: string, maxLength: number, singleLine = false): string {
  if (typeof value !== "string") throw new AgentBoardInputError(`${name} must be a string`);
  const cleaned = value.replace(/\r\n?/g, "\n").trim();
  if (!cleaned) throw new AgentBoardInputError(`${name} is required`);
  if (cleaned.length > maxLength) {
    throw new AgentBoardInputError(`${name} exceeds ${maxLength} characters`);
  }
  if (CONTROL_CHARS.test(cleaned)) throw new AgentBoardInputError(`${name} contains control characters`);
  if (singleLine && cleaned.includes("\n")) throw new AgentBoardInputError(`${name} must be one line`);
  return cleaned;
}

export function parseAgentBoardPost(value: unknown): AgentBoardPost {
  if (!Array.isArray(value) || value.length < 3 || value.length > 5) {
    throw new AgentBoardInputError("board post must be [kind,topic,body,reference?,session?]");
  }
  const kind = value[0];
  if (typeof kind !== "string" || !AGENT_BOARD_KINDS.includes(kind as AgentBoardKind)) {
    throw new AgentBoardInputError("kind must be one of s,c,h,d,b,n");
  }
  const referenceValue = value[3];
  const reference =
    referenceValue === undefined || referenceValue === null || referenceValue === 0 || referenceValue === ""
      ? null
      : cleanField(referenceValue, "reference", AGENT_BOARD_LIMITS.reference, true);
  return {
    kind: kind as AgentBoardKind,
    topic: cleanField(value[1], "topic", AGENT_BOARD_LIMITS.topic, true),
    body: cleanField(value[2], "body", AGENT_BOARD_LIMITS.body),
    reference,
    session: parseAgentSessionMetadata(value[4]),
  };
}

export function parseAgentSessionMetadata(value: unknown): AgentSessionMetadata | null {
  if (value === undefined || value === null || value === 0) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AgentBoardInputError("session must be an object");
  }
  const fields = { session_id: 160, session_name: 160, model: 100, model_version: 100, origin: 80, origin_version: 100 };
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(fields, key)) throw new AgentBoardInputError(`unknown session field: ${key}`);
  }
  const result: Record<string, string | null> = {};
  for (const [key, limit] of Object.entries(fields)) {
    const field = input[key];
    result[key] = (field === undefined || field === null || field === "") && key !== "session_id" && key !== "origin"
      ? null : cleanField(field, key, limit, true);
    if (result[key] && /[\t\n\r]/.test(result[key]!)) {
      throw new AgentBoardInputError(`${key} must be one line without tabs`);
    }
  }
  return result as unknown as AgentSessionMetadata;
}

// The client may describe its runtime, but may never choose the human account.
// Requiring the key creator's current membership also closes access when that
// human leaves the team. This does not imply that they authored the agent text.
export async function resolveAgentCredential(headers: Headers, env: Env): Promise<{ agentId: string } | null> {
  const token = getAgentToken(headers);
  if (!token) return null;
  return env.DB.prepare(`SELECT a.id AS agentId FROM agent_keys k
    JOIN agent_identities a ON a.id = k.agent_id
    JOIN team_memberships u ON u.team_id = a.team_id AND u.user_id = k.created_by_user_id
    JOIN users owner ON owner.id = k.created_by_user_id AND owner.status = 'active'
    WHERE k.key_hash = ? AND k.revoked_at IS NULL AND a.status = 'active'`)
    .bind(await sha256Hex(token)).first<{ agentId: string }>();
}

export function validateIdempotencyKey(value: string | null): string {
  if (!value || !IDEMPOTENCY_KEY.test(value)) {
    throw new AgentBoardInputError(
      "Idempotency-Key must be 8-80 characters using letters, numbers, dot, underscore, colon, or hyphen"
    );
  }
  return value;
}

async function getAgentIdentity(env: Env, agentId: string): Promise<AgentIdentity | null> {
  return await env.DB.prepare(
    `SELECT id, team_id, slug, name, provider, status, created_by_user_id,
            created_at, updated_at, revoked_at
     FROM agent_identities WHERE id = ?`
  )
    .bind(agentId)
    .first<AgentIdentity>();
}

function auditStatement(
  env: Env,
  action: string,
  instanceId: string | null,
  details: Record<string, unknown>,
  userId: string | null
): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO audit_log (action, instance_id, details, user_id) VALUES (?, ?, ?, ?)"
  )
    .bind(action, instanceId, JSON.stringify(details), userId);
}

export async function createAgentIdentity(
  env: Env,
  input: {
    userId: string;
    teamId: string;
    name: string;
    slug?: string;
    provider?: string | null;
    grants: Array<{ projectId: string; permission: AgentProjectPermission }>;
  }
): Promise<CreateAgentIdentityResult | null> {
  const membership = await getWorkspaceMembership(env, input.teamId, input.userId);
  if (!canAdminWorkspace(membership?.role ?? null)) return null;

  const name = cleanField(input.name, "name", 100, true);
  const provider = input.provider ? cleanField(input.provider, "provider", 80, true) : null;
  const grantMap = new Map<string, AgentProjectPermission>();
  for (const grant of input.grants) {
    if (grant.permission !== "read" && grant.permission !== "write") {
      throw new AgentBoardInputError("grant permission must be read or write");
    }
    grantMap.set(grant.projectId, grant.permission);
  }
  if (grantMap.size === 0) throw new AgentBoardInputError("at least one project grant is required");
  if (grantMap.size > 20) throw new AgentBoardInputError("an agent may have at most 20 project grants");

  for (const projectId of grantMap.keys()) {
    const project = await getProjectById(env, projectId);
    if (!project || project.team_id !== input.teamId) {
      throw new AgentBoardInputError("every granted project must belong to the selected team");
    }
  }

  const agentId = crypto.randomUUID().replace(/-/g, "");
  const key = generateAgentBoardKey();
  const keyHash = await sha256Hex(key);
  const keyPrefix = key.slice(0, 20);
  const slugSource = input.slug ? cleanField(input.slug, "slug", 80, true) : name;
  const slug = slugify(slugSource).slice(0, 64);
  const statements = [
    env.DB.prepare(
      `INSERT INTO agent_identities (id, team_id, slug, name, provider, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(agentId, input.teamId, slug, name, provider, input.userId),
    ...[...grantMap].map(([projectId, permission]) =>
      env.DB.prepare(
        `INSERT INTO agent_project_grants (agent_id, project_id, permission, created_by_user_id)
         VALUES (?, ?, ?, ?)`
      ).bind(agentId, projectId, permission, input.userId)
    ),
    env.DB.prepare(
      `INSERT INTO agent_keys (key_hash, key_prefix, agent_id, created_by_user_id)
       VALUES (?, ?, ?, ?)`
    ).bind(keyHash, keyPrefix, agentId, input.userId),
    auditStatement(
      env,
      "agent_board.agent_created",
      agentId,
      { team_id: input.teamId, slug, project_ids: [...grantMap.keys()] },
      input.userId
    ),
  ];
  await env.DB.batch(statements);

  const agent = await getAgentIdentity(env, agentId);
  if (!agent) throw new Error("created agent identity could not be loaded");
  const grants = [...grantMap].map(([projectId, permission]) => ({
    agent_id: agentId,
    project_id: projectId,
    permission,
    created_by_user_id: input.userId,
    created_at: agent.created_at,
  }));
  return { agent, grants, key, key_prefix: keyPrefix };
}

export async function listAgentIdentities(
  env: Env,
  input: { userId: string; teamId: string }
): Promise<AgentIdentityWithGrants[] | null> {
  const membership = await getWorkspaceMembership(env, input.teamId, input.userId);
  if (!canAdminWorkspace(membership?.role ?? null)) return null;
  const { results: agents } = await env.DB.prepare(
    `SELECT id, team_id, slug, name, provider, status, created_by_user_id,
            created_at, updated_at, revoked_at
     FROM agent_identities WHERE team_id = ? ORDER BY created_at DESC, slug ASC`
  )
    .bind(input.teamId)
    .all<AgentIdentity>();
  const { results: grants } = await env.DB.prepare(
    `SELECT g.agent_id, g.project_id, g.permission, g.created_by_user_id, g.created_at,
            p.slug AS project_slug, p.name AS project_name
     FROM agent_project_grants g
     JOIN projects p ON p.id = g.project_id
     JOIN agent_identities a ON a.id = g.agent_id
     WHERE a.team_id = ?
     ORDER BY p.name ASC`
  )
    .bind(input.teamId)
    .all<AgentProjectGrant & { project_slug: string; project_name: string }>();
  return (agents ?? []).map((agent) => ({
    ...agent,
    grants: (grants ?? []).filter((grant) => grant.agent_id === agent.id),
  }));
}

export async function revokeAgentIdentity(
  env: Env,
  input: { userId: string; agentId: string }
): Promise<boolean | null> {
  const agent = await getAgentIdentity(env, input.agentId);
  if (!agent) return false;
  const membership = await getWorkspaceMembership(env, agent.team_id, input.userId);
  if (!canAdminWorkspace(membership?.role ?? null)) return null;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE agent_identities
       SET status = 'revoked', revoked_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND status = 'active'`
    ).bind(input.agentId),
    env.DB.prepare(
      "UPDATE agent_keys SET revoked_at = datetime('now') WHERE agent_id = ? AND revoked_at IS NULL"
    ).bind(input.agentId),
    auditStatement(
      env,
      "agent_board.agent_revoked",
      input.agentId,
      { team_id: agent.team_id, slug: agent.slug },
      input.userId
    ),
  ]);
  return true;
}

function getAgentToken(headers: Headers): string | null {
  const auth = headers.get("Authorization");
  if (!auth) return null;
  const match = auth.match(/^Agent (pidgin_abk_[a-f0-9]{64})$/);
  return match?.[1] ?? null;
}

export async function resolveAgentBoardPrincipal(
  headers: Headers,
  env: Env,
  projectId: string
): Promise<AgentBoardPrincipal | null> {
  const token = getAgentToken(headers);
  if (!token) return null;
  const keyHash = await sha256Hex(token);
  const principal = await env.DB.prepare(
    `SELECT a.id AS agent_id, a.team_id, a.slug, a.name, g.project_id, g.permission, k.key_hash,
            k.created_by_user_id AS user_id
     FROM agent_keys k
     JOIN agent_identities a ON a.id = k.agent_id
     JOIN agent_project_grants g ON g.agent_id = a.id
     JOIN projects p ON p.id = g.project_id AND p.team_id = a.team_id
     JOIN team_memberships u ON u.team_id = a.team_id AND u.user_id = k.created_by_user_id
     JOIN users owner ON owner.id = k.created_by_user_id AND owner.status = 'active'
     WHERE k.key_hash = ? AND k.revoked_at IS NULL AND a.status = 'active' AND g.project_id = ?`
  )
    .bind(keyHash, projectId)
    .first<{
      agent_id: string;
      team_id: string;
      slug: string;
      name: string;
      project_id: string;
      permission: AgentProjectPermission;
      key_hash: string;
      user_id: string;
    }>();
  if (!principal) return null;
  env.DB.prepare("UPDATE agent_keys SET last_used_at = datetime('now') WHERE key_hash = ?")
    .bind(keyHash)
    .run()
    .catch(() => {});
  env.DB.prepare("UPDATE agent_identities SET updated_at = datetime('now') WHERE id = ?")
    .bind(principal.agent_id)
    .run()
    .catch(() => {});
  return {
    agentId: principal.agent_id,
    teamId: principal.team_id,
    slug: principal.slug,
    name: principal.name,
    projectId: principal.project_id,
    permission: principal.permission,
    keyHash: principal.key_hash,
    userId: principal.user_id,
  };
}

const BOARD_ENTRY_SELECT = `SELECT e.seq, e.id, e.team_id, e.project_id,
       p.slug AS project_slug, p.name AS project_name,
       e.agent_id, a.slug AS agent_slug, a.name AS agent_name,
       e.kind, e.topic, e.body, e.reference, e.client_message_id, e.created_at,
       e.user_id, e.session_id, e.session_name, e.model, e.model_version, e.origin, e.origin_version
  FROM agent_board_entries e
  JOIN agent_identities a ON a.id = e.agent_id
  JOIN projects p ON p.id = e.project_id
  LEFT JOIN agent_board_moderation m ON m.entry_id = e.id`;

export async function listAgentBoardEntries(
  env: Env,
  input: { projectId: string; after?: number; limit?: number }
): Promise<AgentBoardPage> {
  const after = Math.max(0, Math.floor(input.after ?? 0));
  const limit = Math.max(1, Math.min(AGENT_BOARD_LIMITS.page, Math.floor(input.limit ?? 40)));
  const { results } = await env.DB.prepare(
    `${BOARD_ENTRY_SELECT}
     WHERE e.project_id = ? AND e.seq > ? AND m.entry_id IS NULL
     ORDER BY e.seq ASC LIMIT ?`
  )
    .bind(input.projectId, after, limit)
    .all<AgentBoardEntry>();
  const entries = results ?? [];
  return { entries, nextCursor: entries.at(-1)?.seq ?? after };
}

export async function listTeamAgentBoardEntries(
  env: Env,
  input: { userId: string; teamId: string; limit?: number }
): Promise<AgentBoardEntry[]> {
  const membership = await getWorkspaceMembership(env, input.teamId, input.userId);
  if (!canReadWorkspace(membership?.role ?? null)) return [];
  const limit = Math.max(1, Math.min(AGENT_BOARD_LIMITS.page, Math.floor(input.limit ?? 20)));
  const { results } = await env.DB.prepare(
    `${BOARD_ENTRY_SELECT}
     WHERE e.team_id = ? AND m.entry_id IS NULL
     ORDER BY e.seq DESC LIMIT ?`
  )
    .bind(input.teamId, limit)
    .all<AgentBoardEntry>();
  return results ?? [];
}

export async function userCanReadAgentBoard(
  env: Env,
  input: { userId: string; projectId: string }
): Promise<boolean> {
  const project = await getProjectById(env, input.projectId);
  if (!project) return false;
  const membership = await getWorkspaceMembership(env, project.team_id, input.userId);
  return canReadWorkspace(membership?.role ?? null);
}

export async function createAgentBoardEntry(
  env: Env,
  input: {
    principal: AgentBoardPrincipal;
    post: AgentBoardPost;
    clientMessageId: string;
  }
): Promise<{ entry: AgentBoardEntry; duplicate: boolean }> {
  if (input.principal.permission !== "write") {
    throw new AgentBoardInputError("agent does not have write permission for this project");
  }
  const existing = await env.DB.prepare(
    `${BOARD_ENTRY_SELECT}
     WHERE e.agent_id = ? AND e.project_id = ? AND e.client_message_id = ?`
  )
    .bind(input.principal.agentId, input.principal.projectId, input.clientMessageId)
    .first<AgentBoardEntry>();
  const duplicate = (entry: AgentBoardEntry) => {
    const session = input.post.session;
    if (entry.kind !== input.post.kind || entry.topic !== input.post.topic || entry.body !== input.post.body ||
        entry.reference !== input.post.reference || entry.user_id !== input.principal.userId ||
        (["session_id", "session_name", "model", "model_version", "origin", "origin_version"] as const)
          .some((key) => entry[key] !== (session?.[key] ?? null))) {
      throw new AgentBoardConflictError("Idempotency-Key already belongs to a different post or session");
    }
    return { entry, duplicate: true };
  };
  if (existing) return duplicate(existing);

  const id = crypto.randomUUID().replace(/-/g, "");
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO agent_board_entries
         (id, team_id, project_id, agent_id, kind, topic, body, reference, client_message_id,
          user_id, session_id, session_name, model, model_version, origin, origin_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
          id,
          input.principal.teamId,
          input.principal.projectId,
          input.principal.agentId,
          input.post.kind,
          input.post.topic,
          input.post.body,
          input.post.reference,
          input.clientMessageId,
          input.principal.userId,
          input.post.session?.session_id ?? null,
          input.post.session?.session_name ?? null,
          input.post.session?.model ?? null,
          input.post.session?.model_version ?? null,
          input.post.session?.origin ?? null,
          input.post.session?.origin_version ?? null
        ),
      auditStatement(
        env,
        "agent_board.post",
        input.principal.agentId,
        {
          entry_id: id,
          team_id: input.principal.teamId,
          project_id: input.principal.projectId,
          kind: input.post.kind,
          topic: input.post.topic,
          session: input.post.session,
        },
        input.principal.userId
      ),
    ]);
  } catch (error) {
    const raced = await env.DB.prepare(
      `${BOARD_ENTRY_SELECT}
       WHERE e.agent_id = ? AND e.project_id = ? AND e.client_message_id = ?`
    )
      .bind(input.principal.agentId, input.principal.projectId, input.clientMessageId)
      .first<AgentBoardEntry>();
    if (raced) return duplicate(raced);
    throw error;
  }

  const entry = await env.DB.prepare(`${BOARD_ENTRY_SELECT} WHERE e.id = ?`)
    .bind(id)
    .first<AgentBoardEntry>();
  if (!entry) throw new Error("created board entry could not be loaded");
  return { entry, duplicate: false };
}

export async function tombstoneAgentBoardEntry(
  env: Env,
  input: { userId: string; entryId: string; reason: string }
): Promise<boolean | null> {
  const row = await env.DB.prepare(
    "SELECT id, team_id, agent_id FROM agent_board_entries WHERE id = ?"
  )
    .bind(input.entryId)
    .first<{ id: string; team_id: string; agent_id: string }>();
  if (!row) return false;
  const membership = await getWorkspaceMembership(env, row.team_id, input.userId);
  if (!canAdminWorkspace(membership?.role ?? null)) return null;
  const reason = cleanField(input.reason, "reason", 240);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO agent_board_moderation (entry_id, reason, actor_user_id)
       VALUES (?, ?, ?)
       ON CONFLICT(entry_id) DO UPDATE SET reason = excluded.reason, actor_user_id = excluded.actor_user_id,
         created_at = datetime('now')`
    ).bind(input.entryId, reason, input.userId),
    auditStatement(
      env,
      "agent_board.tombstone",
      row.agent_id,
      { entry_id: input.entryId, team_id: row.team_id, reason },
      input.userId
    ),
  ]);
  return true;
}

function unixSeconds(value: string): number {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const millis = Date.parse(normalized);
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : 0;
}

export function encodeAgentBoardWire(page: AgentBoardPage, protocol: "pb1" | "pb2" = "pb1"): string {
  const agents: Array<string | Array<string | number>> = [];
  const agentIndex = new Map<string, number>();
  const rows = page.entries.map((entry) => {
    const actor = protocol === "pb1" ? entry.agent_slug : [
      entry.agent_id, entry.agent_slug, entry.agent_name, entry.user_id || 0,
      entry.session_id || 0, entry.session_name || 0, entry.model || 0,
      entry.model_version || 0, entry.origin || 0, entry.origin_version || 0,
    ];
    const actorKey = JSON.stringify(actor);
    let index = agentIndex.get(actorKey);
    if (index === undefined) {
      index = agents.length;
      agents.push(actor);
      agentIndex.set(actorKey, index);
    }
    return [
      entry.seq,
      unixSeconds(entry.created_at),
      index,
      entry.kind,
      entry.topic,
      entry.body,
      entry.reference || 0,
    ];
  });
  return JSON.stringify([protocol, page.nextCursor, agents, rows]);
}

export function agentBoardAttribution(entry: AgentBoardEntry): string {
  return [
    `Agent: ${entry.agent_id}`,
    `Key owner: ${entry.user_id || "unknown"}`,
    entry.session_id ? `Session: ${entry.session_name || "unnamed"} (${entry.session_id})` : "Session: not supplied",
    `Model: ${entry.model || "unknown"}${entry.model_version ? ` / ${entry.model_version}` : ""}`,
    `Origin: ${entry.origin || "unknown"}${entry.origin_version ? ` / ${entry.origin_version}` : ""}`,
  ].join(" · ");
}

export async function listAgentBoardMembers(env: Env, projectId: string) {
  const { results: members } = await env.DB.prepare(`SELECT a.id AS agent_id, a.slug, a.name, a.provider,
      a.status, a.created_by_user_id AS user_id, u.role AS user_role,
      g.permission, g.created_by_user_id AS granted_by_user_id, g.created_at AS granted_at,
      EXISTS (SELECT 1 FROM agent_keys k
        JOIN users owner ON owner.id = k.created_by_user_id AND owner.status = 'active'
        JOIN team_memberships km ON km.team_id = a.team_id AND km.user_id = k.created_by_user_id
        WHERE k.agent_id = a.id AND k.revoked_at IS NULL AND a.status = 'active') AS access_active
    FROM agent_project_grants g
    JOIN agent_identities a ON a.id = g.agent_id
    JOIN projects p ON p.id = g.project_id AND p.team_id = a.team_id
    LEFT JOIN team_memberships u ON u.team_id = a.team_id AND u.user_id = a.created_by_user_id
    WHERE g.project_id = ? ORDER BY a.id`).bind(projectId).all();
  // Presence is not inferred from posts: these are observed posting sessions.
  // Keep revoked members for historical attribution, and label current access.
  const { results: sessions } = await env.DB.prepare(`SELECT agent_id, user_id, session_id, session_name,
      model, model_version, origin, origin_version, first_post_at, created_at AS last_post_at, post_count
    FROM (SELECT e.*,
      MIN(e.created_at) OVER session_posts AS first_post_at,
      COUNT(*) OVER session_posts AS post_count,
      ROW_NUMBER() OVER (PARTITION BY e.agent_id, e.user_id, e.origin, e.session_id ORDER BY e.seq DESC) AS latest
      FROM agent_board_entries e
      LEFT JOIN agent_board_moderation m ON m.entry_id = e.id
      WHERE e.project_id = ? AND e.session_id IS NOT NULL AND m.entry_id IS NULL
      WINDOW session_posts AS (PARTITION BY e.agent_id, e.user_id, e.origin, e.session_id))
    WHERE latest = 1 ORDER BY last_post_at DESC, agent_id, session_id LIMIT 101`)
    .bind(projectId).all();
  return {
    members: (members ?? []).map((member) => ({ ...member, access_active: Boolean(member.access_active) })),
    sessions: (sessions ?? []).slice(0, 100),
    sessions_truncated: (sessions?.length ?? 0) > 100,
  };
}

export function agentBoardKindLabel(kind: AgentBoardKind): string {
  switch (kind) {
    case "s":
      return "Status";
    case "c":
      return "Claim";
    case "h":
      return "Handoff";
    case "d":
      return "Decision";
    case "b":
      return "Blocker";
    case "n":
      return "Note";
  }
}
