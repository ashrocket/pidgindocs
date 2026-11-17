import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import coreWorker from "../core/app";
import { sha256Hex } from "../core/auth-utils";
import { installEditionHooks, TenantWriteRefused, UsageRefused, type UsageMetric } from "../core/edition-hooks";
import { loadArtifactVersionContent, publishArtifact } from "../core/artifacts/store";
import { runGovernedContentCleanup } from "../core/governed-content-cleanup";
import { PublishInputError, publishDocument } from "../core/documents";
import {
  commitDraft, commitStaleDrafts, currentDraft, deleteDraft, deleteOldDrafts, flushDraftCleanup, putDraft, runDraftSweep,
  DRAFT_CRON, DRAFT_IDLE_MS, DRAFT_KEEP_MS, DRAFT_MAX_BYTES, DRAFT_MAX_RETAINED_BYTES,
} from "../core/drafts";
import type { Env } from "../core/types";

const origin = "https://example.test";
const env = { ...bindings, WORKER_URL: origin, ENTRA_ONLY: "false" } as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  installEditionHooks({});
  await env.DB.batch([env.DB.prepare("DELETE FROM draft_commit_keys"), env.DB.prepare("DELETE FROM draft_commits"), env.DB.prepare("DELETE FROM draft_revisions")]);
});
afterEach(() => installEditionHooks({}));

const token = () => crypto.randomUUID().replace(/-/g, "");
const doc = (html = "<p>hello</p>", more: Record<string, unknown> = {}) => ({ kind: "document", title: "A draft", html, ...more });

// An R2 bucket whose named methods run a test's override first.
function wrap(base: Env, overrides: Record<string, (real: any, ...args: any[]) => any>): Env {
  return { ...base, DOCS: new Proxy(base.DOCS, { get(target, prop: string) {
    if (overrides[prop]) return (...args: any[]) => overrides[prop](target, ...args);
    const value = (target as any)[prop];
    return typeof value === "function" ? value.bind(target) : value;
  } }) };
}

// A plan meter that counts reservations and releases by their idempotency key, once each.
function ledger() {
  const reserved = new Map<string, number>(), released = new Map<string, number>();
  installEditionHooks({
    reserveUsage: async (_e, _u, metric: UsageMetric, amount, key) => { if (metric === "storage_bytes" && key.startsWith("draft:") && !reserved.has(key)) reserved.set(key, amount); return { managed: true }; },
    releaseUsage: async (_e, _u, metric: UsageMetric, amount, key) => { if (metric === "storage_bytes" && key.startsWith("draft:") && !released.has(key)) released.set(key, amount); return { managed: true }; },
  });
  const sum = (m: Map<string, number>) => [...m.values()].reduce((n, v) => n + v, 0);
  return { reserved, released, get held() { return sum(reserved) - sum(released); } };
}

async function user(status = "active") {
  const id = crypto.randomUUID(), email = `${id}@example.test`, key = token();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users(id,email,status) VALUES(?,?,?)").bind(id, email, status),
    env.DB.prepare("INSERT INTO api_keys(key_hash,key_prefix,user_id) VALUES(?,?,?)").bind(await sha256Hex(key), "test", id),
  ]);
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await coreWorker.fetch(new Request(origin + path, {
      method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }), env, ctx);
    return { status: response.status, body: await response.json() as any };
  };
  return {
    id, email, key, call,
    put: (k: string, body: unknown) => call("PUT", `/api/drafts/${k}`, body),
    commit: (k: string, idem?: string) => call("POST", `/api/drafts/${k}/commit`, undefined, idem ? { "Idempotency-Key": idem } : {}),
    count: async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND type = 'document'").bind(id).first<{ n: number }>())!.n,
  };
}

async function team(ownerId: string, memberId: string, role: string) {
  const id = crypto.randomUUID(), projectId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO teams(id,slug,name,owner_user_id) VALUES(?,?,?,?)").bind(id, id, "Team", ownerId),
    env.DB.prepare("INSERT INTO team_memberships(team_id,user_id,role) VALUES(?,?,'owner')").bind(id, ownerId),
    env.DB.prepare("INSERT INTO team_memberships(team_id,user_id,role) VALUES(?,?,?)").bind(id, memberId, role),
    env.DB.prepare("INSERT INTO projects(id,team_id,slug,name,created_by_user_id) VALUES(?,?,?,?,?)").bind(projectId, id, `p-${projectId.slice(0, 6)}`, "Project", ownerId),
  ]);
  return { id, projectId };
}

describe("draft revisions", () => {
  it("replaces ten edits with one document and releases every retained byte once", async () => {
    const u = await user(), k = token(), m = ledger();
    for (let i = 0; i < 10; i++) expect((await u.put(k, doc(`<p>${i}</p>`))).status).toBe(200);
    const current = await currentDraft(env, u.id, k);
    expect(m.held).toBe(current!.size_bytes);
    const r = await u.commit(k);
    expect(r.status).toBe(200);
    expect(r.body.data.kind).toBe("document");
    expect(await u.count()).toBe(1);
    expect(await currentDraft(env, u.id, k)).toBeNull();
    expect(m.held).toBe(0);
    expect(m.reserved.size).toBe(10);
    expect(m.released.size).toBe(10);
    expect((await u.commit(k)).status).toBe(404);
    await flushDraftCleanup(env);
    expect(m.released.size).toBe(10);
  });

  it("replays one idempotency alias and treats a later identical upload as a new revision", async () => {
    const u = await user(), k = token();
    await u.put(k, doc());
    const a = await u.commit(k, "same");
    expect(a.status).toBe(200);
    expect((await u.commit(k, "same")).body).toEqual(a.body);
    await u.put(k, doc());
    expect((await u.commit(k, "same")).body).toEqual(a.body);
    expect(await currentDraft(env, u.id, k)).not.toBeNull();
    expect((await u.commit(k, "new")).status).toBe(200);
    expect(await u.count()).toBe(2);
  });

  it("one revision is shared by different manual keys and the idle sweep", async () => {
    const u = await user(), k = token();
    await u.put(k, doc());
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((r) => (release = r)), ready = new Promise<void>((r) => (entered = r));
    const delayed = wrap(env, { put: async (real, name, ...args) => { if (String(name).startsWith("docs/")) { entered(); await waiting; } return real.put(name, ...args); } });
    const first = commitDraft(delayed, u.id, k, "manual-a");
    await ready;
    expect((await u.commit(k, "manual-b")).status).toBe(409);
    await commitStaleDrafts(env, 0, Date.now() + 60_000);
    release();
    expect((await first).status).toBe(200);
    expect(await u.count()).toBe(1);
  });

  it("preserves an edit arriving while an older revision is publishing", async () => {
    const u = await user(), k = token();
    await u.put(k, doc("<p>old</p>"));
    let swapped = false;
    const race = wrap(env, { put: async (real, name, ...args) => { if (!swapped && String(name).startsWith("docs/")) { swapped = true; await u.put(k, doc("<p>new</p>")); } return real.put(name, ...args); } });
    expect((await commitDraft(race, u.id, k)).status).toBe(200);
    const newer = await currentDraft(env, u.id, k);
    expect(newer).not.toBeNull();
    expect(await (await env.DOCS.get(newer!.object_key))!.text()).toContain("new");
    expect((await u.commit(k)).status).toBe(200);
    expect(await u.count()).toBe(2);
  });

  it("a delayed cleanup delete cannot erase a concurrent new revision", async () => {
    const u = await user(), k = token();
    await u.put(k, doc());
    const old = await currentDraft(env, u.id, k);
    let swapped = false;
    const race = wrap(env, { delete: async (real, name) => { if (!swapped && name === old!.object_key) { swapped = true; await u.put(k, doc("<p>new</p>")); } return real.delete(name); } });
    expect((await commitDraft(race, u.id, k)).status).toBe(200);
    const newer = await currentDraft(env, u.id, k);
    expect(await env.DOCS.head(newer!.object_key)).not.toBeNull();
  });

  it("a stale expected revision cannot commit (fencing)", async () => {
    const u = await user(), k = token();
    await u.put(k, doc("<p>one</p>"));
    const stale = (await currentDraft(env, u.id, k))!.id;
    await u.put(k, doc("<p>two</p>"));
    expect((await commitDraft(env, u.id, k, undefined, stale)).status).toBe(409);
    expect(await u.count()).toBe(0);
    expect((await commitDraft(env, u.id, k, undefined, (await currentDraft(env, u.id, k))!.id)).status).toBe(200);
  });

  it("retains byte accounting while R2 deletion fails, then releases it idempotently", async () => {
    const u = await user(), k = token(), m = ledger();
    await u.put(k, doc());
    const revision = await currentDraft(env, u.id, k);
    const broken = wrap(env, { delete: async () => { throw new Error("offline"); } });
    expect(await deleteDraft(broken, u.id, k)).toBe(true);
    expect(m.held).toBe(revision!.size_bytes);
    expect(await env.DB.prepare("SELECT id FROM draft_revisions WHERE id = ?").bind(revision!.id).first()).not.toBeNull();
    await flushDraftCleanup(env);
    await flushDraftCleanup(env);
    expect(m.held).toBe(0);
    expect(m.released.size).toBe(1);
  });

  it("retains a failed release and retries with the same key", async () => {
    const u = await user(), k = token();
    let fail = true;
    const releases: string[] = [];
    installEditionHooks({ releaseUsage: async (_e, _u, _m, _n, key) => { releases.push(key); if (fail) throw new Error("lost response"); return { managed: true }; }, reserveUsage: async () => ({ managed: true }) });
    await u.put(k, doc());
    await deleteDraft(env, u.id, k);
    expect(releases).toHaveLength(1);
    fail = false;
    await flushDraftCleanup(env);
    expect(releases).toEqual([releases[0], releases[0]]);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM draft_revisions WHERE owner = ?").bind(u.id).first<{ n: number }>())!.n).toBe(0);
  });

  it("holds a possibly committed publication without automatic replay", async () => {
    const u = await user(), k = token();
    await u.put(k, doc());
    const DB = new Proxy(env.DB, { get(target, prop: string) {
      if (prop === "prepare") return (sql: string) => { if (sql.startsWith("UPDATE draft_commits SET status = ?,")) throw new Error("lost receipt response"); return target.prepare(sql); };
      const value = (target as any)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    } });
    expect((await commitDraft({ ...env, DB } as Env, u.id, k)).status).toBe(503);
    expect(await u.count()).toBe(1);
    expect((await u.commit(k, "new-key")).status).toBe(409);
    await commitStaleDrafts(env, 0, Date.now() + 60_000);
    await deleteOldDrafts(env, Date.now() + 2 * DRAFT_KEEP_MS);
    expect(await u.count()).toBe(1);
    expect((await env.DB.prepare("SELECT status FROM draft_commits WHERE owner = ?").bind(u.id).first<{ status: string }>())!.status).toBe("held");
  });
});

describe("who may commit a draft", () => {
  it("refuses an inactive owner, including scheduled work", async () => {
    const u = await user(), k = token();
    await u.put(k, doc());
    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").bind(u.id).run();
    expect((await commitDraft(env, u.id, k)).status).toBe(403);
    await commitStaleDrafts(env, 0, Date.now() + 60_000);
    expect(await u.count()).toBe(0);
  });

  it("refuses a viewer exactly as a direct publish does, by hand and on schedule", async () => {
    const owner = await user(), viewer = await user(), k = token();
    const t = await team(owner.id, viewer.id, "viewer");
    await expect(publishDocument(env, { userId: viewer.id, title: "Direct", html: "<p>x</p>", teamId: t.id })).rejects.toBeInstanceOf(PublishInputError);
    await viewer.put(k, doc("<p>x</p>", { team_id: t.id }));
    expect((await viewer.commit(k)).status).toBe(403);
    await commitStaleDrafts(env, 0, Date.now() + 60_000);
    expect(await viewer.count()).toBe(0);
    // A member of the same team may commit, and the document lands in the team.
    const member = await user();
    await env.DB.prepare("INSERT INTO team_memberships(team_id,user_id,role) VALUES(?,?,'member')").bind(t.id, member.id).run();
    await member.put(k, doc("<p>y</p>", { team_id: t.id }));
    expect((await member.commit(k)).status).toBe(200);
    expect((await env.DB.prepare("SELECT team_id FROM messages WHERE user_id = ? AND type = 'document'").bind(member.id).first<{ team_id: string }>())!.team_id).toBe(t.id);
  });

  it("scopes a project to its team", async () => {
    const u = await user(), k = token();
    await u.put(k, doc("<p>x</p>", { project_id: "unknown" }));
    expect((await u.commit(k)).status).toBe(403);
  });

  it("applies the deployment's write gate and plan limits to a commit, and keeps the draft to retry", async () => {
    const u = await user(), k = token();
    await u.put(k, doc());
    installEditionHooks({ reserveUsage: async (_e, _u, metric) => { if (metric === "deliveries") throw new UsageRefused("plan limit", 402); return { managed: false }; } });
    const refused = await u.commit(k);
    expect(refused.status).toBe(402);
    expect(await u.count()).toBe(0);
    expect(await currentDraft(env, u.id, k)).not.toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM draft_commits").first<{ n: number }>())!.n).toBe(0);
    installEditionHooks({ assertWritable: async () => { throw new TenantWriteRefused("read only", 503, "maintenance"); } });
    expect((await u.commit(k)).status).toBe(503);
    expect((await u.put(k, doc())).status).toBe(503);
    expect(await commitStaleDrafts(env, 0, Date.now() + 60_000)).toEqual({ committed: 0, failed: 0, skipped: 0 });
    installEditionHooks({});
    expect((await u.commit(k)).status).toBe(200);
    expect(await u.count()).toBe(1);
  });

  it("holds a commit whose plan service failed after the usage may have been counted", async () => {
    const u = await user(), k = token();
    await u.put(k, doc());
    installEditionHooks({ reserveUsage: async () => { throw new UsageRefused("meter response lost", 503); } });
    expect((await u.commit(k)).status).toBe(503);
    installEditionHooks({});
    expect((await env.DB.prepare("SELECT status FROM draft_commits WHERE owner = ?").bind(u.id).first<{ status: string }>())!.status).toBe("held");
    expect((await u.commit(k)).status).toBe(409);
    expect(await u.count()).toBe(0);
  });

  it("keeps an edition's own refusal body and releases the claim", async () => {
    const u = await user(), k = token();
    await u.put(k, doc());
    class Unpaid extends Error {}
    installEditionHooks({
      reserveUsage: async () => { throw new Unpaid("unpaid"); },
      errorResponse: (error) => (error instanceof Unpaid ? Response.json({ ok: false, error: "payment needed", code: "unpaid" }, { status: 402 }) : null),
    });
    const refused = await u.commit(k);
    expect(refused.status).toBe(402);
    expect(refused.body.code).toBe("unpaid");
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM draft_commits").first<{ n: number }>())!.n).toBe(0);
    installEditionHooks({});
    expect((await u.commit(k)).status).toBe(200);
  });

  it("rejects sibling ownership and cookie writes without same-origin proof", async () => {
    const a = await user(), b = await user(), k = token();
    await a.put(k, doc());
    expect((await b.commit(k)).status).toBe(404);
    const session = token();
    await env.SESSIONS.put(`session:${session}`, a.email);
    for (const originHeader of [undefined, "https://attacker.example"]) {
      const response = await coreWorker.fetch(new Request(`${origin}/api/drafts/${k}`, { method: "DELETE", headers: { Cookie: `session=${session}`, ...(originHeader ? { Origin: originHeader } : {}) } }), env, ctx);
      expect(response.status).toBe(403);
    }
    expect(await currentDraft(env, a.id, k)).not.toBeNull();
  });
});

describe("draft limits", () => {
  it("bounds streamed writes and atomically caps new keys and retained bytes", async () => {
    const u = await user(), k = token();
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(DRAFT_MAX_BYTES)); c.enqueue(new Uint8Array(1)); c.close(); } });
    const response = await coreWorker.fetch(new Request(`${origin}/api/drafts/${k}`, { method: "PUT", headers: { Authorization: `Bearer ${u.key}` }, body }), env, ctx);
    expect(response.status).toBe(413);
    expect(await currentDraft(env, u.id, k)).toBeNull();
    for (let i = 0; i < 49; i++) await putDraft(env, u.id, token(), JSON.stringify(doc()));
    const results = await Promise.all([putDraft(env, u.id, token(), JSON.stringify(doc())), putDraft(env, u.id, token(), JSON.stringify(doc()))]);
    expect(results.sort()).toEqual(["limit", "ok"]);
    expect((await u.put(token(), doc())).status).toBe(409);
    await env.DB.prepare("UPDATE draft_revisions SET size_bytes = ? WHERE id = (SELECT id FROM draft_revisions WHERE owner = ? LIMIT 1)").bind(DRAFT_MAX_RETAINED_BYTES, u.id).run();
    expect(await putDraft(env, u.id, token(), JSON.stringify(doc()))).toBe("limit");
  });

  it("refuses a bad key, a missing kind and invalid JSON", async () => {
    const u = await user();
    expect((await u.put("short", doc())).status).toBe(404);
    expect((await u.put(token(), { title: "no kind" })).status).toBe(400);
    expect((await u.put(token(), "{nope")).status).toBe(400);
  });

  it("honors a plan refusal before retaining any object", async () => {
    const u = await user(), k = token();
    installEditionHooks({ reserveUsage: async () => { throw new UsageRefused("storage full", 402); } });
    expect((await u.put(k, doc())).status).toBe(402);
    expect(await currentDraft(env, u.id, k)).toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM draft_revisions WHERE owner = ?").bind(u.id).first<{ n: number }>())!.n).toBe(0);
  });

  it("retires a staged upload whose object write fails, releasing its bytes", async () => {
    const u = await user(), k = token(), m = ledger();
    const broken = wrap(env, { put: async () => { throw new Error("offline"); } });
    await expect(putDraft(broken, u.id, k, JSON.stringify(doc()))).rejects.toThrow("offline");
    expect(m.held).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM draft_revisions WHERE owner = ?").bind(u.id).first<{ n: number }>())!.n).toBe(0);
  });
});

describe("committing artifacts and incomplete drafts", () => {
  it("commits artifacts with optimistic versions", async () => {
    const u = await user(), k = token();
    await u.put(k, { kind: "artifact", title: "Page", favicon: "📄", html: "<p>x</p>" });
    const first = await u.commit(k);
    expect(first.status).toBe(200);
    const id = first.body.data.id;
    expect(first.body.data.url).toContain(id);
    await u.put(k, { kind: "artifact", title: "Page", favicon: "📄", html: "<p>v2</p>", target: { artifact_id: id, base_version: 1 } });
    expect((await u.commit(k)).body.data.version).toBe(2);
    await u.put(k, { kind: "artifact", title: "Page", favicon: "📄", html: "<p>stale</p>", target: { artifact_id: id, base_version: 1 } });
    expect((await u.commit(k)).status).toBe(409);
  });

  it("does not let a draft update another person's artifact", async () => {
    const a = await user(), b = await user(), k = token();
    const made = await publishArtifact(env, { userId: a.id, html: "<p>mine</p>", favicon: "📄" });
    await b.put(k, { kind: "artifact", title: "Hijack", favicon: "📄", html: "<p>x</p>", target: { artifact_id: made.artifact.id } });
    expect((await b.commit(k)).status).toBe(404);
  });

  it("isolates two different drafts racing for the same artifact version", async () => {
    const u = await user();
    const initial = await publishArtifact(env, { userId: u.id, html: "<p>initial</p>", favicon: "📄" });
    const left = token(), right = token(), id = initial.artifact.id;
    for (const [k, text] of [[left, "left"], [right, "right"]]) await u.put(k, { kind: "artifact", markdown: `# ${text}`, target: { artifact_id: id, base_version: 1 } });
    let entered = 0, release!: () => void;
    const waiting = new Promise<void>((r) => (release = r));
    const race = wrap(env, { put: async (real, name, ...args) => {
      if (String(name).startsWith(`artifacts/${id}/`) && String(name).endsWith(".html")) { entered++; if (entered === 2) release(); await waiting; }
      return real.put(name, ...args);
    } });
    const results = await Promise.all([commitDraft(race, u.id, left), commitDraft(race, u.id, right)]);
    // Core's store refuses the loser as an input error (400), as a direct publish does.
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const winner = results[0].status === 200 ? "left" : "right";
    expect(await loadArtifactVersionContent(env, id, 2)).toContain(winner);
    expect((await env.DB.prepare("SELECT current_version FROM artifacts WHERE id = ?").bind(id).first<{ current_version: number }>())!.current_version).toBe(2);
  });

  it("holds a commit whose D1 batch response was lost, and keeps the committed artifact", async () => {
    const u = await user(), k = token();
    await u.put(k, { kind: "artifact", markdown: "# committed", favicon: "📄" });
    const DB = new Proxy(env.DB, { get(target, prop: string) {
      if (prop === "batch") return async (statements: D1PreparedStatement[]) => { await target.batch(statements); throw new Error("lost committed response"); };
      const v = (target as any)[prop];
      return typeof v === "function" ? v.bind(target) : v;
    } });
    expect((await commitDraft({ ...env, DB } as Env, u.id, k)).status).toBe(503);
    const artifact = await env.DB.prepare("SELECT id FROM artifacts WHERE user_id = ?").bind(u.id).first<{ id: string }>();
    expect(await loadArtifactVersionContent(env, artifact!.id, 1)).toContain("committed");
    expect((await u.commit(k, "retry")).status).toBe(409);
    expect((await env.DB.prepare("SELECT status FROM draft_commits WHERE owner = ?").bind(u.id).first<{ status: string }>())!.status).toBe("held");
  });

  it("keeps a durable staging record after an uncertain upload instead of deleting its bytes", async () => {
    const u = await user(), k = token();
    await u.put(k, { kind: "artifact", html: "<p>upload accepted</p>", favicon: "📄" });
    const broken = wrap(env, { put: async (real, name, ...args) => { const result = await real.put(name, ...args); if (String(name).startsWith("artifacts/")) throw new Error("lost upload response"); return result; } });
    expect((await commitDraft(broken, u.id, k)).status).toBe(503);
    const attempt = await env.DB.prepare("SELECT r2_key,state FROM artifact_upload_attempts WHERE owner = ?").bind(u.id).first<{ r2_key: string; state: string }>();
    expect(attempt!.state).toBe("staging");
    await runGovernedContentCleanup(env);
    expect(await env.DOCS.head(attempt!.r2_key)).not.toBeNull();
  });

  it("checks the existing artifact's scope when the draft omits it", async () => {
    const u = await user(), k = token(), t = token();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO teams(id,slug,name,owner_user_id) VALUES(?,?,?,?)").bind(t, t, "Team", u.id),
      env.DB.prepare("INSERT INTO team_memberships(team_id,user_id,role) VALUES(?,?,'member')").bind(t, u.id),
    ]);
    const initial = await publishArtifact(env, { userId: u.id, teamId: t, sourcePath: "team/page.html", html: "<p>original</p>", favicon: "📄" });
    const id = initial.artifact.id;
    await env.DB.prepare("UPDATE team_memberships SET role = 'viewer' WHERE team_id = ? AND user_id = ?").bind(t, u.id).run();
    await u.put(k, { kind: "artifact", html: "<p>omitted</p>", target: { artifact_id: id, base_version: 1 } });
    expect((await u.commit(k)).status).toBeGreaterThanOrEqual(400);
    expect(await loadArtifactVersionContent(env, id, 1)).toContain("original");
    expect(await loadArtifactVersionContent(env, id, 2)).toBeNull();
  });

  it("rechecks membership after an upload and preserves the current version", async () => {
    const u = await user(), t = token(), k = token();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO teams(id,slug,name,owner_user_id) VALUES(?,?,?,?)").bind(t, t, "Team", u.id),
      env.DB.prepare("INSERT INTO team_memberships(team_id,user_id,role) VALUES(?,?,'member')").bind(t, u.id),
    ]);
    const initial = await publishArtifact(env, { userId: u.id, teamId: t, html: "<p>original</p>", favicon: "📄" });
    await u.put(k, { kind: "artifact", html: "<p>revoked while uploading</p>", target: { artifact_id: initial.artifact.id, base_version: 1 } });
    const revoke = wrap(env, { put: async (real, name, ...args) => {
      const result = await real.put(name, ...args);
      if (String(name).startsWith("artifacts/")) await env.DB.prepare("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?").bind(t, u.id).run();
      return result;
    } });
    expect((await commitDraft(revoke, u.id, k)).status).toBeGreaterThanOrEqual(400);
    expect(await loadArtifactVersionContent(env, initial.artifact.id, 1)).toContain("original");
    expect(await loadArtifactVersionContent(env, initial.artifact.id, 2)).toBeNull();
  });

  it("refuses publication if the artifact's scope moves during the upload", async () => {
    const u = await user(), k = token(), t = token();
    await env.DB.prepare("INSERT INTO teams(id,slug,name,owner_user_id) VALUES(?,?,?,?)").bind(t, t, "Team", u.id).run();
    const initial = await publishArtifact(env, { userId: u.id, html: "<p>original</p>", favicon: "📄" });
    await u.put(k, { kind: "artifact", html: "<p>stale scope</p>", target: { artifact_id: initial.artifact.id, base_version: 1 } });
    const move = wrap(env, { put: async (real, name, ...args) => {
      const result = await real.put(name, ...args);
      if (String(name).startsWith("artifacts/")) await env.DB.prepare("UPDATE artifacts SET team_id = ? WHERE id = ?").bind(t, initial.artifact.id).run();
      return result;
    } });
    expect((await commitDraft(move, u.id, k)).status).toBe(400);
    expect(await loadArtifactVersionContent(env, initial.artifact.id, 1)).toContain("original");
    expect(await loadArtifactVersionContent(env, initial.artifact.id, 2)).toBeNull();
  });

  it("leaves an incomplete document editable without holding a publication", async () => {
    const u = await user(), k = token();
    await u.put(k, { kind: "document", html: "<p>draft</p>" });
    expect((await u.commit(k)).status).toBe(400);
    expect(await u.count()).toBe(0);
    await u.put(k, doc());
    expect((await u.commit(k)).status).toBe(200);
  });
});

describe("the five-minute sweep", () => {
  const sweep = (scheduledTime: number) => coreWorker.scheduled({ cron: DRAFT_CRON, scheduledTime, noRetry() {} } as ScheduledController, env, ctx);
  const age = (id: string, ms: number) => env.DB.prepare("UPDATE draft_revisions SET created_ms = ? WHERE id = ?").bind(Date.now() - ms, id).run();

  it("commits only drafts idle for ten minutes", async () => {
    const u = await user(), idle = token(), fresh = token();
    await u.put(idle, doc("<p>idle</p>"));
    await u.put(fresh, doc("<p>fresh</p>"));
    await age((await currentDraft(env, u.id, idle))!.id, DRAFT_IDLE_MS + 60_000);
    await sweep(Date.now());
    expect(await u.count()).toBe(1);
    expect(await currentDraft(env, u.id, idle)).toBeNull();
    expect(await currentDraft(env, u.id, fresh)).not.toBeNull();
    await sweep(Date.now());
    expect(await u.count()).toBe(1);
    await age((await currentDraft(env, u.id, fresh))!.id, DRAFT_IDLE_MS + 60_000);
    await sweep(Date.now());
    expect(await u.count()).toBe(2);
  });

  it("deletes drafts older than seven days once an hour, not on every run", async () => {
    const u = await user(), k = token();
    await u.put(k, { kind: "document", html: "<p>no title, so it is never published</p>" });
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    await env.DB.prepare("UPDATE draft_revisions SET created_ms = ? WHERE id = ?").bind(hour - DRAFT_KEEP_MS - 60_000, (await currentDraft(env, u.id, k))!.id).run();
    expect(await runDraftSweep(env, hour + 30 * 60_000)).toContain("committed 0, failed 1");
    expect(await currentDraft(env, u.id, k)).not.toBeNull();
    expect(await runDraftSweep(env, hour + 2 * 60_000)).toContain("deleted 1 drafts");
    expect(await currentDraft(env, u.id, k)).toBeNull();
  });

  it("runs none of core's daily work", async () => {
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO messages(id,type,title,expires_at,pinned,instance_model,instance_session_id,instance_project,instance_source) VALUES(?,?,?,datetime('now','-1 day'),0,'m','s','p','t')").bind(id, "message", "expired").run();
    await sweep(Date.now());
    expect(await env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(id).first()).not.toBeNull();
  });
});
