import { contentPolicy } from "./content-policy";
import type {
  AgentBoardEntry,
  AgentIdentity,
  AgentProjectGrant,
  Env,
  Project,
  Team,
  TeamMembership,
  User,
  WorkspaceComment,
} from "./types";
import type { ArtifactRow, ArtifactVersionRow } from "./artifacts/store";
import type { DocumentRecord } from "./documents";
import { loadDocumentText, sourceMarkdownKey } from "./documents";

export const WORKSPACE_BACKUP_PREFIX = "workspace-backups/";
export const WORKSPACE_BACKUP_RETENTION = 30;
type GovernanceBackup = Record<string, Array<Record<string, unknown>>>;

export interface WorkspaceBackupDocument {
  row: DocumentRecord;
  html: string | null;
  markdown: string | null;
}

export interface WorkspaceBackupArtifactVersion extends ArtifactVersionRow {
  html: string | null;
  markdown: string | null;
}

export interface WorkspaceBackupArtifact {
  row: ArtifactRow;
  versions: WorkspaceBackupArtifactVersion[];
}

/** Board columns added by migrations 0046/0047, kept so a snapshot can rebuild work boards, Q&A and authorship. */
type BackupProject = Project & {
  board_kind?: string;
  archived_at?: string | null;
  parent_project_id?: string | null;
  created_by_agent_id?: string | null;
  expires_at?: string | null;
  last_post_at?: string | null;
};
type BackupAgentIdentity = AgentIdentity & { kind?: "agent" | "person"; self_minted?: number };
type BackupAgentBoardEntry = AgentBoardEntry & { intent?: string | null; reply_to_seq?: number | null; to_ref?: string | null; to_auto?: number };
type BackupAgentBoardTrash = {
  entry_id: string;
  team_id: string;
  actor_user_id: string | null;
  actor_kind: "person" | "system";
  digest_id: string | null;
  trashed_at: string;
  purge_at: string;
};
type BackupBoardDigest = {
  id: string; team_id: string; project_id: string; project_name: string;
  scope: string; window_start: string; window_end: string; part: number;
  summary: string; provider: string; model: string;
  covered_count: number; source_first_seq: number; source_last_seq: number; created_at: string;
  prompt_version: string | null; reserved_micro_usd: number | null; ai_attempt_id: string | null;
};
type BackupBoardDigestEntry = {
  entry_id: string; digest_id: string; team_id: string; project_id: string; source_seq: number; created_at: string;
};

export interface WorkspaceBackupSnapshot {
  /** 7 requires restoring governance with content; older importers must reject it. */
  version: 7;
  generated_at: string;
  security: {
    agent_key_hashes_excluded: true;
    governance_required_on_restore: true;
    restore_requires_offline_validation: true;
  };
  governance: GovernanceBackup;
  /** DDL for policy tables, indexes and enforcement triggers. Restore must
   * apply compatible migrations before importing any content or policy rows. */
  governance_schema: Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  counts: {
    users: number;
    teams: number;
    memberships: number;
    projects: number;
    comments: number;
    documents: number;
    artifacts: number;
    artifact_versions: number;
    agent_identities: number;
    agent_grants: number;
    agent_board_entries: number;
    agent_board_tombstones: number;
    agent_board_trash: number;
    agent_board_digests: number;
    agent_board_digest_entries: number;
    agent_board_digest_ai_budget: number;
    agent_board_digest_ai_worker_budget: number;
    agent_board_digest_ai_attempts: number;
    agent_board_digest_team_state: number;
    agent_board_digest_ai_backoff: number;
  };
  users: User[];
  teams: Team[];
  memberships: TeamMembership[];
  projects: BackupProject[];
  comments: WorkspaceComment[];
  documents: WorkspaceBackupDocument[];
  artifacts: WorkspaceBackupArtifact[];
  agent_identities: BackupAgentIdentity[];
  agent_grants: AgentProjectGrant[];
  agent_board_entries: BackupAgentBoardEntry[];
  agent_board_tombstones: Array<{
    entry_id: string;
    action: "tombstone";
    reason: string;
    actor_user_id: string | null;
    actor_kind: "person" | "system";
    created_at: string;
  }>;
  agent_board_trash: BackupAgentBoardTrash[];
  agent_board_digests: BackupBoardDigest[];
  agent_board_digest_entries: BackupBoardDigestEntry[];
  agent_board_digest_ai_budget: Array<Record<string, unknown>>;
  agent_board_digest_ai_worker_budget: Array<Record<string, unknown>>;
  agent_board_digest_ai_attempts: Array<Record<string, unknown>>;
  agent_board_digest_team_state: Array<Record<string, unknown>>;
  agent_board_digest_ai_backoff: Array<Record<string, unknown>>;
  agent_board_digest_restores: Array<{ entry_id: string; team_id: string; restored_by_user_id: string; restored_at: string }>;
}

export interface WorkspaceBackupSummary {
  key: string;
  uploaded: string;
  size: number;
}

export interface WorkspaceBackupResult {
  key: string;
  uploaded: string;
  size: number;
  counts: WorkspaceBackupSnapshot["counts"];
}

function encodeKeyPart(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function fetchDocumentSnapshot(env: Env, row: DocumentRecord): Promise<WorkspaceBackupDocument> {
  const html = await loadDocumentText(env, row.doc_key);
  if (html === null) throw new Error(`Backup source missing for document ${row.id}`);
  const markdownKey = sourceMarkdownKey(row.doc_key);
  const markdown = markdownKey ? await loadDocumentText(env, markdownKey) : null;
  return { row, html, markdown };
}

async function fetchArtifactSnapshot(env: Env, row: ArtifactRow, versions: ArtifactVersionRow[]): Promise<WorkspaceBackupArtifact> {
  if (!versions.some(version => version.version === row.current_version)) {
    throw new Error(`Backup current version missing for artifact ${row.id}`);
  }
  const withContent = await Promise.all(
    versions.map(async (version) => {
      const html = await loadDocumentText(env, version.r2_key);
      if (html === null) throw new Error(`Backup source missing for artifact ${row.id} version ${version.version}`);
      const markdown = await loadDocumentText(env, version.r2_key.replace(/\.html$/, ".md"));
      return { ...version, html, markdown };
    })
  );
  return { row, versions: withContent };
}

export async function listWorkspaceBackups(
  env: Env,
  limit = 10
): Promise<WorkspaceBackupSummary[]> {
  // R2 lists keys in ascending order (oldest first for ISO-timestamp keys), so
  // page through the whole prefix, sort newest first, and only then apply limit.
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const listing = await env.DOCS.list({ prefix: WORKSPACE_BACKUP_PREFIX, cursor });
    objects.push(...(listing.objects ?? []));
    cursor = listing.truncated ? (listing as { cursor?: string }).cursor : undefined;
  } while (cursor);
  return objects
    .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
    .slice(0, Math.max(1, limit))
    .map((object) => ({
      key: object.key,
      uploaded: toIso(object.uploaded),
      size: object.size,
    }));
}

export async function getLatestWorkspaceBackupSummary(
  env: Env
): Promise<WorkspaceBackupSummary | null> {
  const backups = await listWorkspaceBackups(env, 1);
  return backups[0] ?? null;
}

export async function runWorkspaceBackup(env: Env): Promise<WorkspaceBackupResult> {
  const generatedAt = new Date().toISOString();

  // The tables a snapshot holds. Left out on purpose:
  // - help_usage (migration 0048): operational counters, not content.
  // - member_onboarding (0046), help_opened_at (0048) included: per-person setup progress, left out as PR A left it.
  const [
    usersResult,
    teamsResult,
    membershipsResult,
    projectsResult,
    commentsResult,
    documentsResult,
    artifactsResult,
    agentIdentitiesResult,
    agentGrantsResult,
    agentBoardEntriesResult,
    agentBoardTombstonesResult,
    agentBoardTrashResult,
    agentBoardDigestsResult,
    agentBoardDigestEntriesResult,
    agentBoardDigestRestoresResult,
    agentBoardDigestAiBudgetResult,
    agentBoardDigestAiWorkerBudgetResult,
    agentBoardDigestAiAttemptsResult,
    agentBoardDigestTeamStateResult,
    agentBoardDigestAiBackoffResult,
    artifactVersionsResult,
    governanceSchema,
    ...governanceRows
  ] =
    await env.DB.batch([
      env.DB.prepare("SELECT id, email, invited_by, created_at, status FROM users ORDER BY created_at ASC"),
      env.DB.prepare("SELECT id, slug, name, owner_user_id, created_at, updated_at FROM teams ORDER BY created_at ASC"),
      env.DB.prepare("SELECT team_id, user_id, role, created_at FROM team_memberships ORDER BY created_at ASC"),
      env.DB.prepare(`SELECT id, team_id, slug, name, description, created_by_user_id, created_at, updated_at,
         board_kind, archived_at, parent_project_id, created_by_agent_id, expires_at, last_post_at
         FROM projects ORDER BY created_at ASC`),
      env.DB.prepare(
        "SELECT id, team_id, project_id, resource_type, resource_id, parent_id, body, status, author_user_id, created_at, updated_at FROM resource_comments ORDER BY created_at ASC"
      ),
      env.DB.prepare(
        `SELECT id, title, body, doc_key, public, priority, created_at,
                instance_project, instance_model, instance_source, team_id, project_id,
                doc_kind, source_url, doc_slug, doc_version, is_latest, enhance_status, interactive, user_id, sharing, sharing_explicit
         FROM messages
         WHERE type = 'document' AND doc_key IS NOT NULL
         ORDER BY created_at ASC, id ASC`
      ),
      env.DB.prepare(
        `SELECT id, user_id, title, description, favicon, source_path, source_kind,
                role, visibility, shared_version, current_version, capabilities, design_system,
                instance_session_id, instance_project, team_id, project_id, sharing, created_at, updated_at
         FROM artifacts
         ORDER BY created_at ASC, id ASC`
      ),
      env.DB.prepare(
        `SELECT id, team_id, slug, name, provider, status, created_by_user_id,
                created_at, updated_at, revoked_at, kind, self_minted
         FROM agent_identities ORDER BY created_at ASC, id ASC`
      ),
      env.DB.prepare(
        `SELECT agent_id, project_id, permission, created_by_user_id, created_at
         FROM agent_project_grants ORDER BY created_at ASC, agent_id ASC, project_id ASC`
      ),
      env.DB.prepare(
        `SELECT e.seq, e.id, e.team_id, e.project_id,
                p.slug AS project_slug, p.name AS project_name,
                e.agent_id, a.slug AS agent_slug, a.name AS agent_name,
                e.kind, e.topic, e.body, e.reference, e.client_message_id, e.created_at,
                e.user_id, e.session_id, e.session_name, e.model, e.model_version, e.origin, e.origin_version,
                e.intent, e.reply_to_seq, e.to_ref, e.to_auto
         FROM agent_board_entries e
         JOIN agent_identities a ON a.id = e.agent_id
         JOIN projects p ON p.id = e.project_id
         ORDER BY e.seq ASC`
      ),
      env.DB.prepare(
        `SELECT entry_id, action, reason, actor_user_id, actor_kind, created_at
         FROM agent_board_moderation ORDER BY created_at ASC, entry_id ASC`
      ),
      env.DB.prepare(`SELECT entry_id, team_id, actor_user_id, actor_kind, digest_id, trashed_at, purge_at
        FROM agent_board_trash ORDER BY trashed_at ASC, entry_id ASC`),
      env.DB.prepare("SELECT * FROM agent_board_digests ORDER BY window_start ASC, id ASC"),
      env.DB.prepare("SELECT * FROM agent_board_digest_entries ORDER BY source_seq ASC, entry_id ASC"),
      env.DB.prepare("SELECT * FROM agent_board_digest_restores ORDER BY restored_at ASC, entry_id ASC"),
      env.DB.prepare("SELECT * FROM agent_board_digest_ai_budget ORDER BY team_id, day"),
      env.DB.prepare("SELECT * FROM agent_board_digest_ai_worker_budget ORDER BY day"),
      env.DB.prepare("SELECT * FROM agent_board_digest_ai_attempts ORDER BY created_at, id"),
      env.DB.prepare("SELECT * FROM agent_board_digest_team_state ORDER BY team_id"),
      env.DB.prepare("SELECT * FROM agent_board_digest_ai_backoff ORDER BY team_id, entry_id"),
      env.DB.prepare("SELECT artifact_id,version,label,r2_key,size,source_size,created_at,created_by_session FROM artifact_versions ORDER BY artifact_id,version DESC"),
      contentPolicy().backupSchema(env),
      ...contentPolicy().backupTables.map(table => env.DB.prepare(`SELECT * FROM ${table}`)),
    ]) as [
      D1Result<User>, D1Result<Team>, D1Result<TeamMembership>, D1Result<BackupProject>, D1Result<WorkspaceComment>,
      D1Result<DocumentRecord>, D1Result<ArtifactRow>, D1Result<BackupAgentIdentity>, D1Result<AgentProjectGrant>,
      D1Result<BackupAgentBoardEntry>, D1Result<WorkspaceBackupSnapshot["agent_board_tombstones"][number]>,
      D1Result<BackupAgentBoardTrash>, D1Result<BackupBoardDigest>, D1Result<BackupBoardDigestEntry>,
      D1Result<WorkspaceBackupSnapshot["agent_board_digest_restores"][number]>,
      D1Result<Record<string, unknown>>, D1Result<Record<string, unknown>>, D1Result<Record<string, unknown>>,
      D1Result<Record<string, unknown>>, D1Result<Record<string, unknown>>,
      D1Result<ArtifactVersionRow & { artifact_id: string }>, D1Result<WorkspaceBackupSnapshot["governance_schema"][number]>,
      ...D1Result<Record<string, unknown>>[],
    ];

  const documents = await Promise.all((documentsResult.results ?? []).map((row) => fetchDocumentSnapshot(env, row)));
  const versionsByArtifact = new Map<string, ArtifactVersionRow[]>();
  for (const { artifact_id, ...version } of artifactVersionsResult.results ?? []) {
    const versions = versionsByArtifact.get(artifact_id) ?? [];
    versions.push(version);
    versionsByArtifact.set(artifact_id, versions);
  }
  const artifacts = await Promise.all((artifactsResult.results ?? []).map(row =>
    fetchArtifactSnapshot(env, row, versionsByArtifact.get(row.id) ?? [])));
  // D1 metadata, policy and pending cleanup rows came from the same transaction:
  // a concurrent deletion cannot appear both as content and as a cleanup job.
  const governance = Object.fromEntries(contentPolicy().backupTables.map((table, index) =>
    [table, governanceRows[index].results ?? []])) as GovernanceBackup;

  const snapshot: WorkspaceBackupSnapshot = {
    version: 7,
    generated_at: generatedAt,
    // R2 has no transaction shared with D1. Missing primary objects fail the
    // run, but an offline restore still needs compatible migrations, all ACL
    // rows and evidence, foreign-key validation and audience checks before the
    // deployment serves traffic. This file does not implement an importer.
    security: { agent_key_hashes_excluded: true, governance_required_on_restore: true, restore_requires_offline_validation: true },
    governance,
    governance_schema: governanceSchema.results ?? [],
    counts: {
      users: usersResult.results?.length ?? 0,
      teams: teamsResult.results?.length ?? 0,
      memberships: membershipsResult.results?.length ?? 0,
      projects: projectsResult.results?.length ?? 0,
      comments: commentsResult.results?.length ?? 0,
      documents: documents.length,
      artifacts: artifacts.length,
      artifact_versions: artifacts.reduce((sum, artifact) => sum + artifact.versions.length, 0),
      agent_identities: agentIdentitiesResult.results?.length ?? 0,
      agent_grants: agentGrantsResult.results?.length ?? 0,
      agent_board_entries: agentBoardEntriesResult.results?.length ?? 0,
      agent_board_tombstones: agentBoardTombstonesResult.results?.length ?? 0,
      agent_board_trash: agentBoardTrashResult.results?.length ?? 0,
      agent_board_digests: agentBoardDigestsResult.results?.length ?? 0,
      agent_board_digest_entries: agentBoardDigestEntriesResult.results?.length ?? 0,
      agent_board_digest_ai_budget: agentBoardDigestAiBudgetResult.results?.length ?? 0,
      agent_board_digest_ai_worker_budget: agentBoardDigestAiWorkerBudgetResult.results?.length ?? 0,
      agent_board_digest_ai_attempts: agentBoardDigestAiAttemptsResult.results?.length ?? 0,
      agent_board_digest_team_state: agentBoardDigestTeamStateResult.results?.length ?? 0,
      agent_board_digest_ai_backoff: agentBoardDigestAiBackoffResult.results?.length ?? 0,
    },
    users: usersResult.results ?? [],
    teams: teamsResult.results ?? [],
    memberships: membershipsResult.results ?? [],
    projects: projectsResult.results ?? [],
    comments: commentsResult.results ?? [],
    documents,
    artifacts,
    agent_identities: agentIdentitiesResult.results ?? [],
    agent_grants: agentGrantsResult.results ?? [],
    agent_board_entries: agentBoardEntriesResult.results ?? [],
    agent_board_tombstones: agentBoardTombstonesResult.results ?? [],
    agent_board_trash: agentBoardTrashResult.results ?? [],
    agent_board_digests: agentBoardDigestsResult.results ?? [],
    agent_board_digest_entries: agentBoardDigestEntriesResult.results ?? [],
    agent_board_digest_restores: agentBoardDigestRestoresResult.results ?? [],
    agent_board_digest_ai_budget: agentBoardDigestAiBudgetResult.results ?? [],
    agent_board_digest_ai_worker_budget: agentBoardDigestAiWorkerBudgetResult.results ?? [],
    agent_board_digest_ai_attempts: agentBoardDigestAiAttemptsResult.results ?? [],
    agent_board_digest_team_state: agentBoardDigestTeamStateResult.results ?? [],
    agent_board_digest_ai_backoff: agentBoardDigestAiBackoffResult.results ?? [],
  };

  const key = `${WORKSPACE_BACKUP_PREFIX}${encodeKeyPart(generatedAt)}.json`;
  const body = JSON.stringify(snapshot, null, 2);
  const put = await env.DOCS.put(key, body, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: {
      kind: "workspace-backup",
      generated_at: generatedAt,
      users: String(snapshot.counts.users),
      teams: String(snapshot.counts.teams),
      projects: String(snapshot.counts.projects),
      documents: String(snapshot.counts.documents),
      artifacts: String(snapshot.counts.artifacts),
      agent_board_entries: String(snapshot.counts.agent_board_entries),
      agent_board_trash: String(snapshot.counts.agent_board_trash),
      agent_board_digests: String(snapshot.counts.agent_board_digests),
    },
  });

  // Every snapshot, newest first, so anything beyond retention is pruned.
  const backups = await listWorkspaceBackups(env, Number.MAX_SAFE_INTEGER);
  const stale = backups.slice(WORKSPACE_BACKUP_RETENTION);
  if (stale.length > 0) {
    await env.DOCS.delete(stale.map((item) => item.key));
  }

  return {
    key: put.key,
    uploaded: toIso(put.uploaded),
    size: put.size,
    counts: snapshot.counts,
  };
}
