import { editionRecordAiUsage } from "../edition-hooks";
import type { Env } from "../types";

/** About three characters a token, rounded up. Used when a provider reports no usage or none arrived. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 3);

/**
 * Fills in a side the provider reported as 0 when it answered with text: input from the prompt's
 * characters, output from the answer's. A side the provider did report is left as reported.
 */
export function usageWithEstimate(inTok: number, outTok: number, promptChars: number, text: string): { inTok: number; outTok: number } {
  if (!text) return { inTok, outTok };
  return { inTok: inTok || estimateTokens(promptChars), outTok: outTok || estimateTokens(text.length) };
}

/** Records usage. A failed record is logged and never loses the answer. */
export async function recordUsageSafely(env: Env, ctx: ExecutionContext | undefined, model: string, inTok: number, outTok: number): Promise<void> {
  await editionRecordAiUsage(env, ctx, model, inTok, outTok).catch((error) => {
    console.error("ai usage was not recorded", error instanceof Error ? error.message : String(error));
  });
}
