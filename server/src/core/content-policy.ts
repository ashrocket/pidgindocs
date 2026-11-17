import type { Env } from "./types";

export type ContentKind = "document" | "artifact";
export type ContentPermission = "read" | "edit";
export interface DocumentPublishPolicy {
  sharing: "private" | "shared";
  statements: D1PreparedStatement[];
  readAccess: { audience: "team"; role_id: string; role_name: string; permission: "read" };
}
/** Deployment-local content policy, independent of hosting hooks. SQL inputs are
 * internal identifiers only; accessSql must consume exactly two user-ID binds.
 * Every accessor is evaluated when building a query, never at module loading. */
export interface ContentPolicy {
  /** Explicit edition opt-in; saved team preferences never change Solo visibility. */
  documentDefaultsEnabled: boolean;
  /** Runs only for a new document. Statements join its insert in one D1 batch. */
  documentPublish?(env: Env, input: { id: string; resourceKey: string; userId?: string; teamId: string | null;
    projectId?: string; sharing: "private" | "shared" }): Promise<DocumentPublishPolicy | undefined>;
  documentPublishFailure?(error: unknown): string | undefined;
  /** A role-scoped document can return an authenticated URL, never a public token. */
  documentSharedSql?(alias: string): string;
  accessSql?(alias: string, kind: ContentKind, permission: ContentPermission): string;
  restrictedTeams(env: Env, teamIds: readonly (string | null | undefined)[]): Promise<boolean>;
  unrestrictedTeamSql(teamExpression: string): string;
  unrestrictedInstanceSql(): string;
  unrestrictedMemberSql(userExpression: string): string;
  artifactDeletionSql(alias: string): string;
  questionSourceSql(alias: string): string;
  hostedExpirySql(alias: string): string;
  backupTables: readonly string[];
  backupSchema(env: Env): D1PreparedStatement;
}
const defaults: ContentPolicy = {
  documentDefaultsEnabled: false,
  restrictedTeams: async () => false,
  unrestrictedTeamSql: () => "1",
  unrestrictedInstanceSql: () => "1",
  unrestrictedMemberSql: () => "1",
  artifactDeletionSql: () => "1",
  questionSourceSql: alias => `${alias}.type = 'question'`,
  hostedExpirySql: () => "1",
  // The historical table name is retained for migration compatibility. Pending
  // object deletion is core state and must survive a backup in every edition.
  backupTables: ["governed_content_cleanup", "document_audience_preferences", "document_audience_audit", "agent_board_documents"],
  backupSchema: env => env.DB.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND tbl_name IN ('governed_content_cleanup','document_audience_preferences','document_audience_audit','agent_board_documents') ORDER BY type,name"),
};
let policy: ContentPolicy = defaults;
export function installContentPolicy(value: Partial<ContentPolicy>): void { policy = { ...defaults, ...value }; }
export function contentPolicy(): ContentPolicy { return policy; }
export const restrictedContentTeams = (env: Env, ...teamIds: (string | null | undefined)[]): Promise<boolean> => policy.restrictedTeams(env, teamIds);
