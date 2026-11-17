import { AiAllowanceSpentError } from "../ai/run";
import { recordUsageSafely, usageWithEstimate } from "../ai/meter";
import { editionAiBudgetLeft } from "../edition-hooks";
import type { Env } from "../types";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const WEB_SEARCH_MAX_USES = 5;

export interface AnthropicCallInput {
  model: string;
  system?: string;
  user: string;
  maxTokens: number;
  webSearch?: boolean;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

// One non-streaming Messages API call. Research-level calls attach the
// web_search server tool — search happens inside the API call, so the Worker
// needs no separate search integration.
export async function callAnthropic(env: Env, input: AnthropicCallInput): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  if (await editionAiBudgetLeft(env) <= 0) throw new AiAllowanceSpentError();
  const body: Record<string, unknown> = {
    model: input.model,
    max_tokens: input.maxTokens,
    messages: [{ role: "user", content: input.user }],
  };
  if (input.system) body.system = input.system;
  if (input.webSearch) {
    body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: WEB_SEARCH_MAX_USES }];
  }

  const response = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  const data = (await response.json()) as AnthropicResponse;
  if (!response.ok) {
    throw new Error(`Anthropic API error ${response.status}: ${data.error?.message || "unknown"}`);
  }
  const text = (data.content || [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
    .trim();
  if (!text) {
    throw new Error("Anthropic API returned no text content");
  }
  const { inTok, outTok } = usageWithEstimate(
    Number(data.usage?.input_tokens) || 0, Number(data.usage?.output_tokens) || 0, (input.system?.length ?? 0) + input.user.length, text,
  );
  await recordUsageSafely(env, undefined, input.model, inTok, outTok);
  return text;
}
