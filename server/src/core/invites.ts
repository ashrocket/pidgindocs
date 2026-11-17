import type { Env } from "./types";

function generateInviteCode(): string {
  const words = ["BIRD", "NEST", "WING", "FLOCK", "ROOST", "PERCH"];
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const rng = crypto.getRandomValues(new Uint8Array(7)); // 1 byte for word, 6 for suffix
  const word = words[rng[0] % words.length];
  const suffix = Array.from(rng.slice(1)).map((b) => alphabet[b % alphabet.length]).join("");
  return `${word}-${suffix}`;
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
