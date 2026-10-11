import type { EnhanceLevel, Env } from "../types";
import { callAnthropic } from "./anthropic";

const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const WORKERS_AI_CONTEXT_TOKENS = 24_000;
const WORKERS_AI_CONTEXT_OVERHEAD_TOKENS = 512;
const MIN_OUTPUT_TOKENS = 1_024;

interface EnhancePrompt {
  system: string;
  user: string;
  sourceMarkdownBytes: number;
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 3;
      }
    } else {
      // This includes lone surrogates, which TextEncoder replaces with U+FFFD.
      bytes += 3;
    }
  }
  return bytes;
}

/** Research depends on Anthropic's verified web-search tool; other levels can
 * use Workers AI when its optional binding is configured. */
export function isEnhancementProviderConfigured(env: Env, level: EnhanceLevel): boolean {
  return level === "research"
    ? Boolean(env.ANTHROPIC_API_KEY)
    : Boolean(env.AI || env.ANTHROPIC_API_KEY);
}

export async function callEnhancementModel(
  env: Env,
  input: EnhancePrompt & { level: EnhanceLevel; maxTokens: number; anthropicModel: string }
): Promise<string> {
  if (input.level !== "research" && env.AI) {
    // No model tokenizer is exposed by the binding. UTF-8 bytes are a
    // conservative upper bound for byte-fallback tokenizers; reserve extra
    // context for chat framing. Shrink output headroom for longer documents
    // and reject prompts that cannot leave enough room for a useful rewrite.
    const promptBytes = utf8ByteLength(input.system) + 1 + utf8ByteLength(input.user);
    const availableOutputTokens =
      WORKERS_AI_CONTEXT_TOKENS - promptBytes - WORKERS_AI_CONTEXT_OVERHEAD_TOKENS;
    const minimumOutputTokens = Math.min(
      input.maxTokens,
      Math.max(
        MIN_OUTPUT_TOKENS,
        Math.ceil(input.sourceMarkdownBytes * (input.level === "enrich" ? 1.25 : 1))
      )
    );
    const maxTokens = Math.min(input.maxTokens, availableOutputTokens);
    if (maxTokens < minimumOutputTokens) {
      throw new Error(
        `Workers AI cannot fit a complete ${input.level} pass in its ${WORKERS_AI_CONTEXT_TOKENS}-token context: ` +
        `${promptBytes} prompt bytes leave ${Math.max(0, availableOutputTokens)} output tokens, ` +
        `but the safety budget requires at least ${minimumOutputTokens}. ` +
        "No Workers AI inference was sent."
      );
    }

    const result = await env.AI.run(WORKERS_AI_MODEL, {
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
      max_tokens: maxTokens,
      temperature: input.level === "polish" ? 0.1 : 0.2,
    });
    const text =
      typeof result === "string"
        ? result
        : "response" in result && typeof result.response === "string"
          ? result.response
          : "";
    if (!text.trim()) {
      throw new Error("Workers AI returned no text content");
    }
    return text.trim();
  }

  return callAnthropic(env, {
    model: input.anthropicModel,
    system: input.system,
    user: input.user,
    maxTokens: input.maxTokens,
    webSearch: input.level === "research",
  });
}
