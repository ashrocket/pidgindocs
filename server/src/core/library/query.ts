import type { Env } from "../types";
import { editionLibraryEnabled } from "../edition-hooks";
import { appendLibraryFilters, loadLibraryPlacements, type LibraryResourceRef } from "./store";

export interface LibraryQueryInput { userId: string; type: "document" | "artifact"; alias: string; project?: string; tag?: string }

/** Narrows a document or artifact list to a Library project or tag. A deployment without the Library ignores the filters. */
export function applyLibraryQuery(env: Env, input: LibraryQueryInput, conditions: string[], binds: (string | number)[]): void {
  if (!editionLibraryEnabled(env) || (!input.project && !input.tag)) return;
  conditions.push(`${input.alias}.user_id = ?`); binds.push(input.userId);
  const url = new URL("https://library.invalid");
  if (input.project) url.searchParams.set("library_project", input.project);
  if (input.tag) url.searchParams.set("library_tag", input.tag);
  appendLibraryFilters(url, input.type, input.alias, conditions, binds);
}

export async function loadEnabledLibraryPlacements(env: Env, userId: string, refs: LibraryResourceRef[]): Promise<Map<string, unknown>> {
  return editionLibraryEnabled(env) ? await loadLibraryPlacements(env, userId, refs) : new Map();
}
