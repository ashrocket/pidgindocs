import { describe, expect, it } from "vitest";

import { handlePostPreview, handleGetPreview } from "../core/routes/preview";
import type { Env } from "../core/types";

// Ephemeral HTML previews live entirely in KV — no D1, auth is the master
// key only (verifyApiKey is a pure comparison).

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

function makeEnv(overrides: Partial<Env> = {}): { env: Env; kv: MockKV } {
  const kv = new MockKV();
  const env = {
    DB: {} as D1Database,
    DOCS: {} as R2Bucket,
    SESSIONS: kv as unknown as KVNamespace,
    ENHANCE_QUEUE: {} as Env["ENHANCE_QUEUE"],
    API_KEY: "master-key",
    OWNER_EMAIL: "test@example.com",
    APNS_KEY_ID: "",
    APNS_TEAM_ID: "",
    APNS_PRIVATE_KEY: "",
    WORKER_URL: "https://pidgin.example.com",
    ENVIRONMENT: "test",
    ...overrides,
  } as Env;
  return { env, kv };
}

function postRequest(body: unknown, token: string | null = "master-key"): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request("https://origin.example.net/api/preview", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

interface PostData {
  id: string;
  url: string;
  expiresAt: string;
}

async function postOk(env: Env, body: unknown): Promise<PostData> {
  const response = await handlePostPreview(postRequest(body), env);
  expect(response.status).toBe(200);
  const parsed = (await response.json()) as { ok: boolean; data: PostData };
  return parsed.data;
}

describe("handlePostPreview", () => {
  it("1. rejects a missing or wrong API key", async () => {
    const { env } = makeEnv();
    expect((await handlePostPreview(postRequest({ html: "<p>x</p>" }, null), env)).status).toBe(401);
    expect((await handlePostPreview(postRequest({ html: "<p>x</p>" }, "wrong"), env)).status).toBe(401);
  });

  it("2. rejects invalid JSON, missing html, and oversized html", async () => {
    const { env } = makeEnv();
    expect((await handlePostPreview(postRequest("{nope"), env)).status).toBe(400);
    expect((await handlePostPreview(postRequest({ title: "no html" }), env)).status).toBe(400);
    expect((await handlePostPreview(postRequest({ html: 42 }), env)).status).toBe(400);

    const oversized = "x".repeat(2 * 1024 * 1024 + 1);
    expect((await handlePostPreview(postRequest({ html: oversized }), env)).status).toBe(413);
  });

  it("3. stores the preview in KV with the default TTL and title fallback", async () => {
    const { env, kv } = makeEnv();
    const data = await postOk(env, { html: "<h1>hi</h1>" });

    expect(data.url).toBe(`https://pidgin.example.com/preview/${data.id}`);
    expect(Date.parse(data.expiresAt)).toBeGreaterThan(Date.now());

    const stored = JSON.parse(kv.data.get(`preview:${data.id}`)!) as { html: string; title: string };
    expect(stored.html).toBe("<h1>hi</h1>");
    expect(stored.title).toBe("Preview");
    expect(kv.ttls.get(`preview:${data.id}`)).toBe(7200);
  });

  it("4. honors a custom TTL, clamps to 24h, and ignores non-positive TTLs", async () => {
    const { env, kv } = makeEnv();

    const custom = await postOk(env, { html: "<p>a</p>", ttl: 3600 });
    expect(kv.ttls.get(`preview:${custom.id}`)).toBe(3600);

    const clamped = await postOk(env, { html: "<p>b</p>", ttl: 999_999 });
    expect(kv.ttls.get(`preview:${clamped.id}`)).toBe(86_400);

    const negative = await postOk(env, { html: "<p>c</p>", ttl: -5 });
    expect(kv.ttls.get(`preview:${negative.id}`)).toBe(7200);
  });

  it("5. falls back to the request origin when WORKER_URL is unset", async () => {
    const { env } = makeEnv({ WORKER_URL: "" });
    const data = await postOk(env, { html: "<p>x</p>" });
    expect(data.url).toBe(`https://origin.example.net/preview/${data.id}`);
  });
});

describe("handleGetPreview", () => {
  it("6. serves the stored HTML with no-store and the encoded title header", async () => {
    const { env } = makeEnv();
    const data = await postOk(env, { html: "<h1>döc</h1>", title: "Nöte & Co" });

    const response = await handleGetPreview(
      new Request(`https://pidgin.example.com/preview/${data.id}`),
      env,
      data.id
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>döc</h1>");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(decodeURIComponent(response.headers.get("X-Preview-Title")!)).toBe("Nöte & Co");
  });

  it("7. returns the branded 404 page for missing/expired previews (no auth required)", async () => {
    const { env } = makeEnv();
    const response = await handleGetPreview(
      new Request("https://pidgin.example.com/preview/nope"),
      env,
      "nope"
    );
    expect(response.status).toBe(404);
    const page = await response.text();
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(page).toContain("expired or doesn't exist");
  });

  it("8. returns a 500 with the same page shape for corrupted KV entries", async () => {
    const { env, kv } = makeEnv();
    kv.data.set("preview:bad", "{corrupted");
    const response = await handleGetPreview(
      new Request("https://pidgin.example.com/preview/bad"),
      env,
      "bad"
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("expired or doesn't exist");
  });
});
