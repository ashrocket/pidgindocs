import { describe, expect, it, beforeAll } from "vitest";

import { handleOAuthLogin } from "../core/auth/oauth-login";
import type { Jwks } from "../core/auth/jwt-verify";
import type { Env } from "../core/types";

// --- real RS256 signing helpers (local keypair) ---
function b64url(data: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof data === "string") bytes = new TextEncoder().encode(data);
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else bytes = data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let privateKey: CryptoKey;
let publicJwk: any;
const KID = "kid-1";
const NOW = Math.floor(Date.parse("2026-06-03T12:00:00Z") / 1000);

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  publicJwk.kid = KID;
  publicJwk.alg = "RS256";
});

async function signJwt(payload: Record<string, unknown>): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: KID };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, new TextEncoder().encode(input));
  return `${input}.${b64url(sig)}`;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const localJwks = (): Jwks => ({ keys: [publicJwk] });
const deps = () => ({ fetchJwks: async () => localJwks(), now: NOW });

// --- KV + DB mocks ---
class MockSessions {
  store = new Map<string, string>();
  async get(k: string) { return this.store.get(k) ?? null; }
  async put(k: string, v: string) { this.store.set(k, v); }
  async delete(k: string) { this.store.delete(k); }
}
class MockDB {
  constructor(private activeEmails: string[]) {}
  prepare(sql: string) {
    const self = this;
    return {
      bind(...binds: any[]) {
        return {
          async first() {
            if (sql.includes("FROM users")) {
              const email = String(binds[0] ?? "").toLowerCase();
              return self.activeEmails.includes(email) ? { id: "user-1", email } : null;
            }
            return null;
          },
          async run() { return { success: true, meta: { changes: 1 } }; },
        };
      },
    };
  }
}

function makeEnv(over: Partial<Env> = {}, activeEmails = ["owner@example.com"]): Env {
  return {
    DB: new MockDB(activeEmails) as unknown as D1Database,
    DOCS: {} as R2Bucket,
    SESSIONS: new MockSessions() as unknown as KVNamespace,
    ENHANCE_QUEUE: { send: async () => {} } as unknown as Env["ENHANCE_QUEUE"],
    API_KEY: "k",
    OWNER_EMAIL: "owner@example.com",
    APNS_KEY_ID: "", APNS_TEAM_ID: "", APNS_PRIVATE_KEY: "",
    WORKER_URL: "https://example.test",
    ENVIRONMENT: "test",
    APPLE_AUDIENCES: "com.example.pidgin,com.example.pidgin.mac",
    GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
    ...over,
  };
}

function req(idToken: string, nonce?: string): Request {
  const body: Record<string, string> = { id_token: idToken };
  if (nonce !== undefined) body.nonce = nonce;
  return new Request("https://example.test/auth/oauth/apple", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function applePayload(over: Record<string, unknown> = {}) {
  return { iss: "https://appleid.apple.com", aud: "com.example.pidgin", exp: NOW + 600, iat: NOW - 5, email: "owner@example.com", email_verified: "true", ...over };
}
function googlePayload(over: Record<string, unknown> = {}) {
  return { iss: "https://accounts.google.com", aud: "123-abc.apps.googleusercontent.com", exp: NOW + 600, iat: NOW - 5, email: "owner@example.com", email_verified: true, ...over };
}

describe("handleOAuthLogin", () => {
  it("issues a session for an active user signing in with Apple", async () => {
    const env = makeEnv();
    const res = await handleOAuthLogin(req(await signJwt(applePayload())), env, "apple", deps());
    const body = (await res.json()) as { ok: boolean; data: { session_token: string; email: string } };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.email).toBe("owner@example.com");
    expect(body.data.session_token).toBeTruthy();
    // session is persisted
    const sessions = env.SESSIONS as unknown as MockSessions;
    expect(sessions.store.get(`session:${body.data.session_token}`)).toBe("owner@example.com");
  });

  it("issues a session for an active user signing in with Google", async () => {
    const env = makeEnv();
    const res = await handleOAuthLogin(req(await signJwt(googlePayload())), env, "google", deps());
    const body = (await res.json()) as { ok: boolean; data: { email: string } };
    expect(res.status).toBe(200);
    expect(body.data.email).toBe("owner@example.com");
  });

  it("rejects an SSO email that is not a registered active user (401, no account creation)", async () => {
    const env = makeEnv({}, []); // no active users
    const res = await handleOAuthLogin(req(await signJwt(applePayload({ email: "stranger@example.com" }))), env, "apple", deps());
    expect(res.status).toBe(401);
  });

  it("returns 501 when the provider is not configured", async () => {
    const env = makeEnv({ GOOGLE_CLIENT_ID: undefined });
    const res = await handleOAuthLogin(req(await signJwt(googlePayload())), env, "google", deps());
    expect(res.status).toBe(501);
  });

  it("rejects an expired token with 401", async () => {
    const env = makeEnv();
    const res = await handleOAuthLogin(req(await signJwt(applePayload({ exp: NOW - 600 }))), env, "apple", deps());
    expect(res.status).toBe(401);
  });

  it("rejects an unknown provider with 400", async () => {
    const env = makeEnv();
    const res = await handleOAuthLogin(req(await signJwt(applePayload())), env, "facebook" as any, deps());
    expect(res.status).toBe(400);
  });

  it("rejects a Google token whose email is not verified", async () => {
    const env = makeEnv();
    const res = await handleOAuthLogin(req(await signJwt(googlePayload({ email_verified: false }))), env, "google", deps());
    expect(res.status).toBe(401);
  });

  // --- Apple nonce hardening ---

  it("issues a session when the Apple token nonce matches the client nonce", async () => {
    const env = makeEnv();
    const raw = "client-raw-nonce";
    const token = await signJwt(applePayload({ nonce: await sha256Hex(raw) }));
    const res = await handleOAuthLogin(req(token, raw), env, "apple", deps());
    expect(res.status).toBe(200);
  });

  it("rejects an Apple token whose nonce does not match the client nonce (401)", async () => {
    const env = makeEnv();
    const token = await signJwt(applePayload({ nonce: await sha256Hex("a-different-nonce") }));
    const res = await handleOAuthLogin(req(token, "client-raw-nonce"), env, "apple", deps());
    expect(res.status).toBe(401);
  });

  it("rejects replay: the same nonce cannot be redeemed twice (401 on second use)", async () => {
    const env = makeEnv();
    const raw = "single-use-nonce";
    const token = await signJwt(applePayload({ nonce: await sha256Hex(raw) }));
    const first = await handleOAuthLogin(req(token, raw), env, "apple", deps());
    expect(first.status).toBe(200);
    const second = await handleOAuthLogin(req(token, raw), env, "apple", deps());
    expect(second.status).toBe(401);
  });
});
