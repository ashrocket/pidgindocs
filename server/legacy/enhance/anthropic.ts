import type { Env } from "../types";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const WEB_SEARCH_MAX_USES = 5;

export interface AnthropicCallInput {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  webSearch?: boolean;
  /** output_config.effort; omitted uses the model default. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Server-side refusal fallback ("default" routing by refusal category). */
  fallbacks?: "default";
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  error?: { message?: string };
}

// One non-streaming Messages API call. Research-level calls attach the
// web_search server tool — search happens inside the API call, so the Worker
// needs no separate search integration.
export async function callAnthropic(env: Env, input: AnthropicCallInput): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  const body: Record<string, unknown> = {
    model: input.model,
    max_tokens: input.maxTokens,
    system: input.system,
    messages: [{ role: "user", content: input.user }],
  };
  if (input.webSearch) {
    body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: WEB_SEARCH_MAX_USES }];
  }
  if (input.effort) body.output_config = { effort: input.effort };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": env.ANTHROPIC_API_KEY,
    "anthropic-version": ANTHROPIC_VERSION,
  };
  if (input.fallbacks) {
    body.fallbacks = input.fallbacks;
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
  }

  const response = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const data = (await response.json()) as AnthropicResponse;
  if (!response.ok) {
    throw new Error(`Anthropic API error ${response.status}: ${data.error?.message || "unknown"}`);
  }
  if (data.stop_reason === "refusal") {
    throw new Error("Anthropic API declined the request");
  }
  const text = (data.content || [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
    .trim();
  if (!text) {
    throw new Error("Anthropic API returned no text content");
  }
  return text;
}
