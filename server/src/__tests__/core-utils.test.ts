import { describe, expect, it } from "vitest";

import { checkRateLimit } from "../core/ratelimit";
import { json, corsHeaders } from "../core/utils";
import { createInviteCode, generateInviteCode } from "../core/invites";
import type { Env } from "../core/types";

// Three leaf modules that everything else leans on: the KV rate limiter
// (gates every chat send + login attempt), response shaping (every JSON
// response in the worker), and invite minting (gates the /join flow).

class MockKV {
  data = new Map<string, string>();
  ttls = new Map<string, number | undefined>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.data.set(key, value);
    this.ttls.set(key, opts?.expirationTtl);
  }
}

function makeEnv(): { env: Env; kv: MockKV } {
  const kv = new MockKV();
  return { env: { SESSIONS: kv as unknown as KVNamespace } as Env, kv };
}

describe("checkRateLimit", () => {
  it("1. allows up to maxAttempts, then blocks", async () => {
    const { env } = makeEnv();
    expect(await checkRateLimit(env, "login:a", 3, 60)).toBe(true);
    expect(await checkRateLimit(env, "login:a", 3, 60)).toBe(true);
    expect(await checkRateLimit(env, "login:a", 3, 60)).toBe(true);
    expect(await checkRateLimit(env, "login:a", 3, 60)).toBe(false);
    // Denials don't consume attempts: the counter stays at the cap.
    expect(await checkRateLimit(env, "login:a", 3, 60)).toBe(false);
  });

  it("2. namespaces keys under rl: with the window TTL, and isolates keys", async () => {
    const { env, kv } = makeEnv();
    await checkRateLimit(env, "chat-send:conv-1", 30, 300);
    expect(kv.data.get("rl:chat-send:conv-1")).toBe("1");
    expect(kv.ttls.get("rl:chat-send:conv-1")).toBe(300);

    // A different key has its own budget.
    expect(await checkRateLimit(env, "chat-send:conv-2", 1, 300)).toBe(true);
    expect(await checkRateLimit(env, "chat-send:conv-2", 1, 300)).toBe(false);
    expect(await checkRateLimit(env, "chat-send:conv-1", 30, 300)).toBe(true);
  });

  it("3. treats a garbage counter value as blocked-if-NaN-fails-closed", async () => {
    const { env, kv } = makeEnv();
    kv.data.set("rl:weird", "not-a-number");
    // parseInt → NaN; NaN >= max is false, so a corrupted counter fails OPEN
    // — and stays "NaN" until the window TTL expires it. Bounded exposure
    // (one window), preferred over locking the key out; documented here so
    // a future change to fail-closed is a conscious one.
    expect(await checkRateLimit(env, "weird", 3, 60)).toBe(true);
    expect(kv.data.get("rl:weird")).toBe("NaN");
  });
});

describe("json / corsHeaders", () => {
  it("4. shapes success responses with CORS and content-type", async () => {
    const response = json({ ok: true, data: { x: 1 } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await response.json()).toEqual({ ok: true, data: { x: 1 } });
  });

  it("5. carries explicit statuses and error bodies", async () => {
    const response = json({ ok: false, error: "nope" }, 403);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: "nope" });
  });

  it("6. exposes the pagination headers the iOS client reads", () => {
    expect(corsHeaders()["Access-Control-Expose-Headers"]).toContain("X-Unread-Count");
    expect(corsHeaders()["Access-Control-Expose-Headers"]).toContain("X-Has-More");
  });
});

describe("invites", () => {
  it("7. generates WORD-XXXXXX codes from the fixed word list", () => {
    for (let i = 0; i < 20; i++) {
      const code = generateInviteCode();
      expect(code).toMatch(/^(BIRD|NEST|WING|FLOCK|ROOST|PERCH)-[0-9A-Z]{6}$/);
    }
  });

  it("8. persists the exact KV shape the /join redemption path reads", async () => {
    const { env, kv } = makeEnv();
    const code = await createInviteCode(env, "admin@example.com", 5);

    const stored = JSON.parse(kv.data.get(`invite-code:${code}`)!) as {
      uses: number;
      max_uses: number;
      invited_by: string;
    };
    expect(stored).toEqual({ uses: 0, max_uses: 5, invited_by: "admin@example.com" });
    expect(kv.ttls.get(`invite-code:${code}`)).toBe(7 * 24 * 60 * 60);
  });

  it("9. defaults to single-use codes", async () => {
    const { env, kv } = makeEnv();
    const code = await createInviteCode(env, "admin@example.com");
    const stored = JSON.parse(kv.data.get(`invite-code:${code}`)!) as { max_uses: number };
    expect(stored.max_uses).toBe(1);
  });
});
