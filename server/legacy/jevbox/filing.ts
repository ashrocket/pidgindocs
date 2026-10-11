import type { Env } from "../types";
import {
  DOCUMENT_KEY_SQL,
  VISIBLE_ARTIFACTS,
  VISIBLE_DOCUMENTS,
  effectiveProjectSql,
  fileLibraryItems,
  getLibraryOverview,
  type LibraryProject,
  type LibraryResourceType,
  type LibraryTag,
} from "../library";
import { JevError, createJev, jevCost, type JevUsage } from "./jev";
import { LibrarySearchUnavailableError } from "./service";

// JEV filing suggestions: Jevbox's "Organize" for the PidginDocs library. JEV
// chooses which existing project an item belongs to (or none_fit) and what
// kind of item it is. The question and state match
// scripts/pidgin-library-autofile.mjs, whose calibration on 485 filed items
// (2026-10-03) found 100% agreement with the user's filing at confidence
// ≥ 0.85 (83% of items). Below that threshold an item is only suggested.

export const DEFAULT_FILING_CONFIDENCE = 0.85;
const TYPE_TAG_CONFIDENCE = 0.5;
const MAX_ITEMS = 200;
const CONCURRENCY = 8;

// Meanings for common type-tag names; other tags are offered by name only.
const TYPE_MEANINGS: Record<string, string> = {
  status: "A progress or status update: work done so far, something blocked or pending, a checkpoint.",
  release: "Announces something shipped, deployed, published or live (including TestFlight builds).",
  handoff: "A handoff or resume prompt so another agent or session can continue the work.",
  plan: "A plan, strategy, proposal, or set of next steps not yet carried out.",
  research: "A research brief, investigation, or analysis of options or sources.",
  legal: "A legal document: court filing, brief, discovery material, case analysis.",
  access: "About credentials, sign-ins, MFA, accounts, invitations, or permissions.",
  design: "Visual or UI design: mockups, design fixes, brand, icons, landing pages.",
  report: "A data report, inventory, dashboard, chart, or export.",
  media: "A video, animation, storybook, or other creative media piece.",
  visual: "An interactive dashboard, map, diagram, chart, animation, or video rather than mainly text.",
};

export class FilingInputError extends Error {}

export interface FilingSuggestion {
  type: LibraryResourceType;
  id: string;
  title: string;
  current_project_id: string | null;
  /** Suggested project, or null when JEV judged that no project fits. */
  project_id: string | null;
  project_name: string | null;
  probability: number;
  confidence: number;
  /** True when confidence reaches the threshold and a project was chosen. */
  confident: boolean;
  /** A type tag for an item that has no tags yet. */
  tag: { id: string; name: string; confidence: number } | null;
}

export interface FilingResult {
  suggestions: FilingSuggestion[];
  min_confidence: number;
  applied: { filed: number; tagged: number } | null;
  usage: JevUsage & { cost_usd: number };
}

interface Candidate {
  type: LibraryResourceType;
  id: string;
  title: string;
  description: string;
  label: string;
  project_id: string;
  tag_count: number;
}

async function loadCandidates(env: Env, userId: string): Promise<Candidate[]> {
  const tagCount = (type: LibraryResourceType, alias: string) => {
    const key = type === "document" ? DOCUMENT_KEY_SQL(alias) : `${alias}.id`;
    return `(SELECT COUNT(*) FROM library_item_tags t WHERE t.user_id = ${alias}.user_id
      AND t.resource_type = '${type}' AND t.resource_key = ${key})`;
  };
  const [docs, artifacts] = await Promise.all([
    env.DB.prepare(
      `SELECT m.id, m.title, SUBSTR(COALESCE(m.body, ''), 1, 240) AS description,
         COALESCE(m.instance_project, '') AS label, ${effectiveProjectSql("document", "m")} AS project_id,
         ${tagCount("document", "m")} AS tag_count
       FROM messages m WHERE ${VISIBLE_DOCUMENTS}`
    ).bind(userId).all<Omit<Candidate, "type">>(),
    env.DB.prepare(
      `SELECT a.id, a.title, COALESCE(a.description, '') AS description,
         COALESCE(a.instance_project, '') AS label, ${effectiveProjectSql("artifact", "a")} AS project_id,
         ${tagCount("artifact", "a")} AS tag_count
       FROM artifacts a WHERE ${VISIBLE_ARTIFACTS}`
    ).bind(userId).all<Omit<Candidate, "type">>(),
  ]);
  return [
    ...(docs.results ?? []).map((row) => ({ ...row, type: "document" as const })),
    ...(artifacts.results ?? []).map((row) => ({ ...row, type: "artifact" as const })),
  ];
}

function readChoice(answer: unknown, keys: string[]): { choice: string; probability: number; confidence: number } {
  const value = answer as { choice?: unknown; probabilities?: Record<string, unknown>; confidence?: unknown } | undefined;
  const choice = typeof value?.choice === "string" ? value.choice : "";
  const probability = value?.probabilities?.[choice];
  if (!keys.includes(choice) || typeof probability !== "number" || typeof value?.confidence !== "number") {
    throw new JevError("JEV returned an invalid filing answer.");
  }
  return { choice, probability, confidence: value.confidence };
}

export function parseFilingInput(body: Record<string, unknown>): {
  items?: { type: LibraryResourceType; id: string }[];
  apply: boolean;
  minConfidence: number;
} {
  let items: { type: LibraryResourceType; id: string }[] | undefined;
  if (body.items !== undefined && body.items !== null) {
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > MAX_ITEMS) {
      throw new FilingInputError(`items must be an array of 1 to ${MAX_ITEMS} {type, id} objects`);
    }
    items = body.items.map((raw) => {
      const ref = raw as { type?: unknown; id?: unknown };
      if ((ref?.type !== "document" && ref?.type !== "artifact") || typeof ref.id !== "string" || !ref.id) {
        throw new FilingInputError('each item needs type "document" or "artifact" and an id');
      }
      return { type: ref.type, id: ref.id };
    });
  }
  if (body.apply !== undefined && typeof body.apply !== "boolean") throw new FilingInputError("apply must be a boolean");
  const minConfidence = body.min_confidence === undefined ? DEFAULT_FILING_CONFIDENCE : Number(body.min_confidence);
  if (!Number.isFinite(minConfidence) || minConfidence < 0.5 || minConfidence > 1) {
    throw new FilingInputError("min_confidence must be a number from 0.5 to 1");
  }
  return { items, apply: body.apply === true, minConfidence };
}

/**
 * Suggest a project (and a type tag) for items — by default every unfiled
 * item. With `apply`, confident suggestions are filed explicitly and type tags
 * are added to untagged items; everything else is left for the user.
 */
export async function suggestFiling(
  env: Env,
  userId: string,
  input: ReturnType<typeof parseFilingInput>
): Promise<FilingResult> {
  const key = env.TYPESAFE_API_KEY?.trim();
  if (!key) throw new LibrarySearchUnavailableError("JEV filing is not configured on this server (TYPESAFE_API_KEY is not set).");
  const library = await getLibraryOverview(env, userId);
  const projects: LibraryProject[] = library.projects.filter((project) => !project.archived_at);
  const jev = createJev(key);
  const empty: FilingResult = {
    suggestions: [],
    min_confidence: input.minConfidence,
    applied: input.apply ? { filed: 0, tagged: 0 } : null,
    usage: { ...jev.usage, cost_usd: 0 },
  };
  if (!projects.length) return empty;

  const all = await loadCandidates(env, userId);
  const candidates = input.items
    ? all.filter((c) => input.items!.some((ref) => ref.type === c.type && ref.id === c.id))
    : all.filter((c) => c.project_id === "").slice(0, MAX_ITEMS);
  if (!candidates.length) return empty;

  const tags: LibraryTag[] = library.tags;
  const projectKeys = [...projects.map((p) => p.id), "none_fit"];
  const suggestions: FilingSuggestion[] = new Array(candidates.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, async () => {
      while (next < candidates.length) {
        const index = next++;
        const item = candidates[index];
        const answers = await jev.evaluate(
          { title: item.title, description: item.description, agent_label: item.label },
          {
            project: {
              type: "choice",
              instructions:
                "Which of these projects does this document or artifact (described by `title` and `description`) belong to? `agent_label` is the agent workspace that produced it; it is a hint, not proof.",
              criteria: {
                ...Object.fromEntries(projects.map((p) => [p.id, `${p.name}: ${p.description || p.name}`])),
                none_fit: "None of the projects fits this item.",
              },
            },
            ...(tags.length
              ? {
                  type: {
                    type: "choice",
                    instructions: "What kind of item is this document or artifact, judged from `title` and `description`?",
                    criteria: Object.fromEntries(
                      tags.map((t) => [t.id, TYPE_MEANINGS[t.name] ? `${t.name}: ${TYPE_MEANINGS[t.name]}` : t.name])
                    ),
                  },
                }
              : {}),
          }
        );
        const project = readChoice(answers.project, projectKeys);
        const type = tags.length ? readChoice(answers.type, tags.map((t) => t.id)) : null;
        const chosen = project.choice === "none_fit" ? null : projects.find((p) => p.id === project.choice)!;
        const tag = type && item.tag_count === 0 && type.confidence >= TYPE_TAG_CONFIDENCE
          ? { id: type.choice, name: tags.find((t) => t.id === type.choice)!.name, confidence: type.confidence }
          : null;
        suggestions[index] = {
          type: item.type,
          id: item.id,
          title: item.title,
          current_project_id: item.project_id || null,
          project_id: chosen?.id ?? null,
          project_name: chosen?.name ?? null,
          probability: project.probability,
          confidence: project.confidence,
          confident: !!chosen && project.confidence >= input.minConfidence,
          tag,
        };
      }
    })
  );

  let applied: FilingResult["applied"] = null;
  if (input.apply) {
    applied = { filed: 0, tagged: 0 };
    const byProject = new Map<string, { type: LibraryResourceType; id: string }[]>();
    for (const s of suggestions) {
      if (!s.confident || s.project_id === s.current_project_id) continue;
      byProject.set(s.project_id!, [...(byProject.get(s.project_id!) ?? []), { type: s.type, id: s.id }]);
    }
    for (const [projectId, items] of byProject) {
      applied.filed += (await fileLibraryItems(env, userId, { items, project_id: projectId })).updated;
    }
    const byTag = new Map<string, { type: LibraryResourceType; id: string }[]>();
    for (const s of suggestions) {
      if (s.tag) byTag.set(s.tag.id, [...(byTag.get(s.tag.id) ?? []), { type: s.type, id: s.id }]);
    }
    for (const [tagId, items] of byTag) {
      applied.tagged += (await fileLibraryItems(env, userId, { items, add_tags: [tagId] })).updated;
    }
  }
  return {
    suggestions,
    min_confidence: input.minConfidence,
    applied,
    usage: { ...jev.usage, cost_usd: jevCost(jev.usage) },
  };
}
