import { artifactReadSql, messageReadSql } from "../document-rbac";

/** These queries already bind the caller as resource owner. Evaluate the
 * current content policy at query time and supply that same owner to its two
 * required membership checks. Never interpolate an external identifier. */
export function ownedReadSql(type: "document" | "artifact", alias: string): string {
  const predicate = type === "document" ? messageReadSql(alias) : artifactReadSql(alias);
  if ((predicate.match(/\?/g) ?? []).length !== 2) throw new Error("Unexpected content access predicate");
  return predicate.replace(/\?/g, `${alias}.user_id`);
}
