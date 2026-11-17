/**
 * The AI tier registry. Code, settings, prices and customer-facing text name a
 * tier; this file holds the only map from a tier to its provider and model, and
 * the only price tables. Moving to a new model is a one-line change here.
 *
 * Customer-facing text says "fast" or "deep", never a model name.
 */

export type AiTier = "workers-fast" | "claude-fast" | "claude-deep" | "embed" | "openai-fast";
export type AiProvider = "workers-ai" | "anthropic" | "openai";

export interface TierSpec {
  provider: AiProvider;
  model: string;
  /** False while the tier cannot be called, for example until a provider key exists. */
  enabled: boolean;
}

export const TIERS: Readonly<Record<AiTier, TierSpec>> = Object.freeze({
  "workers-fast": { provider: "workers-ai", model: "@cf/google/gemma-4-26b-a4b-it", enabled: true },
  "claude-fast": { provider: "anthropic", model: "claude-haiku-5-5", enabled: true },
  "claude-deep": { provider: "anthropic", model: "claude-sonnet-5-5", enabled: true },
  "embed": { provider: "workers-ai", model: "@cf/baai/bge-m3", enabled: true },
  // Defined so the name exists. No OpenAI call is made until a key exists and this is turned on.
  "openai-fast": { provider: "openai", model: "gpt-6-luna", enabled: false },
});

/** The tier a failed call falls back to, in order. A tier absent here has no fallback. */
const FALLBACKS: Readonly<Partial<Record<AiTier, readonly AiTier[]>>> = Object.freeze({
  "claude-fast": ["workers-fast"],
  "claude-deep": ["claude-fast", "workers-fast"],
  "workers-fast": [],
});

export function resolveTier(tier: AiTier): TierSpec {
  const spec = TIERS[tier];
  if (!spec) throw new Error(`Unknown AI tier: ${String(tier)}`);
  return spec;
}

export function fallbackChain(tier: AiTier): AiTier[] {
  return [...(FALLBACKS[tier] ?? [])];
}

export interface TokenPrice { in: number; out: number }

/**
 * Dollars per million tokens, input then output, keyed by model ID.
 * Workers AI prices come from https://developers.cloudflare.com/workers-ai/platform/pricing/
 * (read 2026-11-09). bge-m3 is listed there at $0.012 per million input tokens;
 * the meter keeps bge-large-en-v1.5's $0.204, which is conservative. Cached-input
 * rates are ignored, which also overstates cost.
 */
export const WORKERS_AI_PRICES: Record<string, TokenPrice> = {
  "@cf/google/gemma-4-26b-a4b-it": { in: 0.10, out: 0.30 },
  "@cf/baai/bge-m3": { in: 0.204, out: 0 },
  // Priced so an accidental route is not metered at the unknown-model price.
  "@cf/openai/gpt-oss-120b": { in: 0.35, out: 0.75 },
  "@cf/zai-org/glm-4.7-flash": { in: 0.06, out: 0.40 },
  "@cf/zai-org/glm-5.2": { in: 1.40, out: 4.40 },
  "@cf/zai-org/glm-5.3": { in: 1.40, out: 4.40 },
  "@cf/zai-org/glm-5.3-flash": { in: 0.15, out: 0.50 },
};

/**
 * Dollars per million tokens for the Anthropic models, from the first-party
 * rates at https://www.anthropic.com/pricing. Cache reads and writes are not
 * metered; every token is charged at the plain rate, which overstates cost.
 */
export const ANTHROPIC_PRICES: Record<string, TokenPrice> = {
  "claude-haiku-5-5": { in: 0.10, out: 0.50 },
  "claude-sonnet-5-5": { in: 2.00, out: 10.00 },
};

/** TypeSafe first-party models.md, verified 2026-11-12: output is free. */
export const TYPESAFE_PRICES: Record<string, TokenPrice> = { "jev-1.14.0": { in: 0.042, out: 0 } };

/** What a model that has no entry above is metered at. */
export const UNKNOWN_MODEL_PRICE: TokenPrice = { in: 1.40, out: 4.40 };

/** Micro-dollars for one call, rounded up. $ per million tokens is micro-dollars per token. */
export function priceMicroUsd(model: string, inTok: number, outTok: number): number {
  const price = WORKERS_AI_PRICES[model] ?? ANTHROPIC_PRICES[model] ?? TYPESAFE_PRICES[model] ?? UNKNOWN_MODEL_PRICE;
  // Subtract a hair so 0.1 * 1000 style float noise does not round a whole micro-dollar up.
  return Math.max(0, Math.ceil(inTok * price.in + outTok * price.out - 1e-6));
}

/** Gemma 4 reasons before answering unless thinking is turned off; other models take the plain input. */
export function disablesThinking(model: string): boolean {
  return model.startsWith("@cf/google/gemma-4");
}

/**
 * Defaults for the Commute feature, which runs on the customer's own OpenAI key. They are
 * not tiers: the customer can type another model in Setup, and no call of this product uses them.
 */
export const COMMUTE_SPEECH_MODEL = "gpt-4o-mini-tts";
export const COMMUTE_SCRIPT_MODEL = "gpt-4.1-mini";
