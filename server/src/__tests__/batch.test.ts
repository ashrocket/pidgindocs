import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import coreWorker from "../core/app";
import { sha256Hex } from "../core/auth-utils";
import { installEditionHooks } from "../core/edition-hooks";
import { installEditionRoutes } from "../core/edition-routes";
import { runBatchSweep } from "../core/routes/batch";
import type { Env } from "../core/types";

vi.mock("../core/push/apns", () => ({ sendPushNotification: vi.fn(async () => {}) }));
vi.mock("../core/destinations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/destinations")>()),
  deliverToDestinations: vi.fn(async () => {}),
}));

// POST /api/batch through the real router and migrated D1. Each item must behave as the single
// request it stands for, so the parity tests send the same request both ways.

const origin = "https://example.test";
const env = { ...bindings, WORKER_URL: origin, ENTRA_ONLY: "false" } as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
// PidginCore alone: no edition hooks or route blocks unless a test installs them.
beforeEach(() => { installEditionHooks({}); installEditionRoutes({}); });
afterEach(() => installEditionHooks({}));

type Json = any;
const instance = { model: "m", session_id: "s", project: "p", source: "test" };
const msg = (ref: string, extra: Json = {}) => ({ ref, kind: "message", title: `t-${ref}`, body: "hello", instance, ...extra });
const doc = (ref: string, extra: Json = {}) => ({ ref, kind: "document", title: `d-${ref}`, html: "<p>hi</p>", instance, ...extra });
const status = (ref: string, extra: Json = {}) => ({ ref, kind: "status", title: `s-${ref}`, body: `line ${ref}`, instance, ...extra });

async function makeUser(label: string) {
  const id = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const token = `key_${id}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, email, status) VALUES (?, ?, 'active')").bind(id, `${id}@example.test`),
    env.DB.prepare("INSERT INTO api_keys (key_hash, key_prefix, user_id) VALUES (?, ?, ?)").bind(await sha256Hex(token), "key", id),
  ]);
  const send = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, credential = `Bearer ${token}`) => {
    const res = await coreWorker.fetch(new Request(origin + path, {
      method, headers: { ...(credential ? { Authorization: credential } : {}), "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }), env, ctx);
    const text = await res.text();
    let parsed: Json = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, text };
  };
  const batch = (items: unknown, key: string | null = crypto.randomUUID()) =>
    send("POST", "/api/batch", { items }, key ? { "Idempotency-Key": key } : {});
  const rows = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?").bind(id).first<{ n: number }>())!.n;
  const receipt = (key: string) => env.DB.prepare("SELECT * FROM batch_receipts WHERE owner = ? AND key = ?").bind(id, key).first<Json>();
  const plant = (key: string, items: unknown, ageMinutes: number, state = "pending") =>
    sha256Hex(JSON.stringify({ items })).then((hash) => env.DB.prepare(
      "INSERT INTO batch_receipts (owner, key, request_hash, claim_id, status, created_ms) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(id, key, hash, crypto.randomUUID(), state, Date.now() - ageMinutes * 60_000).run());
  return { id, token, send, batch, rows, receipt, plant };
}
type User = Awaited<ReturnType<typeof makeUser>>;

async function makeTeam(owner: string, role = "owner", teamOwner = owner) {
  const team = `team-${crypto.randomUUID().slice(0, 8)}`;
  const project = `proj-${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO teams (id, slug, name, owner_user_id) VALUES (?, ?, 'T', ?)").bind(team, team, teamOwner),
    env.DB.prepare("INSERT INTO projects (id, team_id, slug, name, created_by_user_id) VALUES (?, ?, ?, 'P', ?)").bind(project, team, project, teamOwner),
    env.DB.prepare("INSERT INTO team_memberships(team_id,user_id,role) VALUES(?,?,?)").bind(team, owner, role),
  ]);
  return { team, project };
}

describe("POST /api/batch", () => {
  it("creates 3 messages and 1 document", async () => {
    const u = await makeUser("a");
    const r = await u.batch([msg("1"), msg("2"), msg("3"), doc("4")]);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.results.map((x: Json) => [x.ref, x.ok])).toEqual([["1", true], ["2", true], ["3", true], ["4", true]]);
    expect(r.body.results.every((x: Json) => typeof x.id === "string")).toBe(true);
    expect(await u.rows()).toBe(4);
  });

  it("rejects bad requests and creates nothing", async () => {
    const u = await makeUser("b");
    const big = await u.batch(Array.from({ length: 26 }, (_, i) => msg(String(i))));
    expect(big.status).toBe(413);
    expect(big.body.limits).toEqual({ max_items: 25, max_bytes: 2 * 1024 * 1024 });
    expect((await u.batch([])).status).toBe(400);
    expect((await u.batch([msg("1")], null)).status).toBe(400);
    expect((await u.batch([msg("1")], "k".repeat(129))).status).toBe(400);
    expect((await u.batch([msg("1")], "bad\u0001key")).status).toBe(400);
    expect((await u.send("POST", "/api/batch", "{not json", { "Idempotency-Key": "j" })).status).toBe(400);
    expect((await u.send("POST", "/api/batch", { items: "no" }, { "Idempotency-Key": "j2" })).status).toBe(400);
    const huge = await u.batch([msg("1", { body: "x".repeat(2 * 1024 * 1024 + 10) })]);
    expect(huge.status).toBe(413);
    expect(await u.rows()).toBe(0);
  });

  it("refuses a request that carries both a session cookie and a Bearer key, before any receipt", async () => {
    const u = await makeUser("amb");
    const session = crypto.randomUUID();
    await env.SESSIONS.put(`session:${session}`, `${u.id}@example.test`);
    const r = await u.send("POST", "/api/batch", { items: [msg("1")] }, { Cookie: `session=${session}`, Origin: origin, "Idempotency-Key": "amb-1" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("ambiguous_credentials");
    expect(await u.receipt("amb-1")).toBeNull();
    expect(await u.rows()).toBe(0);
  });

  it("requires auth", async () => {
    const res = await coreWorker.fetch(new Request(origin + "/api/batch", {
      method: "POST", headers: { "Idempotency-Key": "k" }, body: JSON.stringify({ items: [msg("1")] }),
    }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("runs items independently: an invalid middle item does not stop the others", async () => {
    const u = await makeUser("c");
    const r = await u.batch([msg("1"), { ref: "2", kind: "message", body: "no title" }, msg("3")]);
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: Json) => x.ok)).toEqual([true, false, true]);
    expect(r.body.results[1].error.code).toBe("invalid");
    expect(await u.rows()).toBe(2);
  });

  it("rejects an unknown kind, a message item carrying html or markdown, and a non-object item", async () => {
    const u = await makeUser("c2");
    const r = await u.batch([{ ref: "1", kind: "nope" }, msg("2", { html: "<p>x</p>" }), msg("3", { markdown: "# x" }), "text", null, { ref: "6", kind: "constructor" }]);
    expect(r.body.results.map((x: Json) => x.ok)).toEqual([false, false, false, false, false, false]);
    expect(r.body.results.map((x: Json) => x.ref)).toEqual(["1", "2", "3", "3", "4", "6"]);
    expect(await u.rows()).toBe(0);
  });

  it("the kind decides the type: a message item cannot become a document", async () => {
    const u = await makeUser("c3");
    const r = await u.batch([msg("1", { type: "document", body: "plain" }), status("2", { type: "message" })]);
    expect(r.body.results.map((x: Json) => x.ok)).toEqual([true, true]);
    const types = await env.DB.prepare("SELECT type FROM messages WHERE user_id = ? ORDER BY rowid").bind(u.id).all<Json>();
    expect(types.results.map((x) => x.type)).toEqual(["message", "status"]);
  });

  it("replays a repeated key with the stored results and writes nothing again", async () => {
    const u = await makeUser("d");
    const key = crypto.randomUUID();
    const first = await u.batch([msg("1"), msg("2")], key);
    const second = await u.batch([msg("1"), msg("2")], key);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await u.rows()).toBe(2);
    expect((await u.receipt(key)).status).toBe("done");
  });

  it("refuses the same key with a different body, and never replays it", async () => {
    const u = await makeUser("d2");
    const key = crypto.randomUUID();
    const first = await u.batch([msg("1")], key);
    const other = await u.batch([msg("1"), msg("2")], key);
    expect(other.status).toBe(409);
    expect(other.body).toEqual({ ok: false, error: "idempotency_key_reused" });
    expect(other.body).not.toEqual(first.body);
    expect(await u.rows()).toBe(1);
    // A reordered or re-spaced copy of the same items is a different body too.
    expect((await u.send("POST", "/api/batch", ` ${JSON.stringify({ items: [msg("1")] })}`, { "Idempotency-Key": key })).status).toBe(409);
  });

  it("keeps receipts per account: two accounts can use one key", async () => {
    const a = await makeUser("d3"), b = await makeUser("d4");
    const key = crypto.randomUUID();
    const ra = await a.batch([msg("1")], key), rb = await b.batch([msg("1")], key);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(ra.body.results[0].id).not.toBe(rb.body.results[0].id);
    expect(await a.rows()).toBe(1);
    expect(await b.rows()).toBe(1);
  });

  it("fails a team_id item for a non-member and runs the rest", async () => {
    const u = await makeUser("i");
    const r = await u.batch([msg("1"), msg("2", { team_id: "team-not-mine" }), msg("3")]);
    expect(r.body.results.map((x: Json) => x.ok)).toEqual([true, false, true]);
    expect(r.body.results[1].error.code).toBe("forbidden");
    expect(await u.rows()).toBe(2);
  });

  it("a non-string team_id never skips the scope check", async () => {
    const u = await makeUser("i2");
    const r = await u.batch([msg("1", { team_id: 5 }), msg("2", { team_id: { id: "x" } }), msg("3", { team_id: ["t"] }), msg("4")]);
    expect(r.body.results.map((x: Json) => x.ok)).toEqual([false, false, false, true]);
    expect(await u.rows()).toBe(1);
  });

  it("two concurrent batches with one key: one set of rows", async () => {
    const u = await makeUser("j");
    const key = crypto.randomUUID();
    const [a, b] = await Promise.all([u.batch([msg("1"), msg("2")], key), u.batch([msg("1"), msg("2")], key)]);
    const winners = [a, b].filter((r) => r.status === 200);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    for (const other of [a, b].filter((r) => r.status === 409)) expect(other.body.error).toBe("batch_in_progress");
    if (winners.length === 2) expect(winners[0].body).toEqual(winners[1].body);
    expect(await u.rows()).toBe(2);
  });

  it("a pending claim 6 minutes old is held and nothing runs", async () => {
    const u = await makeUser("k");
    const items = [msg("1")], key = "stale-key";
    await u.plant(key, items, 6);
    const [a, b] = await Promise.all([u.batch(items, key), u.batch(items, key)]);
    expect([a.status, b.status]).toEqual([409, 409]);
    expect([a.body.error, b.body.error]).toEqual(["batch_abandoned", "batch_abandoned"]);
    expect(await u.rows()).toBe(0);
    expect((await u.receipt(key)).status).toBe("held");
    expect((await u.batch(items, key)).body.error).toBe("batch_abandoned");
  });

  it("a pending claim 4 minutes old is still in progress", async () => {
    const u = await makeUser("l");
    const items = [msg("1")];
    await u.plant("young", items, 4);
    const r = await u.batch(items, "young");
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("batch_in_progress");
    expect(await u.rows()).toBe(0);
  });

  it("a held claim is never replayed, whatever its age", async () => {
    const u = await makeUser("l2");
    const items = [msg("1")];
    await u.plant("held", items, 60 * 24 * 30, "held");
    expect((await u.batch(items, "held")).status).toBe(409);
    expect(await u.rows()).toBe(0);
  });

  it("a claim held while its items ran answers batch_abandoned and stays unreplayable", async () => {
    const u = await makeUser("l3");
    const key = "outlived";
    installEditionHooks({
      // The first item's request makes the claim look abandoned, as a batch that outlived the window would be.
      meterRequest: async (_request, _env, _ctx, serve) => {
        await env.DB.prepare("UPDATE batch_receipts SET status = 'held' WHERE owner = ? AND key = ?").bind(u.id, key).run();
        return serve();
      },
    });
    const r = await u.batch([msg("1")], key);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("batch_abandoned");
    expect((await u.receipt(key)).status).toBe("held");
    expect((await u.batch([msg("1")], key)).status).toBe(409);
  });

  it("the sweep holds stale pending claims, drops old answered receipts, and keeps held and young ones", async () => {
    const u = await makeUser("p");
    const items = [msg("1")];
    await u.plant("stale", items, 10);
    await u.plant("young", items, 1);
    await u.plant("old-done", items, 60 * 24 * 8, "done");
    await u.plant("new-done", items, 60 * 24 * 6, "done");
    await u.plant("old-held", items, 60 * 24 * 30, "held");
    expect(await runBatchSweep(env)).toMatchObject({ held: expect.any(Number), deleted: expect.any(Number) });
    expect((await u.receipt("stale")).status).toBe("held");
    expect((await u.receipt("young")).status).toBe("pending");
    expect(await u.receipt("old-done")).toBeNull();
    expect((await u.receipt("new-done")).status).toBe("done");
    expect((await u.receipt("old-held")).status).toBe("held");
  });

  it("a crash after the items committed leaves a pending claim that the sweep holds, so a retry cannot send them again", async () => {
    const u = await makeUser("p3");
    const items = [msg("1"), msg("2")], key = "crashed";
    const first = await u.batch(items, key);
    expect(first.status).toBe(200);
    // The answer was never recorded: put the receipt back as a pending claim from ten minutes ago.
    await env.DB.prepare("UPDATE batch_receipts SET status = 'pending', http_status = NULL, body = NULL, created_ms = ? WHERE owner = ? AND key = ?")
      .bind(Date.now() - 10 * 60_000, u.id, key).run();
    expect(await runBatchSweep(env)).toMatchObject({ held: 1 });
    expect((await u.receipt(key)).status).toBe("held");
    expect((await u.batch(items, key)).body.error).toBe("batch_abandoned");
    expect(await u.rows()).toBe(2);
  });

  it("the hourly cleanup runs the sweep", async () => {
    const u = await makeUser("p2");
    await u.plant("cron-stale", [msg("1")], 10);
    await coreWorker.scheduled!({ cron: "17 * * * *", scheduledTime: Date.now() } as ScheduledController, env, ctx);
    expect((await u.receipt("cron-stale")).status).toBe("held");
  });

  it("publishes an artifact and deletes it, and reports a missing delete", async () => {
    const u = await makeUser("q");
    const a = await u.batch([{ ref: "a", kind: "artifact", title: "Page", favicon: "📄", html: "<p>x</p>" }]);
    expect(a.body.results[0]).toMatchObject({ ref: "a", ok: true, version: 1 });
    const id = a.body.results[0].id;
    const d = await u.batch([{ ref: "d", kind: "delete", id }, { ref: "e", kind: "delete", id: "abcdef12" }, { ref: "f", kind: "delete", id: "../messages" }, { ref: "g", kind: "delete" }]);
    expect(d.body.results[0]).toEqual({ ref: "d", ok: true, id });
    expect(d.body.results[1].error.code).toBe("not_found");
    expect(d.body.results[2].error.code).toBe("invalid");
    expect(d.body.results[3].error.code).toBe("invalid");
  });

  it("fails a comment item for a non-member and creates a comment for a member", async () => {
    const u = await makeUser("r");
    const refused = await u.batch([{ ref: "c", kind: "comment", team_id: "nope", resource_type: "message", resource_id: "x", body: "hi" }]);
    expect(refused.body.results[0].error.code).toBe("forbidden");
    const t = await makeTeam(u.id);
    const posted = await u.batch([msg("1", { team_id: t.team, project_id: t.project })]);
    expect(posted.body.results[0].ok).toBe(true);
    const commented = await u.batch([{ ref: "c", kind: "comment", team_id: t.team, project_id: t.project, resource_type: "message", resource_id: posted.body.results[0].id, body: "nice" }]);
    expect(commented.body.results[0]).toMatchObject({ ref: "c", ok: true });
    expect(typeof commented.body.results[0].id).toBe("string");
  });

  it("status items fold per item", async () => {
    const u = await makeUser("s");
    const r = await u.batch([status("1"), status("2", { final: true }), status("3")]);
    expect(r.body.results[0].folded).toBeUndefined();
    expect(r.body.results[1]).toMatchObject({ ok: true, folded: true, id: r.body.results[0].id });
    expect(r.body.results[2].folded).toBeUndefined();
    expect(r.body.results[2].id).not.toBe(r.body.results[0].id);
    const rows = await env.DB.prepare("SELECT body, status_closed_at FROM messages WHERE user_id = ? ORDER BY rowid").bind(u.id).all<Json>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0].status_closed_at).not.toBeNull();
    expect(rows.results[0].body).toBe("line 2\nline 1");
  });

  it("bounds chunked batch bodies before taking a receipt, and rejects a cross-origin cookie write", async () => {
    const u = await makeUser("bounded");
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(2 * 1024 * 1024)); c.enqueue(new Uint8Array(1)); c.close(); } });
    const response = await coreWorker.fetch(new Request(origin + "/api/batch", {
      method: "POST", headers: { Authorization: `Bearer ${u.token}`, "Idempotency-Key": "bounded" }, body, duplex: "half",
    } as RequestInit), env, ctx);
    expect(response.status).toBe(413);
    expect(await u.receipt("bounded")).toBeNull();
    const session = crypto.randomUUID();
    await env.SESSIONS.put(`session:${session}`, `${u.id}@example.test`);
    const denied = await u.send("POST", "/api/batch", { items: [msg("1")] }, { Cookie: `session=${session}`, Origin: "https://attacker.example", "Idempotency-Key": "csrf" }, "");
    expect(denied.status).toBe(403);
    expect(await u.rows()).toBe(0);
    expect(await u.receipt("csrf")).toBeNull();
  });
});

describe("batch items go through the router as their own requests", () => {
  it("each item is blocked by an edition route block for its own path", async () => {
    const u = await makeUser("e1");
    installEditionHooks({ blocksRequest: (_env, method, path) => method === "POST" && path === "/api/artifacts" });
    const r = await u.batch([msg("1"), { ref: "2", kind: "artifact", title: "Page", favicon: "📄", html: "<p>x</p>" }, msg("3")]);
    expect(r.body.results.map((x: Json) => x.ok)).toEqual([true, false, true]);
    expect(r.body.results[1].error.code).toBe("not_found");
    const single = await u.send("POST", "/api/artifacts", { title: "Page", favicon: "📄", html: "<p>x</p>" });
    expect(single.status).toBe(404);
  });

  it("each item passes through the edition's request metering, with its own path", async () => {
    const u = await makeUser("e2");
    const seen: string[] = [];
    installEditionHooks({ meterRequest: async (request, _env, _ctx, serve) => { seen.push(`${request.method} ${new URL(request.url).pathname}`); return serve(); } });
    await u.batch([msg("1"), { ref: "2", kind: "artifact", title: "P", favicon: "📄", html: "<p>x</p>" }, { ref: "3", kind: "delete", id: "abc123" }]);
    // The batch request itself, then each item as the request it stands for.
    expect(seen).toEqual(["POST /api/batch", "POST /api/messages", "POST /api/artifacts", "DELETE /api/artifacts/abc123"]);
  });

  it("an edition's refusal of one item leaves the others running", async () => {
    const u = await makeUser("e3");
    installEditionHooks({
      meterRequest: async (request, _env, _ctx, serve) => new URL(request.url).pathname === "/api/artifacts"
        ? new Response(JSON.stringify({ ok: false, error: "over the limit" }), { status: 429, headers: { "Content-Type": "application/json" } })
        : serve(),
    });
    const r = await u.batch([msg("1"), { ref: "2", kind: "artifact", title: "P", favicon: "📄", html: "<p>x</p>" }, msg("3")]);
    expect(r.body.results.map((x: Json) => x.ok)).toEqual([true, false, true]);
    expect(r.body.results[1].error).toEqual({ code: "limit", message: "over the limit" });
  });

  it("a server error in an item shows no internal text", async () => {
    const u = await makeUser("e4");
    installEditionHooks({ meterRequest: async (request, _env, _ctx, serve) => {
      if (new URL(request.url).pathname === "/api/artifacts") throw new Error("secret internal detail");
      return serve();
    } });
    const r = await u.batch([{ ref: "1", kind: "artifact", title: "P", favicon: "📄", html: "<p>x</p>" }, msg("2")]);
    expect(r.body.results[0]).toEqual({ ref: "1", ok: false, error: { code: "internal", message: "item failed" } });
    expect(r.body.results[1].ok).toBe(true);
    expect(r.text).not.toContain("secret");
  });
});

// The same request, sent once to its single route and once as a batch item, is refused the same way.
describe("batch items are refused as their single routes refuse them", () => {
  type Case = { name: string; prepare?: (u: User) => Promise<Json | void>; kind: string; fields: (u: User, setup: Json) => Json; method?: string; path: (setup: Json) => string; body: (u: User, setup: Json) => Json; expectStatus: number };
  const cases: Case[] = [
    {
      name: "a message in a team where the caller is a viewer",
      prepare: (u) => makeTeam(u.id, "viewer"), kind: "message", expectStatus: 403,
      path: () => "/api/messages", fields: (_u, t) => ({ title: "t", body: "b", instance, team_id: t.team }), body: (_u, t) => ({ type: "message", title: "t", body: "b", instance, team_id: t.team }),
    },
    {
      name: "a status in a team the caller does not belong to",
      prepare: async () => ({ team: "team-not-mine" }), kind: "status", expectStatus: 403,
      path: () => "/api/messages", fields: (_u, t) => ({ title: "t", body: "b", instance, team_id: t.team }), body: (_u, t) => ({ type: "status", title: "t", body: "b", instance, team_id: t.team }),
    },
    {
      name: "a document with a project of another team",
      prepare: async (u) => { const a = await makeTeam(u.id), b = await makeTeam(u.id); return { team: a.team, project: b.project }; }, kind: "document", expectStatus: 403,
      path: () => "/api/messages", fields: (_u, t) => ({ title: "t", html: "<p>x</p>", instance, team_id: t.team, project_id: t.project }), body: (_u, t) => ({ type: "document", title: "t", html: "<p>x</p>", instance, team_id: t.team, project_id: t.project }),
    },
    {
      name: "a public document in a team",
      prepare: (u) => makeTeam(u.id), kind: "document", expectStatus: 400,
      path: () => "/api/messages", fields: (_u, t) => ({ title: "t", html: "<p>x</p>", instance, team_id: t.team, public: true }), body: (_u, t) => ({ type: "document", title: "t", html: "<p>x</p>", instance, team_id: t.team, public: true }),
    },
    {
      name: "an artifact in a team where the caller is a viewer",
      prepare: (u) => makeTeam(u.id, "viewer"), kind: "artifact", expectStatus: 400,
      path: () => "/api/artifacts", fields: (_u, t) => ({ title: "t", favicon: "📄", html: "<p>x</p>", team_id: t.team, sharing: "shared" }), body: (_u, t) => ({ title: "t", favicon: "📄", html: "<p>x</p>", team_id: t.team, sharing: "shared" }),
    },
    {
      name: "a comment in a team the caller does not belong to",
      prepare: async () => ({ team: "team-not-mine" }), kind: "comment", expectStatus: 403,
      path: () => "/api/comments", fields: (_u, t) => ({ team_id: t.team, resource_type: "message", resource_id: "x", body: "hi" }), body: (_u, t) => ({ team_id: t.team, resource_type: "message", resource_id: "x", body: "hi" }),
    },
    {
      name: "a comment by a viewer",
      prepare: (u) => makeTeam(u.id, "viewer"), kind: "comment", expectStatus: 403,
      path: () => "/api/comments", fields: (_u, t) => ({ team_id: t.team, resource_type: "message", resource_id: "x", body: "hi" }), body: (_u, t) => ({ team_id: t.team, resource_type: "message", resource_id: "x", body: "hi" }),
    },
    {
      name: "a comment where the edition denies access to the team",
      prepare: async (u) => {
        const t = await makeTeam(u.id);
        installEditionHooks({ accessError: async (_env, input) => (input.teamId === t.team ? "access to this team is closed" : null) });
        return t;
      }, kind: "comment", expectStatus: 403,
      path: () => "/api/comments", fields: (_u, t) => ({ team_id: t.team, resource_type: "message", resource_id: "x", body: "hi" }), body: (_u, t) => ({ team_id: t.team, resource_type: "message", resource_id: "x", body: "hi" }),
    },
    {
      name: "deleting another account's artifact",
      prepare: async () => {
        const other = await makeUser("par-owner");
        const made = await other.batch([{ ref: "a", kind: "artifact", title: "Mine", favicon: "📄", html: "<p>x</p>" }]);
        return { id: made.body.results[0].id };
      }, kind: "delete", method: "DELETE", expectStatus: 404,
      path: (s) => `/api/artifacts/${s.id}`, fields: (_u, s) => ({ id: s.id }), body: () => undefined,
    },
    {
      name: "a message without a title",
      kind: "message", expectStatus: 400,
      path: () => "/api/messages", fields: () => ({ body: "b", instance }), body: () => ({ type: "message", body: "b", instance }),
    },
    {
      name: "an artifact with neither html nor markdown",
      kind: "artifact", expectStatus: 400,
      path: () => "/api/artifacts", fields: () => ({ title: "t" }), body: () => ({ title: "t" }),
    },
  ];
  const codes: Record<number, string> = { 400: "invalid", 401: "unauthorized", 403: "forbidden", 404: "not_found" };

  for (const c of cases) {
    it(c.name, async () => {
      const u = await makeUser("par");
      const setup = (await c.prepare?.(u)) ?? {};
      const single = await u.send(c.method ?? "POST", c.path(setup), c.body(u, setup));
      expect(single.status).toBe(c.expectStatus);
      const item = (await u.batch([{ ref: "x", kind: c.kind, ...c.fields(u, setup) }])).body.results[0];
      expect(item.ok).toBe(false);
      expect(item.error.code).toBe(codes[single.status]);
      expect(item.error.message).toBe(single.body?.error ?? "request refused");
      expect(await u.rows()).toBe(0);
    });
  }

  it("a cookie session is refused for a message item exactly as for POST /api/messages, and works where the route accepts it", async () => {
    const u = await makeUser("par-cookie");
    const session = crypto.randomUUID();
    await env.SESSIONS.put(`session:${session}`, `${u.id}@example.test`);
    const headers = { Cookie: `session=${session}`, Origin: origin };
    const single = await u.send("POST", "/api/messages", { type: "message", title: "t", body: "b", instance }, headers, "");
    expect(single.status).toBe(401);
    const r = await u.send("POST", "/api/batch", { items: [msg("1"), { ref: "2", kind: "artifact", title: "Page", favicon: "📄", html: "<p>x</p>" }] }, { ...headers, "Idempotency-Key": "cookie-1" }, "");
    expect(r.status).toBe(200);
    expect(r.body.results[0]).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    const artifactSingle = await u.send("POST", "/api/artifacts", { title: "Page 2", favicon: "📄", html: "<p>y</p>" }, headers, "");
    expect(artifactSingle.status).toBe(201);
    expect(r.body.results[1].ok).toBe(true);
    expect(await u.rows()).toBe(0);
  });

  it("an agent key is refused by the batch and by the single routes alike", async () => {
    const sponsor = await makeUser("par-agent");
    const t = await makeTeam(sponsor.id);
    const agent = crypto.randomUUID().replace(/-/g, ""), token = `agent_${agent}`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO agent_identities(id,team_id,slug,name,created_by_user_id) VALUES (?,?,?,?,?)").bind(agent, t.team, "bot", "Bot", sponsor.id),
      env.DB.prepare("INSERT INTO agent_keys(key_hash,key_prefix,agent_id,created_by_user_id) VALUES (?,?,?,?)").bind(await sha256Hex(token), "agent", agent, sponsor.id),
    ]);
    const asAgent = (path: string, body: unknown, headers: Record<string, string> = {}) => coreWorker.fetch(new Request(origin + path, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
    }), env, ctx);
    expect((await asAgent("/api/messages", { type: "message", title: "t", body: "b", instance })).status).toBe(401);
    expect((await asAgent("/api/batch", { items: [msg("1")] }, { "Idempotency-Key": "agent-key" })).status).toBe(401);
    expect(await sponsor.rows()).toBe(0);
    expect(await sponsor.receipt("agent-key")).toBeNull();
  });

  it("the sponsor and another account cannot replay each other's batches", async () => {
    const a = await makeUser("par-a"), b = await makeUser("par-b");
    const key = "shared-key";
    const first = await a.batch([msg("1")], key);
    const second = await b.batch([msg("1")], key);
    expect(second.body.results[0].id).not.toBe(first.body.results[0].id);
    expect(await b.rows()).toBe(1);
  });
});
