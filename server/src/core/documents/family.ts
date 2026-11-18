// Version-family key for documents, kept dependency-free so workspace and
// message storage can use it without importing the documents module.

/** A version family is one slug inside one audience (a team, or one person's
 * private documents). Slugs are caller-chosen, so the slug alone is not a key.
 * Bind with documentFamilyBinds; legacy rows without a slug are keyed by id. */
export const DOCUMENT_FAMILY_SQL =
  "type = 'document' AND (doc_slug = ? OR (doc_slug IS NULL AND id = ?)) AND team_id IS ? AND (team_id IS NOT NULL OR user_id = ?)";

export function documentFamilyBinds(row: { id: string; doc_slug?: string | null; team_id?: string | null; user_id?: string | null }): (string | null)[] {
  const slug = row.doc_slug || row.id;
  return [slug, slug, row.team_id ?? null, row.user_id ?? null];
}
