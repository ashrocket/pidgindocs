import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __clearInstanceSettingsCache, setInstanceSetting } from "../core/instance-settings";
import { resolveSelfHostEnv, selfHostEntry, type CoreHandlers } from "../core/self-host";
import type { Env } from "../core/types";

const bindings = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
const db = bindings.DB;
const base = { ...bindings, WORKER_URL: undefined, API_KEY: undefined, DOC_SHARE_SECRET: undefined } as unknown as Env;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const seen: Env[] = [];
const fake: CoreHandlers = {
  async fetch(_request, received) { seen.push(received); return new Response("ok"); },
  async scheduled(_controller, received) { seen.push(received); },
  async queue(_batch, received) { seen.push(received); },
};
const wrapped = selfHostEntry(fake);
const hit = (received: Env, origin = "https://pidgin.example.test") =>
  wrapped.fetch(new Request(`${origin}/health`), received, ctx);
const rowCount = async (name: string) =>
  (await db.prepare("SELECT COUNT(*) AS n FROM instance_settings WHERE name = ?1").bind(name).first<{ n: number }>())!.n;

beforeAll(async () => {
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
});

beforeEach(async () => {
  seen.length = 0;
  await db.prepare("DELETE FROM instance_settings").run();
  __clearInstanceSettingsCache();
});

describe("the self-host entry", () => {
  it("uses the request's origin until one is stored", async () => {
    expect((await hit(base)).status).toBe(200);
    expect(seen[0].WORKER_URL).toBe("https://pidgin.example.test");
    expect(seen[0].SELF_HOST).toEqual({ originSource: "request" });
    expect(await rowCount("origin")).toBe(0);
  });

  it("prefers a stored origin to the request's", async () => {
    await setInstanceSetting(db, "origin", "https://docs.example.test", "keep");
    await hit(base, "https://other.example.test");
    expect(seen[0].WORKER_URL).toBe("https://docs.example.test");
    expect(seen[0].SELF_HOST).toEqual({ originSource: "stored" });
  });

  it("lets a set WORKER_URL win", async () => {
    await setInstanceSetting(db, "origin", "https://docs.example.test", "keep");
    await hit({ ...base, WORKER_URL: "https://set.example.test" } as Env);
    expect(seen[0].WORKER_URL).toBe("https://set.example.test");
    expect(seen[0].SELF_HOST).toEqual({ originSource: "configured" });
  });

  it("gives scheduled and queue the stored origin", async () => {
    await setInstanceSetting(db, "origin", "https://docs.example.test", "keep");
    await wrapped.scheduled({} as ScheduledController, base, ctx);
    await wrapped.queue({} as MessageBatch<never>, base, ctx);
    expect(seen.map((received) => received.WORKER_URL)).toEqual(["https://docs.example.test", "https://docs.example.test"]);
  });

  it("leaves WORKER_URL unset in scheduled when nothing is stored", async () => {
    await wrapped.scheduled({} as ScheduledController, base, ctx);
    expect(seen[0].WORKER_URL).toBeUndefined();
    expect(seen[0].SELF_HOST).toEqual({ originSource: "none" });
  });

  it("takes DOC_SHARE_SECRET first", async () => {
    await setInstanceSetting(db, "share_secret", "stored-secret", "keep");
    await hit({ ...base, DOC_SHARE_SECRET: "share-secret", API_KEY: "test-key" } as Env);
    expect(seen[0].DOC_SHARE_SECRET).toBe("share-secret");
  });

  it("then takes a stored secret over API_KEY", async () => {
    await setInstanceSetting(db, "share_secret", "stored-secret", "keep");
    await hit({ ...base, API_KEY: "test-key" } as Env);
    expect(seen[0].DOC_SHARE_SECRET).toBe("stored-secret");
  });

  it("then uses API_KEY without storing it", async () => {
    await hit({ ...base, API_KEY: "test-key" } as Env);
    expect(seen[0].DOC_SHARE_SECRET).toBe("test-key");
    expect(await rowCount("share_secret")).toBe(0);
  });

  it("then generates a secret, stores it, and reuses it", async () => {
    await hit(base);
    const first = seen[0].DOC_SHARE_SECRET!;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await rowCount("share_secret")).toBe(1);
    await hit(base);
    expect(seen[1].DOC_SHARE_SECRET).toBe(first);
  });

  it("keeps a generated secret after API_KEY is set later", async () => {
    await hit(base);
    const generated = seen[0].DOC_SHARE_SECRET;
    await hit({ ...base, API_KEY: "test-key" } as Env);
    expect(seen[1].DOC_SHARE_SECRET).toBe(generated);
  });

  it("agrees on one secret when two first requests race", async () => {
    __clearInstanceSettingsCache();
    const origin = "https://pidgin.example.test";
    const [a, b] = await Promise.all([resolveSelfHostEnv(base, origin), resolveSelfHostEnv(base, origin)]);
    expect(a.DOC_SHARE_SECRET).toBe(b.DOC_SHARE_SECRET);
    expect(await rowCount("share_secret")).toBe(1);
  });

  it("never writes to env", async () => {
    const frozen = Object.freeze({ ...base }) as Env;
    await hit(frozen);
    expect(seen[0].WORKER_URL).toBe("https://pidgin.example.test");
    expect(frozen.WORKER_URL).toBeUndefined();
  });

  it("serves requests when instance_settings is missing", async () => {
    const broken = { prepare() { throw new Error("no such table: instance_settings"); } } as unknown as D1Database;
    const response = await hit({ ...base, DB: broken } as Env);
    expect(response.status).toBe(200);
    expect(seen[0].WORKER_URL).toBe("https://pidgin.example.test");
    expect(seen[0].SELF_HOST).toEqual({ originSource: "request" });
    expect(seen[0].DOC_SHARE_SECRET).toBeUndefined();
  });
});
