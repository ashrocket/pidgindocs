import type { Env } from "../types";
import { UNFILED, getLibraryOverview } from "../library";
import { answerFromPassages, type LibraryAnswer } from "./answer";
import {
  DEFAULT_INDEX_BUDGET,
  ensureLibraryIndex,
  isCurrent,
  itemRef,
  type IndexStatus,
  type LibraryItem,
} from "./index-store";
import { JevError, createJev, jevCost, retrievalLimits, searchBudgets, type JevUsage, type SearchBudget } from "./jev";
import { retrieveFromLibrary, type RetrievalStep, type RetrievedPassage, type SearchableItem } from "./retrieval";

// Jevbox in PidginDocs: the shared logic behind /api/library/search, /ask, and
// the MCP tools. Every call is scoped to one user's own library.

export class LibrarySearchInputError extends Error {}
export class LibrarySearchUnavailableError extends Error {}
export class LibraryAnswerError extends Error {}

/** Items indexed before a search runs; the rest wait for prepare calls. */
const SEARCH_INDEX_BUDGET = 24;
const MAX_QUERY = 2000;
const MAX_QUESTION = 4000;
const MAX_ITEMS = 50;

export interface LibrarySearchInput {
  query: string;
  project_id?: string;
  tag_id?: string;
  items?: { type: "document" | "artifact"; id: string }[];
  limit?: number;
  /** "standard" (48 passages, the default) or "thorough" (96). */
  budget?: SearchBudget;
}

export interface LibrarySearchOutput {
  query: string;
  results: (RetrievedPassage & { ref: number })[];
  trace: RetrievalStep[];
  scored_passages: number;
  limited: boolean;
  searched_items: number;
  index: IndexStatus;
  usage: JevUsage & { cost_usd: number };
}

export type LibraryAskOutput = LibrarySearchOutput & LibraryAnswer & { question: string };

function typesafeKey(env: Env): string {
  const key = env.TYPESAFE_API_KEY?.trim();
  if (!key) {
    throw new LibrarySearchUnavailableError(
      "JEV library search is not configured on this server (TYPESAFE_API_KEY is not set)."
    );
  }
  return key;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new LibrarySearchInputError(`${field} must be a string`);
  return value.trim() || undefined;
}

/** Validate a search or ask request body. `field` is "query" or "question". */
export function parseSearchInput(body: Record<string, unknown>, field: "query" | "question"): LibrarySearchInput {
  const text = body[field];
  const max = field === "query" ? MAX_QUERY : MAX_QUESTION;
  if (typeof text !== "string" || !text.trim()) throw new LibrarySearchInputError(`${field} is required`);
  if (text.length > max) throw new LibrarySearchInputError(`${field} must be ${max} characters or fewer`);
  let items: LibrarySearchInput["items"];
  if (body.items !== undefined && body.items !== null) {
    if (!Array.isArray(body.items) || body.items.length > MAX_ITEMS) {
      throw new LibrarySearchInputError(`items must be an array of at most ${MAX_ITEMS} {type, id} objects`);
    }
    items = body.items.map((raw) => {
      const ref = raw as { type?: unknown; id?: unknown };
      if ((ref?.type !== "document" && ref?.type !== "artifact") || typeof ref.id !== "string" || !ref.id) {
        throw new LibrarySearchInputError('each item needs type "document" or "artifact" and an id');
      }
      return { type: ref.type, id: ref.id };
    });
  }
  let limit: number | undefined;
  if (body.limit !== undefined && body.limit !== null) {
    if (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > retrievalLimits.results) {
      throw new LibrarySearchInputError(`limit must be an integer from 1 to ${retrievalLimits.results}`);
    }
    limit = body.limit;
  }
  const budget = body.budget;
  if (budget !== undefined && budget !== null && !(typeof budget === "string" && budget in searchBudgets)) {
    throw new LibrarySearchInputError(`budget must be one of ${Object.keys(searchBudgets).join(", ")}`);
  }
  return {
    query: text.trim(),
    budget: (budget ?? undefined) as SearchBudget | undefined,
    project_id: optionalString(body, "project_id"),
    tag_id: optionalString(body, "tag_id"),
    items,
    limit,
  };
}

async function taggedRefs(env: Env, userId: string, tagId: string): Promise<Set<string>> {
  const rows = await env.DB.prepare(
    "SELECT resource_type, resource_key FROM library_item_tags WHERE user_id = ? AND tag_id = ?"
  ).bind(userId, tagId).all<{ resource_type: string; resource_key: string }>();
  return new Set((rows.results ?? []).map((row) => `${row.resource_type}:${row.resource_key}`));
}

function matchesItem(item: LibraryItem, refs: NonNullable<LibrarySearchInput["items"]>): boolean {
  return refs.some((ref) => ref.type === item.type && (ref.id === item.id || ref.id === item.key));
}

export async function prepareLibraryIndex(env: Env, userId: string, budget = DEFAULT_INDEX_BUDGET): Promise<IndexStatus> {
  const { items: _items, rows: _rows, ...status } = await ensureLibraryIndex(env, userId, budget);
  return status;
}

export async function runLibrarySearch(env: Env, userId: string, input: LibrarySearchInput): Promise<LibrarySearchOutput> {
  const key = typesafeKey(env);
  const [{ items, rows, ...index }, library] = await Promise.all([
    ensureLibraryIndex(env, userId, SEARCH_INDEX_BUDGET),
    getLibraryOverview(env, userId),
  ]);
  let scoped = items;
  if (input.project_id) {
    const project = input.project_id === UNFILED ? "" : input.project_id;
    if (project && !library.projects.some((p) => p.id === project)) {
      throw new LibrarySearchInputError("project_id is not one of your library projects");
    }
    scoped = scoped.filter((item) => item.project_id === project);
  }
  if (input.tag_id) {
    if (!library.tags.some((tag) => tag.id === input.tag_id)) {
      throw new LibrarySearchInputError("tag_id is not one of your library tags");
    }
    const tagged = await taggedRefs(env, userId, input.tag_id);
    scoped = scoped.filter((item) => tagged.has(itemRef(item)));
  }
  if (input.items?.length) scoped = scoped.filter((item) => matchesItem(item, input.items!));

  const searchable: SearchableItem[] = scoped.flatMap((item) => {
    const row = rows.get(itemRef(item));
    return row && isCurrent(item, row) && row.status === "ready" ? [{ item, row }] : [];
  });
  const jev = createJev(key);
  const retrieval = searchable.length
    ? await retrieveFromLibrary(env, jev, input.query, searchable, library.projects, {
        direct: Boolean(input.items?.length || input.project_id),
        maxResults: input.limit,
        budget: input.budget,
      })
    : { results: [], trace: [], scored_passages: 0, limited: false };
  return {
    query: input.query,
    results: retrieval.results.map((result, index) => ({ ref: index + 1, ...result })),
    trace: retrieval.trace,
    scored_passages: retrieval.scored_passages,
    limited: retrieval.limited,
    searched_items: searchable.length,
    index,
    usage: { ...jev.usage, cost_usd: jevCost(jev.usage) },
  };
}

export async function runLibraryAsk(env: Env, userId: string, input: LibrarySearchInput): Promise<LibraryAskOutput> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new LibrarySearchUnavailableError("Library answers are not configured on this server (ANTHROPIC_API_KEY is not set).");
  }
  const search = await runLibrarySearch(env, userId, input);
  let answer: LibraryAnswer;
  try {
    answer = await answerFromPassages(env, input.query, search.results);
  } catch (err) {
    console.error("library answer failed", err instanceof Error ? err.message : err);
    throw new LibraryAnswerError("The answer model did not respond. Try again, or search without an answer.");
  }
  return { ...search, question: input.query, ...answer };
}

export { JevError };
