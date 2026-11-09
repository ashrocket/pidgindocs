import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import worker from "../index";
import { sha256Hex } from "../auth-utils";
import { scheduled } from "../cron";
import { commitStaleDrafts } from "../drafts";
import { setMeterHooks } from "../meter";
import { WORKSPACE_BACKUP_PREFIX } from "../workspace-backup";
import type { Env } from "../types";
import { installFakeMeter } from "./fake-meter";

// Server-side drafts through the real router, R2 and migrated D1. The meter
// hooks are a test double: this repository has no real metering.

const env = {
  ...bindings,
  API_KEY: "drafts-test-key",
  OWNER_EMAIL: "owner@example.com",
  WORKER_URL: "https://pidgindocs.example.workers.dev",
  ENVIRONMENT: "production",
} as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
afterEach(() => setMeterHooks({}));

type Json = any;
const MIN = 60_000;
const newKey = () => `k${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

async function makeUser(label: string) {
  const id = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const token = `pidgin_sk_${id}`;
  await env.DB.prepare("INSERT INTO users (id, email, status) VALUES (?, ?, 'active')").bind(id, `${id}@example.com`).run();
  await env.DB.prepare("INSERT INTO api_keys (key_hash, key_prefix, user_id) VALUES (?, ?, ?)")
    .bind(await sha256Hex(token), "pidgin_sk", id).run();
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await worker.fetch(new Request(`https://pidgindocs.example.workers.dev${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }), env, ctx);
    return { status: res.status, units: res.headers.get("X-Pidgin-Units"), body: (await res.json().catch(() => null)) as Json };
  };
  const put = (key: string, body: unknown) => call("PUT", `/api/drafts/${key}`, body);
  const commit = (key: string, idem?: string) =>
    call("POST", `/api/drafts/${key}/commit`, undefined, idem ? { "Idempotency-Key": idem } : {});
  const docs = async () =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND type = 'document'").bind(id).first<{ n: number }>())!.n;
  const objectKey = (key: string) => `drafts/${id}/${key}.json`;
  const exists = async (key: string) => (await env.DOCS.head(objectKey(key))) !== null;
  return { id, put, commit, call, docs, exists, objectKey };
}

const docDraft = (extra: Json = {}) => ({ kind: "document", title: "Draft doc", html: "<p>hi</p>", ...extra });
const artDraft = (extra: Json = {}) => ({ kind: "artifact", title: "Page", favicon: "📄", html: "<p>x</p>", ...extra });

describe("drafts", () => {
  it("10 PUTs then 1 commit make one document and remove the draft", async () => {
    const u = await makeUser("a");
    const key = newKey();
    for (let i = 0; i < 10; i++) {
      const r = await u.put(key, docDraft({ html: `<p>v${i}</p>` }));
      expect(r.status).toBe(200);
      expect(r.units).toBe("draft_put=1");
    }
    const c = await u.commit(key);
    expect(c.status).toBe(200);
    expect(c.units).toBe("draft_commit=1");
    expect(await u.docs()).toBe(1);
    expect(await u.exists(key)).toBe(false);
  });

  it("a second commit is 404", async () => {
    const u = await makeUser("b");
    const key = newKey();
    await u.put(key, docDraft());
    expect((await u.commit(key)).status).toBe(200);
    expect((await u.commit(key)).status).toBe(404);
    expect(await u.docs()).toBe(1);
  });

  it("two commits with one Idempotency-Key run once and replay the first result", async () => {
    const u = await makeUser("b2");
    const key = newKey();
    await u.put(key, docDraft());
    const idem = crypto.randomUUID();
    const [a, b] = await Promise.all([u.commit(key, idem), u.commit(key, idem)]);
    const ok = [a, b].filter((r) => r.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of [a, b]) expect([200, 409, 404]).toContain(r.status);
    expect(await u.docs()).toBe(1);
    const again = await u.commit(key, idem);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(ok[0].body);
    expect(await u.docs()).toBe(1);
  });

  it("a stale base_version is 409 and keeps the draft", async () => {
    const u = await makeUser("c");
    const first = newKey();
    await u.put(first, artDraft());
    const created = await u.commit(first);
    expect(created.status).toBe(200);
    const artifactId = created.body.data.id;
    const key = newKey();
    await u.put(key, artDraft({ target: { artifact_id: artifactId, base_version: 7 } }));
    const stale = await u.commit(key);
    expect(stale.status).toBe(409);
    expect(await u.exists(key)).toBe(true);
    await u.put(key, artDraft({ target: { artifact_id: artifactId, base_version: 1 } }));
    const ok = await u.commit(key);
    expect(ok.status).toBe(200);
    expect(ok.body.data.version).toBe(2);
  });

  it("the 51st key is 409, an existing key can still be overwritten", async () => {
    const u = await makeUser("d");
    const keys = Array.from({ length: 50 }, newKey);
    for (const k of keys) expect((await u.put(k, docDraft())).status).toBe(200);
    expect((await u.put(newKey(), docDraft())).status).toBe(409);
    expect((await u.put(keys[0], docDraft({ title: "again" }))).status).toBe(200);
    await u.commit(keys[1]);
    expect((await u.put(newKey(), docDraft())).status).toBe(200);
  });

  it("another user's key is 404 for commit and delete", async () => {
    const u = await makeUser("e");
    const v = await makeUser("e2");
    const key = newKey();
    await u.put(key, docDraft());
    expect((await v.commit(key)).status).toBe(404);
    expect((await v.call("DELETE", `/api/drafts/${key}`)).status).toBe(404);
    expect(await u.exists(key)).toBe(true);
  });

  it("rejects a body over 2 MB, bad keys and bad kinds", async () => {
    const u = await makeUser("f");
    const key = newKey();
    expect((await u.put(key, docDraft({ html: "x".repeat(2 * 1024 * 1024 + 10) }))).status).toBe(413);
    expect(await u.exists(key)).toBe(false);
    expect((await u.call("PUT", "/api/drafts/short", docDraft())).status).toBe(404);
    expect((await u.put(key, { kind: "message", title: "x" })).status).toBe(400);
    expect((await u.put(key, "not json")).status).toBe(400);
  });

  it("requires auth", async () => {
    const res = await worker.fetch(new Request(`https://pidgindocs.example.workers.dev/api/drafts/${newKey()}`, {
      method: "PUT", body: JSON.stringify(docDraft()),
    }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("deletes a draft", async () => {
    const u = await makeUser("g");
    const key = newKey();
    await u.put(key, docDraft());
    expect((await u.call("DELETE", `/api/drafts/${key}`)).status).toBe(200);
    expect(await u.exists(key)).toBe(false);
    expect((await u.call("DELETE", `/api/drafts/${key}`)).status).toBe(404);
  });
});

describe("draft cron", () => {
  async function uploaded(u: { objectKey: (k: string) => string }, key: string) {
    return (await env.DOCS.head(u.objectKey(key)))!.uploaded.getTime();
  }

  it("commits a draft idle for 11 minutes and leaves one idle for 9", async () => {
    const u = await makeUser("h");
    const key = newKey();
    await u.put(key, docDraft());
    const t = await uploaded(u, key);
    await commitStaleDrafts(env, 10 * MIN, t + 9 * MIN);
    expect(await u.exists(key)).toBe(true);
    expect(await u.docs()).toBe(0);
    await commitStaleDrafts(env, 10 * MIN, t + 11 * MIN);
    expect(await u.exists(key)).toBe(false);
    expect(await u.docs()).toBe(1);
  });

  it("reserves keyed by the draft and keeps the reservation on success", async () => {
    const u = await makeUser("i");
    const meter = installFakeMeter(10);
    const key = newKey();
    await u.put(key, docDraft());
    const t = await uploaded(u, key);
    await commitStaleDrafts(env, 10 * MIN, t + 11 * MIN);
    expect(meter.reserveCalls).toHaveLength(1);
    expect(meter.reserveCalls[0]).toContain(key);
    expect(meter.reserveCalls[0]).toContain(String(t));
    expect(meter.settleCalls).toHaveLength(0);
    expect(meter.remaining).toBe(9);
  });

  it("a refusing hook keeps the draft and never settles", async () => {
    const u = await makeUser("j");
    const meter = installFakeMeter(10, { refuseNext: 1 });
    const key = newKey();
    await u.put(key, docDraft());
    const t = await uploaded(u, key);
    await commitStaleDrafts(env, 10 * MIN, t + 11 * MIN);
    expect(await u.exists(key)).toBe(true);
    expect(await u.docs()).toBe(0);
    expect(meter.settleCalls).toHaveLength(0);
    // The next run reserves again (a refusal wrote no ledger row) and commits.
    await commitStaleDrafts(env, 10 * MIN, t + 16 * MIN);
    expect(await u.exists(key)).toBe(false);
  });

  it("a failing publish settles once with nothing and keeps the draft", async () => {
    const u = await makeUser("k");
    const meter = installFakeMeter(10);
    const key = newKey();
    await u.put(key, { kind: "document", title: "no content" });
    const t = await uploaded(u, key);
    await commitStaleDrafts(env, 10 * MIN, t + 11 * MIN);
    expect(meter.settleCalls).toHaveLength(1);
    expect(meter.settleCalls[0].actual).toEqual({});
    expect(meter.remaining).toBe(10);
    expect(await u.exists(key)).toBe(true);
    // A settled key is a tombstone: the next run does not reserve or settle again.
    await commitStaleDrafts(env, 10 * MIN, t + 16 * MIN);
    expect(meter.settleCalls).toHaveLength(1);
    expect(meter.remaining).toBe(10);
  });

  it("a throw on one draft does not stop the next", async () => {
    const u = await makeUser("l");
    const bad = "aaaa" + newKey();
    const good = "zzzz" + newKey();
    await env.DOCS.put(u.objectKey(bad), "{ not json");
    await u.put(good, docDraft());
    const t = await uploaded(u, good);
    await commitStaleDrafts(env, 10 * MIN, t + 11 * MIN);
    expect(await u.exists(good)).toBe(false);
    expect(await u.exists(bad)).toBe(true);
    expect(await u.docs()).toBe(1);
  });

  it("the five-minute trigger commits drafts and runs neither expiry nor backup", async () => {
    const u = await makeUser("m");
    const key = newKey();
    await u.put(key, docDraft());
    await env.DB.prepare(
      `INSERT INTO messages (id, type, title, user_id, expires_at, instance_model, instance_session_id, instance_project, instance_source)
       VALUES (?, 'message', 't', ?, datetime('now', '-1 day'), 'm', 's', 'p', 't')`
    ).bind(`exp-5-${u.id}`, u.id).run();
    const before = (await env.DOCS.list({ prefix: WORKSPACE_BACKUP_PREFIX })).objects.length;
    await scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() + 11 * MIN } as ScheduledController, env, ctx);
    expect(await u.exists(key)).toBe(false); // committed: scheduledTime is the clock
    expect(await env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(`exp-5-${u.id}`).first()).not.toBeNull();
    expect((await env.DOCS.list({ prefix: WORKSPACE_BACKUP_PREFIX })).objects.length).toBe(before);
  });

  it("the daily trigger runs expiry and backup, and deletes drafts over 7 days old", async () => {
    const u = await makeUser("n");
    const key = newKey();
    await u.put(key, docDraft());
    await env.DB.prepare(
      `INSERT INTO messages (id, type, title, user_id, expires_at, instance_model, instance_session_id, instance_project, instance_source)
       VALUES (?, 'message', 't', ?, datetime('now', '-1 day'), 'm', 's', 'p', 't')`
    ).bind(`exp-d-${u.id}`, u.id).run();
    const before = (await env.DOCS.list({ prefix: WORKSPACE_BACKUP_PREFIX })).objects.length;
    await scheduled({ cron: "0 3 * * *", scheduledTime: Date.now() + 8 * 24 * 60 * MIN } as ScheduledController, env, ctx);
    expect(await env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(`exp-d-${u.id}`).first()).toBeNull();
    expect((await env.DOCS.list({ prefix: WORKSPACE_BACKUP_PREFIX })).objects.length).toBeGreaterThan(before);
    expect(await u.exists(key)).toBe(false);
    expect(await u.docs()).toBe(0); // deleted, not committed
  });

  it("the daily trigger keeps a fresh draft", async () => {
    const u = await makeUser("o");
    const key = newKey();
    await u.put(key, docDraft());
    await scheduled({ cron: "0 3 * * *", scheduledTime: Date.now() } as ScheduledController, env, ctx);
    expect(await u.exists(key)).toBe(true);
  });
});
