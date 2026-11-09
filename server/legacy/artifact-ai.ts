// PidginCore: optional hook for composing a long document into a page with AI.
// This repository ships no AI page generation, so the default is none. A
// deployment that has some registers it with setArtifactAI. Nothing here knows
// a model, a provider, a limit or a price.
import type { Env } from "./types";

export interface ArtifactAIHooks {
  // Returns the composed page, or null when it could not make one.
  generate(env: Env, userId: string, input: { markdown: string; title?: string }): Promise<{ html: string } | null>;
}

let hooks: ArtifactAIHooks | null = null;

export function setArtifactAI(h: ArtifactAIHooks | null): void {
  hooks = h;
}

// null means no hook: the caller publishes a plain artifact.
export function artifactAI(): ArtifactAIHooks | null {
  return hooks;
}
