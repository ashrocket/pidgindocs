import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:email", () => ({
  EmailMessage: class EmailMessage {
    constructor(public from: string, public to: string, public raw: string) {}
  },
}));

import { handleLinkIdentity, handleListIdentities, handleUnlinkIdentity } from "../core/routes/identities";
import { handleOAuthLogin } from "../core/auth/oauth-login";
import { handleLogin } from "../core/routes/auth";
import type { Jwks } from "../core/auth/jwt-verify";
import type { Env } from "../core/types";
import { SESSION_TTL_SECONDS } from "../core/middleware";

// --- real RS256 signing helpers (local keypair), same setup as oauth-login.test.ts ---
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
const NOW = Math.floor(Date.parse("2026-07-08T12:00:00Z") / 1000);

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

const localJwks = (): Jwks => ({ keys: [publicJwk] });
const deps = () => ({ fetchJwks: async () => localJwks(), now: NOW });

function applePayload(over: Record<string, unknown> = {}) {
  return { iss: "https://appleid.apple.com", aud: "com.example.pidgin", exp: NOW + 600, iat: NOW - 5, sub: "apple-sub-1", email: "relay@privaterelay.appleid.com", email_verified: "true", ...over };
}
function googlePayload(over: Record<string, unknown> = {}) {
  return { iss: "https://accounts.google.com", aud: "123-abc.apps.googleusercontent.com", exp: NOW + 600, iat: NOW - 5, sub: "google-sub-1", email: "gmail@example.com", email_verified: true, ...over };
}

// --- stateful KV + DB mocks modeling users + user_identities ---
class MockSessions {
  store = new Map<string, string>();
  async get(k: string) { return this.store.get(k) ?? null; }
  async getWithMetadata(k: string) {
    const value = this.store.get(k) ?? null;
    // exp far enough out that lookupSession never triggers a renew write
    return { value, metadata: value ? { exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS } : null };
  }
  async put(k: string, v: string, _opts?: unknown) { this.store.set(k, v); }
  async delete(k: string) { this.store.delete(k); }
}

interface UserRow { id: string; email: string; status: string }
interface IdentityRecord { user_id: string; provider: string; provider_sub: string | null; created_at: string }

class MockDB {
  users: UserRow[] = [];
  identities = new Map<string, IdentityRecord>();
  auditLog: Array<{ action: string; details: string }> = [];

  prepare(sql: string) {
    const db = this;
    return {
      bind(...binds: any[]) {
        return {
          async first() {
            const email = String(binds[0] ?? "").toLowerCase();
            if (sql.includes("LEFT JOIN user_identities")) {
              const direct = db.users.find((u) => u.email === email && u.status === "active");
              if (direct) return { id: direct.id, email: direct.email };
              const ident = db.identities.get(email);
              if (!ident) return null;
              const owner = db.users.find((u) => u.id === ident.user_id && u.status === "active");
              return owner ? { id: owner.id, email: owner.email } : null;
            }
            if (sql.includes("SELECT user_id FROM user_identities")) {
              const ident = db.identities.get(email);
              return ident ? { user_id: ident.user_id } : null;
            }
            if (sql.includes("FROM users WHERE email") && sql.includes("status = 'active'")) {
              const u = db.users.find((x) => x.email === email && x.status === "active");
              return u ? { id: u.id, email: u.email } : null;
            }
            if (sql.includes("SELECT id FROM users WHERE email")) {
              const u = db.users.find((x) => x.email === email);
              return u ? { id: u.id } : null;
            }
            return null;
          },
          async all() {
            if (sql.includes("FROM user_identities WHERE user_id")) {
              const results = [...db.identities.entries()]
                .filter(([, v]) => v.user_id === binds[0])
                .map(([identityEmail, v]) => ({ email: identityEmail, provider: v.provider, created_at: v.created_at }));
              return { results };
            }
            return { results: [] };
          },
          async run() {
            if (sql.startsWith("INSERT OR REPLACE INTO user_identities")) {
              db.identities.set(String(binds[0]), {
                user_id: String(binds[1]),
                provider: String(binds[2]),
                provider_sub: binds[3] === null ? null : String(binds[3]),
                created_at: "2026-07-08 00:00:00",
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.startsWith("DELETE FROM user_identities")) {
              const ident = db.identities.get(String(binds[0]));
              if (ident && ident.user_id === binds[1]) {
                db.identities.delete(String(binds[0]));
                return { success: true, meta: { changes: 1 } };
              }
              return { success: true, meta: { changes: 0 } };
            }
            if (sql.startsWith("INSERT INTO audit_log")) {
              db.auditLog.push({ action: String(binds[0]), details: String(binds[1]) });
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
    };
  }
}

function makeEnv(db: MockDB, sessions = new MockSessions(), over: Partial<Env> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    DOCS: {} as R2Bucket,
    SESSIONS: sessions as unknown as KVNamespace,
    ENHANCE_QUEUE: { send: async () => {} } as unknown as Env["ENHANCE_QUEUE"],
    API_KEY: "k",
    OWNER_EMAIL: "owner@example.com",
    APNS_KEY_ID: "", APNS_TEAM_ID: "", APNS_PRIVATE_KEY: "",
    WORKER_URL: "https://example.test",
    ENVIRONMENT: "test",
    APPLE_AUDIENCES: "com.example.pidgin,com.example.pidgin.mac",
    GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
    ...over,
  } as Env;
}

// Canonical account: owner@example.com (user u1)
function seededDb(): MockDB {
  const db = new MockDB();
  db.users.push({ id: "u1", email: "owner@example.com", status: "active" });
  return db;
}

async function sessionFor(sessions: MockSessions, email: string): Promise<string> {
  const token = crypto.randomUUID();
  await sessions.put(`session:${token}`, email);
  return token;
}

function jsonReq(path: string, method: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://example.test${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("handleOAuthLogin via linked identity", () => {
  it("signs in with an Apple relay email linked to a Gmail-canonical account and mints a canonical session", async () => {
    const db = seededDb();
    db.identities.set("relay@privaterelay.appleid.com", { user_id: "u1", provider: "apple", provider_sub: "apple-sub-1", created_at: "2026-07-01" });
    const sessions = new MockSessions();
    const env = makeEnv(db, sessions);

    const res = await handleOAuthLogin(
      jsonReq("/auth/oauth/apple", "POST", { id_token: await signJwt(applePayload()) }),
      env, "apple", deps()
    );
    const body = (await res.json()) as { ok: boolean; data: { session_token: string; email: string } };

    expect(res.status).toBe(200);
    // Response and session both carry the CANONICAL email, not the relay one
    expect(body.data.email).toBe("owner@example.com");
    expect(sessions.store.get(`session:${body.data.session_token}`)).toBe("owner@example.com");
    const audit = db.auditLog.find((a) => a.action === "oauth_login");
    expect(audit?.details).toContain("via linked relay@privaterelay.appleid.com");
  });

  it("still rejects an email that is neither canonical nor linked", async () => {
    const env = makeEnv(seededDb());
    const res = await handleOAuthLogin(
      jsonReq("/auth/oauth/apple", "POST", { id_token: await signJwt(applePayload({ email: "stranger@example.com" })) }),
      env, "apple", deps()
    );
    expect(res.status).toBe(401);
  });
});

describe("handleLogin (magic link) via linked identity", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("accepts a linked email and stores the canonical email in the magic token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const db = seededDb();
    db.identities.set("relay@privaterelay.appleid.com", { user_id: "u1", provider: "apple", provider_sub: null, created_at: "2026-07-01" });
    const sessions = new MockSessions();
    const env = makeEnv(db, sessions, { RESEND_API_KEY: "test-resend-key" });

    const res = await handleLogin(
      jsonReq("/auth/login", "POST", { email: "relay@privaterelay.appleid.com" }),
      env
    );

    expect(res.status).toBe(200);
    const magicKey = [...sessions.store.keys()].find((k) => k.startsWith("magic:"));
    expect(magicKey).toBeTruthy();
    const payload = JSON.parse(sessions.store.get(magicKey!)!) as { email: string };
    expect(payload.email).toBe("owner@example.com");
  });
});

describe("handleLinkIdentity", () => {
  it("rejects a request with no session (401), including API-key-only callers", async () => {
    const env = makeEnv(seededDb());
    const noAuth = await handleLinkIdentity(jsonReq("/api/identities", "POST", {}), env, deps());
    expect(noAuth.status).toBe(401);

    const apiKeyOnly = await handleLinkIdentity(
      jsonReq("/api/identities", "POST", { provider: "google", id_token: await signJwt(googlePayload()) }, { Authorization: "Bearer k" }),
      env, deps()
    );
    expect(apiKeyOnly.status).toBe(401);
  });

  it("links a Google identity with a valid id_token and records provider + sub", async () => {
    const db = seededDb();
    const sessions = new MockSessions();
    const token = await sessionFor(sessions, "owner@example.com");
    const env = makeEnv(db, sessions);

    const res = await handleLinkIdentity(
      jsonReq("/api/identities", "POST", { provider: "google", id_token: await signJwt(googlePayload()) }, { Authorization: `Session ${token}` }),
      env, deps()
    );
    const body = (await res.json()) as { ok: boolean; data: { linked: boolean; email: string } };

    expect(res.status).toBe(201);
    expect(body.data).toMatchObject({ linked: true, email: "gmail@example.com", provider: "google", primary: false });
    expect(db.identities.get("gmail@example.com")).toMatchObject({ user_id: "u1", provider: "google", provider_sub: "google-sub-1" });
    expect(db.auditLog.some((a) => a.action === "identity_link")).toBe(true);
  });

  it("treats linking the account's own primary email as a no-op success", async () => {
    const db = seededDb();
    const sessions = new MockSessions();
    const token = await sessionFor(sessions, "owner@example.com");
    const env = makeEnv(db, sessions);

    const res = await handleLinkIdentity(
      jsonReq("/api/identities", "POST", { provider: "google", id_token: await signJwt(googlePayload({ email: "owner@example.com" })) }, { Authorization: `Session ${token}` }),
      env, deps()
    );
    const body = (await res.json()) as { ok: boolean; data: { primary: boolean } };

    expect(res.status).toBe(200);
    expect(body.data.primary).toBe(true);
    expect(db.identities.size).toBe(0);
  });

  it("rejects an email that is another user's primary (409)", async () => {
    const db = seededDb();
    db.users.push({ id: "u2", email: "gmail@example.com", status: "active" });
    const sessions = new MockSessions();
    const token = await sessionFor(sessions, "owner@example.com");
    const env = makeEnv(db, sessions);

    const res = await handleLinkIdentity(
      jsonReq("/api/identities", "POST", { provider: "google", id_token: await signJwt(googlePayload()) }, { Authorization: `Session ${token}` }),
      env, deps()
    );
    expect(res.status).toBe(409);
  });

  it("rejects an email already linked to a different account (409)", async () => {
    const db = seededDb();
    db.users.push({ id: "u2", email: "other@example.com", status: "active" });
    db.identities.set("gmail@example.com", { user_id: "u2", provider: "google", provider_sub: null, created_at: "2026-07-01" });
    const sessions = new MockSessions();
    const token = await sessionFor(sessions, "owner@example.com");
    const env = makeEnv(db, sessions);

    const res = await handleLinkIdentity(
      jsonReq("/api/identities", "POST", { provider: "google", id_token: await signJwt(googlePayload()) }, { Authorization: `Session ${token}` }),
      env, deps()
    );
    expect(res.status).toBe(409);
  });

  it("rejects an invalid id_token (401) without touching identities", async () => {
    const db = seededDb();
    const sessions = new MockSessions();
    const token = await sessionFor(sessions, "owner@example.com");
    const env = makeEnv(db, sessions);

    const res = await handleLinkIdentity(
      jsonReq("/api/identities", "POST", { provider: "google", id_token: await signJwt(googlePayload({ aud: "wrong-audience" })) }, { Authorization: `Session ${token}` }),
      env, deps()
    );
    expect(res.status).toBe(401);
    expect(db.identities.size).toBe(0);
  });

  it("rejects an unknown provider (400)", async () => {
    const db = seededDb();
    const sessions = new MockSessions();
    const token = await sessionFor(sessions, "owner@example.com");
    const env = makeEnv(db, sessions);

    const res = await handleLinkIdentity(
      jsonReq("/api/identities", "POST", { provider: "facebook", id_token: "x" }, { Authorization: `Session ${token}` }),
      env, deps()
    );
    expect(res.status).toBe(400);
  });
});

describe("handleUnlinkIdentity", () => {
  it("unlinks a linked identity", async () => {
    const db = seededDb();
    db.identities.set("relay@privaterelay.appleid.com", { user_id: "u1", provider: "apple", provider_sub: null, created_at: "2026-07-01" });
    const sessions = new MockSessions();
    const token = await sessionFor(sessions, "owner@example.com");
    const env = makeEnv(db, sessions);

    const res = await handleUnlinkIdentity(
      jsonReq("/api/identities", "DELETE", { email: "relay@privaterelay.appleid.com" }, { Authorization: `Session ${token}` }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.identities.size).toBe(0);
    expect(db.auditLog.some((a) => a.action === "identity_unlink")).toBe(true);
  });

  it("returns 404 for an identity that is not linked", async () => {
    const db = seededDb();
    const sessions = new MockSessions();
    const token = await sessionFor(sessions, "owner@example.com");
    const env = makeEnv(db, sessions);

    const res = await handleUnlinkIdentity(
      jsonReq("/api/identities", "DELETE", { email: "nobody@example.com" }, { Authorization: `Session ${token}` }),
      env
    );
    expect(res.status).toBe(404);
  });

  it("refuses to unlink the primary email (400)", async () => {
    const db = seededDb();
    const sessions = new MockSessions();
    const token = await sessionFor(sessions, "owner@example.com");
    const env = makeEnv(db, sessions);

    const res = await handleUnlinkIdentity(
      jsonReq("/api/identities", "DELETE", { email: "owner@example.com" }, { Authorization: `Session ${token}` }),
      env
    );
    expect(res.status).toBe(400);
  });

  it("cannot unlink another user's identity", async () => {
    const db = seededDb();
    db.users.push({ id: "u2", email: "other@example.com", status: "active" });
    db.identities.set("gmail@example.com", { user_id: "u2", provider: "google", provider_sub: null, created_at: "2026-07-01" });
    const sessions = new MockSessions();
    const token = await sessionFor(sessions, "owner@example.com");
    const env = makeEnv(db, sessions);

    const res = await handleUnlinkIdentity(
      jsonReq("/api/identities", "DELETE", { email: "gmail@example.com" }, { Authorization: `Session ${token}` }),
      env
    );
    expect(res.status).toBe(404);
    expect(db.identities.has("gmail@example.com")).toBe(true);
  });
});

describe("handleListIdentities", () => {
  it("lists the primary email plus linked identities", async () => {
    const db = seededDb();
    db.identities.set("relay@privaterelay.appleid.com", { user_id: "u1", provider: "apple", provider_sub: null, created_at: "2026-07-01" });
    db.identities.set("gmail@example.com", { user_id: "u1", provider: "google", provider_sub: null, created_at: "2026-07-02" });
    const sessions = new MockSessions();
    const token = await sessionFor(sessions, "owner@example.com");
    const env = makeEnv(db, sessions);

    const res = await handleListIdentities(
      new Request("https://example.test/api/identities", { headers: { Authorization: `Session ${token}` } }),
      env
    );
    const body = (await res.json()) as { ok: boolean; data: { identities: Array<{ email: string; provider: string; primary: boolean }> } };

    expect(res.status).toBe(200);
    expect(body.data.identities).toHaveLength(3);
    expect(body.data.identities[0]).toMatchObject({ email: "owner@example.com", provider: "primary", primary: true });
    const emails = body.data.identities.map((i) => i.email);
    expect(emails).toContain("relay@privaterelay.appleid.com");
    expect(emails).toContain("gmail@example.com");
  });

  it("requires a session (401)", async () => {
    const env = makeEnv(seededDb());
    const res = await handleListIdentities(new Request("https://example.test/api/identities"), env);
    expect(res.status).toBe(401);
  });
});
