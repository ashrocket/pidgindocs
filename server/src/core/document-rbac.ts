import { contentPolicy, type ContentKind, type ContentPermission } from "./content-policy";

/** Internal alias only. Both the baseline and edition predicate consume exactly
 * two user-ID binds: personal owner, then current member. */
export function contentAccessSql(alias: string, kind: ContentKind, permission: ContentPermission): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) throw new Error("Invalid SQL alias");
  const edition = contentPolicy().accessSql;
  if (edition) return edition(alias, kind, permission);
  const audience = permission === "read"
    ? `(${alias}.sharing = 'shared' OR ${kind === "document" ? `${alias}.type <> 'document' OR ` : ""}${alias}.user_id = access_member.user_id)`
    : `access_member.role IN ('owner','admin','member') AND (${alias}.user_id = access_member.user_id${kind === "document" ? ` OR (access_member.role IN ('owner','admin') AND ${alias}.sharing = 'shared')` : ""})`;
  return `((${alias}.team_id IS NULL AND ${alias}.user_id = ?) OR EXISTS (SELECT 1 FROM team_memberships access_member WHERE access_member.team_id = ${alias}.team_id AND access_member.user_id = ? AND ${audience}))`;
}
export function messageReadSql(alias: string): string { return contentAccessSql(alias, "document", "read"); }
export function artifactReadSql(alias: string): string { return contentAccessSql(alias, "artifact", "read"); }
export function messageEditSql(alias: string): string { return contentAccessSql(alias, "document", "edit"); }
export function artifactEditSql(alias: string): string { return contentAccessSql(alias, "artifact", "edit"); }
