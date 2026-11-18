import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkRateLimit } from "../core/ratelimit";
import { selfHostEntry, type CoreHandlers } from "../core/self-host";
import type { Env } from "../core/types";

const bindings = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
const db = bindings.DB;
const base = { ...bindings, WORKER_URL: undefined } as unknown as Env;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const controller = { cron: "17 * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController;

const throwing = (): never => { throw new Error("kv must not be used"); };
const kvThatThrows = {
  get: throwing, put: throwing, delete: throwing, list: throwing, getWithMetadata: throwing,
} as unknown as KVNamespace;
const selfEnv = { ...bindings, SELF_HOST: { originSource: "request" }, SESSIONS: kvThatThrows } as unknown as Env;

const rowFor = (bucket: string) =>
  db.prepare("SELECT count, expires_at AS expiresAt FROM rate_limits WHERE bucket = ?1").bind(bucket).first<{ count: number; expiresAt: number }>();

beforeAll(async () => {
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await db.prepare("DELETE FROM rate_limits").run();
});

describe("rate limits on a self-host", () => {
  it("counts in D1 and never touches KV", async () => {
    expect(await checkRateLimit(selfEnv, "a", 2, 60)).toBe(true);
    expect(await checkRateLimit(selfEnv, "a", 2, 60)).toBe(true);
    expect(await checkRateLimit(selfEnv, "a", 2, 60)).toBe(false);
  });

  it("keeps separate keys apart", async () => {
    await checkRateLimit(selfEnv, "a", 1, 60);
    expect(await checkRateLimit(selfEnv, "a", 1, 60)).toBe(false);
    expect(await checkRateLimit(selfEnv, "b", 1, 60)).toBe(true);
  });

  it("starts a new window after the old one ends", async () => {
    await checkRateLimit(selfEnv, "a", 1, 60);
    expect(await checkRateLimit(selfEnv, "a", 1, 60)).toBe(false);
    await db.prepare("UPDATE rate_limits SET expires_at = 0").run();
    expect(await checkRateLimit(selfEnv, "a", 1, 60)).toBe(true);
    expect((await rowFor("rl:a"))!.count).toBe(1);
  });

  it("keeps a hosted edition on KV", async () => {
    const puts: string[] = [];
    const kv = {
      async get() { return null; },
      async put(key: string) { puts.push(key); },
    } as unknown as KVNamespace;
    const hosted = { ...bindings, SESSIONS: kv } as unknown as Env;
    expect(await checkRateLimit(hosted, "a", 2, 60)).toBe(true);
    expect(puts).toContain("rl:a");
    expect(await rowFor("rl:a")).toBeNull();
  });

  it("prunes expired counters on schedule", async () => {
    const seen: Env[] = [];
    const app: CoreHandlers = {
      async fetch() { return new Response("ok"); },
      async scheduled(_controller, received) { seen.push(received); },
      async queue() {},
    };
    await db.prepare("INSERT INTO rate_limits (bucket, count, expires_at) VALUES ('old', 1, 1)").run();
    await db.prepare("INSERT INTO rate_limits (bucket, count, expires_at) VALUES ('live', 1, 4102444800)").run();
    await selfHostEntry(app).scheduled(controller, base, ctx);
    const rows = await db.prepare("SELECT bucket FROM rate_limits").all<{ bucket: string }>();
    expect(rows.results.map((row) => row.bucket)).toEqual(["live"]);
    expect(seen).toHaveLength(1);
  });
});
