import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import coreWorker from "../core/app";
import { sha256Hex } from "../core/auth-utils";
import { installEditionHooks, type UsageMetric } from "../core/edition-hooks";
import { createMessage, foldStatus } from "../core/messages/store";
import type { Env } from "../core/types";

vi.mock("../core/push/apns", () => ({ sendPushNotification: vi.fn(async () => {}) }));
vi.mock("../core/destinations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/destinations")>()),
  deliverToDestinations: vi.fn(async () => {}),
}));
import { sendPushNotification } from "../core/push/apns";
import { deliverToDestinations } from "../core/destinations";

// Status posts from one stable session update one row (the living status item).

const origin = "https://example.test";
const env = { ...bindings, WORKER_URL: origin, ENTRA_ONLY: "false" } as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => installEditionHooks({}));
afterEach(() => {
  installEditionHooks({});
  vi.mocked(sendPushNotification).mockClear();
  vi.mocked(deliverToDestinations).mockClear();
});

type Json = any;

async function makeUser(label: string) {
  const id = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const token = `key_${id}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, email, status) VALUES (?, ?, 'active')").bind(id, `${id}@example.test`),
    env.DB.prepare("INSERT INTO api_keys (key_hash, key_prefix, user_id) VALUES (?, ?, ?)").bind(await sha256Hex(token), "key", id),
  ]);
  const call = async (path: string, body: unknown) => {
    const res = await coreWorker.fetch(new Request(`${origin}${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), env, ctx);
    return { status: res.status, body: (await res.json()) as Json };
  };
  const post = (extra: Json = {}, session = "sess-1") => call("/api/messages", {
    type: "status", title: "t", body: "line", instance: { model: "m", session_id: session, project: "p", source: "test" }, ...extra,
  });
  const mcp = (name: string, args: Json) =>
    call("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const rows = async (type = "status") =>
    (await env.DB.prepare("SELECT * FROM messages WHERE user_id = ? AND type = ? ORDER BY created_at, rowid").bind(id, type).all<Json>()).results;
  const audit = async () =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ?").bind(id).first<{ n: number }>())!.n;
  return { id, post, mcp, call, rows, audit };
}

async function makeTeam(owner: string) {
  const team = `team-${crypto.randomUUID().slice(0, 8)}`;
  const project = `proj-${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO teams (id, slug, name, owner_user_id) VALUES (?, ?, 'T', ?)").bind(team, team, owner),
    env.DB.prepare("INSERT INTO projects (id, team_id, slug, name, created_by_user_id) VALUES (?, ?, ?, 'P', ?)").bind(project, team, project, owner),
    env.DB.prepare("INSERT INTO team_memberships(team_id,user_id,role) VALUES(?,?,'owner')").bind(team, owner),
  ]);
  return { team, project };
}

// A plan meter that counts what it is asked to reserve and release.
function meter() {
  const reserved: Array<[UsageMetric, number, string]> = [];
  const released: Array<[UsageMetric, number, string]> = [];
  installEditionHooks({
    reserveUsage: async (_e, _u, metric, amount, key) => { reserved.push([metric, amount, key]); return { managed: true }; },
    releaseUsage: async (_e, _u, metric, amount, key) => { released.push([metric, amount, key]); return { managed: true }; },
  });
  const net = (metric: UsageMetric) =>
    reserved.filter(([m]) => m === metric).reduce((n, [, a]) => n + a, 0) - released.filter(([m]) => m === metric).reduce((n, [, a]) => n + a, 0);
  return { reserved, released, net };
}

describe("status folding", () => {
  it("folds two statuses from one session into one row", async () => {
    const u = await makeUser("a");
    const first = await u.post({ title: "one", body: "first" });
    expect(first.status).toBe(201);
    expect(first.body.data.folded).toBeUndefined();
    const second = await u.post({ title: "two", body: "second" });
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual({ id: first.body.data.id, type: "status", folded: true });
    const rows = await u.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("two");
    expect(rows[0].body).toBe("second\nfirst");
  });

  it("an MCP status keeps inserting a row each time; folding is the HTTP route's", async () => {
    const u = await makeUser("b");
    await u.mcp("pidgin_send_message", { title: "x", type: "status", body: "a", instance_id: "inst-1" });
    await u.mcp("pidgin_send_message", { title: "y", type: "status", body: "b", instance_id: "inst-1" });
    expect(await u.rows()).toHaveLength(2);
  });

  it("does not fold into a row older than 4 hours", async () => {
    const u = await makeUser("c");
    await u.post();
    await env.DB.prepare("UPDATE messages SET created_at = datetime('now', '-5 hours') WHERE user_id = ?").bind(u.id).run();
    expect((await u.post()).body.data.folded).toBeUndefined();
    expect(await u.rows()).toHaveLength(2);
  });

  it("final folds once more, closes the row, and the next status inserts", async () => {
    const u = await makeUser("d");
    await u.post({ body: "a" });
    const last = await u.post({ body: "done", final: true });
    expect(last.body.data.folded).toBe(true);
    let rows = await u.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status_closed_at).not.toBeNull();
    expect(rows[0].body).toBe("done\na");
    expect((await u.post({ body: "next" })).body.data.folded).toBeUndefined();
    rows = await u.rows();
    expect(rows).toHaveLength(2);
    expect(rows[1].status_closed_at).toBeNull();
  });

  it("final on a first post inserts a closed row", async () => {
    const u = await makeUser("d2");
    await u.post({ final: true });
    expect((await u.rows())[0].status_closed_at).not.toBeNull();
    expect((await u.post()).body.data.folded).toBeUndefined();
    expect(await u.rows()).toHaveLength(2);
  });

  it("rejects a non-boolean final", async () => {
    const u = await makeUser("d3");
    expect((await u.post({ final: "yes" })).status).toBe(400);
    expect(await u.rows()).toHaveLength(0);
  });

  it("does not fold across project, team, user, session or instance project", async () => {
    const u = await makeUser("e");
    const other = await makeUser("e2");
    const a = await makeTeam(u.id);
    const b = await makeTeam(u.id);
    await u.post({ team_id: a.team, project_id: a.project });
    expect((await u.post({ team_id: a.team, project_id: a.project })).body.data.folded).toBe(true);
    expect((await u.post({ team_id: b.team, project_id: b.project })).body.data.folded).toBeUndefined();
    expect((await u.post({ team_id: a.team })).body.data.folded).toBeUndefined();
    expect((await u.post({ team_id: a.team, project_id: a.project }, "sess-2")).body.data.folded).toBeUndefined();
    await other.post();
    expect((await other.post({}, "sess-1")).body.data.folded).toBe(true);
    expect(await u.rows()).toHaveLength(4);
    expect(await other.rows()).toHaveLength(1);
    await u.post();
    const r = await u.post({ instance: { model: "m", session_id: "sess-1", project: "elsewhere", source: "test" } });
    expect(r.body.data.folded).toBeUndefined();
  });

  it("skips archived and dismissed rows", async () => {
    const u = await makeUser("f");
    await u.post();
    await env.DB.prepare("UPDATE messages SET archived_at = datetime('now') WHERE user_id = ?").bind(u.id).run();
    expect((await u.post()).body.data.folded).toBeUndefined();
    await env.DB.prepare("UPDATE messages SET dismiss_action = 'delete' WHERE user_id = ?").bind(u.id).run();
    expect((await u.post()).body.data.folded).toBeUndefined();
  });

  it("keeps at most 20 lines and 4 KB over 25 folds", async () => {
    const u = await makeUser("g");
    for (let i = 0; i < 25; i++) await u.post({ body: `update ${i}` });
    let rows = await u.rows();
    expect(rows).toHaveLength(1);
    let lines = rows[0].body.split("\n");
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe("update 24");
    expect(lines[19]).toBe("update 5");
    const v = await makeUser("g2");
    for (let i = 0; i < 20; i++) await v.post({ body: `${i}:` + "x".repeat(400) });
    rows = await v.rows();
    expect(new TextEncoder().encode(rows[0].body).byteLength).toBeLessThanOrEqual(4096);
    lines = rows[0].body.split("\n");
    expect(lines[0].startsWith("19:")).toBe(true);
    expect(lines.length).toBeLessThan(20);
  });

  it("a lone oversized line is cut to 4 KB", async () => {
    const u = await makeUser("g3");
    await u.post({ body: "first" });
    await u.post({ body: "y".repeat(10_000) });
    const rows = await u.rows();
    expect(new TextEncoder().encode(rows[0].body).byteLength).toBeLessThanOrEqual(4096);
    expect(rows[0].body.startsWith("yyy")).toBe(true);
  });

  it("a fold sends no push and writes no audit row", async () => {
    const u = await makeUser("h");
    await u.post();
    const pushes = vi.mocked(sendPushNotification).mock.calls.length;
    const audits = await u.audit();
    await u.post();
    expect(vi.mocked(sendPushNotification).mock.calls.length).toBe(pushes);
    expect(await u.audit()).toBe(audits);
    expect(pushes).toBe(1);
  });

  it("a fold writes at most 2 rows", async () => {
    const u = await makeUser("i");
    await u.post();
    let written = 0;
    const db = {
      prepare: (sql: string) => {
        const stmt = env.DB.prepare(sql);
        return {
          bind: (...a: unknown[]) => {
            const bound = stmt.bind(...a);
            return {
              first: (...x: any[]) => (bound as any).first(...x),
              all: () => bound.all(),
              run: async () => { const r = await bound.run(); written += r.meta.rows_written ?? 0; return r; },
            };
          },
        };
      },
    };
    const folded = await foldStatus({ ...env, DB: db } as unknown as Env, {
      userId: u.id, teamId: null, projectId: null, sessionId: "sess-1", instanceProject: "p",
      title: "t2", body: "more", final: true,
    });
    expect(folded).not.toBeNull();
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThanOrEqual(2);
  });

  it("message and question posts never fold", async () => {
    const u = await makeUser("j");
    for (const type of ["message", "question"]) {
      await u.post({ type });
      expect((await u.post({ type })).body.data.folded).toBeUndefined();
      expect(await u.rows(type)).toHaveLength(2);
    }
  });

  it("a status with blocks is inserted, not folded", async () => {
    const u = await makeUser("k");
    await u.post();
    const r = await u.post({ blocks: [{ type: "markdown", markdown: "hi" }] });
    expect(r.body.data.folded).toBeUndefined();
    expect(await u.rows()).toHaveLength(2);
  });

  it("a status with empty blocks is refused, not folded", async () => {
    const u = await makeUser("k2");
    await u.post();
    const r = await u.post({ blocks: [] });
    expect(r.status).toBe(400);
    expect(await u.rows()).toHaveLength(1);
  });

  it("a plain status never folds into a row that has blocks", async () => {
    const u = await makeUser("m");
    const blocked = await u.post({ blocks: [{ type: "markdown", markdown: "hi" }] });
    const plain = await u.post({ body: "plain" });
    expect(plain.body.data.folded).toBeUndefined();
    expect(plain.body.data.id).not.toBe(blocked.body.data.id);
    expect(await u.rows()).toHaveLength(2);
    const blocks = await env.DB.prepare("SELECT message_id FROM message_blocks WHERE message_id IN (?, ?)")
      .bind(blocked.body.data.id, plain.body.data.id).all<Json>();
    expect(blocks.results.map((r) => r.message_id)).toEqual([blocked.body.data.id]);
    const next = await u.post({ body: "again" });
    expect(next.body.data.folded).toBe(true);
    expect(next.body.data.id).toBe(plain.body.data.id);
  });

  it("two concurrent first statuses make one row: one insert, one fold", async () => {
    const m = meter();
    const u = await makeUser("n");
    const [a, b] = await Promise.all([u.post({ body: "a" }), u.post({ body: "b" })]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect([a, b].filter((r) => r.body.data.folded === true)).toHaveLength(1);
    expect(a.body.data.id).toBe(b.body.data.id);
    const rows = await u.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].body.split("\n")).toHaveLength(2);
    expect(await u.audit()).toBe(1);
    expect(vi.mocked(sendPushNotification)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deliverToDestinations)).toHaveBeenCalledTimes(1);
    // Whichever request lost the race gave its delivery reservation back.
    expect(m.net("deliveries")).toBe(1);
  });
});

// Each side effect of a new status, and what a fold does about it. Core has no edit path for a
// message, so a fold has no edit side effects to copy: it is a content update of the same item,
// not a new delivery.
describe("status folding side effects", () => {
  it("a new status: one audit row, one push, one destination delivery, one delivery reservation, one content-store statement", async () => {
    const m = meter();
    const stored: string[] = [];
    installEditionHooks({
      reserveUsage: async (_e, _u, metric, amount, key) => { m.reserved.push([metric, amount, key]); return { managed: true }; },
      contentStoreStatements: (e, input) => { stored.push(`${input.kind}:${input.id}`); return []; },
    });
    const u = await makeUser("s1");
    const first = await u.post();
    expect(await u.audit()).toBe(1);
    expect(vi.mocked(sendPushNotification)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deliverToDestinations)).toHaveBeenCalledTimes(1);
    expect(m.reserved.filter(([metric]) => metric === "deliveries")).toHaveLength(1);
    expect(stored).toEqual([`message:${first.body.data.id}`]);
  });

  it("a fold writes no audit row, no push, no destination delivery, no reservation and no content-store statement", async () => {
    const m = meter();
    const stored: string[] = [];
    installEditionHooks({
      reserveUsage: async (_e, _u, metric, amount, key) => { m.reserved.push([metric, amount, key]); return { managed: true }; },
      contentStoreStatements: (e, input) => { stored.push(`${input.kind}:${input.id}`); return []; },
    });
    const u = await makeUser("s2");
    await u.post();
    const before = { audit: await u.audit(), push: vi.mocked(sendPushNotification).mock.calls.length,
      dest: vi.mocked(deliverToDestinations).mock.calls.length, reserved: m.reserved.length, stored: stored.length };
    const folded = await u.post({ body: "more", final: true });
    expect(folded.body.data.folded).toBe(true);
    expect({ audit: await u.audit(), push: vi.mocked(sendPushNotification).mock.calls.length,
      dest: vi.mocked(deliverToDestinations).mock.calls.length, reserved: m.reserved.length, stored: stored.length }).toEqual(before);
  });

  it("a fold keeps the read flag and the owner, and emits no event", async () => {
    const u = await makeUser("s3");
    const first = await u.post();
    await env.DB.prepare("UPDATE messages SET read = 1, read_at = datetime('now') WHERE id = ?").bind(first.body.data.id).run();
    const events = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>())!.n;
    const before = await events();
    await u.post({ body: "later" });
    const row = (await u.rows())[0];
    expect(row.read).toBe(1);
    expect(row.user_id).toBe(u.id);
    expect(await events()).toBe(before);
  });

  it("a fold cannot update a status of a team the caller no longer belongs to", async () => {
    const u = await makeUser("s4");
    const t = await makeTeam(u.id);
    await u.post({ team_id: t.team, project_id: t.project });
    await env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?").bind(t.team, u.id).run();
    const refused = await u.post({ team_id: t.team, project_id: t.project, body: "after" });
    expect(refused.status).toBe(403);
    expect((await u.rows())[0].body).toBe("line");
  });

  it("a fold of a first-insert race gives the reservation back and keeps the usage metered once", async () => {
    const m = meter();
    const u = await makeUser("s5");
    await Promise.all([u.post({ body: "a" }), u.post({ body: "b" }), u.post({ body: "c" })]);
    expect(await u.rows()).toHaveLength(1);
    expect(m.net("deliveries")).toBe(1);
  });

  it("an insert that finds an open row written after the first look folds into it and gives its reservation back", async () => {
    const reserved: string[] = [], released: string[] = [];
    const u = await makeUser("s6");
    let planted = "";
    installEditionHooks({
      reserveUsage: async (_e, _u, metric, _a, key) => {
        reserved.push(metric);
        // Another request of the same session commits between this request's first look and its insert.
        if (metric === "deliveries" && !planted) {
          planted = crypto.randomUUID();
          await env.DB.prepare(
            `INSERT INTO messages (id, type, title, body, instance_model, instance_session_id, instance_project, instance_source, user_id, sharing)
             VALUES (?, 'status', 'planted', 'planted', 'm', 'sess-1', 'p', 'test', ?, 'shared')`).bind(planted, u.id).run();
        }
        return { managed: true };
      },
      releaseUsage: async (_e, _u, metric) => { released.push(metric); return { managed: true }; },
    });
    const r = await u.post({ body: "mine" });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ id: planted, type: "status", folded: true });
    expect(reserved).toEqual(["deliveries"]);
    expect(released).toEqual(["deliveries"]);
    const rows = await u.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("mine\nplanted");
    expect(await u.audit()).toBe(0);
    expect(vi.mocked(sendPushNotification)).not.toHaveBeenCalled();
  });

  it("a conditional insert next to an open row writes nothing at all", async () => {
    const u = await makeUser("s7");
    await u.post();
    installEditionHooks({ contentStoreStatements: (_e, input) => [
      env.DB.prepare("INSERT INTO audit_log(action,instance_id,details,user_id) VALUES ('store-marker',?,?,?)").bind(input.id, input.kind, input.userId),
    ] });
    const audits = await u.audit();
    const result = await createMessage(env, {
      type: "status", title: "t", body: "b", onlyIfNoOpenStatus: true, userId: u.id,
      instance: { model: "m", session_id: "sess-1", project: "p", source: "test" },
    }, ctx);
    expect(result.skipped).toBe(true);
    expect(await u.rows()).toHaveLength(1);
    expect(await u.audit()).toBe(audits);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'store-marker' AND user_id = ?").bind(u.id).first<{ n: number }>())!.n).toBe(0);
  });
});
