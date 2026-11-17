import { beforeEach, describe, it, expect } from "vitest";
import { verifyApiKey, resolveApiKeyUser, verifySession, __clearApiKeyCache, SESSION_TTL_SECONDS } from "../core/middleware";
import type { Env } from "../core/types";

describe("SESSION_TTL_SECONDS", () => {
  it("is 48 hours", () => {
    expect(SESSION_TTL_SECONDS).toBe(48 * 60 * 60);
  });
});

describe("verifyApiKey", () => {
  it("returns true for valid bearer token", () => {
    const headers = new Headers({ Authorization: "Bearer test-key-123" });
    expect(verifyApiKey(headers, "test-key-123")).toBe(true);
  });

  it("returns false for missing header", () => {
    const headers = new Headers();
    expect(verifyApiKey(headers, "test-key-123")).toBe(false);
  });

  it("returns false for wrong key", () => {
    const headers = new Headers({ Authorization: "Bearer wrong-key" });
    expect(verifyApiKey(headers, "test-key-123")).toBe(false);
  });

  it("returns false for non-Bearer scheme", () => {
    const headers = new Headers({ Authorization: "Basic test-key-123" });
    expect(verifyApiKey(headers, "test-key-123")).toBe(false);
  });

  it("returns false for empty authorization header", () => {
    const headers = new Headers({ Authorization: "" });
    expect(verifyApiKey(headers, "test-key-123")).toBe(false);
  });
});

const mockEnv = {
  API_KEY: "test-api-key",
  OWNER_EMAIL: "owner@test.com",
  DB: {
    prepare: () => ({
      bind: () => ({ first: async () => null }),
    }),
  },
} as unknown as Env;

describe("verifySession sliding renewal", () => {
  function mockKV(initial: Record<string, { value: string; metadata?: { exp?: number } }>) {
    const store = new Map(Object.entries(initial));
    const puts: Array<{ key: string; value: string; opts?: any }> = [];
    return {
      kv: {
        async get(key: string) {
          return store.get(key)?.value ?? null;
        },
        async getWithMetadata(key: string) {
          const entry = store.get(key);
          return { value: entry?.value ?? null, metadata: entry?.metadata ?? null };
        },
        async put(key: string, value: string, opts?: any) {
          puts.push({ key, value, opts });
          store.set(key, { value, metadata: opts?.metadata });
        },
      } as unknown as KVNamespace,
      puts,
    };
  }

  it("renews a session nearing expiry so active users never get logged out", async () => {
    const soon = Math.floor(Date.now() / 1000) + 12 * 60 * 60; // 12 hours left
    const { kv, puts } = mockKV({
      "session:tok1": { value: "a@example.com", metadata: { exp: soon } },
    });
    const headers = new Headers({ Authorization: "Session tok1" });

    const email = await verifySession(headers, kv);

    expect(email).toBe("a@example.com");
    expect(puts).toHaveLength(1);
    expect(puts[0].key).toBe("session:tok1");
    expect(puts[0].opts?.expirationTtl).toBe(48 * 60 * 60);
  });

  it("renews legacy sessions without expiry metadata on first use", async () => {
    const { kv, puts } = mockKV({
      "session:tok2": { value: "b@example.com" },
    });
    const headers = new Headers({ Authorization: "Session tok2" });

    const email = await verifySession(headers, kv);

    expect(email).toBe("b@example.com");
    expect(puts).toHaveLength(1);
  });

  it("leaves fresh sessions untouched", async () => {
    const far = Math.floor(Date.now() / 1000) + 47 * 60 * 60; // 47 hours left (just under the 48h TTL)
    const { kv, puts } = mockKV({
      "session:tok3": { value: "c@example.com", metadata: { exp: far } },
    });
    const headers = new Headers({ Authorization: "Session tok3" });

    const email = await verifySession(headers, kv);

    expect(email).toBe("c@example.com");
    expect(puts).toHaveLength(0);
  });

  it("still rejects unknown sessions", async () => {
    const { kv } = mockKV({});
    const headers = new Headers({ Authorization: "Session nope" });
    expect(await verifySession(headers, kv)).toBeNull();
  });
});

describe("resolveApiKeyUser caching", () => {
  beforeEach(() => __clearApiKeyCache());

  function countingEnv() {
    let queries = 0;
    const env = {
      API_KEY: "test-api-key",
      OWNER_EMAIL: "owner@test.com",
      DB: {
        prepare: (sql: string) => ({
          bind: () => ({
            first: async () => {
              queries++;
              return sql.includes("api_keys")
                ? { user_id: "u1", email: "owner@test.com" }
                : null;
            },
            run: async () => {},
          }),
        }),
      },
    } as unknown as Env;
    return { env, queryCount: () => queries };
  }

  it("serves repeat lookups for the same key from cache without hitting D1", async () => {
    const { env, queryCount } = countingEnv();
    const headers = new Headers({ Authorization: "Bearer hot-key" });

    const first = await resolveApiKeyUser(headers, env);
    const afterFirst = queryCount();
    const second = await resolveApiKeyUser(headers, env);

    expect(first).toEqual({ userId: "u1", email: "owner@test.com" });
    expect(second).toEqual(first);
    expect(afterFirst).toBeGreaterThan(0);
    expect(queryCount()).toBe(afterFirst); // no extra D1 reads on the warm path
  });

  it("does not cache failed lookups", async () => {
    const env = {
      API_KEY: "real-key",
      OWNER_EMAIL: "owner@test.com",
      DB: {
        prepare: () => ({ bind: () => ({ first: async () => null, run: async () => {} }) }),
      },
    } as unknown as Env;
    const headers = new Headers({ Authorization: "Bearer wrong-key" });

    expect(await resolveApiKeyUser(headers, env)).toBeNull();
    expect(await resolveApiKeyUser(headers, env)).toBeNull();
  });
});

describe("resolveApiKeyUser", () => {
  beforeEach(() => __clearApiKeyCache());

  it("returns null when no Authorization header", async () => {
    const headers = new Headers();
    const result = await resolveApiKeyUser(headers, mockEnv);
    expect(result).toBeNull();
  });

  it("returns null when Authorization is not Bearer", async () => {
    const headers = new Headers({ Authorization: "Session some-token" });
    const result = await resolveApiKeyUser(headers, mockEnv);
    expect(result).toBeNull();
  });

  it("returns null when token not in DB and not in env.API_KEY", async () => {
    const headers = new Headers({ Authorization: "Bearer unknown-key" });
    const result = await resolveApiKeyUser(headers, mockEnv);
    expect(result).toBeNull();
  });

  it("returns owner user for env.API_KEY fallback", async () => {
    const headers = new Headers({ Authorization: "Bearer test-api-key" });
    const mockEnvWithOwner = {
      ...mockEnv,
      DB: {
        prepare: (sql: string) => ({
          bind: () => ({
            first: async () =>
              sql.includes("api_keys")
                ? null
                : { id: "owner-id", email: "owner@test.com" },
            run: async () => {},
          }),
        }),
      },
    } as unknown as Env;
    const result = await resolveApiKeyUser(headers, mockEnvWithOwner);
    expect(result).toEqual({ userId: "owner-id", email: "owner@test.com" });
  });
});
