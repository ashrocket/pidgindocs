import type { Env } from "../types";
import type {
  DestinationResult,
  MessageDestination,
  MessageEnvelope,
} from "./types";
import { commuteDestination } from "./commute";
import { microsoft365Destination } from "./microsoft365";

const destinations: MessageDestination[] = [
  microsoft365Destination,
  commuteDestination,
];

export async function deliverToDestinations(
  env: Env,
  envelope: MessageEnvelope
): Promise<DestinationResult[]> {
  const withConfig = await Promise.all(
    destinations.map(async (destination) => ({
      destination,
      config: await destination.loadConfig(env),
    }))
  );

  const active = withConfig.filter(
    ({ destination, config }) => config && destination.supports(envelope)
  );

  if (active.length === 0) {
    return [];
  }

  const results = await Promise.all(
    active.map(async ({ destination, config }) => {
      try {
        const status = await destination.deliver(env, envelope, config as never);
        return { name: destination.name, status } satisfies DestinationResult;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[destination:${destination.name}] ${message}`);
        return { name: destination.name, status: `error: ${message}` } as DestinationResult;
      }
    })
  );

  return results;
}
