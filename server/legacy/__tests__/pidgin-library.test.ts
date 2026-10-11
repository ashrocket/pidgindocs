import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../index";
import { sha256Hex } from "../auth-utils";
import type { Env } from "../types";

// Personal library (PidginDocs app Projects and Tags) through the real
// pidgindocs.example.workers.dev host route, against migrated D1.

const env = {
  ...bindings,
  API_KEY: "library-test-key",
  OWNER_EMAIL: "owner@example.com",
  WORKER_URL: "https://pidgindocs.example.workers.dev",
  ENVIRONMENT: "production",
} as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

type Json = any;

async function makeUser(label: string) {
  const id = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const key = `pidgin_sk_${id}`;
  await env.DB.prepare("INSERT INTO users (id, email, status) VALUES (?, ?, 'active')").bind(id, `${id}@example.com`).run();
  await env.DB.prepare("INSERT INTO api_keys (key_hash, key_prefix, user_id) VALUES (?, ?, ?)")
    .bind(await sha256Hex(key), "pidgin_sk", id).run();
  const api = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: Json }> => {
    const response = await worker.fetch(new Request(`https://pidgindocs.example.workers.dev${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    }), env, ctx);
    return { status: response.status, body: await response.json() };
  };
  return { id, api };
}

async function addDoc(userId: string, title: string, project: string, extra: { slug?: string; archived?: boolean; latest?: boolean } = {}) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO messages (id, type, title, body, doc_key, priority, doc_slug, doc_version, is_latest,
       instance_model, instance_session_id, instance_project, instance_source, user_id, archived_at)
     VALUES (?, 'document', ?, 'body', ?, 'normal', ?, 1, ?, 'test', 's', ?, 'test', ?, ?)`
  ).bind(id, title, `docs/${id}.html`, extra.slug ?? id, extra.latest === false ? 0 : 1, project, userId,
    extra.archived ? new Date().toISOString() : null).run();
  return id;
}

async function addArtifact(userId: string, title: string, project: string | null) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO artifacts (id, user_id, title, favicon, instance_project) VALUES (?, ?, ?, '🕊️', ?)"
  ).bind(id, userId, title, project).run();
  return id;
}

describe("PidginDocs personal library", () => {
  it("auto-files by agent project label, lets explicit filing win, and keeps counts in step", async () => {
    const { id: user, api } = await makeUser("lib");
    const docA = await addDoc(user, "Project notes", "research-project");
    const docB = await addDoc(user, "Release checklist", "Research-Project");
    const docC = await addDoc(user, "Dishwasher repair", "home");
    const art = await addArtifact(user, "System diagram", "infrastructure");
    const loose = await addArtifact(user, "Untitled sketch", null);

    const empty = await api("/api/library");
    expect(empty.status).toBe(200);
    expect(empty.body.data.library.projects).toEqual([]);
    expect(empty.body.data.library.unfiled).toEqual({ documents: 3, artifacts: 2 });
    expect(empty.body.data.library.sources.map((s: Json) => s.label)).toEqual(
      expect.arrayContaining(["research-project", "home", "infrastructure"])
    );

    const created = await api("/api/library/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Research", color: "teal", symbol: "folder", sources: ["research-project", "infrastructure"] }),
    });
    expect(created.status).toBe(201);
    const researchProject = created.body.data.project_id as string;
    const project = created.body.data.library.projects[0];
    expect(project).toMatchObject({ id: researchProject, name: "Research", slug: "research", color: "teal", symbol: "folder", pinned: false });
    expect(project.sources).toEqual(["infrastructure", "research-project"]);
    expect(project.counts).toEqual({ documents: 2, artifacts: 1 });
    expect(created.body.data.library.unfiled).toEqual({ documents: 1, artifacts: 1 });

    // Rule-filed items report their project and how they were filed.
    const docs = await api(`/api/docs?library_project=${researchProject}`);
    expect(docs.body.data.map((d: Json) => d.id).sort()).toEqual([docA, docB].sort());
    expect(docs.body.data[0].library).toMatchObject({ project_id: researchProject, filed: "rule", tags: [] });

    // Explicitly unfiling one doc beats its rule; "auto" restores the rule.
    const unfiled = await api("/api/library/file", {
      method: "POST",
      body: JSON.stringify({ items: [{ type: "document", id: docB }], project_id: "unfiled" }),
    });
    expect(unfiled.body.data.placements[0]).toMatchObject({ id: docB, project_id: null, filed: "explicit" });
    expect((await api("/api/docs?library_project=unfiled")).body.data.map((d: Json) => d.id).sort())
      .toEqual([docB, docC].sort());
    await api("/api/library/file", {
      method: "POST",
      body: JSON.stringify({ items: [{ type: "document", id: docB }], project_id: "auto" }),
    });
    expect((await api(`/api/docs?library_project=${researchProject}`)).body.data).toHaveLength(2);

    // Explicit filing into a second project, plus tags created by name.
    const home = (await api("/api/library/projects", { method: "POST", body: JSON.stringify({ name: "Home" }) })).body.data.project_id;
    const filed = await api("/api/library/file", {
      method: "POST",
      body: JSON.stringify({
        items: [{ type: "document", id: docC }, { type: "artifact", id: loose }],
        project_id: home,
        add_tags: ["Research", "follow up"],
      }),
    });
    expect(filed.status).toBe(200);
    expect(filed.body.data.updated).toBe(2);
    expect(filed.body.data.placements.map((p: Json) => p.tags.map((t: Json) => t.name))).toEqual([
      ["follow up", "Research"],
      ["follow up", "Research"],
    ]);
    const lib = filed.body.data.library;
    expect(lib.tags.map((t: Json) => [t.name, t.slug, t.count])).toEqual([
      ["follow up", "follow-up", 2],
      ["Research", "research", 2],
    ]);
    expect(lib.unfiled).toEqual({ documents: 0, artifacts: 0 });

    const research = lib.tags.find((t: Json) => t.slug === "research").id;
    const tagged = await api(`/api/artifacts?library_tag=${research}`);
    expect(tagged.body.data.artifacts.map((a: Json) => a.id)).toEqual([loose]);
    expect(tagged.body.data.artifacts[0].library).toMatchObject({ project_id: home, filed: "explicit" });
    expect((await api(`/api/artifacts?library_project=${researchProject}`)).body.data.artifacts.map((a: Json) => a.id)).toEqual([art]);

    // set_tags replaces; remove_tags accepts names.
    await api("/api/library/file", { method: "POST", body: JSON.stringify({ items: [{ type: "artifact", id: loose }], set_tags: ["Sketch"] }) });
    const removed = await api("/api/library/file", {
      method: "POST",
      body: JSON.stringify({ items: [{ type: "document", id: docC }], remove_tags: ["research"] }),
    });
    expect(removed.body.data.placements[0].tags.map((t: Json) => t.name)).toEqual(["follow up"]);
    expect(removed.body.data.library.tags.map((t: Json) => [t.name, t.count])).toEqual([
      ["follow up", 1], ["Research", 0], ["Sketch", 1],
    ]);

    // Detail endpoints carry the placement too.
    expect((await api(`/api/messages/${docC}`)).body.data.library.project_id).toBe(home);
    expect((await api(`/api/artifacts/${art}`)).body.data.artifact.library).toMatchObject({ project_id: researchProject, filed: "rule" });
  });

  it("keeps filing on a document's version family and never deletes content with a project", async () => {
    const { id: user, api } = await makeUser("ver");
    const slug = crypto.randomUUID();
    const v1 = await addDoc(user, "Spec v1", "spec-lab", { slug, latest: false });
    const projectId = (await api("/api/library/projects", { method: "POST", body: JSON.stringify({ name: "Specs" }) })).body.data.project_id;
    await api("/api/library/file", {
      method: "POST",
      body: JSON.stringify({ items: [{ type: "document", id: v1 }], project_id: projectId, add_tags: ["draft"] }),
    });
    const v2 = await addDoc(user, "Spec v2", "spec-lab", { slug });
    const listed = await api(`/api/docs?library_project=${projectId}`);
    const v2Row = listed.body.data.find((d: Json) => d.id === v2);
    expect(v2Row.library).toMatchObject({ project_id: projectId, filed: "explicit" });
    expect(v2Row.library.tags.map((t: Json) => t.name)).toEqual(["draft"]);
    // Counts use the latest version only.
    expect((await api("/api/library")).body.data.library.projects[0].counts.documents).toBe(1);

    const deleted = await api(`/api/library/projects/${projectId}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.library.projects).toEqual([]);
    expect(deleted.body.data.library.unfiled.documents).toBe(1);
    const still = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE doc_slug = ?").bind(slug).first<{ n: number }>();
    expect(still?.n).toBe(2);
  });

  it("isolates every user's library", async () => {
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    const aliceDoc = await addDoc(alice.id, "Private brief", "legal");
    const bobDoc = await addDoc(bob.id, "Bob notes", "notes");
    const aliceProject = (await alice.api("/api/library/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Legal", sources: ["legal"] }),
    })).body.data.project_id;

    // Bob cannot see, edit, delete, or file into Alice's project, and cannot file her doc.
    const bobView = (await bob.api("/api/library")).body.data.library;
    expect(bobView.projects).toEqual([]);
    expect(bobView.sources.map((s: Json) => s.label)).toEqual(["notes"]);
    expect((await bob.api(`/api/library/projects/${aliceProject}`, { method: "PATCH", body: JSON.stringify({ name: "Mine" }) })).status).toBe(404);
    expect((await bob.api(`/api/library/projects/${aliceProject}`, { method: "DELETE" })).status).toBe(404);
    const intoForeign = await bob.api("/api/library/file", {
      method: "POST",
      body: JSON.stringify({ items: [{ type: "document", id: bobDoc }], project_id: aliceProject }),
    });
    expect(intoForeign.status).toBe(400);
    const foreignItem = await bob.api("/api/library/file", {
      method: "POST",
      body: JSON.stringify({ items: [{ type: "document", id: aliceDoc }], add_tags: ["mine"] }),
    });
    expect(foreignItem.body.data).toMatchObject({ updated: 0, missing: [aliceDoc] });
    expect((await alice.api(`/api/messages/${aliceDoc}`)).body.data.library.tags).toEqual([]);

    // Bob's rule for the same label does not touch Alice's documents.
    await bob.api("/api/library/projects", { method: "POST", body: JSON.stringify({ name: "Legal", sources: ["legal"] }) });
    expect((await alice.api("/api/library")).body.data.library.projects[0].counts.documents).toBe(1);
    expect((await alice.api(`/api/docs?library_project=${aliceProject}`)).body.data.map((d: Json) => d.id)).toEqual([aliceDoc]);
  });

  it("validates input and keeps names unique per user", async () => {
    const { api } = await makeUser("val");
    expect((await api("/api/library/projects", { method: "POST", body: JSON.stringify({}) })).status).toBe(400);
    expect((await api("/api/library/projects", { method: "POST", body: JSON.stringify({ name: "X", color: "neon" }) })).status).toBe(400);
    expect((await api("/api/library/projects", { method: "POST", body: JSON.stringify({ name: "X", symbol: "bad symbol!" }) })).status).toBe(400);
    expect((await api("/api/library/file", { method: "POST", body: JSON.stringify({ items: [] }) })).status).toBe(400);
    expect((await api("/api/library/file", { method: "POST", body: "not json" })).status).toBe(400);

    const first = (await api("/api/library/projects", { method: "POST", body: JSON.stringify({ name: "Research" }) })).body.data;
    const second = (await api("/api/library/projects", { method: "POST", body: JSON.stringify({ name: "research" }) })).body.data;
    expect(second.library.projects.map((p: Json) => p.slug).sort()).toEqual(["research", "research-2"]);
    expect(first.project_id).not.toBe(second.project_id);

    const tag = (await api("/api/library/tags", { method: "POST", body: JSON.stringify({ name: "Legal", color: "red" }) })).body.data.tag;
    const again = (await api("/api/library/tags", { method: "POST", body: JSON.stringify({ name: "legal" }) })).body.data.tag;
    expect(again.id).toBe(tag.id);
    const other = (await api("/api/library/tags", { method: "POST", body: JSON.stringify({ name: "Ops" }) })).body.data.tag;
    expect((await api(`/api/library/tags/${other.id}`, { method: "PATCH", body: JSON.stringify({ name: "LEGAL" }) })).status).toBe(400);
    const renamed = await api(`/api/library/tags/${other.id}`, { method: "PATCH", body: JSON.stringify({ name: "Operations", color: "orange" }) });
    expect(renamed.body.data.library.tags.find((t: Json) => t.id === other.id)).toMatchObject({ name: "Operations", color: "orange" });

    const archived = await api(`/api/library/projects/${first.project_id}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: true, pinned: true, description: "Reading list" }),
    });
    const row = archived.body.data.library.projects.find((p: Json) => p.id === first.project_id);
    expect(row).toMatchObject({ pinned: true, description: "Reading list" });
    expect(row.archived_at).toBeTruthy();
    // Archived projects sort after active ones.
    expect(archived.body.data.library.projects.at(-1).id).toBe(first.project_id);

    // A source label belongs to one project: assigning it moves it.
    await api(`/api/library/projects/${first.project_id}`, { method: "PATCH", body: JSON.stringify({ sources: ["papers"] }) });
    const moved = await api(`/api/library/projects/${second.project_id}`, { method: "PATCH", body: JSON.stringify({ sources: ["papers"] }) });
    const projects = moved.body.data.library.projects;
    expect(projects.find((p: Json) => p.id === first.project_id).sources).toEqual([]);
    expect(projects.find((p: Json) => p.id === second.project_id).sources).toEqual(["papers"]);

    expect((await api(`/api/library/tags/${tag.id}`, { method: "DELETE" })).status).toBe(200);
  });

  it("lets agents read the library and file items over MCP", async () => {
    const { id: user, api } = await makeUser("mcp");
    const doc = await addDoc(user, "Squawk research", "research");
    const rpc = async (name: string, args: Record<string, unknown>) =>
      (await api("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).body.result;
    const tools = (await api("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).body.result.tools;
    expect(tools.map((t: Json) => t.name)).toEqual(expect.arrayContaining(["pidgin_get_library", "pidgin_save_library_project", "pidgin_file_items"]));

    const saved = await rpc("pidgin_save_library_project", { name: "Squawk", color: "orange", symbol: "speaker.wave.2" });
    expect(saved.isError).not.toBe(true);
    const projectId = saved.structuredContent.project.id;
    const filed = await rpc("pidgin_file_items", { items: [{ type: "document", id: doc }], project_id: projectId, add_tags: ["research"] });
    expect(filed.structuredContent.placements[0]).toMatchObject({ project_id: projectId, filed: "explicit" });
    const bad = await rpc("pidgin_save_library_project", { name: "X", color: "neon" });
    expect(bad.isError).toBe(true);
    const library = (await rpc("pidgin_get_library", {})).structuredContent.library;
    expect(library.projects[0]).toMatchObject({ name: "Squawk", counts: { documents: 1, artifacts: 0 } });
    expect(library.tags[0]).toMatchObject({ name: "research", count: 1 });
  });

  it("requires authentication", async () => {
    const response = await worker.fetch(new Request("https://pidgindocs.example.workers.dev/api/library"), env, ctx);
    expect(response.status).toBe(401);
  });
});
