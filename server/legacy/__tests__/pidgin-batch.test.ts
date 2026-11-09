import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import worker from "../index";
import { sha256Hex } from "../auth-utils";
import { meter as meterHooks, setMeterHooks } from "../meter";
import { sweepBatchReceipts } from "../routes/batch";
import type { Env } from "../types";
import { installFakeMeter } from "./fake-meter";

// POST /api/batch through the real router and migrated D1. The meter hooks
// are a test double: this repository has no real metering.

const env = {
  ...bindings,
  API_KEY: "batch-test-key",
  OWNER_EMAIL: "owner@example.com",
  WORKER_URL: "https://pidgindocs.example.workers.dev",
  ENVIRONMENT: "production",
} as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
afterEach(() => setMeterHooks({}));

type Json = any;
const instance = { model: "m", session_id: "s", project: "p", source: "test" };
const msg = (ref: string, extra: Json = {}) => ({ ref, kind: "message", title: `t-${ref}`, body: "hello", instance, ...extra });
const doc = (ref: string) => ({ ref, kind: "document", title: `d-${ref}`, html: "<p>hi</p>" });

async function makeUser(label: string) {
  const id = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const token = `pidgin_sk_${id}`;
  await env.DB.prepare("INSERT INTO users (id, email, status) VALUES (?, ?, 'active')").bind(id, `${id}@example.com`).run();
  await env.DB.prepare("INSERT INTO api_keys (key_hash, key_prefix, user_id) VALUES (?, ?, ?)")
    .bind(await sha256Hex(token), "pidgin_sk", id).run();
  const batch = async (items: unknown, key: string | null = crypto.randomUUID()) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    if (key) headers["Idempotency-Key"] = key;
    const res = await worker.fetch(new Request("https://pidgindocs.example.workers.dev/api/batch", {
      method: "POST", headers, body: JSON.stringify({ items }),
    }), env, ctx);
    return { status: res.status, units: res.headers.get("X-Pidgin-Units"), body: (await res.json()) as Json };
  };
  const rows = async () =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?").bind(id).first<{ n: number }>())!.n;
  const receipt = (key: string) =>
    env.DB.prepare("SELECT * FROM batch_receipts WHERE owner = ? AND key = ?").bind(id, key).first<Json>();
  const plant = (key: string, claim: string, ageMinutes: number, extra: { status?: string; reserved?: number; units?: string; settled?: number } = {}) =>
    env.DB.prepare(
      `INSERT INTO batch_receipts (owner, key, claim_id, status, reserved, units, settled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`
    ).bind(id, key, claim, extra.status ?? "pending", extra.reserved ?? 0, extra.units ?? null, extra.settled ?? 0, `-${ageMinutes} minutes`).run();
  return { id, batch, rows, receipt, plant };
}

describe("POST /api/batch", () => {
  it("creates 3 messages and 1 document, reports units", async () => {
    const u = await makeUser("a");
    const r = await u.batch([msg("1"), msg("2"), msg("3"), doc("4")]);
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: Json) => [x.ref, x.ok])).toEqual([["1", true], ["2", true], ["3", true], ["4", true]]);
    expect(r.body.results.every((x: Json) => typeof x.id === "string")).toBe(true);
    expect(await u.rows()).toBe(4);
    expect(r.units).toBe("message=3;document=1");
  });

  it("rejects bad requests and creates nothing", async () => {
    const u = await makeUser("b");
    const big = await u.batch(Array.from({ length: 26 }, (_, i) => msg(String(i))));
    expect(big.status).toBe(413);
    expect(big.body.limits).toEqual({ max_items: 25, max_bytes: 2 * 1024 * 1024 });
    expect((await u.batch([])).status).toBe(400);
    expect((await u.batch([msg("1")], null)).status).toBe(400);
    const huge = await u.batch([msg("1", { body: "x".repeat(2 * 1024 * 1024 + 10) })]);
    expect(huge.status).toBe(413);
    expect(await u.rows()).toBe(0);
  });

  it("requires auth", async () => {
    const res = await worker.fetch(new Request("https://pidgindocs.example.workers.dev/api/batch", {
      method: "POST", headers: { "Idempotency-Key": "k" }, body: JSON.stringify({ items: [msg("1")] }),
    }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("runs items independently: an invalid middle item does not stop the others", async () => {
    const u = await makeUser("c");
    const meter = installFakeMeter(100);
    const r = await u.batch([msg("1"), { ref: "2", kind: "message", body: "no title" }, msg("3")]);
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: Json) => x.ok)).toEqual([true, false, true]);
    expect(r.body.results[1].error.code).toBe("invalid");
    expect(await u.rows()).toBe(2);
    expect(r.units).toBe("message=2");
    expect(meter.settleCalls[0].actual).toEqual({ message: 2 });
  });

  it("rejects an unknown kind and a message item carrying html", async () => {
    const u = await makeUser("c2");
    const r = await u.batch([{ ref: "1", kind: "nope" }, msg("2", { html: "<p>x</p>" })]);
    expect(r.body.results.map((x: Json) => x.ok)).toEqual([false, false]);
    expect(await u.rows()).toBe(0);
  });

  it("replays a repeated key: rows once, stored results, header none, no reserve", async () => {
    const u = await makeUser("d");
    const meter = installFakeMeter(100);
    const key = crypto.randomUUID();
    const first = await u.batch([msg("1"), msg("2")], key);
    const second = await u.batch([msg("1"), msg("2")], key);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(second.units).toBe("none");
    expect(await u.rows()).toBe(2);
    expect(meter.reserveCalls).toHaveLength(1);
    expect(meter.settleCalls).toHaveLength(1);
  });

  it("a refused reserve returns 429 with remaining and writes nothing", async () => {
    const u = await makeUser("e");
    const meter = installFakeMeter(1);
    const r = await u.batch([msg("1"), msg("2")]);
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ ok: false, error: "limit", remaining: { message: 1 } });
    expect(await u.rows()).toBe(0);
    expect(meter.settleCalls).toHaveLength(0);
  });

  it("a refused reserve deletes the claim, so the same key then runs", async () => {
    const u = await makeUser("f");
    const meter = installFakeMeter(100, { refuseNext: 1 });
    const key = crypto.randomUUID();
    expect((await u.batch([msg("1")], key)).status).toBe(429);
    expect(await u.receipt(key)).toBeNull();
    expect((await u.batch([msg("1")], key)).status).toBe(200);
    expect(await u.rows()).toBe(1);
    expect(meter.reserveCalls).toHaveLength(2);
  });

  it("settles once with only the successes when items fail", async () => {
    const u = await makeUser("g");
    const meter = installFakeMeter(100);
    const r = await u.batch([{ ref: "1", kind: "message" }, msg("2"), { ref: "3", kind: "status" }, msg("4")]);
    expect(r.body.results.map((x: Json) => x.ok)).toEqual([false, true, false, true]);
    expect(meter.settleCalls).toHaveLength(1);
    expect(meter.settleCalls[0].actual).toEqual({ message: 2 });
    expect(meter.remaining).toBe(98); // reserved 3 message + 1 status, 2 messages used
  });

  it("works with no hook installed", async () => {
    const u = await makeUser("h");
    const r = await u.batch([msg("1")]);
    expect(r.status).toBe(200);
    expect(r.units).toBe("message=1");
  });

  it("fails a team_id item for a non-member and runs the rest", async () => {
    const u = await makeUser("i");
    const r = await u.batch([msg("1"), msg("2", { team_id: "team-not-mine" }), msg("3")]);
    expect(r.body.results.map((x: Json) => x.ok)).toEqual([true, false, true]);
    expect(r.body.results[1].error.code).toBe("forbidden");
    expect(await u.rows()).toBe(2);
  });

  it("two concurrent batches with one key: one set of rows, one reserve", async () => {
    const u = await makeUser("j");
    const meter = installFakeMeter(100);
    const key = crypto.randomUUID();
    const [a, b] = await Promise.all([u.batch([msg("1"), msg("2")], key), u.batch([msg("1"), msg("2")], key)]);
    const winners = [a, b].filter((r) => r.status === 200 && r.units === "message=2");
    expect(winners).toHaveLength(1);
    const other = a === winners[0] ? b : a;
    expect(
      (other.status === 409 && other.body.error === "batch_in_progress") ||
      (other.status === 200 && other.units === "none")
    ).toBe(true);
    expect(await u.rows()).toBe(2);
    expect(meter.reserveCalls).toHaveLength(1);
  });

  it("a pending claim 6 minutes old is abandoned once and nothing runs", async () => {
    const u = await makeUser("k");
    const meter = installFakeMeter(100);
    const key = "stale-key";
    await u.plant(key, "claim-1", 6, { reserved: 1 });
    const [a, b] = await Promise.all([u.batch([msg("1")], key), u.batch([msg("1")], key)]);
    expect([a.status, b.status]).toEqual([409, 409]);
    expect([a.body.error, b.body.error]).toEqual(["batch_abandoned", "batch_abandoned"]);
    expect(meter.settleCalls).toEqual([{ rk: `${u.id}:${key}:claim-1`, actual: {} }]);
    expect(await u.rows()).toBe(0);
    expect((await u.receipt(key)).status).toBe("abandoned");
    expect((await u.receipt(key)).settled).toBe(1);
    expect((await u.batch([msg("1")], key)).body.error).toBe("batch_abandoned");
    expect(meter.settleCalls).toHaveLength(1);
  });

  it("a pending claim 4 minutes old is still in progress", async () => {
    const u = await makeUser("l");
    const meter = installFakeMeter(100);
    await u.plant("young", "claim-2", 4);
    const r = await u.batch([msg("1")], "young");
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("batch_in_progress");
    expect(meter.settleCalls).toHaveLength(0);
    expect(await u.rows()).toBe(0);
  });

  it("a claim abandoned between reserve and the reserved mark settles once and runs nothing", async () => {
    const u = await makeUser("m");
    const key = "slow-key";
    const meter = installFakeMeter(100, {
      onReserve: async () => {
        await env.DB.prepare("UPDATE batch_receipts SET status = 'abandoned' WHERE owner = ? AND key = ?").bind(u.id, key).run();
      },
    });
    const r = await u.batch([msg("1"), msg("2")], key);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("batch_abandoned");
    expect(meter.settleCalls).toHaveLength(1);
    expect(meter.settleCalls[0].actual).toEqual({});
    expect(meter.remaining).toBe(100);
    expect(await u.rows()).toBe(0);
  });

  it("a crash between the done update and settle is repaired once by the sweep", async () => {
    const u = await makeUser("n");
    const meter = installFakeMeter(100, { settleThrowsOnce: true });
    const key = crypto.randomUUID();
    const r = await u.batch([msg("1"), { ref: "2", kind: "message" }, msg("3")], key);
    expect(r.status).toBe(200);
    expect((await u.receipt(key)).settled).toBe(0);
    expect(meter.settleCalls).toHaveLength(1);
    await env.DB.prepare("UPDATE batch_receipts SET created_at = datetime('now', '-2 minutes') WHERE owner = ? AND key = ?").bind(u.id, key).run();
    await sweepBatchReceipts(env);
    expect(meter.settleCalls).toHaveLength(2);
    expect(meter.settleCalls[1].actual).toEqual({ message: 2 });
    expect(meter.remaining).toBe(98);
    await sweepBatchReceipts(env);
    expect(meter.settleCalls).toHaveLength(2);
    expect((await u.receipt(key)).settled).toBe(1);
  });

  it("a crash right after reserve is refunded by the sweep", async () => {
    const u = await makeUser("o");
    const meter = installFakeMeter(100);
    const key = "crashed-key";
    const rk = `${u.id}:${key}:claim-3`;
    await meterHooks().reserve(env, u.id, { message: 5 }, rk);
    expect(meter.remaining).toBe(95);
    await u.plant(key, "claim-3", 6); // reserved=0: the crash came before the mark
    const swept = await sweepBatchReceipts(env);
    expect(swept.abandoned).toBe(1);
    expect(meter.settleCalls).toEqual([{ rk, actual: {} }]);
    expect(meter.remaining).toBe(100);
    await sweepBatchReceipts(env);
    expect(meter.settleCalls).toHaveLength(1);
    // The abandoned key can never run again.
    expect((await u.batch([msg("1")], key)).body.error).toBe("batch_abandoned");
  });

  it("the sweep settles old unsettled receipts first, then deletes receipts older than 7 days", async () => {
    const u = await makeUser("p");
    const meter = installFakeMeter(100);
    await u.plant("old-settled", "c1", 60 * 24 * 8, { status: "done", settled: 1, units: "{}" });
    await u.plant("old-open", "c2", 60 * 24 * 8, { status: "done", settled: 0, units: "{}" });
    await sweepBatchReceipts(env);
    expect(await u.receipt("old-settled")).toBeNull();
    expect(meter.settleCalls).toHaveLength(1); // old-open was refunded before it was dropped
    expect(await u.receipt("old-open")).toBeNull();
  });

  it("publishes an artifact and deletes it, and reports a missing delete", async () => {
    const u = await makeUser("q");
    const a = await u.batch([{ ref: "a", kind: "artifact", title: "Page", favicon: "📄", html: "<p>x</p>" }]);
    expect(a.body.results[0]).toMatchObject({ ref: "a", ok: true, version: 1 });
    const id = a.body.results[0].id;
    const d = await u.batch([{ ref: "d", kind: "delete", id }, { ref: "e", kind: "delete", id: "missing" }]);
    expect(d.body.results[0].ok).toBe(true);
    expect(d.body.results[1].error.code).toBe("not_found");
    expect(d.units).toBe("delete=1");
  });

  it("fails a comment item for a non-member", async () => {
    const u = await makeUser("r");
    const r = await u.batch([{ ref: "c", kind: "comment", team_id: "nope", resource_type: "message", resource_id: "x", body: "hi" }]);
    expect(r.body.results[0].error.code).toBe("forbidden");
  });
});
