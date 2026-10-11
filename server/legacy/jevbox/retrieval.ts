// Hierarchical JEV retrieval over the PidginDocs library, ported from Jevbox
// (https://github.com/extend-hq/jevbox, server/retrieval.ts, MIT).
//
// Tree: Library → Projects (and Unfiled) → documents/artifacts → sections.
// JEV Choice routes the query down the tree with a beam; reached sections
// supply their original source passages, which JEV Score rates for
// usefulness (0–3). Passages below 1.5 are dropped. Search stops when one
// passage fully answers the question (≥ 2.75), or when the best partial
// passages together do. A route score ranks paths; it is not a probability
// that a passage answers the question. There is no keyword or embedding
// fallback: an empty result stays empty.

import type { Env } from "../types";
import type { LibraryProject } from "../library";
import { createTraversal, type RouteNode } from "./beam-search";
import { buildSectionPreviews, flatten, metadataCandidates, type IndexNode } from "./indexing";
import { itemRef, loadParsedItem, type IndexRow, type LibraryItem } from "./index-store";
import { retrievalLimits, searchBudgets, type Jev, type SearchBudget } from "./jev";

export interface RetrievalStep {
  stage: "category" | "item" | "section";
  label: string;
  item?: { type: LibraryItem["type"]; id: string };
  project_id?: string | null;
  section_id?: string;
  probability?: number;
  route_score?: number;
}

export interface RetrievedPassage {
  type: LibraryItem["type"];
  id: string;
  title: string;
  /** When the item was sent (UTC, "YYYY-MM-DD HH:MM:SS"). */
  created_at: string;
  project_id: string | null;
  section_id: string;
  section_path: string[];
  passage_id: string;
  content: string;
  score: number;
  route_score: number;
}

type SourceDraft = Omit<RetrievedPassage, "score" | "route_score">;
interface Value {
  step: RetrievalStep;
  sources: SourceDraft[];
}

export interface SearchableItem {
  item: LibraryItem;
  row: IndexRow;
}

export interface RetrieveOptions {
  /** Restrict routing to these items, listed directly (no project level). */
  direct?: boolean;
  maxResults?: number;
  /** "standard" (default) for the app; "thorough" for agents. */
  budget?: SearchBudget;
}

export interface RetrievalResult {
  results: RetrievedPassage[];
  trace: RetrievalStep[];
  scored_passages: number;
  limited: boolean;
}

const UNFILED_CATEGORY = "unfiled";

function describeItem(item: LibraryItem, row: IndexRow): string {
  const kind = item.type === "document" ? "Document" : "Artifact";
  const date = item.created_at.slice(0, 10);
  return `${item.title}\n${kind}, ${date}${item.description ? `\n${item.description.slice(0, 300)}` : ""}\n${row.outline}`.slice(0, 1200);
}

export async function retrieveFromLibrary(
  env: Env,
  jev: Pick<Jev, "choose" | "scorePassages" | "score">,
  query: string,
  searchable: SearchableItem[],
  projects: LibraryProject[],
  options: RetrieveOptions = {}
): Promise<RetrievalResult> {
  const maxResults = Math.min(retrievalLimits.results, options.maxResults ?? retrievalLimits.results);
  const budget = searchBudgets[options.budget ?? "standard"];
  const maxPassages = budget.passages;
  const projectNames = new Map(projects.map((project) => [project.id, project]));

  function bounded(nodes: RouteNode<Value>[], parent: string): RouteNode<Value>[] {
    if (nodes.length <= retrievalLimits.menuSize) return nodes;
    const categories = nodes.filter((node) => node.value?.step.stage === "category");
    if (categories.length && categories.length < retrievalLimits.menuSize) {
      const other = nodes.filter((node) => node.value?.step.stage !== "category");
      if (other.length) {
        const grouped = bounded(other, `${parent}:sources`);
        if (categories.length + grouped.length <= retrievalLimits.menuSize) return [...categories, ...grouped];
      }
    }
    const groups: RouteNode<Value>[] = [];
    const size = Math.max(retrievalLimits.menuSize, Math.ceil(nodes.length / retrievalLimits.menuSize));
    const groupBudget = Math.floor((retrievalLimits.routingCharacters - 4096) / Math.ceil(nodes.length / size));
    for (let start = 0; start < nodes.length; start += size) {
      const children = bounded(nodes.slice(start, start + size), `${parent}:group:${start}`);
      groups.push({
        id: `${parent}:group:${start}`,
        children,
        describe: async () => {
          const descriptions = (await Promise.all(children.map((child) => child.describe()))).filter(
            (text): text is string => text !== undefined
          );
          const length = Math.floor(groupBudget / Math.max(1, descriptions.length));
          return descriptions.length ? `Source group: ${descriptions.map((text) => text.slice(0, length)).join("\n")}` : undefined;
        },
      });
    }
    return groups;
  }

  function sectionNode(
    entry: SearchableItem,
    node: IndexNode,
    previews: ReadonlyMap<string, string>,
    ancestors: string[] = []
  ): RouteNode<Value> {
    const { item } = entry;
    const path = [...ancestors, node.title];
    const id = `section:${itemRef(item)}:${node.id}`;
    return {
      id,
      scope: itemRef(item),
      describe: async () => previews.get(node.id) ?? `${node.title}\n${node.summary}`.slice(0, 1200),
      children: bounded(node.children.map((child) => sectionNode(entry, child, previews, path)), id),
      value: {
        step: {
          stage: "section",
          label: node.title,
          item: { type: item.type, id: item.id },
          section_id: node.id,
        },
        sources: node.passages.map((passage) => ({
          type: item.type,
          id: item.id,
          title: item.title,
          created_at: item.created_at,
          project_id: item.project_id || null,
          section_id: node.id,
          section_path: path,
          passage_id: passage.id,
          content: passage.content,
        })),
      },
    };
  }

  const itemNodes = new Map<string, RouteNode<Value>>();
  function itemNode(entry: SearchableItem): RouteNode<Value> {
    const ref = itemRef(entry.item);
    const cached = itemNodes.get(ref);
    if (cached) return cached;
    let children: RouteNode<Value>[] | undefined;
    const node: RouteNode<Value> = {
      id: `item:${ref}`,
      scope: ref,
      describe: async () => describeItem(entry.item, entry.row),
      children: [],
      loadChildren: async () => {
        if (!children) {
          const parsed = await loadParsedItem(env, entry.row);
          if (!parsed) return (children = []);
          const previews = buildSectionPreviews(parsed.nodes, query);
          children = bounded(
            parsed.nodes.map((section) => sectionNode(entry, section, previews)),
            `item:${ref}`
          );
        }
        return children;
      },
      value: {
        step: {
          stage: "item",
          label: entry.item.title,
          item: { type: entry.item.type, id: entry.item.id },
          project_id: entry.item.project_id || null,
        },
        sources: [],
      },
    };
    itemNodes.set(ref, node);
    return node;
  }

  function categoryNode(id: string, name: string, description: string, entries: SearchableItem[]): RouteNode<Value> {
    const children = entries.map(itemNode);
    return {
      id: `category:${id}`,
      describe: async () => {
        const outlines = (await Promise.all(children.map((child) => child.describe()))).filter(
          (text): text is string => text !== undefined
        );
        const budget = Math.min(
          16000,
          Math.floor((retrievalLimits.routingCharacters - 8192) / Math.max(1, Math.min(retrievalLimits.menuSize, categoryCount)))
        );
        const prefix = `${name}\n${description.slice(0, 600)}\nContained sources:\n`.slice(0, budget);
        const size = Math.max(0, Math.floor((budget - prefix.length - outlines.length) / Math.max(1, outlines.length)));
        return prefix + outlines.map((outline) => outline.slice(0, size)).join("\n");
      },
      children: bounded(children, `category:${id}`),
      value: { step: { stage: "category", label: name, project_id: id === UNFILED_CATEGORY ? null : id }, sources: [] },
    };
  }

  // Newest first, so menus and their bounded groups lead with recent items.
  searchable = [...searchable].sort((a, b) => b.item.created_at.localeCompare(a.item.created_at));

  // Group items by project; a single group (or a direct search) skips the project level.
  const groups = new Map<string, SearchableItem[]>();
  for (const entry of searchable) {
    const project = entry.item.project_id && projectNames.has(entry.item.project_id) ? entry.item.project_id : UNFILED_CATEGORY;
    const list = groups.get(project) ?? [];
    list.push(entry);
    groups.set(project, list);
  }
  const categoryCount = groups.size;
  const roots: RouteNode<Value>[] =
    options.direct || groups.size <= 1
      ? searchable.map(itemNode)
      : [...groups.entries()]
          .sort(([a], [b]) => (a === UNFILED_CATEGORY ? 1 : b === UNFILED_CATEGORY ? -1 : 0))
          .map(([id, entries]) => {
            const project = projectNames.get(id);
            return project
              ? categoryNode(id, project.name, project.description ?? "", entries)
              : categoryNode(UNFILED_CATEGORY, "Unfiled", "Items not filed in any project.", entries);
          });

  // A small direct-candidate branch from distinctive title/outline matches.
  if (!options.direct && searchable.length > 1) {
    const byRef = new Map(searchable.map((entry) => [itemRef(entry.item), entry]));
    const preferred = metadataCandidates(
      searchable.map((entry) => ({ id: itemRef(entry.item), name: entry.item.title, outline: entry.row.outline })),
      query
    );
    if (preferred.length) {
      const candidates = preferred.map((candidate) => ({
        ...itemNode(byRef.get(candidate.id)!),
        describe: async () => candidate.hint,
      }));
      roots.unshift({
        id: "metadata-candidates",
        children: candidates,
        describe: async () =>
          `Direct source candidates from matching titles and outlines. These partial outlines locate sources; their facts still require verification.\n${preferred
            .map((candidate) => candidate.hint.slice(0, Math.floor(6000 / preferred.length)))
            .join("\n")}`,
      });
    }
  }

  const traversal = createTraversal(
    bounded(roots, "library"),
    jev,
    query,
    (node) => Boolean(node.value?.sources.length),
    true,
    { expansions: budget.expansions }
  );
  const results: RetrievedPassage[] = [];
  const trace: RetrievalStep[] = [];
  const candidates: (SourceDraft & { route_score: number })[] = [];
  const passageCounts = new Map<string, number>();
  const evidence = (source: SourceDraft) =>
    `Source: ${source.title}\nSection: ${source.section_path.join(" › ")}\n\n${source.content}`;
  let scored = 0;
  let coverageChecked = "";

  /** Score one batch, then decide whether the evidence is enough to stop. */
  const scoreBatch = async (batch: typeof candidates): Promise<boolean> => {
    const scores = await jev.scorePassages(query, batch.map(evidence));
    batch.forEach((source, index) => {
      if (scores[index] >= retrievalLimits.minimumScore) results.push({ ...source, score: scores[index] });
    });
    if (results.some((source) => source.score >= retrievalLimits.sufficientScore)) return true;
    // Nothing useful in the most promising routes: more routing rarely helps.
    if (!results.length && scored >= retrievalLimits.noEvidenceStop) return true;
    if (results.length >= retrievalLimits.minimumUsefulResults) {
      const best = rank([...results]).slice(0, maxResults);
      const identity = best.map((source) => `${source.id}:${source.passage_id}`).join("|");
      if (identity !== coverageChecked) {
        coverageChecked = identity;
        const combined = await jev.score(query, best.map(evidence).join("\n\n").slice(0, retrievalLimits.contextCharacters));
        if (combined >= retrievalLimits.sufficientScore) return true;
      }
    }
    return false;
  };

  // Routing and scoring overlap: while JEV scores one batch of passages, the
  // traversal routes toward the next. A finished batch can stop the search.
  let scoring: Promise<boolean> | null = null;
  for (;;) {
    const routing = !traversal.exhausted && scored < maxPassages ? traversal.walk() : Promise.resolve([]);
    const [routes, stop] = await Promise.all([routing, scoring ?? Promise.resolve(false)]);
    scoring = null;
    if (stop) break;
    for (const route of routes) {
      if (!route.node.value) continue;
      const { step, sources } = route.node.value;
      trace.push({ ...step, probability: route.probability, route_score: route.score });
      for (const source of sources) candidates.push({ ...source, route_score: route.score });
    }
    if (scored >= maxPassages) break;
    if (!candidates.length) {
      if (traversal.exhausted) break;
      continue;
    }
    const batch: typeof candidates = [];
    // Until a passage is useful, never score past the no-evidence stop.
    const untilStop = results.length ? Infinity : retrievalLimits.noEvidenceStop - scored;
    const size = Math.min(retrievalLimits.evidenceBatchSize, maxPassages - scored, Math.max(1, untilStop));
    while (candidates.length && batch.length < size) {
      const rounds = (source: SourceDraft) =>
        Math.floor((passageCounts.get(`${source.type}:${source.id}`) ?? 0) / retrievalLimits.sectionsPerDocument);
      candidates.sort((a, b) => rounds(a) - rounds(b) || b.route_score - a.route_score);
      const source = candidates.shift()!;
      batch.push(source);
      const ref = `${source.type}:${source.id}`;
      passageCounts.set(ref, (passageCounts.get(ref) ?? 0) + 1);
    }
    scored += batch.length;
    scoring = scoreBatch(batch);
  }

  const context: RetrievedPassage[] = [];
  let characters = 0;
  for (const source of rank(results)) {
    if (context.length >= maxResults) break;
    if (characters + source.content.length > retrievalLimits.contextCharacters) continue;
    if (
      context.some(
        (existing) =>
          existing.id === source.id && existing.section_id === source.section_id && existing.content.includes(source.content)
      )
    ) {
      continue;
    }
    context.push(source);
    characters += source.content.length;
  }
  return {
    results: context,
    trace,
    scored_passages: scored,
    limited: traversal.limited || !traversal.exhausted || candidates.length > 0 || scored >= maxPassages,
  };
}

/**
 * Most useful first. Scores in the same quarter-point band (2.75–3 is the
 * "answers" band) count as equal,
 * and then the more recent item wins; route score breaks remaining ties.
 */
export function rank<T extends { score: number; route_score: number; created_at: string }>(passages: T[]): T[] {
  const band = (score: number) => Math.floor(score * 4);
  return passages.sort(
    (a, b) =>
      band(b.score) - band(a.score) ||
      b.created_at.localeCompare(a.created_at) ||
      b.score - a.score ||
      b.route_score - a.route_score
  );
}

/** Count of sections in an item's stored tree (for tests and diagnostics). */
export function sectionCount(nodes: IndexNode[]): number {
  return flatten(nodes).length;
}
