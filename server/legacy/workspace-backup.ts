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
import { listArtifactVersions } from "./artifacts/store";
import { loadDocumentText, sourceMarkdownKey } from "./documents";

export const WORKSPACE_BACKUP_PREFIX = "workspace-backups/";
export const WORKSPACE_BACKUP_RETENTION = 30;

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

export interface WorkspaceBackupSnapshot {
  version: 2;
  generated_at: string;
  security: {
    agent_key_hashes_excluded: true;
  };
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
  };
  users: User[];
  teams: Team[];
  memberships: TeamMembership[];
  projects: Project[];
  comments: WorkspaceComment[];
  documents: WorkspaceBackupDocument[];
  artifacts: WorkspaceBackupArtifact[];
  agent_identities: AgentIdentity[];
  agent_grants: AgentProjectGrant[];
  agent_board_entries: AgentBoardEntry[];
  agent_board_tombstones: Array<{
    entry_id: string;
    action: "tombstone";
    reason: string;
    actor_user_id: string;
    created_at: string;
  }>;
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

export async function canListGlobalWorkspaceBackups(env: Env, userId: string): Promise<boolean> {
  const ownerEmail = env.OWNER_EMAIL?.trim().toLowerCase();
  if (!ownerEmail || !userId) return false;
  const owner = await env.DB.prepare(
    "SELECT id FROM users WHERE email = ? AND status = 'active'"
  ).bind(ownerEmail).first<{ id: string }>();
  return owner?.id === userId;
}

function encodeKeyPart(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function fetchDocumentSnapshot(env: Env, row: DocumentRecord): Promise<WorkspaceBackupDocument> {
  const html = await loadDocumentText(env, row.doc_key);
  const markdownKey = sourceMarkdownKey(row.doc_key);
  const markdown = markdownKey ? await loadDocumentText(env, markdownKey) : null;
  return { row, html, markdown };
}

async function fetchArtifactSnapshot(env: Env, row: ArtifactRow): Promise<WorkspaceBackupArtifact> {
  const versions = await listArtifactVersions(env, row.id);
  const withContent = await Promise.all(
    versions.map(async (version) => {
      const html = await loadDocumentText(env, version.r2_key);
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
  const listing = await env.DOCS.list({ prefix: WORKSPACE_BACKUP_PREFIX, limit: Math.max(1, limit) });
  return (listing.objects ?? [])
    .slice()
    .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
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
  ] =
    await Promise.all([
      env.DB.prepare("SELECT id, email, invited_by, created_at, status FROM users ORDER BY created_at ASC").all<User>(),
      env.DB.prepare("SELECT id, slug, name, owner_user_id, created_at, updated_at FROM teams ORDER BY created_at ASC").all<Team>(),
      env.DB.prepare("SELECT team_id, user_id, role, created_at FROM team_memberships ORDER BY created_at ASC").all<TeamMembership>(),
      env.DB.prepare("SELECT id, team_id, slug, name, description, created_by_user_id, created_at, updated_at FROM projects ORDER BY created_at ASC").all<Project>(),
      env.DB.prepare(
        "SELECT id, team_id, project_id, resource_type, resource_id, parent_id, body, status, author_user_id, created_at, updated_at FROM resource_comments ORDER BY created_at ASC"
      ).all<WorkspaceComment>(),
      env.DB.prepare(
        `SELECT id, title, body, doc_key, public, priority, created_at,
                instance_project, instance_model, instance_source, team_id, project_id,
                doc_kind, source_url, doc_slug, enhance_status, interactive
         FROM messages
         WHERE type = 'document' AND doc_key IS NOT NULL
         ORDER BY created_at ASC, id ASC`
      ).all<DocumentRecord>(),
      env.DB.prepare(
        `SELECT id, user_id, title, description, favicon, source_path, source_kind,
                role, visibility, shared_version, current_version, capabilities, design_system,
                instance_session_id, instance_project, team_id, project_id, created_at, updated_at
         FROM artifacts
         ORDER BY created_at ASC, id ASC`
      ).all<ArtifactRow>(),
      env.DB.prepare(
        `SELECT id, team_id, slug, name, provider, status, created_by_user_id,
                created_at, updated_at, revoked_at
         FROM agent_identities ORDER BY created_at ASC, id ASC`
      ).all<AgentIdentity>(),
      env.DB.prepare(
        `SELECT agent_id, project_id, permission, created_by_user_id, created_at
         FROM agent_project_grants ORDER BY created_at ASC, agent_id ASC, project_id ASC`
      ).all<AgentProjectGrant>(),
      env.DB.prepare(
        `SELECT e.seq, e.id, e.team_id, e.project_id,
                p.slug AS project_slug, p.name AS project_name,
                e.agent_id, a.slug AS agent_slug, a.name AS agent_name,
                e.kind, e.topic, e.body, e.reference, e.client_message_id, e.created_at,
                e.user_id, e.session_id, e.session_name, e.model, e.model_version, e.origin, e.origin_version
         FROM agent_board_entries e
         JOIN agent_identities a ON a.id = e.agent_id
         JOIN projects p ON p.id = e.project_id
         ORDER BY e.seq ASC`
      ).all<AgentBoardEntry>(),
      env.DB.prepare(
        `SELECT entry_id, action, reason, actor_user_id, created_at
         FROM agent_board_moderation ORDER BY created_at ASC, entry_id ASC`
      ).all<{
        entry_id: string;
        action: "tombstone";
        reason: string;
        actor_user_id: string;
        created_at: string;
      }>(),
    ]);

  const documents = await Promise.all((documentsResult.results ?? []).map((row) => fetchDocumentSnapshot(env, row)));
  const artifacts = await Promise.all((artifactsResult.results ?? []).map((row) => fetchArtifactSnapshot(env, row)));

  const snapshot: WorkspaceBackupSnapshot = {
    version: 2,
    generated_at: generatedAt,
    security: { agent_key_hashes_excluded: true },
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
    },
  });

  const backups = await listWorkspaceBackups(env, WORKSPACE_BACKUP_RETENTION + 10);
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
