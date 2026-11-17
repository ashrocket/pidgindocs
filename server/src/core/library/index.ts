import type { Env } from "../types";
import type { EditionToolResult } from "../edition-hooks";
import { assertTenantWritable, editionLibraryEnabled } from "../edition-hooks";
import { json } from "../utils";
import { isSameOriginMutation, resolveCallerUserId, unauthorized } from "./auth";
import * as routes from "./routes/library";
import * as search from "./routes/library-search";
import { createLibraryProject, fileLibraryItems, getLibraryOverview, updateLibraryProject } from "./store";
import { parseSearchInput, runLibraryAsk, runLibrarySearch } from "./search/service";
import { parseFilingInput, suggestFiling } from "./search/filing";
import { listLibraryItems } from "./search/index-store";
import { renderLibrary } from "./web";
import { LIBRARY_TOOLS } from "./tools";

export { LIBRARY_TOOLS };
export { appendLibraryFilters, effectiveProjectSql, loadLibraryPlacements } from "./store";

/** `path` is already stripped of the deployment's BASE_PATH. */
export async function handleLibrary(request: Request, env: Env, path: string): Promise<Response | null> {
  if (!editionLibraryEnabled(env) || !(path === "/library" || /^\/api\/library(?:\/|$)/.test(path))) return null;
  if (!isSameOriginMutation(request)) return json({ ok: false, error: "origin not allowed" }, 403);
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return unauthorized();
  const method = request.method;
  try {
    if (method !== "GET" && method !== "HEAD") await assertTenantWritable(env);
    if (method === "GET" && path === "/library") return renderLibrary(request, env, userId);
    if (method === "GET" && path === "/api/library/items") {
      // Storage references are internal and never serialized to the browser.
      const items = (await listLibraryItems(env, userId)).map(({ sources: _sources, fallback: _fallback, signature: _signature, ...item }) => item);
      return json({ ok: true, data: { items } });
    }
    if (method === "GET" && path === "/api/library") return routes.handleGetLibrary(request, env);
    if (path === "/api/library/search/index") {
      if (method === "GET") return await search.handleGetLibraryIndex(request, env);
      if (method === "POST") return await search.handlePrepareLibraryIndex(request, env);
    }
    if (method === "POST") {
      if (path === "/api/library/projects") return await routes.handleCreateLibraryProject(request, env);
      if (path === "/api/library/tags") return await routes.handleCreateLibraryTag(request, env);
      if (path === "/api/library/file") return await routes.handleFileLibraryItems(request, env);
      if (path === "/api/library/search") return await search.handleLibrarySearch(request, env);
      if (path === "/api/library/ask") return await search.handleLibraryAsk(request, env);
      if (path === "/api/library/suggest") return await search.handleSuggestFiling(request, env);
    }
    const resource = /^\/api\/library\/(projects|tags)\/([^/]+)$/.exec(path);
    if (resource) {
      const id = decodeURIComponent(resource[2]);
      if (resource[1] === "projects") {
        if (method === "PATCH") return await routes.handleUpdateLibraryProject(request, env, id);
        if (method === "DELETE") return await routes.handleDeleteLibraryProject(request, env, id);
      } else {
        if (method === "PATCH") return await routes.handleUpdateLibraryTag(request, env, id);
        if (method === "DELETE") return await routes.handleDeleteLibraryTag(request, env, id);
      }
    }
    return json({ ok: false, error: "not found" }, 404);
  } catch (error) {
    if (error instanceof URIError) return json({ ok: false, error: "invalid path" }, 400);
    return search.errorResponse(error);
  }
}

export async function callLibraryTool(input: {
  env: Env; request: Request; name: string; args: Record<string, unknown>;
}): Promise<EditionToolResult | undefined> {
  const { env, request, name, args } = input;
  if (!editionLibraryEnabled(env) || !LIBRARY_TOOLS.some(tool => tool.name === name)) return undefined;
  const userId = await resolveCallerUserId(request, env);
  if (!userId) return { text: "Unauthorized", isError: true };
  if (!isSameOriginMutation(request)) return { text: "origin not allowed", isError: true };
  try {
    let data: unknown;
    let text: string;
    if (name === "pidgin_get_library") {
      const library = await getLibraryOverview(env, userId);
      data = { library };
      text = `Library has ${library.projects.length} project(s), ${library.tags.length} tag(s); unfiled: ${library.unfiled.documents} document(s), ${library.unfiled.artifacts} artifact(s).`;
    } else if (name === "pidgin_save_library_project") {
      await assertTenantWritable(env);
      let id: string;
      if (args.id !== undefined) {
        if (typeof args.id !== "string" || !await updateLibraryProject(env, userId, args.id, args)) return { text: "project not found", data: { id: args.id, found: false }, isError: true };
        id = args.id;
      } else id = await createLibraryProject(env, userId, args);
      const library = await getLibraryOverview(env, userId);
      data = { project: library.projects.find(project => project.id === id), library };
      text = `${args.id ? "Updated" : "Created"} library project.`;
    } else if (name === "pidgin_file_items") {
      await assertTenantWritable(env);
      const result = await fileLibraryItems(env, userId, args);
      data = result;
      text = `Filed ${result.updated} item(s)${result.missing.length ? `; ${result.missing.length} not found` : ""}.`;
    } else if (name === "pidgin_search_library" || name === "pidgin_ask_library") {
      const parsed = parseSearchInput({ ...args, budget: args.budget ?? "thorough" }, name === "pidgin_search_library" ? "query" : "question");
      if (name === "pidgin_search_library") {
        const result = await runLibrarySearch(env, userId, parsed);
        data = result;
        text = `Found ${result.results.length} useful passage(s) in ${new Set(result.results.map(item => item.id)).size} item(s) (searched ${result.searched_items}; ${result.index.pending} not yet indexed).`;
      } else {
        const result = await runLibraryAsk(env, userId, parsed);
        data = result;
        text = result.answer;
      }
    } else {
      const result = await suggestFiling(env, userId, parseFilingInput(args));
      data = result;
      text = `${result.suggestions.length} item(s) judged; ${result.suggestions.filter(item => item.confident).length} confident at ${result.min_confidence}`
        + (result.applied ? `; filed ${result.applied.filed}, tagged ${result.applied.tagged}` : "; nothing written (pass apply: true to file)")
        + `. Search cost $${result.usage.cost_usd}.`;
    }
    return { text, data };
  } catch (error) {
    const response = search.errorResponse(error);
    const body = await response.json() as { error: string; code?: string };
    return { text: body.error, data: { error: body.error, ...(body.code ? { code: body.code } : {}) }, isError: true };
  }
}
