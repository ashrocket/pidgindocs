import type { Env } from "../types";
import { editionAiBudgetLeft, editionRecordAiUsage } from "../edition-hooks";
import { AiAllowanceSpentError } from "../ai/run";
import { priceMicroUsd } from "../ai/tiers";
import { createJev, JEV_MODEL } from "./search/jev";

export async function assertLibraryAiBudget(env: Env, estimatedInputTokens = 1): Promise<void> {
  const left = await editionAiBudgetLeft(env);
  if (!(left > 0) || left < priceMicroUsd(JEV_MODEL, estimatedInputTokens, 0)) throw new AiAllowanceSpentError();
}

/** Use the edition's per-instance allowance and durable usage ledger for
 * every provider request, including successful but malformed answers. */
export function createMeteredJev(env: Env, key: string) {
  return createJev(key, fetch, undefined, {
    beforeCall: (inputTokens) => assertLibraryAiBudget(env, inputTokens),
    afterCall: (model, inputTokens, outputTokens) => editionRecordAiUsage(env, undefined, model, inputTokens, outputTokens),
  });
}
