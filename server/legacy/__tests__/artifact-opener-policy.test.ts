import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../index";
import { sha256Hex } from "../auth-utils";
import { publishArtifact } from "../artifacts/store";
import type { Env } from "../types";

const origin = "https://pidgindocs.example.workers.dev";
const env = {
  ...bindings,
  API_KEY: "opener-policy-test",
  OWNER_EMAIL: "owner@example.com",
  WORKER_URL: origin,
  ENVIRONMENT: "production",
} as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// Creates an active user with an API key, returning a GET helper that sends its bearer token.
async function user() {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID().replace(/-/g, "");
  await env.DB.prepare("INSERT INTO users(id,email,status) VALUES(?,?,'active')")
    .bind(id, `${id}@example.com`).run();
  await env.DB.prepare("INSERT INTO api_keys(key_hash,key_prefix,user_id) VALUES(?,?,?)")
    .bind(await sha256Hex(token), "test", id).run();
  const get = (path: string, headers: Record<string, string> = {}) =>
    worker.fetch(
      new Request(origin + path, { method: "GET", headers: { Authorization: `Bearer ${token}`, ...headers } }),
      env,
      ctx
    );
  return { id, get };
}

describe("artifact page opener policy", () => {
  it("sends the opener policy on an artifact page", async () => {
    const u = await user();
    const published = await publishArtifact(env, { userId: u.id, html: "<p>opener</p>", favicon: "📄" });
    const response = await u.get(`/a/${published.artifact.id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Content-Security-Policy")).toBeTruthy();
  });

  it("does not send it on a JSON error", async () => {
    const u = await user();
    const response = await u.get(`/a/${crypto.randomUUID()}`);
    expect(response.status).not.toBe(200);
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBeNull();
  });

  it("sends the opener policy on a public artifact without credentials", async () => {
    const u = await user();
    const published = await publishArtifact(env, {
      userId: u.id,
      html: "<p>public</p>",
      favicon: "📄",
      visibility: "public",
    });
    const response = await worker.fetch(new Request(origin + `/a/${published.artifact.id}`), env, ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Content-Security-Policy")).toBeTruthy();
  });
});
