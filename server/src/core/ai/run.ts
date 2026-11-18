import { editionAiBudgetLeft } from "../edition-hooks";
import { estimateTokens, recordUsageSafely, usageWithEstimate } from "./meter";
import type { Env } from "../types";
import { disablesThinking, fallbackChain, resolveTier, type AiTier } from "./tiers";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const WEB_SEARCH_MAX_USES = 5;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface TierRequest {
  system?: string;
  user: string;
  maxTokens: number;
  /** Anthropic only; a Workers AI hop ignores it. */
  webSearch?: boolean;
  timeoutMs?: number;
}

export interface TierResult {
  text: string;
  /** The tier that answered, which differs from the one asked for after a fallback hop. */
  tier: AiTier;
  model: string;
  /** True when the tier that answered is not the one asked for. */
  fellBack: boolean;
}

/** The workspace's AI allowance is spent. It stops the call and never falls back to a cheaper model. */
export class AiAllowanceSpentError extends Error {
  constructor() {
    super("This workspace has used this month's AI allowance.");
  }
}

/** A provider answered with an error that is not a reason to try the next tier. */
export class AiTierError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** A reason to move to the next tier: 429, 5xx, a timeout, or a missing provider key. */
class Hop extends Error {
  /** The provider may have billed the prompt of a request that timed out. */
  constructor(message: string, readonly timedOut = false) {
    super(message);
  }
}

interface Completion { text: string; inTok: number; outTok: number }

async function callAnthropicTier(env: Env, model: string, req: TierRequest): Promise<Completion> {
  if (!env.ANTHROPIC_API_KEY) throw new Hop("ANTHROPIC_API_KEY is not configured");
  const body: Record<string, unknown> = {
    model,
    max_tokens: req.maxTokens,
    messages: [{ role: "user", content: req.user }],
  };
  if (req.system) body.system = req.system;
  if (req.webSearch) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: WEB_SEARCH_MAX_USES }];
  let response: Response;
  try {
    response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeout(error)) throw new Hop("timed out", true);
    throw new Hop( `request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 429 || response.status >= 500) throw new Hop(`status ${response.status}`);
  const data = (await response.json().catch(() => ({}))) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };
  if (!response.ok) throw new AiTierError(`Anthropic API error ${response.status}: ${data.error?.message || "unknown"}`, response.status);
  const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  return { text, inTok: Number(data.usage?.input_tokens) || 0, outTok: Number(data.usage?.output_tokens) || 0 };
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function workersText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!output || typeof output !== "object") return "";
  const o = output as { choices?: Array<{ message?: { content?: unknown } }>; response?: unknown; result?: unknown };
  const content = o.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (typeof o.response === "string") return o.response;
  if (typeof o.result === "string") return o.result;
  return "";
}

async function callWorkersTier(env: Env, model: string, req: TierRequest): Promise<Completion> {
  const ai = env.AI as unknown as { run(model: string, input: Record<string, unknown>): Promise<unknown> } | undefined;
  if (!ai || typeof ai.run !== "function") throw new Hop("the Workers AI binding is missing");
  const messages = [
    ...(req.system ? [{ role: "system", content: req.system }] : []),
    { role: "user", content: req.user },
  ];
  const input: Record<string, unknown> = { messages, max_tokens: req.maxTokens };
  if (disablesThinking(model)) input.chat_template_kwargs = { enable_thinking: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let output: unknown;
  try {
    output = await Promise.race([
      Promise.resolve().then(() => ai.run(model, input)).catch((error: unknown) => {
        throw new Hop(`Workers AI failed: ${error instanceof Error ? error.message : String(error)}`);
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Hop("timed out", true)), req.timeoutMs ?? DEFAULT_TIMEOUT_MS); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const usage = (output as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
  return { text: workersText(output), inTok: Number(usage?.prompt_tokens) || 0, outTok: Number(usage?.completion_tokens) || 0 };
}

/**
 * Runs a request on a tier and, on 429, 5xx, a timeout or a missing provider key, on
 * each tier of its fallback chain in turn. Every hop that answers is metered at its own
 * model's price through recordAiUsage. A spent allowance stops the call before the first
 * hop and before every later one, so it never leads to a cheaper model.
 */
export async function runTier(env: Env, tier: AiTier, req: TierRequest, options: { ctx?: ExecutionContext; noFallback?: boolean } = {}): Promise<TierResult> {
  const chain: AiTier[] = options.noFallback ? [tier] : [tier, ...fallbackChain(tier)];
  const promptChars = (req.system?.length ?? 0) + req.user.length;
  let lastReason = "tier is disabled";
  for (const candidate of chain) {
    const spec = resolveTier(candidate);
    if (!spec.enabled || (spec.provider !== "anthropic" && spec.provider !== "workers-ai")) continue;
    if (await editionAiBudgetLeft(env) <= 0) throw new AiAllowanceSpentError();
    try {
      const done = spec.provider === "anthropic"
        ? await callAnthropicTier(env, spec.model, req)
        : await callWorkersTier(env, spec.model, req);
      const { inTok, outTok } = usageWithEstimate(done.inTok, done.outTok, promptChars, done.text);
      await recordUsageSafely(env, options.ctx, spec.model, inTok, outTok);
      return { text: done.text, tier: candidate, model: spec.model, fellBack: candidate !== tier };
    } catch (error) {
      if (!(error instanceof Hop)) throw error;
      lastReason = error.message;
      // A timed-out request may still be billed for its prompt, so charge that and no output.
      if (error.timedOut) await recordUsageSafely(env, options.ctx, spec.model, estimateTokens(promptChars), 0);
    }
  }
  throw new AiTierError(`No AI tier could answer: ${lastReason}`, 503);
}
