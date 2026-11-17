import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import coreWorker from "../core/app";
import { sha256Hex } from "../core/auth-utils";
import type { Env } from "../core/types";

const env = { ...bindings, WORKER_URL: "https://example.test", ENTRA_ONLY: "false" } as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const stamp = (n: number) => `2026-01-01 00:${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

async function user(label: string): Promise<{ id: string; key: string }> {
  const id = crypto.randomUUID();
  const key = `overview-key-${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users(id,email,status) VALUES (?,?,'active')").bind(id, `${label}-${id}@example.test`),
    env.DB.prepare("INSERT INTO api_keys(key_hash,key_prefix,user_id,label) VALUES (?,?,?,?)").bind(await sha256Hex(key), key.slice(0, 8), id, label),
  ]);
  return { id, key };
}

async function team(ownerId: string, members: Array<[string, string]> = []): Promise<{ id: string; projectId: string }> {
  const id = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO teams(id,slug,name,owner_user_id) VALUES (?,?,?,?)").bind(id, id, `Team ${id.slice(0, 4)}`, ownerId),
    env.DB.prepare("INSERT INTO team_memberships(team_id,user_id,role) VALUES (?,?,'owner')").bind(id, ownerId),
    ...members.map(([userId, role]) => env.DB.prepare("INSERT INTO team_memberships(team_id,user_id,role) VALUES (?,?,?)").bind(id, userId, role)),
    env.DB.prepare("INSERT INTO projects(id,team_id,slug,name,created_by_user_id) VALUES (?,?,?,?,?)").bind(projectId, id, `p-${projectId.slice(0, 6)}`, "Project", ownerId),
  ]);
  return { id, projectId };
}

async function seed(t: { id: string; projectId: string }, ownerId: string, counts: { memos: number; comments: number; board: number }) {
  const agentId = crypto.randomUUID();
  const memoIds: string[] = [];
  const stmts = [env.DB.prepare("INSERT INTO agent_identities(id,team_id,slug,name,created_by_user_id) VALUES (?,?,?,?,?)").bind(agentId, t.id, `a-${agentId.slice(0, 6)}`, "Agent", ownerId)];
  for (let i = 0; i < counts.memos; i++) {
    const id = crypto.randomUUID();
    memoIds.push(id);
    stmts.push(env.DB.prepare(
      `INSERT INTO messages(id,type,title,body,doc_key,instance_model,instance_session_id,instance_project,instance_source,user_id,team_id,project_id,doc_kind,sharing,created_at)
       VALUES (?,'document',?,?,?,'m','s','p','test',?,?,?,'decision_memo','shared',?)`
    ).bind(id, `Memo ${i}`, "body", `key-${id}`, ownerId, t.id, t.projectId, stamp(i)));
  }
  for (let i = 0; i < counts.comments; i++) {
    stmts.push(env.DB.prepare(
      "INSERT INTO resource_comments(id,team_id,project_id,resource_type,resource_id,body,author_user_id,created_at) VALUES (?,?,?,'decision_memo',?,?,?,?)"
    ).bind(`c${i}-${t.id}`, t.id, t.projectId, memoIds[0], `Comment ${i}`, ownerId, stamp(i)));
  }
  for (let i = 0; i < counts.board; i++) {
    stmts.push(env.DB.prepare(
      "INSERT INTO agent_board_entries(id,team_id,project_id,agent_id,kind,topic,body,client_message_id,user_id) VALUES (?,?,?,?,'n',?,'b',?,?)"
    ).bind(`e${i}-${t.id}`, t.id, t.projectId, agentId, `Entry ${i}`, `client-${i}-${t.id}`, ownerId));
  }
  await env.DB.batch(stmts);
}

type Overview = { ok: boolean; data: { teams: Array<{ team: { id: string; role: string }; projects: unknown[]; memos: Array<{ title: string }>; comments: Array<{ body: string }>; boardEntries: Array<{ topic: string }> }> } };

async function overview(key?: string): Promise<Response> {
  const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
  return coreWorker.fetch(new Request("https://example.test/api/workspace/overview", { headers }), env, ctx);
}

describe("GET /api/workspace/overview", () => {
  it("returns 401 when signed out", async () => {
    expect((await overview()).status).toBe(401);
    expect((await overview("not-a-real-key")).status).toBe(401);
  });

  it("shows a member their own team and omits a team they do not belong to", async () => {
    const mine = await user("mine");
    const other = await user("other");
    const own = await team(mine.id);
    const foreign = await team(other.id);
    await seed(own, mine.id, { memos: 1, comments: 1, board: 1 });
    await seed(foreign, other.id, { memos: 1, comments: 1, board: 1 });
    const response = await overview(mine.key);
    expect(response.status).toBe(200);
    const body = await response.json() as Overview;
    expect(body.ok).toBe(true);
    expect(body.data.teams.map((view) => view.team.id)).toEqual([own.id]);
    const [view] = body.data.teams;
    expect(view.team.role).toBe("owner");
    expect(view.projects).toHaveLength(1);
    expect(view.memos).toHaveLength(1);
    expect(view.comments).toHaveLength(1);
    expect(view.boardEntries).toHaveLength(1);
  });

  it("lets a viewer read the overview", async () => {
    const owner = await user("owner");
    const viewer = await user("viewer");
    const t = await team(owner.id, [[viewer.id, "viewer"]]);
    await seed(t, owner.id, { memos: 1, comments: 1, board: 1 });
    const response = await overview(viewer.key);
    expect(response.status).toBe(200);
    const body = await response.json() as Overview;
    expect(body.data.teams).toHaveLength(1);
    expect(body.data.teams[0].team).toMatchObject({ id: t.id, role: "viewer" });
    expect(body.data.teams[0].memos).toHaveLength(1);
    expect(body.data.teams[0].comments).toHaveLength(1);
    expect(body.data.teams[0].boardEntries).toHaveLength(1);
  });

  it("caps each team at 4 memos, 4 comments and 12 board entries, newest first", async () => {
    const owner = await user("cap");
    const t = await team(owner.id);
    await seed(t, owner.id, { memos: 6, comments: 6, board: 15 });
    const body = await (await overview(owner.key)).json() as Overview;
    const [view] = body.data.teams;
    expect(view.memos.map((m) => m.title)).toEqual(["Memo 5", "Memo 4", "Memo 3", "Memo 2"]);
    expect(view.comments.map((c) => c.body)).toEqual(["Comment 2", "Comment 3", "Comment 4", "Comment 5"]);
    expect(view.boardEntries).toHaveLength(12);
    expect(view.boardEntries[0].topic).toBe("Entry 14");
  });
});
