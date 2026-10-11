import type { Env } from "./types";
import { ensureDefaultWorkspace } from "./workspace";

export function generateApiKey(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `pidgin_sk_${hex}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Apple's web Sign-In-with-Apple JS only round-trips a single opaque `state`
// string (unlike Google's redirect flow, which lets us tack extra query
// params onto the login_uri) — so `next`/`nonce` ride together inside it.
export function encodeOAuthWebState(payload: { next?: string; nonce: string }): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeOAuthWebState(state: string): { next?: string; nonce?: string } | null {
  try {
    const padded = state.replace(/-/g, "+").replace(/_/g, "/");
    const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
    const binary = atob(withPadding);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json) as { next?: string; nonce?: string };
    return parsed;
  } catch {
    return null;
  }
}

// Resolve a login email to its active user, following linked identities
// (user_identities) as well as the canonical users.email. Returns the
// CANONICAL email — callers minting sessions must store that, so every
// downstream `users WHERE email = ?` lookup lands on the same account no
// matter which provider identity signed in.
export async function findActiveUserByEmail(
  env: Env,
  email: string
): Promise<{ id: string; email: string } | null> {
  const normalized = email.toLowerCase();
  return await env.DB.prepare(
    `SELECT u.id, u.email FROM users u
     LEFT JOIN user_identities ui ON ui.user_id = u.id
     WHERE u.status = 'active' AND (u.email = ? OR ui.email = ?)
     LIMIT 1`
  )
    .bind(normalized, normalized)
    .first<{ id: string; email: string }>();
}

export async function storeApiKey(
  env: Env,
  userId: string,
  key: string,
  label: string
): Promise<void> {
  const keyHash = await sha256Hex(key);
  const keyPrefix = key.slice(0, 16);
  await env.DB.prepare(
    `INSERT INTO api_keys (key_hash, key_prefix, user_id, label)
     VALUES (?, ?, ?, ?)`
  )
    .bind(keyHash, keyPrefix, userId, label)
    .run();
}

let ownerSeeded = false;

export async function ensureOwnerExists(env: Env): Promise<void> {
  if (ownerSeeded) return;
  if (!env.OWNER_EMAIL) return;

  const row = await env.DB.prepare(
    "SELECT COUNT(*) as c FROM users"
  ).first<{ c: number }>();

  if ((row?.c ?? 0) > 0) {
    const owner = await env.DB.prepare(
      "SELECT id FROM users WHERE email = ? AND status = 'active'"
    )
      .bind(env.OWNER_EMAIL.toLowerCase())
      .first<{ id: string }>();
    if (owner) {
      await ensureDefaultWorkspace(env, owner.id).catch(() => {});
    }
    ownerSeeded = true;
    return;
  }

  const id = crypto.randomUUID().replace(/-/g, "");
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, email, status) VALUES (?, ?, 'active')"
  )
    .bind(id, env.OWNER_EMAIL.toLowerCase())
    .run();

  await ensureDefaultWorkspace(env, id).catch(() => {});

  ownerSeeded = true;
}
