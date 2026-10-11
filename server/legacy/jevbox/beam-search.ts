// Beam traversal over a described tree, ported from Jevbox
// (https://github.com/extend-hq/jevbox, server/beam-search.ts, MIT).
//
// Each frontier node's children form one JEV Choice menu (with a "none"
// option); menus are batched up to the routing character budget. The beam
// keeps four routes ranked by the geometric mean of their edge probabilities.
// Routes JEV rates at or below "none" are deferred, not discarded, so weak
// evidence can widen the search later.

import { retrievalLimits, type Distribution, type Jev } from "./jev";

export interface RouteNode<T> {
  id: string;
  /** Description shown to JEV; undefined hides the node. */
  describe: () => Promise<string | undefined>;
  children: RouteNode<T>[];
  loadChildren?: () => Promise<RouteNode<T>[]>;
  /** Groups section visits by item, so one item cannot use the whole budget. */
  scope?: string;
  value?: T;
}

export interface Route<T> {
  node: RouteNode<T>;
  path: RouteNode<T>[];
  logProbability: number;
  decisions: number;
  probability: number;
  score: number;
}

export function extendRoute<T>(route: Route<T>, node: RouteNode<T>, probability: number, decision: boolean): Route<T> {
  const logProbability = route.logProbability + (decision ? Math.log(probability) : 0);
  const decisions = route.decisions + Number(decision);
  return {
    node,
    path: [...route.path, node],
    logProbability,
    decisions,
    probability,
    score: decisions ? Math.exp(logProbability / decisions) : 1,
  };
}

export function createTraversal<T>(
  roots: RouteNode<T>[],
  jev: Pick<Jev, "choose">,
  query: string,
  hasEvidence: (node: RouteNode<T>) => boolean,
  recoverRoutes = true,
  limits: { expansions: number } = retrievalLimits
) {
  const root: RouteNode<T> = { id: "library", describe: async () => "Library", children: roots };
  let beam: Route<T>[] = [{ node: root, path: [], logProbability: 0, decisions: 0, probability: 1, score: 1 }];
  const deferred: Route<T>[] = [];
  const visited = new Set<string>();
  const expandedNodes = new Set<string>();
  const evidenceVisits = new Map<string, number>();
  let expansions = 0;
  const rank = (a: Route<T>, b: Route<T>) => {
    const rounds = (route: Route<T>) =>
      Math.floor((evidenceVisits.get(route.node.scope ?? "") ?? 0) / retrievalLimits.sectionsPerDocument);
    return rounds(a) - rounds(b) || b.score - a.score;
  };

  return {
    get limited() {
      return expansions >= limits.expansions;
    },
    get exhausted() {
      return expansions >= limits.expansions || (!beam.length && !deferred.length);
    },
    /** Advance until new evidence-bearing routes appear; returns newly visited routes. */
    async walk(): Promise<Route<T>[]> {
      const found: Route<T>[] = [];
      beam = [...beam, ...deferred.splice(0)].sort(rank);
      deferred.push(...beam.splice(retrievalLimits.beamWidth));
      while (beam.length && expansions < limits.expansions) {
        const described: Route<T>[] = [];
        let newEvidence = false;
        for (const route of beam) {
          if ((await route.node.describe()) === undefined) continue;
          described.push(route);
          if (!visited.has(route.node.id)) {
            visited.add(route.node.id);
            found.push(route);
            if (hasEvidence(route.node)) {
              newEvidence = true;
              if (route.node.scope) {
                evidenceVisits.set(route.node.scope, (evidenceVisits.get(route.node.scope) ?? 0) + 1);
              }
            }
          }
        }
        beam = described;
        if (newEvidence) return found;

        const prepared: { route: Route<T>; choices: { id: string; text: string; node: RouteNode<T> }[] }[] = [];
        for (const route of beam) {
          expandedNodes.add(route.node.id);
          const children = route.node.loadChildren ? await route.node.loadChildren() : route.node.children;
          if (!children.length) continue;
          if (++expansions > limits.expansions) break;
          const choices = (
            await Promise.all(
              children.map(async (node) => {
                const text = await node.describe();
                return text === undefined ? [] : [{ id: node.id, text, node }];
              })
            )
          ).flat();
          if (choices.length) prepared.push({ route, choices });
        }
        if (!prepared.length) break;

        const distributions = new Map<string, Distribution>();
        let pending: typeof prepared = [];
        let characters = 0;
        const dispatch = async () => {
          const menus = pending
            .filter((menu) => menu.choices.length > 1)
            .map((menu) => ({ id: menu.route.node.id, choices: menu.choices.map(({ id, text }) => ({ id, text })) }));
          for (const [id, distribution] of await jev.choose(query, menus)) distributions.set(id, distribution);
          pending = [];
          characters = 0;
        };
        for (const menu of prepared) {
          const size = JSON.stringify(menu.choices.map(({ id, text }) => ({ id, text }))).length;
          if (pending.length && characters + size > retrievalLimits.routingCharacters) await dispatch();
          pending.push(menu);
          characters += size;
        }
        if (pending.length) await dispatch();

        const expanded: Route<T>[] = [];
        for (const { route, choices } of prepared) {
          const decision = choices.length > 1;
          const distribution = distributions.get(route.node.id);
          for (const choice of choices) {
            const probability = decision ? distribution![choice.id] : 1;
            const rejected = probability <= 0 || (decision && probability <= distribution!.none);
            if (rejected && !recoverRoutes) continue;
            const next = extendRoute(route, choice.node, Math.max(probability, 0.000001), decision);
            if (rejected) deferred.push(next);
            else expanded.push(next);
          }
        }
        const ranked = [...expanded, ...deferred.splice(0)].sort(rank);
        beam = ranked.slice(0, retrievalLimits.beamWidth);
        deferred.push(...ranked.slice(retrievalLimits.beamWidth).filter((route) => !expandedNodes.has(route.node.id)));
        deferred.splice(limits.expansions);
      }
      beam = [];
      return found;
    },
  };
}
