import { afterEach, describe, expect, it, vi } from "vitest";

import { cacheTtlSeconds, fetchJwks } from "../core/auth/jwks";
import type { Env } from "../core/types";

class MockSessions {
  store = new Map<string, string>();
  puts: Array<{ key: string; value: string; options?: KVNamespacePutOptions }> = [];

  async get(key: string) { return this.store.get(key) ?? null; }
  async put(key: string, value: string, options?: KVNamespacePutOptions) {
    this.store.set(key, value);
    this.puts.push({ key, value, options });
  }
}

function env(sessions: MockSessions): Env {
  return { SESSIONS: sessions } as unknown as Env;
}

afterEach(() => vi.restoreAllMocks());

describe("JWKS caching", () => {
  it("honors a provider max-age within safe bounds", () => {
    expect(cacheTtlSeconds("public, max-age=90")).toBe(5 * 60);
    expect(cacheTtlSeconds("max-age=900")).toBe(900);
    expect(cacheTtlSeconds("max-age=999999")).toBe(6 * 60 * 60);
    expect(cacheTtlSeconds(null)).toBe(60 * 60);
  });

  it("refreshes once for an unknown key and then uses a cooldown", async () => {
    const sessions = new MockSessions();
    sessions.store.set("jwks:accounts.example.com", JSON.stringify({ keys: [{ kid: "old" }] }));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ keys: [{ kid: "new" }] }), {
        headers: { "Cache-Control": "max-age=1200" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const refreshed = await fetchJwks("https://accounts.example.com/keys", env(sessions), { bypassCache: true });
    expect(refreshed.keys[0]).toMatchObject({ kid: "new" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
    expect(sessions.puts).toContainEqual(expect.objectContaining({
      key: "jwks:accounts.example.com",
      options: { expirationTtl: 1200 },
    }));
    expect(sessions.puts).toContainEqual(expect.objectContaining({
      key: "jwks_refetch:accounts.example.com",
      options: { expirationTtl: 60 },
    }));

    const cached = await fetchJwks("https://accounts.example.com/keys", env(sessions), { bypassCache: true });
    expect(cached.keys[0]).toMatchObject({ kid: "new" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
