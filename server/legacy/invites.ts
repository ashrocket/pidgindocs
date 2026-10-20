import type { Env } from "./types";

function generateInviteCode(): string {
  const words = ["BIRD", "NEST", "WING", "FLOCK", "ROOST", "PERCH"];
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const word = words[unbiasedIndex(words.length)];
  const suffix = Array.from({ length: 6 }, () => alphabet[unbiasedIndex(alphabet.length)]).join("");
  return `${word}-${suffix}`;
}

function secureRandomByte(): number {
  return crypto.getRandomValues(new Uint8Array(1))[0];
}

/** Select uniformly from 0..maxExclusive-1 using rejection sampling. */
export function unbiasedIndex(maxExclusive: number, nextByte: () => number = secureRandomByte): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > 256) {
    throw new RangeError("maxExclusive must be an integer between 1 and 256");
  }
  const acceptedRange = Math.floor(256 / maxExclusive) * maxExclusive;
  let byte: number;
  do {
    byte = nextByte();
  } while (byte >= acceptedRange);
  return byte % maxExclusive;
}

/**
 * Mint an invite code and persist it under the KV key + payload shape the /join
 * redemption path reads (`invite-code:<CODE>` → {uses, max_uses, invited_by},
 * 7-day TTL). Shared by index.ts's invite endpoints and the admin invite handler
 * so every minting site stores codes identically and they all redeem.
 *
 * Lives in this leaf module (deps: Env + crypto only) so index.ts and
 * routes/admin.ts can both import it without forming an import cycle.
 */
export async function createInviteCode(env: Env, invitedBy: string, maxUses = 1): Promise<string> {
  const code = generateInviteCode();
  await env.SESSIONS.put(
    `invite-code:${code}`,
    JSON.stringify({ uses: 0, max_uses: maxUses, invited_by: invitedBy }),
    { expirationTtl: 7 * 24 * 60 * 60 }
  );
  return code;
}

export { generateInviteCode };
