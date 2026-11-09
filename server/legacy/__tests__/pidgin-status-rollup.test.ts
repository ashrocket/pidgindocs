import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { sha256Hex } from "../auth-utils";
import { setMeterHooks } from "../meter";
import { foldStatus } from "../messages/store";
import type { Env } from "../types";

vi.mock("../push/apns", () => ({ sendPushNotification: vi.fn(async () => {}) }));
import { sendPushNotification } from "../push/apns";

// Status posts from one stable session update one row (the living status item).

const env = {
  ...bindings,
  API_KEY: "rollup-test-key",
  OWNER_EMAIL: "owner@example.com",
  WORKER_URL: "https://pidgindocs.example.workers.dev",
  ENVIRONMENT: "production",
} as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
afterEach(() => { setMeterHooks({}); vi.mocked(sendPushNotification).mockClear(); });

type Json = any;

async function makeUser(label: string) {
  const id = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const token = `pidgin_sk_${id}`;
  await env.DB.prepare("INSERT INTO users (id, email, status) VALUES (?, ?, 'active')").bind(id, `${id}@example.com`).run();
  await env.DB.prepare("INSERT INTO api_keys (key_hash, key_prefix, user_id) VALUES (?, ?, ?)")
    .bind(await sha256Hex(token), "pidgin_sk", id).run();
  const call = async (path: string, body: unknown) => {
    const res = await worker.fetch(new Request(`https://pidgindocs.example.workers.dev${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), env, ctx);
    return { status: res.status, units: res.headers.get("X-Pidgin-Units"), body: (await res.json()) as Json };
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
  await env.DB.prepare("INSERT INTO teams (id, slug, name, owner_user_id) VALUES (?, ?, 'T', ?)").bind(team, team, owner).run();
  await env.DB.prepare("INSERT INTO projects (id, team_id, slug, name, created_by_user_id) VALUES (?, ?, ?, 'P', ?)").bind(project, team, project, owner).run();
  return { team, project };
}

describe("status rollup", () => {
  it("folds two statuses from one session into one row", async () => {
    const u = await makeUser("a");
    const first = await u.post({ title: "one", body: "first" });
    expect(first.status).toBe(201);
    expect(first.units).toBe("status=1");
    expect(first.body.data.folded).toBeUndefined();
    const second = await u.post({ title: "two", body: "second" });
    expect(second.body.data.folded).toBe(true);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.units).toBe("fold=1");
    const rows = await u.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("two");
    expect(rows[0].body).toBe("second\nfirst");
  });

  it("an MCP status without instance_id never folds; with one it does", async () => {
    const u = await makeUser("b");
    await u.mcp("pidgin_send_message", { title: "x", type: "status", body: "a" });
    await u.mcp("pidgin_send_message", { title: "y", type: "status", body: "b" });
    expect(await u.rows()).toHaveLength(2);
    const one = await u.mcp("pidgin_send_message", { title: "z", type: "status", body: "c", instance_id: "inst-1" });
    const two = await u.mcp("pidgin_send_message", { title: "z2", type: "status", body: "d", instance_id: "inst-1" });
    expect(one.body.result.structuredContent.message.folded).toBeUndefined();
    expect(two.body.result.structuredContent.message.folded).toBe(true);
    expect(await u.rows()).toHaveLength(3);
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
    expect((await u.rows())).toHaveLength(4);
    expect((await other.rows())).toHaveLength(1);
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

  it("a plain status never folds into a row that has blocks", async () => {
    const u = await makeUser("m");
    const blocked = await u.post({ blocks: [{ type: "markdown", markdown: "hi" }] });
    const plain = await u.post({ body: "plain" });
    expect(plain.body.data.folded).toBeUndefined();
    expect(plain.body.data.id).not.toBe(blocked.body.data.id);
    const rows = await u.rows();
    expect(rows).toHaveLength(2);
    const blocks = await env.DB.prepare("SELECT message_id FROM message_blocks WHERE message_id IN (?, ?)")
      .bind(blocked.body.data.id, plain.body.data.id).all<Json>();
    expect(blocks.results.map((r) => r.message_id)).toEqual([blocked.body.data.id]);
    const next = await u.post({ body: "again" });
    expect(next.body.data.folded).toBe(true);
    expect(next.body.data.id).toBe(plain.body.data.id);
  });

  it("two concurrent first statuses make one row: one insert, one fold", async () => {
    const u = await makeUser("n");
    const [a, b] = await Promise.all([u.post({ body: "a" }), u.post({ body: "b" })]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect([a, b].filter((r) => r.body.data.folded === true)).toHaveLength(1);
    expect(a.body.data.id).toBe(b.body.data.id);
    expect([a.units, b.units].sort()).toEqual(["fold=1", "status=1"]);
    const rows = await u.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].body.split("\n")).toHaveLength(2);
    expect(await u.audit()).toBe(1);
    expect(vi.mocked(sendPushNotification)).toHaveBeenCalledTimes(1);
  });

  it("MCP status calls set X-Pidgin-Units: status=1 on insert, fold=1 on fold, none for a message", async () => {
    const u = await makeUser("o");
    const first = await u.mcp("pidgin_send_message", { title: "x", type: "status", body: "a", instance_id: "inst-u" });
    expect(first.units).toBe("status=1");
    const second = await u.mcp("pidgin_send_message", { title: "y", type: "status", body: "b", instance_id: "inst-u" });
    expect(second.units).toBe("fold=1");
    expect(second.body.result.structuredContent.message.folded).toBe(true);
    const noSession = await u.mcp("pidgin_send_message", { title: "z", type: "status", body: "c" });
    expect(noSession.units).toBe("status=1");
    const plain = await u.mcp("pidgin_send_message", { title: "m", body: "c" });
    expect(plain.units).toBeNull();
    const list = await u.call("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.units).toBeNull();
  });

  it("batch status items fold per item and count fold units", async () => {
    const u = await makeUser("l");
    const instance = { model: "m", session_id: "sess-b", project: "p", source: "test" };
    const res = await worker.fetch(new Request("https://pidgindocs.example.workers.dev/api/batch", {
      method: "POST",
      headers: { Authorization: `Bearer pidgin_sk_${u.id}`, "Content-Type": "application/json", "Idempotency-Key": "roll-1" },
      body: JSON.stringify({ items: [
        { ref: "1", kind: "status", title: "s1", body: "a", instance },
        { ref: "2", kind: "status", title: "s2", body: "b", instance, final: true },
      ] }),
    }), env, ctx);
    const body = (await res.json()) as Json;
    expect(body.results[0].folded).toBeUndefined();
    expect(body.results[1].folded).toBe(true);
    expect(body.results[1].id).toBe(body.results[0].id);
    expect(res.headers.get("X-Pidgin-Units")).toBe("status=1;fold=1");
    const rows = await u.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status_closed_at).not.toBeNull();
  });
});
